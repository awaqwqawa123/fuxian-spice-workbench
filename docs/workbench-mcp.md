# 通过 MCP 使用伏安软件

伏安软件提供一个标准 **stdio MCP** 入口，让支持这一传输方式的 AI 助手共用电路工具内核。网页助手和外部助手使用相同的候选方案、校验和仿真操作。MCP 服务不会启动新的 AI 对话，不要求助手使用 Codex。

## 连接

1. 启动伏安软件，在网页中创建或打开项目。
2. 在设置中的 MCP 接入区域复制配置；也可以运行下面的命令导出配置。
3. 将配置添加到你的助手的 MCP 服务设置中。不同客户端的配置文件位置和格式可能不同，按其文档填写 `command` 和 `args`。

```console
node scripts/workbench-mcp.mjs --print-config
```

导出的内容类似下面的示例。程序会使用实际的 Node 可执行文件和绝对路径，不包含本地凭据。

```json
{
  "mcpServers": {
    "fuxian": {
      "command": "C:/path/to/node.exe",
      "args": [
        "E:/path/to/spice-workbench/scripts/workbench-mcp.mjs",
        "--connection",
        "E:/path/to/spice-workbench/.desktop-circuit/connection.json"
      ]
    }
  }
}
```

默认连接文件相对于脚本的位置为 `../.desktop-circuit/connection.json`，与启动时的工作目录无关。需要指定其他安装位置时，使用 `--connection` 加连接文件的绝对路径。

```console
node scripts/workbench-mcp.mjs --print-config --connection "E:/my-workbench/.desktop-circuit/connection.json"
```

连接文件由本地工作台服务生成，包含版本、显式数字回环地址和凭据。入口只向 `http://127.0.0.1:端口` 或 `http://[::1]:端口` 发送凭据。每次请求重新读取文件，因此正常服务重启和凭据轮换不要求重新导出配置。软件不会改写外部助手的配置文件，也不会在连接失败时自动启动服务或窗口。

这里支持的是 stdio MCP 客户端。只支持远程 HTTP、专有工具协议或没有 MCP 支持的 harness，需要自己的适配方式，不能直接使用这份 stdio 配置。

本地后端也提供 `POST /api/desktop-circuit/mcp` JSON-RPC 入口，供自行编写的本地 HTTP 适配器使用，需读取连接文件并通过 `Authorization: Bearer …` 认证。它不是公开远程服务，默认配置仍使用 stdio 入口，不需要在客户端配置中复制凭据。

## 操作流程

| 工具 | 用途 |
| --- | --- |
| `get_workbench_status` | 读取应用/协议版本、能力、任务限制、同步工程摘要和任务状态数量；不返回图纸、模型正文或凭据 |
| `list_projects` | 获取可用项目，明确选择目标项目 |
| `get_circuit_graph` | 按元件、网络或电气端口分页读取保存工程或指定任务候选；不返回整张图纸和模型正文 |
| `inspect_project` | 读取最新电路、项目修订号和工具说明 |
| `start_circuit_task` | 使用实际项目 ID、最新修订号、请求文字和请求 ID 建立电路任务 |
| 电路工具，如 `validate_circuit`、`simulate_circuit` | 在工具参数中传入 `taskId`，读取或操作同一任务的候选电路 |
| `get_circuit_task` | 读取当前任务状态和结果，用于轮询、连接中断后的核对 |
| `finish_circuit_task` | 完成任务并提交说明，供网页审阅方案 |
| `cancel_circuit_task` | 取消指定任务，运行中的请求可同时收到取消操作 |

工具的实际参数以 MCP 的 `tools/list` 返回的 JSON Schema 为准。先调用 `inspect_project`，然后使用返回的修订号创建任务；不要猜项目 ID、修订号或电气引脚顺序。重复提交创建任务应复用同一请求 ID，避免创建多个候选任务。

电路修改会保留为**候选方案**，用户在网页中查看预览并应用，之后可以撤销。外部助手不直接覆盖正在编辑的画布。当用户在任务期间继续编辑时，共用内核会检查项目修订和方案冲突，按网页提供的合并或恢复流程处理。

本入口复用当前内核已经提供的电路、模型查询和仿真工具。它不会凭接口标准新增模拟器对某一种原厂模型的支持，也不会让未知引脚或不兼容语法自动变正确。仿真结果和任务失败均由同一个工具内核返回。

