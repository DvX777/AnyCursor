using System;
using System.Text;
using System.Runtime.InteropServices;

class AnyCursorCredentials
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct CREDENTIAL
    {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public long LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredRead(string target, int type, int flags, out IntPtr credential);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredWrite(ref CREDENTIAL credential, int flags);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredDelete(string target, int type, int flags);

    [DllImport("advapi32.dll")]
    static extern void CredFree(IntPtr buffer);

    static int Get(string target)
    {
        IntPtr ptr;
        if (!CredRead(target, 1, 0, out ptr)) return 1;
        try
        {
            CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
            if (cred.CredentialBlobSize <= 0 || cred.CredentialBlob == IntPtr.Zero) return 2;
            byte[] bytes = new byte[cred.CredentialBlobSize];
            Marshal.Copy(cred.CredentialBlob, bytes, 0, bytes.Length);
            Console.Out.Write(Encoding.UTF8.GetString(bytes));
            return 0;
        }
        finally
        {
            CredFree(ptr);
        }
    }

    static int Set(string target, string secret)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(secret ?? "");
        IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
        try
        {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            CREDENTIAL cred = new CREDENTIAL();
            cred.Type = 1;
            cred.TargetName = target;
            cred.UserName = "AnyCursor";
            cred.CredentialBlob = blob;
            cred.CredentialBlobSize = bytes.Length;
            cred.Persist = 2;
            if (!CredWrite(ref cred, 0)) return 3;
            return 0;
        }
        finally
        {
            Marshal.FreeHGlobal(blob);
        }
    }

    static int Delete(string target)
    {
        if (CredDelete(target, 1, 0)) return 0;
        int error = Marshal.GetLastWin32Error();
        return error == 1168 ? 0 : 4; // ERROR_NOT_FOUND is success for delete
    }

    static int Main(string[] args)
    {
        if (args.Length < 2)
        {
            Console.Error.Write("usage: get|delete <target> | set <target> (secret on stdin)");
            return 64;
        }
        string command = args[0].ToLowerInvariant();
        string target = args[1];
        if (command == "get") return Get(target);
        if (command == "delete") return Delete(target);
        if (command == "set")
        {
            string secret = Console.In.ReadToEnd();
            return Set(target, secret);
        }
        Console.Error.Write("unknown command");
        return 64;
    }
}
