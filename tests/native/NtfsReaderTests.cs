using System;
using System.IO;
using System.Reflection;
using System.Text;

internal static class NtfsReaderTests
{
    /**
     * Construct a versioned binary USN response without opening a real volume.
     * @param name Unicode entry name.
     * @returns Controlled binary response.
     */
    static byte[] Buffer(string name)
    {
        byte[] encoded = Encoding.Unicode.GetBytes(name), result = new byte[68 + encoded.Length];
        Array.Copy(BitConverter.GetBytes(60 + encoded.Length), 0, result, 8, 4);
        Array.Copy(BitConverter.GetBytes((ushort)2), 0, result, 12, 2);
        Array.Copy(BitConverter.GetBytes(UInt64.MaxValue - 1), 0, result, 16, 8);
        Array.Copy(BitConverter.GetBytes((ulong)5), 0, result, 24, 8);
        Array.Copy(BitConverter.GetBytes((uint)0x2000), 0, result, 48, 4);
        Array.Copy(BitConverter.GetBytes((uint)16), 0, result, 60, 4);
        Array.Copy(BitConverter.GetBytes((ushort)encoded.Length), 0, result, 64, 2);
        Array.Copy(BitConverter.GetBytes((ushort)60), 0, result, 66, 2);
        Array.Copy(encoded, 0, result, 68, encoded.Length);
        return result;
    }

    /**
     * Invoke the native record parser against a controlled byte buffer.
     * @param bytes Serialized records.
     * @returns Serialized NDJSON output.
     */
    static string Parse(byte[] bytes)
    {
        var writer = new StringWriter();
        typeof(NtfsReader).GetMethod("Records", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, new object[] { bytes, bytes.Length, writer });
        return writer.ToString();
    }

    /**
     * Require malformed native data to fail before being accepted as an index row.
     * @param bytes Malformed response.
     * @returns No value.
     * @throws Exception when the parser accepts malformed data.
     */
    static void Reject(byte[] bytes)
    {
        try { Parse(bytes); }
        catch (TargetInvocationException error) { if (error.InnerException is InvalidDataException) return; throw; }
        throw new Exception("Malformed record accepted");
    }

    /**
     * Exercise real compiled C# layout validation without privileged filesystem access.
     * @returns Success exit status.
     */
    public static int Main()
    {
        byte[] valid = Buffer("中文\"目录😀");
        string output = Parse(valid);
        if (!output.Contains("18446744073709551614") || !output.Contains("中文") || !output.Contains("8192")) throw new Exception("UTF-16 or 64-bit identity lost");
        byte[] version = Buffer("version");version[12]=3;Reject(version);
        byte[] offset = Buffer("offset");offset[66]=255;Reject(offset);
        byte[] truncated = Buffer("short");Array.Resize(ref truncated, truncated.Length-1);Reject(truncated);
        Console.WriteLine("4 native parser checks passed (Unicode/64-bit IDs, unsupported version, invalid offset, truncation)");
        return 0;
    }
}