### 按需读取电气连接

从 v0.29.6 起，`get_circuit_graph` 复用生成网表的 `compileDrawing` 连接规则。`section` 可选 `components`（默认）、`nets` 或 `terminals`，每页默认 50 项、最多 100 项。`deviceIds` 和 `netIds` 分别最多 32 个精确编号；同时指定时取交集。未知编号会报错，不会悄悄返回空图。网络页只返回统计；读取某个网络上的端口应使用 `terminals` 和 `netIds`。

例如先读取电阻，再读取它所在网络的全部端口：

```json
{"name":"get_circuit_graph","arguments":{"projectId":"实际工程ID","deviceIds":["R1"]}}
```

```json
{"name":"get_circuit_graph","arguments":{"projectId":"实际工程ID","section":"terminals","netIds":["上次返回的netId"],"expectedGraphKey":"上次返回的graphKey"}}
```

结果包含工程 `revision`、最近同步时间 `synchronizedAt`、数据来源 `source`、指纹 `graphKey` 和 `graph`。分页通过 `graph.nextOffset` 继续读取，最后一页为 `null`；后续请求携带 `expectedGraphKey`，图变化后返回 409，需重新读取第一页。节点编号仅在对应工程指纹内有效；不同候选或修订不能凭同名自动对应。状态与连接图接口的输出 Schema 同时描述成功结果和 `{error,status}` 错误结果，标准客户端校验后仍可读取错误原因。

省略 `taskId` 时只读取最近同步保存快照，未同步的画布编辑不可见。传入 `taskId` 时读取该任务的实际候选，并返回任务的 `baselineRevision` 和 `taskStatus`；不会把候选与新画布自动合并。跨工程任务拒绝访问；取消、中断或候选缺失时明确失败，不会退回保存工程。查询不消耗任务工具预算、不新增任务事件。

`pinIndex` 是从 0 开始的图纸电气端口序号。X 子电路的 `pinOrdering: "subcircuit-ports"` 使用保存的 `.subckt` 端口顺序；其他元件为 `drawing-terminals`。物理封装编号另列 `physicalPinNumber`，显示专用脚另列 `physicalOnlyPins`，不能当作电气连接。合成器件可能展开为多个仿真元件，MOS 可能增加内部体端，不能把图纸端序直接当作所有 SPICE 行的位置。

自由图纸的未接线草稿仍可查询，并保留最多 50 条连接或模型端序问题及实际总数；解析无效或旧模板无自由图纸时返回 422。连接图可读不等于参数、模型或仿真已通过，运行前仍使用 `validate_circuit` 与 `simulate_circuit`。

## 状态与重试

### 原子编辑与差异读取

从 v0.29.7 起，`edit_candidate` 一次执行 1–32 个操作，传入 `taskId`、`expectedCandidateRevision`、稳定 `operationId` 和 `operations`。先从 `get_circuit_task` / `inspect_circuit` 获取实际候选修订，不要将画布修订当作候选修订。示例：

```json
{"name":"edit_candidate","arguments":{"taskId":"实际任务ID","expectedCandidateRevision":1,"operationId":"adjust-r1-001","operations":[{"op":"set_value","deviceId":"R1","value":"2k"}]}}
```

所有操作及最终电路校验一起成功后才发布；存储失败回滚。重试使用同 ID 和同参数，包括原先的修订号；它返回原历史结果而不会再执行。已有 ID 携带不同参数或新操作使用旧修订时返回 409。历史回执可在任务完成或重启中断后核对，新编辑必须在运行中的任务执行。回执最多 128 条，达到限制明确拒绝新事务。

`op` 包含 `set_value`、`add_component`、`remove_component`、`connect`、`disconnect`、`move_component`、`set_probes`、`set_net_label`、`remove_net_label`、`set_reference_source` 和 `set_output`。字段结构以发现接口为准。引用必须明确存在，删除元件不会隐式清除导线或探针；可以在同一事务中显式修复关联引用。

`diff_candidate` 传入 `taskId`，可携带 `expectedCandidateRevision`。它比较候选与基线、最近同步画布，返回变化分类、路径、冲突和电气等价状态。查询不应用修改、不消耗任务预算。`electricalEquivalent: null` 表示连接或端序证据不足；即使为 true 也不表示设计指标通过。完成的候选仍须在网页审阅和应用。

