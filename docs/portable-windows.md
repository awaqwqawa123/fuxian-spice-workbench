# Windows 解压运行与统一运行模式

普通用户从 [v0.30.0 发布页](https://github.com/awaqwqawa123/fuxian-spice-workbench/releases/tag/v0.30.0) 下载 `Fuxian-0.30.0-Windows-x64.zip`，完整解压到可写目录，双击 `Start-Fuxian.cmd`。随包提供 Node、依赖、已构建前端、ngspice WebAssembly 引擎以及公开模型；首次启动无需 npm 安装或联网编译。`Stop-Fuxian.cmd` 停止该目录对应的服务，`Status-Fuxian.cmd` 查看状态。默认端口 3032，不抢占其他进程的端口。

这是 Windows x64 的本机运行包。AI 客户端、模型网站登录和兼容 API 均为可选外部能力，需自行安装或配置；基础绘图、公开模型与仿真可独立使用。不会附带维护者的私人模型、项目或账号信息。

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

Node 运行时旁须保留 `NODE-LICENSE.txt`。依赖按 package-lock 中实际安装的包复制，保留其原始许可文件；包中包含原公开源码和公开模型对应源码、转换脚本及许可。原项目 MIT 许可不替代模型和其他组件许可。打包器不打包私人厂商库、个人项目、聊天、密钥或浏览器登录信息。使用者可按自身授权导入本地库。

`WINDOWS-PORTABLE.json` 记录软件版本、运行时哈希和依赖数；`DEPENDENCY-LICENSES.json` 提供逐包许可索引。先从干净源码快照生成运行包和 ZIP，再在独立目录解压测试。运行会创建本机状态，测试后的目录不能未经检查重新原样压缩发布。GitHub 的自动 “Source code” 压缩包仍是源码，不等同于 Windows 运行包。
