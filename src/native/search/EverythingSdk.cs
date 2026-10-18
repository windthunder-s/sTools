// Official Everything SDK IPC v2 protocol: https://www.voidtools.com/support/everything/sdk/ipc/
// This bridge implements the published protocol; the Everything indexing engine remains external.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed class SdkRequest {
    public string action = "query", query = "", filter = "all", instance = "";
    public int offset = 0, sort = 1;
    public bool matchCase = false, matchPath = false, matchWholeWord = false;
}
internal sealed class SdkItem { public string name, path; public bool directory; }
internal sealed class SdkPage {
    public List<SdkItem> items = new List<SdkItem>();
    public uint total;
    public int offset;
    public bool limited;
    public string hash, prefixHash;
}
internal sealed class EverythingSdk : NativeWindow, IDisposable {
    [StructLayout(LayoutKind.Sequential)] private struct CopyData { public IntPtr id; public int size; public IntPtr data; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindow(string name, string title);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wparam, IntPtr lparam, uint flags, uint timeout, out UIntPtr result);
    private IntPtr target;
    private byte[] reply;
    private string failure;
    private uint replyId = 711;
    private const int MaxReply = 64 * 1024 * 1024;

    /**
     * Create a message-only receiver connected to the selected Everything instance.
     * @param instance Optional named instance for isolated indexes.
     * @returns A connected bridge.
     * @throws If Everything is unavailable or the instance name is invalid.
     */
    public EverythingSdk(string instance) {
        if (instance.Length > 128 || instance.IndexOfAny(new char[] {'\0', '\r', '\n'}) >= 0) throw new Exception("Everything 实例名称无效");
        var deadline = Stopwatch.StartNew();
        do {
            target = FindWindow("EVERYTHING_TASKBAR_NOTIFICATION" + (instance.Length == 0 ? "" : "_(" + instance + ")"), null);
            if (target != IntPtr.Zero) break;
            Thread.Sleep(50);
        } while (deadline.ElapsedMilliseconds < 4000);
        if (target == IntPtr.Zero) throw new Exception("未连接到 Everything，请检查本地工具设置中的程序路径和实例名称");
        CreateHandle(new CreateParams { Caption = "sTools SDK receiver", Parent = new IntPtr(-3) });
    }

    /**
     * Send a bounded read-only SDK request without blocking indefinitely.
     * @param message Windows message identifier.
     * @param wparam Message parameter.
     * @param lparam Message payload address.
     * @returns The response value.
     * @throws If the target cannot respond within five seconds.
     */
    private uint Send(uint message, IntPtr wparam, IntPtr lparam) {
        UIntPtr value;
        if (SendMessageTimeout(target, message, wparam, lparam, 2, 5000, out value) == IntPtr.Zero)
            throw new Exception("Everything 未响应，请重试");
        return (uint)value.ToUInt64();
    }

    /**
     * Copy a matching SDK reply before the sender releases its buffer.
     * @param message Incoming Windows message.
     * @returns No value.
     */
    protected override void WndProc(ref Message message) {
        if (message.Msg == 0x4A) {
            try {
                var data = (CopyData)Marshal.PtrToStructure(message.LParam, typeof(CopyData));
                if (data.id.ToInt64() == replyId) {
                    if (data.size < 20 || data.size > MaxReply || data.data == IntPtr.Zero) failure = "Everything 返回了无效的数据长度";
                    else { reply = new byte[data.size]; Marshal.Copy(data.data, reply, 0, data.size); }
                    message.Result = new IntPtr(1);
                    return;
                }
            } catch (Exception error) { failure = error.Message; }
        }
        base.WndProc(ref message);
    }