原命令行可使用 `edit --task ID --revision N --operation-id ID --input-file OPERATIONS_JSON_PATH`（文件正文是操作数组），以及 `diff --task ID [--revision N]`。

### 连接诊断

在安装目录运行 `npm run mcp:doctor`，或直接调用：

```console
node scripts/workbench-mcp.mjs --doctor
node scripts/workbench-mcp.mjs --doctor --json
```

诊断使用真实连接完成 MCP 初始化、工具发现和只读工程列表检查，总等待上限为 10 秒。它不启动服务、不修改工程，也不改写助手配置；输出不包含工程名称、工程正文或连接凭据。需要检查另一安装位置时，可同时传入 `--connection` 和绝对路径。

| 退出码 | JSON status | 含义 |
| --- | --- | --- |
| 0 | `ready` | 接口响应正常，至少一个工程已同步 |
| 2 | `connection_missing` | 连接文件不存在，先启动工作台 |
| 3 | `connection_invalid` | 连接文件无效或无法读取 |
| 4 | `service_unavailable` | 本地服务不可达或超过诊断期限 |
| 5 | `auth_failed` | 凭据被服务拒绝 |
| 6 | `protocol_failed` | 协议响应或必需的只读工具不符合约定 |
| 7 | `project_sync_required` | 接口可用，但尚无同步工程；打开并保存工程后重试 |

`ready` 表示服务及工程发现可用，不表示某个 AI 客户端已经连接，也不证明电气设计通过验收。`get_workbench_status` 另提供版本化结构和最近保存修订：`schemaVersion: 1`、本地 stdio 传输、候选审阅模式、能力、执行限制、工程摘要及任务状态计数。运行中与重启中断的任务分别统计；中断任务需从当前工程显式重新开始，不能当作已经恢复执行。

### 重试规则

正常运行时，标准输出只包含逐行 JSON-RPC 响应；启动错误和无法送达的通知写入标准错误。MCP 初始化通知没有响应。调用可以并发执行，因此长时间仿真不会挡住取消请求。

- 服务不可用：先启动工作台并确认连接文件已经生成，再让客户端重新连接。
- 凭据轮换：明确收到 HTTP 403 后，入口只在连接文件发生变化时重试一次。
- 网络中断或超时：入口不会自动重发可能已执行的电路操作。先调用 `get_circuit_task` 核对结果，再决定是否继续。
- 仿真或工具失败：查看工具返回的错误及任务状态，修正候选方案后重试。协议错误与电路工具执行失败分别返回。

单条输入消息最多 2 MiB，响应最多 16 MiB，每个请求等待上限为 120 秒。超出输入长度或格式错误会返回 JSON-RPC 错误，随后仍可处理其他消息。客户端关闭输入后，入口等待已提交请求完成，等待时间受上述请求超时约束。

原有 `scripts/desktop-circuit.mjs` 命令行接口继续可用。MCP 是面向兼容助手的接入方式，命令行则适合脚本和手动调用。

## 接入回归

`npm run test:mcp` 先构建真实仿真 worker，再运行 MCP HTTP、原始 stdio、标准 SDK 客户端、诊断命令、设置界面和电气语义图回归。SDK 使用锁定的开发依赖；测试在独立临时工程中运行，不复用用户存储或账号。

标准 SDK 的十个种子场景覆盖发现、修订读取、通用三 LED 工作点、PWM 瞬态、修改后仿真/审阅、结果过期、布局限制/取消、版本冲突、请求幂等及服务重启。LED 夹具是通用模型和串联限流电阻，用于核对真实电气数据交接；不代表 LR432 恒流设计或实物验证。真实桌面 AI 客户端的兼容验收单独记录，不能用测试客户端通过替代。

新增第 11 个 SDK 场景通过真实 stdio → HTTP → 共享内核读取图分页，逐元件比较生成网表，依据图查询修改候选后运行 ngspice 并提交审阅，同时核对原工程未改变。

第 12 个 SDK 场景验证工具发现后的错误回复：缺失工程、未知元件、旧版本分页，以及请求到达正在关闭的管理器时的状态错误，均保持可读取的结构化诊断。
