using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace FuxianLauncher
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            try
            {
                int port = 3032, timeout = 45;
                for (int i = 0; i < args.Length; i++)
                {
                    string option = args[i].ToLowerInvariant();
                    int value;
                    if (++i >= args.Length || !Int32.TryParse(args[i], out value)) throw new ArgumentException("启动参数需要整数值。");
                    if (option == "-port" || option == "--port") { if (value < 1024 || value > 65535) throw new ArgumentException("端口应为 1024 至 65535。"); port = value; }
                    else if (option == "-timeoutseconds") { if (value < 2 || value > 120) throw new ArgumentException("等待时间应为 2 至 120 秒。"); timeout = value; }
                    else throw new ArgumentException("无法识别启动参数：" + option);
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new LauncherForm(port, timeout));
            }
            catch (Exception error) { MessageBox.Show(error.Message, "伏线启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error); }
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
        private static string Quote(string value)
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
                return ReadReadyUrl(output.Result.Trim(), port);
            }
        }
    }

    internal sealed class LauncherForm : Form
    {
        private readonly Button launch = new Button();
        private readonly Label status = new Label();
        private readonly TextBox details = new TextBox();
        private readonly ProgressBar progress = new ProgressBar();
        private readonly int port, timeout;
        private bool busy, closed;
        public LauncherForm(int port, int timeout)
        {
            this.port = port; this.timeout = timeout;
            Text = "伏线 · 电路仿真工作台";
            AutoScaleMode = AutoScaleMode.Dpi; ClientSize = new Size(520, 350);
            FormBorderStyle = FormBorderStyle.FixedSingle; MaximizeBox = false; StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(246, 249, 245); Font = new Font("Microsoft YaHei UI", 10);
            var title = new Label { Text = "伏线 Fuxian", Font = new Font(Font.FontFamily, 23, FontStyle.Bold), ForeColor = Color.FromArgb(34, 67, 48) };
            title.SetBounds(30, 24, 460, 48); Controls.Add(title);
            var subtitle = new Label { Text = "原理图绘制  ·  SPICE 仿真  ·  画布内波形", ForeColor = Color.FromArgb(98, 114, 101) };
            subtitle.SetBounds(33, 79, 455, 26); Controls.Add(subtitle);
            launch.Text = "启动软件"; launch.Font = new Font(Font.FontFamily, 15, FontStyle.Bold);
            launch.SetBounds(32, 125, 456, 60); launch.FlatStyle = FlatStyle.Flat; launch.FlatAppearance.BorderSize = 0;
            launch.BackColor = Color.FromArgb(46, 112, 76); launch.ForeColor = Color.White; launch.Cursor = Cursors.Hand;
            launch.Click += LaunchClicked; Controls.Add(launch); AcceptButton = launch;
            status.Text = "点击启动，服务准备好后自动打开浏览器。"; status.ForeColor = Color.FromArgb(78, 94, 81);
            status.SetBounds(32, 200, 456, 38); Controls.Add(status);
            progress.SetBounds(32, 241, 456, 5); progress.Style = ProgressBarStyle.Marquee; progress.MarqueeAnimationSpeed = 30; progress.Visible = false; Controls.Add(progress);
            details.SetBounds(32, 245, 456, 65); details.ReadOnly = true; details.Multiline = true; details.ScrollBars = ScrollBars.Vertical;
            details.BorderStyle = BorderStyle.None; details.BackColor = BackColor; details.ForeColor = Color.FromArgb(150, 56, 46);
            details.Font = new Font(Font.FontFamily, 8); details.Visible = false; Controls.Add(details);
            var footer = new Label { Text = "本机地址 localhost:" + port + "  ·  关闭此窗口不会停止软件", Font = new Font(Font.FontFamily, 8), ForeColor = Color.FromArgb(115, 126, 116) };
            footer.SetBounds(32, 321, 456, 18); Controls.Add(footer);
            FormClosed += delegate { closed = true; }; // Independent service never receives a Stop request.
        }

        private async void LaunchClicked(object sender, EventArgs args)
        {
            if (busy) return;
            busy = true; launch.Enabled = false; launch.Text = "正在启动…"; details.Visible = false; progress.Visible = true;
            status.Text = "正在准备本机服务，请稍候…"; status.ForeColor = Color.FromArgb(78, 94, 81);
            try
            {
                string helper = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "scripts", "launcher-service.ps1");
                string url = await Task.Run(() => ServiceLauncher.Start(helper, port, timeout));
                if (closed || IsDisposed) return;
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                status.Text = "软件已就绪，浏览器已打开。"; status.ForeColor = Color.FromArgb(46, 112, 76); launch.Text = "打开软件";
            }
            catch (Exception error)
            {
                if (closed || IsDisposed) return;
                status.Text = "启动未完成，请查看原因后重试。"; status.ForeColor = Color.FromArgb(150, 56, 46);
                details.Text = error.Message; details.Visible = true; launch.Text = "重试启动";
            }
            finally { if (!closed && !IsDisposed) { busy = false; launch.Enabled = true; progress.Visible = false; } }
        }
    }
}
