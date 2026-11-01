# Windows 解压运行与统一运行模式

普通用户下载 GitHub Release 中的 Windows x64 运行包，完整解压到可写目录，双击根目录的 **`Fuxian.exe`** 或 **`启动伏线.cmd`**，然后点击启动窗口里的 **“启动软件”** 按钮。英文入口 `Launch-Fuxian.cmd` 打开同一个窗口。窗口提供服务状态、打开网页及停止服务操作；启动后由默认浏览器打开工作台，服务在后台运行，没有常驻终端。默认端口 3032，不抢占其他进程的端口。

请先完整解压整个目录，不要从压缩软件中单独运行入口。入口会检查运行时、前端、启动脚本和主要依赖，缺少文件时提示重新解压。随包提供 Node、依赖、已构建前端、ngspice WebAssembly 引擎以及公开模型；首次启动无需 npm 安装或联网编译。关闭启动窗口会保留正在运行的后台服务，需要停止时使用窗口中的停止操作。

原有命令入口继续保留：`Start-Fuxian.cmd` 直接启动服务并打开网页，`Stop-Fuxian.cmd` 停止该目录对应的服务，`Status-Fuxian.cmd` 查看状态。新的中文和英文入口直接打开随包提供的 `Fuxian.exe` 原生 Windows 图形界面。运行包在发布时已编译好启动程序，用户首次启动无需安装开发工具或现场编译；后台服务操作使用系统自带 Windows PowerShell 5.1。

源码开发与软件运行共用相同 API、项目格式、模型处理和求解器：

- `npm start`：读取 `dist/`，不监视源文件、不做浏览器请求时的源码转换。首次开发先运行 `npm ci`、`npm run build`。
- `npm run start:debug`：显式使用源码开发服务；关闭 HMR，避免验证过程中覆盖编辑输入。保存源码后手动刷新。
- `npm run build`：重新构建生产前端。开发模式不会改变仿真步长或精度。

构建资源使用带内容哈希的文件名和长期缓存；HTML 必须重新验证，API 不缓存。升级后入口引用新文件名，避免继续加载旧前端。

## 可复现打包

从已审查的公开源码快照打包，不直接复制开发电脑整个目录。快照根目录需有 `PUBLIC-SNAPSHOT.json`、`LICENSE`，且不含私人模型目录或账号状态。先构建，再运行：

```powershell
node scripts/package-windows.mjs --output 'D:/Releases/Fuxian-0.30.0-Windows-x64' --node 'D:/NodeRuntime/node.exe' --modules 'D:/Dependencies/node_modules'
```

打包必须在 Windows 上进行；打包器调用系统 Windows PowerShell 执行 `scripts/build-launcher.ps1`，从随包保留的 `scripts/launcher.cs` 编译输出根目录 `Fuxian.exe`。Node 运行时旁须保留 `NODE-LICENSE.txt`。依赖按 package-lock 中实际安装的包复制，保留其原始许可文件；包中包含原公开源码和公开模型对应源码、转换脚本及许可。原项目 MIT 许可不替代模型和其他组件许可。打包器不打包私人厂商库、个人项目、聊天、密钥或浏览器登录信息。使用者可按自身授权导入本地库。

`WINDOWS-PORTABLE.json` 记录软件版本、运行时哈希、依赖数、默认启动入口 `启动伏线.cmd` 和图形启动程序 `Fuxian.exe`；`DEPENDENCY-LICENSES.json` 提供逐包许可索引。打包前会确认公开源码快照包含 `scripts/launcher.cs`、`scripts/build-launcher.ps1`、`scripts/launcher-service.ps1` 及后台服务所需脚本，这些源码也随运行包保留。完整目录可启动后才压缩和上传；GitHub 的自动 “Source code” 压缩包仍是源码，不等同于 Windows 运行包。
