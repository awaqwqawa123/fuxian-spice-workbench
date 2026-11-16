using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace FuxianLauncher
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            try
            {
                var options = LauncherOptions.Parse(args);
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new LauncherForm(options));
            }
            catch (Exception error) { MessageBox.Show(error.Message, "伏线启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error); }
        }
    }

    public sealed class LauncherOptions
    {
        public int Port { get; private set; }
        public int Timeout { get; private set; }
        public string ProjectPath { get; private set; }

        public static LauncherOptions Parse(string[] args)
        {
            var result = new LauncherOptions { Port = 3032, Timeout = 45 };
            for (int i = 0; i < args.Length; i++)
            {
                string option = args[i].ToLowerInvariant();
                if (option == "-port" || option == "--port" || option == "-timeoutseconds")
                {
                    int value;
                    if (++i >= args.Length || !Int32.TryParse(args[i], out value)) throw new ArgumentException("启动参数需要整数值。");
                    if (option == "-timeoutseconds")
                    {
                        if (value < 2 || value > 120) throw new ArgumentException("等待时间应为 2 至 120 秒。");
                        result.Timeout = value;
                    }
                    else
                    {
                        if (value < 1024 || value > 65535) throw new ArgumentException("端口应为 1024 至 65535。");
                        result.Port = value;
                    }
                }
                else if (result.ProjectPath == null) result.ProjectPath = ProjectInbox.ValidatePath(args[i]);
                else throw new ArgumentException("每次只能打开一个 .fuxian 工程文件。");
            }
            return result;
        }
    }

    public static class ServiceLauncher
    {
        public static string ReadReadyUrl(string json, int port)
        {
            var serializer = new JavaScriptSerializer { MaxJsonLength = 65536 };
            var state = serializer.Deserialize<Dictionary<string, object>>(json);
            object ready, actualPort, url;
            string expected = "http://localhost:" + port + "/";
            if (state == null || !state.TryGetValue("ready", out ready) || !(ready is bool) || !(bool)ready ||
                !state.TryGetValue("port", out actualPort) || !(actualPort is int) || (int)actualPort != port ||
                !state.TryGetValue("url", out url) || !(url is string) || (string)url != expected)
                throw new InvalidOperationException("本机服务尚未报告有效的就绪状态，请稍后重试。");
            return expected;
        }

        // Windows command-line quoting, with no cmd.exe or shell interpretation.
        internal static string Quote(string value)
        {
            var result = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in value)
            {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); slashes = 0; continue; }
                result.Append('\\', slashes); slashes = 0; result.Append(c);
            }
            result.Append('\\', slashes * 2); result.Append('"');
            return result.ToString();
        }

        public static string Start(string helper, int port, int timeout)
        {
            return ReadReadyUrl(RunHelper(helper, port, timeout), port);
        }

        public static string StartProject(string helper, int port, int timeout, string projectPath)
        {
            // Validate the file before launching the service and keep the same
            // handle open while waiting. Then copy only that file to the inbox.
            using (var source = ProjectInbox.Open(projectPath))
            {
                string json = RunHelper(helper, port, timeout);
                string url = ReadReadyUrl(json, port);
                var serializer = new JavaScriptSerializer { MaxJsonLength = 65536 };
                object directory;
                if (!serializer.Deserialize<Dictionary<string, object>>(json).TryGetValue("serviceDirectory", out directory)
                    || !(directory is string) || !Directory.Exists((string)directory) || !Path.IsPathRooted((string)directory))
                    throw new InvalidOperationException("无法识别伏线本机服务目录，请尝试在网页内打开工程。");
                return url + "#openFuxian=" + ProjectInbox.Stage((string)directory, source);
            }
        }

        private static string RunHelper(string helper, int port, int timeout)
        {
            if (!File.Exists(helper)) throw new FileNotFoundException("启动文件不完整，请将 ZIP 完整解压后重试。", helper);
            string shellDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0");
            var info = new ProcessStartInfo(Path.Combine(shellDirectory, "powershell.exe"))
            {
                Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + Quote(helper) + " -Port " + port + " -TimeoutSeconds " + timeout,
                WorkingDirectory = Path.GetDirectoryName(helper), UseShellExecute = false, CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
            };
            // A child WinPS must find its own system modules even when started
            // from a PowerShell 7 host with an incompatible inherited module path.
            info.EnvironmentVariables["PSModulePath"] = Path.Combine(shellDirectory, "Modules");
            using (var process = Process.Start(info))
            {
                Task<string> output = process.StandardOutput.ReadToEndAsync();
                Task<string> errors = process.StandardError.ReadToEndAsync();
                if (!process.WaitForExit((timeout * 2 + 45) * 1000)) throw new TimeoutException("本机服务仍在准备，请稍后重试；服务进程未被强制停止。");
                Task.WaitAll(output, errors);
                if (process.ExitCode != 0) throw new InvalidOperationException(String.IsNullOrWhiteSpace(errors.Result) ? "本机服务启动失败，请检查保留的服务日志。" : errors.Result.Trim());
                return output.Result.Trim();
            }
        }
    }

    internal static class ProjectInbox
    {
        private const int MaxProjectBytes = 32 * 1024 * 1024;
        private const string InboxName = "open-project-inbox";

        internal static string ValidatePath(string path)
        {
            if (String.IsNullOrWhiteSpace(path) || !String.Equals(Path.GetExtension(path), ".fuxian", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("请选择一个 .fuxian 工程文件。");
            string root = Path.GetPathRoot(path);
            if (String.IsNullOrEmpty(root) || root.Length < 3 || path.StartsWith(@"\\?\", StringComparison.Ordinal) || path.StartsWith(@"\\.\", StringComparison.Ordinal))
                throw new ArgumentException("请选择一个具有完整路径的 .fuxian 工程文件。");
            return Path.GetFullPath(path);
        }

        internal static FileStream Open(string path)
        {
            try
            {
                var file = new FileStream(ValidatePath(path), FileMode.Open, FileAccess.Read, FileShare.Read);
                if (file.Length > 0 && file.Length <= MaxProjectBytes) return file;
                file.Dispose();
                throw new InvalidDataException("工程文件为空或超过 32 MB，请在伏线中检查文件。");
            }
            catch (FileNotFoundException) { throw new FileNotFoundException("找不到所选工程，文件可能已移动。"); }
            catch (DirectoryNotFoundException) { throw new FileNotFoundException("找不到所选工程，目录可能已移动。"); }
        }

        internal static string Stage(string serviceDirectory, FileStream source)
        {
            string inbox = Path.Combine(serviceDirectory, InboxName);
            if ((File.GetAttributes(serviceDirectory) & FileAttributes.ReparsePoint) != 0) throw new IOException("本机服务目录不能是重定向目录。");
            var info = Directory.CreateDirectory(inbox);
            if ((info.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("工程临时目录不能是重定向目录。");
            Prune(inbox);
            var random = new byte[16];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(random);
            string token = BitConverter.ToString(random).Replace("-", "").ToLowerInvariant();
            string temporary = Path.Combine(inbox, token + ".tmp");
            string output = Path.Combine(inbox, token + ".fuxian");
            try
            {
                using (var pending = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    source.CopyTo(pending);
                    pending.Flush(true);
                }
                File.Move(temporary, output);
                return token;
            }
            catch { TryDelete(temporary); throw; }
        }

        private static void Prune(string inbox)
        {
            DateTime cutoff = DateTime.UtcNow.AddMinutes(-5);
            foreach (string file in Directory.EnumerateFiles(inbox))
            {
                string extension = Path.GetExtension(file), name = Path.GetFileNameWithoutExtension(file);
                if ((extension != ".fuxian" && extension != ".tmp" && extension != ".claimed") || name.Length != 32) continue;
                bool token = true;
                foreach (char c in name) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) { token = false; break; }
                if (token && File.GetLastWriteTimeUtc(file) < cutoff) TryDelete(file);
            }
        }

        private static void TryDelete(string file)
        {
            try { File.Delete(file); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    public static class ProjectFileAssociation
    {
        private const string AppName = "伏线 Fuxian";
        private const string ProgId = "Fuxian.Project";
        private const string Capabilities = @"Software\Fuxian\Capabilities";

        [DllImport("shell32.dll")]
        private static extern void SHChangeNotify(uint eventId, uint flags, IntPtr first, IntPtr second);

        // Registers a handler; Windows Settings owns the user's default choice.
        public static string Register(RegistryKey user, string executable)
        {
            if (!Path.IsPathRooted(executable) || !File.Exists(executable)) throw new FileNotFoundException("找不到当前伏线启动器。请从已解压的目录启动。");
            string command = ServiceLauncher.Quote(executable) + " \"%1\"";
            using (RegistryKey app = user.CreateSubKey(@"Software\Classes\" + ProgId))
            {
                app.SetValue("", "伏线工程文件");
                using (RegistryKey icon = app.CreateSubKey("DefaultIcon")) icon.SetValue("", ServiceLauncher.Quote(executable) + ",0");
                using (RegistryKey open = app.CreateSubKey(@"shell\open\command")) open.SetValue("", command);
            }
            using (RegistryKey extension = user.CreateSubKey(@"Software\Classes\.fuxian\OpenWithProgids"))
                extension.SetValue(ProgId, new byte[0], RegistryValueKind.None);
            using (RegistryKey appCapabilities = user.CreateSubKey(Capabilities))
            {
                appCapabilities.SetValue("ApplicationName", AppName);
                appCapabilities.SetValue("ApplicationDescription", "通过本机网页工作台打开 .fuxian 电路工程");
                using (RegistryKey files = appCapabilities.CreateSubKey("FileAssociations")) files.SetValue(".fuxian", ProgId);
            }
            using (RegistryKey registered = user.CreateSubKey(@"Software\RegisteredApplications")) registered.SetValue(AppName, Capabilities);
            return "ms-settings:defaultapps?registeredAppUser=" + Uri.EscapeDataString(AppName);
        }

        internal static void OpenSettings(string executable)
        {
            string url = Register(Registry.CurrentUser, executable);
            SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero); // SHCNE_ASSOCCHANGED
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
            catch (System.ComponentModel.Win32Exception) { Process.Start(new ProcessStartInfo("ms-settings:defaultapps") { UseShellExecute = true }); }
        }
    }

    internal sealed class LauncherForm : Form
    {
        private readonly Button launch = new Button();
        private readonly Button associate = new Button();
        private readonly Label status = new Label();
        private readonly TextBox details = new TextBox();
        private readonly ProgressBar progress = new ProgressBar();
        private readonly int port, timeout;
        private readonly string projectPath;
        private bool busy, closed;
        public LauncherForm(LauncherOptions options)
        {
            port = options.Port; timeout = options.Timeout; projectPath = options.ProjectPath;
            Text = "伏线 · 电路仿真工作台";
            AutoScaleMode = AutoScaleMode.Dpi; ClientSize = new Size(520, 392);
            FormBorderStyle = FormBorderStyle.FixedSingle; MaximizeBox = false; StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(246, 249, 245); Font = new Font("Microsoft YaHei UI", 10);
            var title = new Label { Text = "伏线 Fuxian", Font = new Font(Font.FontFamily, 23, FontStyle.Bold), ForeColor = Color.FromArgb(34, 67, 48) };
            title.SetBounds(30, 24, 460, 48); Controls.Add(title);
            var subtitle = new Label { Text = "原理图绘制  ·  SPICE 仿真  ·  画布内波形", ForeColor = Color.FromArgb(98, 114, 101) };
            subtitle.SetBounds(33, 79, 455, 26); Controls.Add(subtitle);
            launch.Text = projectPath == null ? "启动软件" : "打开工程"; launch.Font = new Font(Font.FontFamily, 15, FontStyle.Bold);
            launch.SetBounds(32, 125, 456, 60); launch.FlatStyle = FlatStyle.Flat; launch.FlatAppearance.BorderSize = 0;
            launch.BackColor = Color.FromArgb(46, 112, 76); launch.ForeColor = Color.White; launch.Cursor = Cursors.Hand;
            launch.Click += LaunchClicked; Controls.Add(launch); AcceptButton = launch;
            status.Text = "点击启动，服务准备好后自动打开浏览器。"; status.ForeColor = Color.FromArgb(78, 94, 81);
            status.SetBounds(32, 200, 456, 38); Controls.Add(status);
            progress.SetBounds(32, 241, 456, 5); progress.Style = ProgressBarStyle.Marquee; progress.MarqueeAnimationSpeed = 30; progress.Visible = false; Controls.Add(progress);
            details.SetBounds(32, 245, 456, 65); details.ReadOnly = true; details.Multiline = true; details.ScrollBars = ScrollBars.Vertical;
            details.BorderStyle = BorderStyle.None; details.BackColor = BackColor; details.ForeColor = Color.FromArgb(150, 56, 46);
            details.Font = new Font(Font.FontFamily, 8); details.Visible = false; Controls.Add(details);
            associate.Text = "关联 .fuxian 文件"; associate.SetBounds(32, 320, 162, 30); associate.Click += AssociateClicked; Controls.Add(associate);
            var footer = new Label { Text = "本机地址 localhost:" + port + "  ·  关闭此窗口不会停止软件", Font = new Font(Font.FontFamily, 8), ForeColor = Color.FromArgb(115, 126, 116) };
            footer.SetBounds(32, 364, 456, 18); Controls.Add(footer);
            if (projectPath != null) Shown += LaunchClicked;
            FormClosed += delegate { closed = true; }; // Independent service never receives a Stop request.
        }

        private void AssociateClicked(object sender, EventArgs args)
        {
            try
            {
                ProjectFileAssociation.OpenSettings(Application.ExecutablePath);
                status.ForeColor = Color.FromArgb(46, 112, 76);
                status.Text = "已注册伏线。请在 Windows 默认应用中将 .fuxian 设为伏线。";
                details.Visible = false;
            }
            catch (Exception error)
            {
                status.ForeColor = Color.FromArgb(150, 56, 46);
                status.Text = "未能打开默认应用设置，请在 Windows 设置中手动选择伏线。";
                details.Text = error.Message; details.Visible = true;
            }
        }

        private async void LaunchClicked(object sender, EventArgs args)
        {
            if (busy) return;
            busy = true; launch.Enabled = false; associate.Enabled = false; launch.Text = "正在启动…"; details.Visible = false; progress.Visible = true;
            status.Text = projectPath == null ? "正在准备本机服务，请稍候…" : "正在准备工作台，随后将在浏览器中打开工程…";
            status.ForeColor = Color.FromArgb(78, 94, 81);
            try
            {
                string helper = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "scripts", "launcher-service.ps1");
                string url = await Task.Run(() => projectPath == null ? ServiceLauncher.Start(helper, port, timeout) : ServiceLauncher.StartProject(helper, port, timeout, projectPath));
                if (closed || IsDisposed) return;
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                if (projectPath != null) { Close(); return; }
                status.Text = "软件已就绪，浏览器已打开。"; status.ForeColor = Color.FromArgb(46, 112, 76); launch.Text = "打开软件";
            }
            catch (Exception error)
            {
                if (closed || IsDisposed) return;
                status.Text = "启动未完成，请查看原因后重试。"; status.ForeColor = Color.FromArgb(150, 56, 46);
                details.Text = error.Message; details.Visible = true; launch.Text = "重试启动";
            }
            finally { if (!closed && !IsDisposed) { busy = false; launch.Enabled = true; associate.Enabled = true; progress.Visible = false; } }
        }
    }
}
