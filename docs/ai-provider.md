# AI 电路助手

v0.16 默认使用本机 Codex App Server，复用已安装 Codex 的登录与默认模型配置。打开最右侧助手会自动检查本机状态；输入任务并发送后，Codex 可读取电路、修改候选方案并调用 ngspice。可以留空模型覆盖项以使用本机默认模型，也可显式填写模型 ID。状态检查仅表示本机配置就绪，实际推理和工具调用以任务结果为准。

该入口是独立的电路会话，不共享 Codex 桌面当前聊天记录。浏览器不读取 Codex 密钥；后端由 Codex 自身处理登录。状态与任务分别通过同源 `POST /api/codex/status`、`POST /api/codex/run` 提供。仅部署静态文件无法运行本机助手。尚未安装或登录时，先在本机完成 Codex 安装/登录，再点击「刷新 Codex 状态」。

需要原有模型 API 时，在高级选项的「AI 运行方式」切换 DSH/API；下面保留其配置说明。原生 Codex 与「Codex / Responses」服务模板是两个不同入口，后者仍需 API 配置。

v0.15 中，AI 位于最右侧独立可调宽侧栏，可与器件编辑同时使用。顶栏开关或收起按钮保留会话和正在进行的任务；明确关闭、切换工程或刷新会清除内存中的密钥与会话。

DSH/API 模式中的「Agent 执行」由官方 DeepSeek Harness `0.1.5-rc.2` 驱动，可读取电路、修改候选方案、检查连接并调用真实 ngspice，最多 18 次工具调用、3 次仿真。应用候选需要点击确认，整个修改可撤销。「解释 / 检查」和「生成修改方案」继续使用普通推理接口。下文的非流式请求格式与 60 秒限制适用于这两个普通模式；DSH Agent 使用独立 `/api/agent/run` 路由、约 120 秒任务期限与工具循环。

Agent 桥接为通用 Chat 接口显式设置兼容选项，避免 SDK 因本机代理地址误判服务能力、附加不支持的可选字段。接受标准 SSE，也可以将同协议的完整 JSON 响应转换成 SDK 所需的事件流，不因此重试模型请求。缺失完成状态、错误或不完整的工具数据不会当作成功。服务仍需实际支持工具调用；普通「测试模型推理」通过不能证明 Agent 可用。

失败记录显示协议、模型、HTTP 状态或 SDK 错误码及脱敏后的具体原因，并提供返回配置入口。截图中的旧版统一错误不能确定用户接口的具体失败原因；兼容修复使用本机模型夹具验证，未使用用户 API 密钥或付费服务。

在工作台打开 AI 助手，先选择服务商卡片，再填写密钥和模型 ID。提供 OpenAI、Codex / Responses、DeepSeek、OpenRouter、本机 Ollama、自定义兼容服务。模板只设置接口地址，不猜测用户账户有权使用的模型，也不自动联网。

| 模板 | API 基础地址 | 模型列表 | 推理 |
| --- | --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `/v1/models` | `/v1/chat/completions` |
| Codex / Responses | `https://api.openai.com/v1`（可改为自有服务） | `/v1/models` | `/v1/responses` |
| DeepSeek | `https://api.deepseek.com` | `/models` | `/chat/completions` |
| OpenRouter | `https://openrouter.ai/api/v1` | `/api/v1/models` | `/api/v1/chat/completions` |
| Ollama 本机 | `http://localhost:11434/v1` | `/v1/models` | `/v1/chat/completions` |

地址接受 base URL、完整 `/chat/completions` 或 `/responses` URL；界面可展开查看实际 GET/POST 地址。不会盲目添加 `/v1`，例如 DeepSeek 的官方示例直接使用根地址。`/messages`、`/models` 不是本工作台的基础地址，填写时会提示修正。

1. **获取模型列表**：仅向 `/models` 发 GET，返回模型 ID 供选择。列表中可能有嵌入或其他非聊天模型；列表成功只证明列表访问正常。
2. **手填模型 ID**：任何服务均可手填，不依赖列表成功。部分服务没有标准 `/models`，但仍能处理聊天请求。
3. **测试模型推理**：用户点击后，向所选模型发送固定短提示 `Reply with exactly OK.`。测试不含当前电路、用户问题、历史回复，但会产生一次真实推理，可能按服务商规则计费。收到可显示文本才标记推理成功，展示耗时；不把这视为电路分析能力验证。

