using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

internal sealed class SearchService : ServiceBase
{
    const string ServiceId = "sToolsSearch";
    const string RegistryPath = @"SOFTWARE\sTools\Search";
    volatile bool stopping;
    NamedPipeServerStream active;

    /**
     * Configure the dedicated metadata service.
     * @returns Service instance.
     */
    SearchService() { ServiceName = ServiceId; CanStop = true; AutoLog = false; }

    /**
     * Start the pipe listener independently of the service-control dispatcher.
     * @param args Service arguments.
     * @returns No value.
     */
    protected override void OnStart(string[] args)
    {
        new Thread(Listen) { IsBackground = true }.Start();
    }

    /**
     * Close the active pipe so shutdown interrupts blocked readers and writers.
     * @returns No value.
     */
    protected override void OnStop() { stopping = true; if (active != null) active.Dispose(); }

    /**
     * Serve only the owner SID; the protocol exposes fixed read-only volume operations.
     * @returns No value.
     */
    void Listen()
    {
        string sid;
        using (RegistryKey key = Registry.LocalMachine.OpenSubKey(RegistryPath)) sid = (string)key.GetValue("OwnerSid");
        var owner = new SecurityIdentifier(sid);
        var security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
        security.AddAccessRule(new PipeAccessRule(owner, PipeAccessRights.ReadWrite, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        while (!stopping) {
            try {
                using (var pipe = new NamedPipeServerStream("sTools.Search." + sid, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.None, 65536, 65536, security)) {
                    active = pipe;
                    pipe.WaitForConnection();
                    // A dead client cannot hold the single service connection indefinitely.
                    using (var timeout = new Timer(delegate { try { pipe.Dispose(); } catch { } }, null, 300000, Timeout.Infinite))
                    using (var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 1024, true))
                    using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 65536, true)) {
                        var line = new StringBuilder();
                        int c;
                        while ((c = reader.Read()) != -1 && c != '\n') {
                            if (line.Length >= 256) throw new InvalidDataException("Request too long");
                            if (c != '\r') line.Append((char)c);
                        }
                        var args = new JavaScriptSerializer().Deserialize<string[]>(line.ToString());
                        // The service never accepts paths, executable names, shell commands or write requests.
                        try { NtfsReader.Run(args, writer); }
                        catch (Exception error) { writer.WriteLine(new JavaScriptSerializer().Serialize(new { type = "error", error = error.Message })); }
                        writer.Flush();
                    }
                }
            } catch { if (stopping) return; Thread.Sleep(250); }
            finally { active = null; }
        }
    }

    /**
     * Invoke a fixed service-control utility and check its exit code.
     * @param arguments Fixed, validated sc.exe arguments.
     * @returns No value.
     * @throws InvalidOperationException when service control fails.
     */
    static void Sc(string arguments)
    {
        using (Process child = Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "sc.exe"), arguments) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true })) {
            string output = child.StandardOutput.ReadToEnd();
            child.WaitForExit();
            if (child.ExitCode != 0) throw new InvalidOperationException(output);
        }
    }

    /**
     * Install or update a service binary in an administrator-writable location.
     * @param sid Local sTools owner SID.
     * @returns No value.
     * @throws Exception if elevation, ownership or installation validation fails.
     */
    static void Install(string sid)
    {
        if (!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator)) throw new UnauthorizedAccessException("Administrator approval required");
        var owner = new SecurityIdentifier(sid);
        bool exists = false;
        foreach (var service in ServiceController.GetServices()) {
            using (service) if (service.ServiceName == ServiceId) {
                exists = true;
                if (service.Status != ServiceControllerStatus.Stopped) { service.Stop(); service.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30)); }
            }
        }
        string directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "sTools Search");
        Directory.CreateDirectory(directory);
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new IOException("Service directory cannot be a reparse point");
        // Never run a SYSTEM service from the per-user application folder.
        var acl = new DirectorySecurity();
        acl.SetAccessRuleProtection(true, false);
        acl.SetOwner(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null));
        foreach (WellKnownSidType kind in new[] { WellKnownSidType.LocalSystemSid, WellKnownSidType.BuiltinAdministratorsSid, WellKnownSidType.BuiltinUsersSid })
            acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(kind, null), kind == WellKnownSidType.BuiltinUsersSid ? FileSystemRights.ReadAndExecute : FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        Directory.SetAccessControl(directory, acl);
        string target = Path.Combine(directory, "stools-ntfs.exe");
        if (File.Exists(target) && (File.GetAttributes(target) & FileAttributes.ReparsePoint) != 0) throw new IOException("Service executable cannot be a reparse point");
        string replacement = Path.Combine(directory, "indexer-" + Guid.NewGuid().ToString("N") + ".tmp");
        File.Copy(Assembly.GetExecutingAssembly().Location, replacement, false);
        if (File.Exists(target)) File.Delete(target);
        File.Move(replacement, target);
        using (RegistryKey key = Registry.LocalMachine.CreateSubKey(RegistryPath)) key.SetValue("OwnerSid", owner.Value);
        string binary = "\"\\\"" + target + "\\\" --service\"";
        Sc((exists ? "config " : "create ") + ServiceId + " binPath= " + binary + " start= auto obj= LocalSystem DisplayName= \"sTools File Index\"");
        Sc("start " + ServiceId);
    }

    /**
     * Remove the service registration; user data and indexed files are untouched.
     * @returns No value.
     */
    static void Uninstall()
    {
        using (var service = new ServiceController(ServiceId)) {
            try { if (service.Status != ServiceControllerStatus.Stopped) { service.Stop(); service.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30)); } }
            catch (InvalidOperationException) { return; }
        }
        Sc("delete " + ServiceId);
        Registry.LocalMachine.DeleteSubKeyTree(RegistryPath, false);
        string directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "sTools Search");
        if (Directory.Exists(directory) && (File.GetAttributes(directory) & FileAttributes.ReparsePoint) == 0) {
            File.Delete(Path.Combine(directory, "stools-ntfs.exe"));
            if (Directory.GetFileSystemEntries(directory).Length == 0) Directory.Delete(directory);
        }
    }

    /**
     * Prefer the owner-restricted service and otherwise try direct read access.
     * @param args Metadata operation arguments.
     * @returns No value.
     */
    static void Client(string[] args)
    {
        string sid = WindowsIdentity.GetCurrent().User.Value;
        using (var pipe = new NamedPipeClientStream(".", "sTools.Search." + sid, PipeDirection.InOut, PipeOptions.None, TokenImpersonationLevel.Identification)) {
            using (RegistryKey key = Registry.LocalMachine.OpenSubKey(RegistryPath)) {
                if (key == null || (string)key.GetValue("OwnerSid") != sid) { NtfsReader.Run(args, Console.Out); return; }
            }
            try { pipe.Connect(2000); }
            catch (System.TimeoutException) { NtfsReader.Run(args, Console.Out); return; }
            using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 1024, true)) { writer.WriteLine(new JavaScriptSerializer().Serialize(args)); writer.Flush(); }
            using (var reader = new StreamReader(pipe, new UTF8Encoding(false))) { string line; while ((line = reader.ReadLine()) != null) Console.WriteLine(line); }
        }
    }

    /**
     * Route the console-free service entrypoint separately from local lifecycle and query commands.
     * @param args Command-line arguments.
     * @returns Exit status.
     */
    public static int Main(string[] args)
    {
        // Windows services have no console handles; setting its encoding would fail before dispatch.
        if (args.Length == 1 && args[0] == "--service") {
            ServiceBase.Run(new SearchService());
            return 0;
        }
        try {
            Console.OutputEncoding = new UTF8Encoding(false);
            if (args.Length == 2 && args[0] == "install") Install(args[1]);
            else if (args.Length == 1 && args[0] == "uninstall") Uninstall();
            else Client(args);
            return 0;
        } catch (Exception error) { Console.WriteLine(new JavaScriptSerializer().Serialize(new { type = "error", error = error.Message })); return 1; }
    }
}


