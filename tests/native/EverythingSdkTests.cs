using System;
using System.Text;
internal static class EverythingSdkTests {
    /**
     * Construct an SDK v2 full-path reply with one Unicode folder.
     * @returns A valid binary fixture.
     */
    private static byte[] Fixture() {
        byte[] text = Encoding.Unicode.GetBytes("E:\\资料\\测试\0"), bytes = new byte[32 + text.Length];
        uint[] fields = { 1, 1, 0, 4, 1, 1, 28, (uint)(text.Length / 2 - 1) };
        for (int i = 0; i < fields.Length; i++) Buffer.BlockCopy(BitConverter.GetBytes(fields[i]), 0, bytes, i * 4, 4);
        Buffer.BlockCopy(text, 0, bytes, 32, text.Length);
        return bytes;
    }
    /**
     * Confirm malformed IPC data cannot escape validation.
     * @param bytes Corrupted response bytes.
     * @returns No value.
     * @throws If the malformed fixture was accepted.
     */
    private static void Reject(byte[] bytes) {
        try { EverythingSdk.Decode(bytes, 0); }
        catch (Exception) { return; }
        throw new Exception("Malformed SDK data was accepted");
    }
    /**
     * Validate Unicode decoding and all variable-length response boundaries.
     * @returns Zero when every check passes.
     * @throws If any invariant fails.
     */
    private static int Main() {
        var page = EverythingSdk.Decode(Fixture(), 0);
        if (page.items.Count != 1 || page.items[0].name != "测试" || !page.items[0].directory) throw new Exception("Unicode folder mismatch");
        Reject(new byte[19]);
        byte[] count = Fixture(); Buffer.BlockCopy(BitConverter.GetBytes(UInt32.MaxValue), 0, count, 4, 4); Reject(count);
        byte[] offset = Fixture(); Buffer.BlockCopy(BitConverter.GetBytes(UInt32.MaxValue), 0, offset, 24, 4); Reject(offset);
        byte[] length = Fixture(); Buffer.BlockCopy(BitConverter.GetBytes(UInt32.MaxValue), 0, length, 28, 4); Reject(length);
        byte[] terminal = Fixture(); terminal[terminal.Length - 1] = 1; Reject(terminal);
        byte[] flags = Fixture(); flags[12] = 1; Reject(flags);
        Console.WriteLine("SDK parser: 7 checks passed");
        return 0;
    }
}