列表获取和推理测试均可取消，进行中锁定配置以免旧请求结果混入新配置。改变地址、模型或密钥会清除上次检查状态。切换模板清空旧密钥和模型，避免将原服务商的密钥发送给新服务商。本机 Ollama 需先运行服务并安装模型；无鉴权的本机服务可留空密钥。

点击发送才会把当前项目 JSON 和问题发送给所填模型服务。密钥只保存在组件内存中，可显示/隐藏，关闭面板或刷新后需要重填。地址、模板、协议和模型 ID 会保存在当前浏览器 origin 的 localStorage，便于下次使用；密钥不保存。包含用户名、密码、查询参数或锚点的 URL 不允许使用，也不写入存储。

- **解释 / 检查**：回答关于当前电路的提问，检查连接和参数。最近 6 轮文本对话只保留在组件内存；可继续追问或点击“新对话”清除。改变服务地址、密钥、协议或模型时开启新对话，避免把旧服务的上下文带给新服务。页面显示最近 6 轮完整文本回复；发往服务的历史独立限制为每条最多 12,000 字符、合计最多 48,000 字符，超过总量后按完整轮次移除最早记录，不截断页面上已显示的回复。每次都附上当前项目，旧项目不作为事实来源。
- **生成修改方案**：模型返回完整项目，工作台校验引用、编号、模型和坐标结构，显示变更清单及仿真检查信息。点击“应用方案”才修改工程，父工作台负责记为一次可撤销操作。
- 项目在请求后有任何编辑（含位置、名称）时，旧方案不可应用；重新生成即可。
- 这两个普通推理模式不会执行工具；「Agent 执行」可调用已注册的电路工具及 ngspice，不开放任意脚本或命令。结构有效不代表电路物理上正确，应用后应运行 ngspice 验证。未完成的原理图可以作为草稿应用，仿真检查仍会提示待修复项。

## 运行

使用本项目的 `npm run dev` 或 `npm run preview`。Vite 插件在两种模式下都注册同源 `/api/ai`、`/api/ai/models`、`/api/ai/test` 网关，浏览器不直接跨域调用模型供应商。只托管 `dist/` 静态文件不会带上该网关，需要另行部署等效后端。

当前网关面向本机个人工作台，仅接受本机连接、localhost / 127.0.0.1 / ::1 Host 以及完全相同 Origin 的 POST JSON 请求。对外多人部署时需要单独实现账号、访问控制和服务端凭据管理，不能把开发预览服务器作为公共 AI 网关。

两种可切换协议：

- **Chat Completions**：`POST /chat/completions`，发送 `model`、`messages`、`stream:false`。
- **Responses**：`POST /responses`，发送 `model`、`input`（系统消息、历史对话、本次问题与当前项目）、`stream:false`、`store:false`。只提取 assistant message 的 `output_text`；不执行工具调用，不显示 reasoning；未完成、失败或只有工具调用的响应不视为成功。

密钥通过 Bearer Authorization 转发，不放入模型上下文。为兼容不同供应商，不强制 temperature 或 JSON response_format。Codex / Responses 卡片连接具有 Responses API 的模型服务，需要该服务的地址、API 密钥和准确模型 ID；它不是 Codex CLI / 桌面应用登录集成。不会猜测用户账户可用的 Codex 模型名称。原生 Claude Messages 等其他协议暂不支持。

助手支持嵌入侧栏，`AiAssistant` 的 `embedded` 属性只改变布局，仍通过父工作台的 `onApply` 记录可撤销的方案应用。

请求上限 192 KiB，推理响应上限 1 MiB，模型目录响应上限 4 MiB（目录包含较多额外元数据，网关仅保留最多 1000 个模型 ID/名称），等待约 60 秒，可主动取消。网关拒绝重定向，不回传上游原始错误或请求密钥，不保存请求日志。API 地址支持远程 HTTP 与 HTTPS，HTTP 在配置处给出非阻断提示；浏览器经本机网关访问，不因浏览器跨域或混合内容策略而直接拦截用户有效 HTTP 服务。所有三个路由使用同样的来源、方法、类型、超时检查。

## 验证

