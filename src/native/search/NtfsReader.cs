using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// The helper only reads volume metadata. It never creates/deletes a journal or writes a volume.
internal static class NtfsReader
{
    /**
     * Open a read-only volume handle using the Windows API.
     * @param name Volume device name.
     * @param access Requested read access.
     * @param share Sharing flags.
     * @param security Default security attributes.
     * @param creation Existing-object mode.
     * @param flags File flags.
     * @param template Unused template handle.
     * @returns Safe native handle.
     */
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    /**
     * Invoke a fixed read-only metadata control operation.
     * @param handle Volume handle.
     * @param code Control code.
     * @param input Argument bytes.
     * @param inputSize Argument length.
     * @param output Response buffer.
     * @param outputSize Buffer capacity.
     * @param returned Valid response length.
     * @param overlapped Unused asynchronous context.
     * @returns Whether the operation succeeded.
     */
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(SafeFileHandle handle, uint code, byte[] input, int inputSize, byte[] output, int outputSize, out int returned, IntPtr overlapped);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    /**
     * Write one UTF-8 protocol record without buffering an entire disk in memory.
     * @param output Response stream.
     * @param value Serializable record.
     * @returns No value.
     */
    static void Emit(TextWriter output, object value) { output.WriteLine(Json.Serialize(value)); }

    /**
     * Read a Windows metadata control response and preserve the native error code.
     * @param handle Read-only volume handle.
     * @param code Metadata control code.
     * @param input Control arguments.
     * @param output Response buffer.
     * @returns Number of valid response bytes.
     * @throws Win32Exception when the volume denies the request.
     */
    static int Control(SafeFileHandle handle, uint code, byte[] input, byte[] output)
    {
        int size;
        if (!DeviceIoControl(handle, code, input, input == null ? 0 : input.Length, output, output.Length, out size, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return size;
    }

    /**
     * Serialize validated version-two NTFS records; unknown layouts fail closed.
     * @param buffer Returned USN buffer.
     * @param length Valid buffer length.
     * @param output Response stream.
     * @returns No value.
     * @throws InvalidDataException for unsupported or truncated records.
     */
    static void Records(byte[] buffer, int length, TextWriter output)
    {
        for (int p = 8; p < length; ) {
            if (p + 60 > length) throw new InvalidDataException("Truncated NTFS record");
            int size = BitConverter.ToInt32(buffer, p);
            int version = BitConverter.ToUInt16(buffer, p + 4);
            int count = BitConverter.ToUInt16(buffer, p + 56), offset = BitConverter.ToUInt16(buffer, p + 58);
            if (version != 2 || size < 60 || size > length - p || offset < 60 || offset + count > size || count % 2 != 0)
                throw new InvalidDataException("Unsupported NTFS record layout");
            Emit(output, new { type = "entry", id = BitConverter.ToUInt64(buffer, p + 8).ToString(), parent = BitConverter.ToUInt64(buffer, p + 16).ToString(),
                name = Encoding.Unicode.GetString(buffer, p + offset, count), attributes = BitConverter.ToUInt32(buffer, p + 52), reason = BitConverter.ToUInt32(buffer, p + 40) });
            p += size;
        }
    }

    /**
     * Enumerate MFT records or resume a bounded USN journal cursor on a fixed NTFS disk.
     * @param args Operation, drive letter and optional journal ID/cursor.
     * @param output Response stream.
     * @returns No value.
     * @throws Exception when access, journal continuity or protocol validation fails.
     */
    internal static void Run(string[] args, TextWriter output)
    {
        if (args.Length < 2 || args[1].Length != 2 || !Char.IsLetter(args[1][0]) || args[1][1] != ':')
            throw new ArgumentException("Expected a local drive letter");
        string drive = args[1].ToUpperInvariant();
        DriveInfo info = new DriveInfo(drive + "\\");
        if (info.DriveType != DriveType.Fixed || !info.IsReady || info.DriveFormat != "NTFS")
            throw new InvalidOperationException("Only fixed NTFS volumes are supported");
        using (SafeFileHandle handle = CreateFile(@"\\.\" + drive, 0x80000000, 7, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            byte[] journal = new byte[80];
            if (Control(handle, 0x000900f4, null, journal) < 56) throw new InvalidDataException("Invalid journal metadata");
            ulong journalId = BitConverter.ToUInt64(journal, 0);
            long first = Math.Max(BitConverter.ToInt64(journal, 8), BitConverter.ToInt64(journal, 24));
            long next = BitConverter.ToInt64(journal, 16);
            Emit(output, new { type = "meta", journal = journalId.ToString(), first = first.ToString(), next = next.ToString(), drive = drive });
            if (args[0] == "probe") { Emit(output, new { type = "done", next = next.ToString() }); return; }
            byte[] buffer = new byte[1024 * 1024];
            if (args[0] == "snapshot") {
                byte[] input = new byte[24];
                // Include records changed while enumeration runs; replay from the pre-snapshot cursor afterwards.
                Array.Copy(BitConverter.GetBytes(Int64.MaxValue), 0, input, 16, 8);
                while (true) {
                    int size;
                    try { size = Control(handle, 0x000900b3, input, buffer); }
                    catch (Win32Exception error) { if (error.NativeErrorCode == 38) break; throw; }
                    if (size < 8) throw new InvalidDataException("Invalid MFT response");
                    Records(buffer, size, output);
                    Array.Copy(buffer, 0, input, 0, 8);
                }
            } else if (args[0] == "changes") {
                ulong expected;
                long cursor;
                if (args.Length != 4 || !UInt64.TryParse(args[2], out expected) || !Int64.TryParse(args[3], out cursor) || expected != journalId || cursor < first || cursor > next)
                    throw new InvalidOperationException("JOURNAL_RESET: full snapshot required");
                byte[] input = new byte[40];
                // Read every change up to the captured endpoint, without waiting for a handle-close event.
                Array.Copy(BitConverter.GetBytes((uint)0x00113300), 0, input, 8, 4);
                Array.Copy(BitConverter.GetBytes(journalId), 0, input, 32, 8);
                while (cursor < next) {
                    Array.Copy(BitConverter.GetBytes(cursor), 0, input, 0, 8);
                    int size = Control(handle, 0x000900bb, input, buffer);
                    if (size < 8) throw new InvalidDataException("Invalid journal response");
                    long after = BitConverter.ToInt64(buffer, 0);
                    if (after <= cursor) throw new InvalidDataException("Journal cursor did not advance");
                    Records(buffer, size, output);
                    cursor = after;
                }
                next = cursor;
            } else throw new ArgumentException("Unsupported operation");
            Emit(output, new { type = "done", next = next.ToString() });
        }
    }

    /**
     * Execute a read-only helper operation and expose failures as structured output.
     * @param args Command-line arguments.
     * @returns Process exit code.
     */
    public static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        try { Run(args, Console.Out); return 0; }
        catch (Exception error) {
            Emit(Console.Out, new { type = "error", error = error.Message, code = error is Win32Exception ? ((Win32Exception)error).NativeErrorCode : 0 });
            return 1;
        }
    }
}