    /**
     * Hash an ordered result prefix to detect insertion, removal and rename between pages.
     * @param items Ordered matching items.
     * @param count Prefix length.
     * @returns A SHA-256 fingerprint.
     */
    private static string Hash(List<SdkItem> items, int count) {
        var text = new StringBuilder();
        for (int i = 0; i < Math.Min(count, items.Count); i++) text.Append(items[i].directory ? "D" : "F").Append(items[i].path).Append('\0');
        using (var algorithm = SHA256.Create()) return Convert.ToBase64String(algorithm.ComputeHash(Encoding.UTF8.GetBytes(text.ToString())));
    }

    /**
     * Decode only the full-path field requested from SDK v2, checking every buffer boundary.
     * @param bytes SDK response bytes.
     * @param offset Previously displayed prefix length.
     * @returns One page plus prefix fingerprints.
     * @throws If the response structure or any path is malformed.
     */
    internal static SdkPage Decode(byte[] bytes, int offset) {
        if (bytes.Length < 20 || BitConverter.ToUInt32(bytes, 12) != 4 || BitConverter.ToUInt32(bytes, 8) != 0) throw new Exception("Everything SDK 响应格式不受支持");
        uint total = BitConverter.ToUInt32(bytes, 0), count = BitConverter.ToUInt32(bytes, 4);
        if (count > (bytes.Length - 20) / 8 || count > total) throw new Exception("Everything SDK 结果数量无效");
        var all = new List<SdkItem>();
        for (int i = 0; i < count; i++) {
            uint flags = BitConverter.ToUInt32(bytes, 20 + i * 8), start = BitConverter.ToUInt32(bytes, 24 + i * 8);
            if (start < 20 + count * 8 || start > bytes.Length - 4) throw new Exception("Everything SDK 路径偏移无效");
            uint length = BitConverter.ToUInt32(bytes, (int)start);
            if (length > 32767 || (long)start + 4 + ((long)length + 1) * 2 > bytes.Length) throw new Exception("Everything SDK 路径长度无效");
            int end = (int)start + 4 + (int)length * 2;
            if (bytes[end] != 0 || bytes[end + 1] != 0) throw new Exception("Everything SDK 路径终止符无效");
            string path = Encoding.Unicode.GetString(bytes, (int)start + 4, (int)length * 2);
            if (!Path.IsPathRooted(path) || path.IndexOf('\0') >= 0) throw new Exception("Everything SDK 路径无效");
            string name = Path.GetFileName(path.TrimEnd('\\', '/'));
            all.Add(new SdkItem { path = path, name = name.Length == 0 ? path : name, directory = (flags & 3) != 0 });
        }
        return new SdkPage { total = total, offset = offset, items = all.GetRange(Math.Min(offset, all.Count), Math.Max(0, all.Count - offset)), limited = count < total, hash = Hash(all, all.Count), prefixHash = Hash(all, offset) };
    }