`tests/ai.test.ts` 与 `tests/ai-provider.test.ts` 共 18 项通过，使用真实本地 HTTP 模拟服务，验证消息体、鉴权转发、密钥脱敏、来源限制、错误、重定向、超时、大小上限、方案结构校验、模型列表失败后仍可手填调用、无密钥本机模型和“测试不发送工程”、Responses 的请求/完整响应/错误响应、远程 HTTP 的注入 fetch 模拟、多轮上下文和只允许 user/assistant 历史角色。JSDOM 验证明确点击才联网、模型选择、密钥显示/隐藏、模板切换清除密钥、配置变化令成功状态失效、原方案审阅/应用/撤销入口保持。生产构建通过。未向外部付费 API 发送测试请求，未验证用户未提供的模型账号或实际回答质量。

## 互联网研究记录

2026-09-19 至 2026-09-20 实际联网阅读，结论用于本次界面和网关实现：

| 来源 | 已核对内容与采用方式 |
| --- | --- |
| [DeepSeek 官方首次调用](https://api-docs.deepseek.com/) | OpenAI 兼容基础地址 `https://api.deepseek.com`；Chat Completions 示例使用 Bearer、model、messages、stream。采用根地址模板，避免套用其他厂商的 `/v1`。 |
| [DeepSeek 官方模型列表](https://api-docs.deepseek.com/api/list-models/) | `GET /models` 返回 `data[].id`。采用标准列表结构，模型名从列表获取或手填。 |
| [Ollama 官方兼容文档](https://docs.ollama.com/api/openai-compatibility) | 本机基础地址 `http://localhost:11434/v1/`；支持 `/v1/chat/completions` 和 `/v1/models`；SDK 示例中的本机 key 被忽略。采用本机模板并允许无密钥。 |
| [OpenRouter 官方 API 总览](https://openrouter.ai/docs/api/reference/overview) 与 [模型列表](https://openrouter.ai/docs/api/api-reference/models/get-models) | 完整端点分别为 `/api/v1/chat/completions`、`/api/v1/models`；模型 ID 包含供应商前缀；目录含较多非必要属性。采用独立地址模板、保留原 ID、只读取 ID/名称。 |
| [Open WebUI 官方兼容服务配置](https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-openai-compatible/) | “Verify Connection” 请求 `/models`，某些供应商列表失败而聊天仍能工作，允许手动模型 ID。采用列表/推理分别检查，明确区分成功含义并保留手填。 |
| [Open WebUI Connections.svelte](https://github.com/open-webui/open-webui/blob/main/src/lib/components/admin/Settings/Connections.svelte) 与 [OpenAIConnection.svelte](https://github.com/open-webui/open-webui/blob/main/src/lib/components/admin/Settings/Connections/OpenAIConnection.svelte) | 通过 GitHub Contents API 成功取得真实源文件，核对 URL、key、connection config 分离及模型刷新流程。借鉴配置组织，没有复制源码。 |
| [Cherry Studio 模型服务文档](https://docs.cherryai.com.cn/pre-basic/providers) | 模板选择 → 密钥/地址 → 获取模型列表 → 用对话模型检测；同时区分 OpenAI 兼容与其他原生协议。采用相同的清晰配置顺序，本版不声称直接支持原生 Claude 协议。 |

v0.8 时 OpenAI Docs 按官方文档优先流程完成官方域名搜索尝试，并实际请求 [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Models](https://developers.openai.com/api/reference/resources/models/methods/list)、[Authentication](https://platform.openai.com/docs/api-reference/authentication) 及 platform 的模型列表页面，均收到 HTTP 403。未将未打开的搜索结果当作依据，也未声称核实新模型、价格或新增可选字段；保留已有 OpenAI 基础 Chat Completions 配置，不强制 temperature、响应格式或特定版本专属参数。


### v0.10 Responses 官方文档核对（2026-09-20）

本轮先搜索 `site:developers.openai.com Responses API input output_text`，再实际获取 [OpenAI Docs / Create a response](https://developers.openai.com/api/reference/resources/responses/methods/create)，HTTP **200**。核对 `input` 支持 user/assistant 文本消息，`store` 省略时默认为 true，`output` 中 message 的内容类型为 `output_text`，以及 `incomplete_details` 与未完成状态。实现显式 `store:false` 并拒绝未完成方案。platform.openai.com 对应页面仍返回 403，不影响这次已成功读取的 developers.openai.com 来源。没有测试真实付费服务、订阅登录或猜测新模型 ID。
