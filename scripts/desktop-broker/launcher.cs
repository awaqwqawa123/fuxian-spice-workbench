using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class Launcher
{
    private const uint JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    // Filled by Prepare. The official Desktop may copy only this executable into
    // a sandbox runtime cache; keep its stable installation configuration usable.
    private const string InstalledConfigPath = @"__DESKTOP_CONTROL_CONFIG_PATH__";

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        uint informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static int Main(string[] args)
    {
        try
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string configPath = Path.Combine(baseDir, "desktop-control.config");
            if (!File.Exists(configPath)) configPath = InstalledConfigPath;
            string[] config = File.ReadAllLines(configPath, Encoding.UTF8);
            if (config.Length != 5 || config[0] != "version=1")
            {
                throw new InvalidDataException("Bridge config must contain the Windows runtime paths for version 1.");
            }

            var startInfo = CreateRedirectedStartInfo(
                config[1],
                JoinArguments(config[2], args),
                config[3]);
            startInfo.EnvironmentVariables["CODEX_DESKTOP_CONTROL_DIRECTORY"] = config[4];
            IntPtr job = CreateKillOnCloseJob();
            try
            {
                using (Process child = Process.Start(startInfo))
                {
                    if (child == null) throw new InvalidOperationException("Failed to start the Desktop bridge runtime.");
                    if (!AssignProcessToJobObject(job, child.Handle))
                    {
                        int errorCode = Marshal.GetLastWin32Error();
                        try { child.Kill(); child.WaitForExit(3000); } catch { }
                        throw new Win32Exception(errorCode, "Cannot contain the Desktop bridge process tree; startup was stopped.");
                    }
                    Thread stdin = StartCopyThread(Console.OpenStandardInput(), child.StandardInput.BaseStream, true);
                    Thread stdout = StartCopyThread(child.StandardOutput.BaseStream, Console.OpenStandardOutput(), false);
                    Thread stderr = StartCopyThread(child.StandardError.BaseStream, Console.OpenStandardError(), false);
                    child.WaitForExit();
                    stdout.Join();
                    stderr.Join();
                    return child.ExitCode;
                }
            }
            finally { CloseHandle(job); }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("[desktop-control-launcher] " + error);
            return 1;
        }
    }

    private static ProcessStartInfo CreateRedirectedStartInfo(string fileName, string arguments, string workingDirectory)
    {
        return new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
    }

    private static Thread StartCopyThread(Stream source, Stream destination, bool closeDestination)
    {
        var thread = new Thread(delegate()
        {
            try
            {
                byte[] buffer = new byte[16384];
                int count;
                while ((count = source.Read(buffer, 0, buffer.Length)) > 0)
                {
                    destination.Write(buffer, 0, count);
                    destination.Flush();
                }
            }
            catch (IOException)
            {
                // The opposite endpoint closed normally.
            }
            finally
            {
                if (closeDestination)
                {
                    try { destination.Close(); } catch { }
                }
            }
        });
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }

    private static string JoinArguments(string scriptPath, string[] args)
    {
        var builder = new StringBuilder();
        AppendQuoted(builder, scriptPath);
        foreach (string arg in args)
        {
            builder.Append(' ');
            AppendQuoted(builder, arg);
        }
        return builder.ToString();
    }

    private static void AppendQuoted(StringBuilder builder, string value)
    {
        builder.Append('"');
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                builder.Append('\\', backslashes * 2 + 1);
                builder.Append('"');
                backslashes = 0;
                continue;
            }
            builder.Append('\\', backslashes);
            builder.Append(character);
            backslashes = 0;
        }
        builder.Append('\\', backslashes * 2);
        builder.Append('"');
    }

    private static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot create Desktop bridge process container.");
        var info = new ExtendedLimitInformation();
        info.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        int size = Marshal.SizeOf(typeof(ExtendedLimitInformation));
        IntPtr pointer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, pointer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)size))
            {
                int errorCode = Marshal.GetLastWin32Error();
                CloseHandle(job);
                throw new Win32Exception(errorCode, "Cannot configure Desktop bridge process cleanup.");
            }
            return job;
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }
}