    /**
     * Execute one native query; the user expression is sent as UTF-16 data, never shell arguments.
     * @param request Search and matching options.
     * @param expression Original expression plus an optional grouped category constraint.
     * @param offset Previously loaded result count.
     * @param count Maximum requested prefix size.
     * @returns A validated page.
     * @throws If Everything rejects, times out or returns malformed results.
     */
    private SdkPage Query(SdkRequest request, string expression, int offset, int count) {
        reply = null; failure = null; replyId++;
        var text = Encoding.Unicode.GetBytes(expression + "\0");
        var payload = new byte[28 + text.Length];
        uint flags = (request.matchCase ? 1u : 0) | (request.matchWholeWord ? 2u : 0) | (request.matchPath ? 4u : 0);
        uint[] fields = { unchecked((uint)Handle.ToInt64()), replyId, flags, 0, (uint)count, 4, (uint)request.sort };
        for (int i = 0; i < fields.Length; i++) Buffer.BlockCopy(BitConverter.GetBytes(fields[i]), 0, payload, i * 4, 4);
        Buffer.BlockCopy(text, 0, payload, 28, text.Length);
        IntPtr data = Marshal.AllocHGlobal(payload.Length), copy = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(CopyData)));
        try {
            Marshal.Copy(payload, 0, data, payload.Length);
            Marshal.StructureToPtr(new CopyData { id = new IntPtr(18), size = payload.Length, data = data }, copy, false);
            if (Send(0x4A, Handle, copy) == 0) throw new Exception("Everything 版本不支持 SDK v2 查询，请使用 1.4.1 或更新版本");
            var deadline = Stopwatch.StartNew();
            while (reply == null && failure == null && deadline.ElapsedMilliseconds < 10000) { Application.DoEvents(); Thread.Sleep(2); }
            if (failure != null) throw new Exception(failure);
            if (reply == null) throw new Exception("Everything 查询超时，请缩小范围或重试");
            return Decode(reply, offset);
        } finally { Marshal.FreeHGlobal(copy); Marshal.FreeHGlobal(data); }
    }

    /**
     * Add sTools category semantics without changing the all-results expression.
     * @param query Original Everything query.
     * @param filter sTools category.
     * @returns A grouped Everything expression.
     * @throws If the category is unsupported.
     */
    private static string Expression(string query, string filter) {
        if (filter == "all") return query;
        string constraint = filter == "app" ? "file: ext:exe;lnk;appref-ms" : filter == "file" ? "file: !ext:exe;lnk;appref-ms" : filter == "folder" ? "folder:" : null;
        if (constraint == null) throw new Exception("搜索分类无效");
        return (query.Length == 0 ? "" : "<" + query + "> ") + constraint;
    }

    /**
     * Execute status, first-category pages, or a continuation page.
     * @param request Validated bridge request.
     * @returns A serializable response object.
     * @throws If the engine is still indexing or any query fails.
     */
    private object Execute(SdkRequest request) {
        if (Send(1024, new IntPtr(401), IntPtr.Zero) == 0) throw new Exception("Everything 索引正在加载，请稍后重试");
        if (request.action == "status") {
            string version = Send(1024, IntPtr.Zero, IntPtr.Zero) + "." + Send(1024, new IntPtr(1), IntPtr.Zero) + "." + Send(1024, new IntPtr(2), IntPtr.Zero) + "." + Send(1024, new IntPtr(3), IntPtr.Zero);
            return new { version = version, count = Query(request, "", 0, 0).total };
        }
        if (request.action == "page") return Query(request, Expression(request.query, request.filter), request.offset, checked(request.offset + 100));
        if (request.action != "query") throw new Exception("SDK 操作无效");
        var buckets = new Dictionary<string, SdkPage>();
        foreach (string filter in new[] { "all", "app", "file", "folder" }) buckets[filter] = Query(request, Expression(request.query, filter), 0, 100);
        return new { buckets = buckets };
    }

    /**
     * Release the message-only window.
     * @returns No value.
     */
    public void Dispose() { DestroyHandle(); }

    /**
     * Read one bounded JSON request and write one JSON response for the host.
     * @returns Zero for success, one for a reported error.
     */
    [STAThread] private static int Main() {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        var json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
        try {
            // Read at most one small request; the parent owns cancellation and process lifetime.
            char[] input = new char[16385]; int size = 0, next;
            while (size < input.Length && (next = Console.In.Read()) != -1) input[size++] = (char)next;
            if (size == input.Length) throw new Exception("SDK 请求过长");
            var request = json.Deserialize<SdkRequest>(new string(input, 0, size));
            if (request == null || request.query == null || request.query.Length > 512 || request.query.IndexOf('\0') >= 0 || request.instance == null || request.offset < 0 || request.offset > 1000000 || Array.IndexOf(new[] {1,2,3,4,5,6,13,14}, request.sort) < 0) throw new Exception("SDK 查询参数无效");
            using (var sdk = new EverythingSdk(request.instance)) Console.WriteLine(json.Serialize(sdk.Execute(request)));
            return 0;
        } catch (Exception error) { Console.WriteLine(json.Serialize(new { error = error.Message })); return 1; }
    }
}
