# MCP 配置连接界面

用户要求将 AI 连接改为提供 MCP 配置，并允许切换 Codex 安装路径。

默认 AI 连接入口集中到设置的一个导航项。连接方式来自共享偏好
`connectionMode`，默认 `mcp`；旧桌面共享和直接 CLI 功能保留为显式
`native` 高级模式。切回 MCP 时取消正在进行的连接检查；已有 API
输入、模型偏好及会话数据不清除。

MCP 配置来自本机真实 `mcp-info` 发现结果，始终使用已提供的 stdio
桥与绝对 Node 路径。Codex 导出 TOML；Cursor 与通用客户端导出
`mcpServers` JSON；DSH 显示通用 stdio 示例及版本支持限制，避免
冒充已验证的专有配置。导出只允许 command 与 args，不能混入凭据。
页面不改写 AI 配置，不把工作台“接口就绪”描述为外部客户端已连接。

Codex 安装路径组件由独立分支实现，在连接页共同显示。Codex CLI
路径用于本机程序定位，MCP command 是工作台 Node 桥，两者不混淆。

MCP 模式不读取 Codex/Cursor 运行状态或桌面共享状态，不创建 AI
会话，不访问桌面文件夹设置。工作区页面才按需读取会话文件夹；读取
成功后切换设置分类不覆盖未保存的文件夹输入。

验收包括导出路径转义、字段白名单、复制及下载、失败刷新清理配置、
默认模式不请求原生连接、模式切换与旧高级连接回归。实际外部 AI
登录及推理不由这些协议/界面测试代替。

已完成 18 项定向测试（MCP 导出和设置、原生桌面连接、Cursor / DSH
一键连接及 Codex 路径设置），并通过 TypeScript 构建检查。模式切换
回归覆盖未保存 API 密钥保留、工作区文件夹草稿保留和按需读取。

参考：Codex 官方 MCP 页面 `https://developers.openai.com/codex/mcp`
与 Cursor 官方 `https://cursor.com/docs/context/mcp`。2026-11-06 此
环境访问 OpenAI 文档返回 HTTP 403，Cursor 页面可读取 JSON 示例；
Codex TOML 使用现有官方 MCP 配置约定，并以本地导出回归检查路径。
