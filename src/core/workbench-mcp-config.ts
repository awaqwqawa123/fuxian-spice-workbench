import type { WorkbenchMcpInfo } from './workbench-mcp-client'

export type WorkbenchMcpClient = 'codex' | 'cursor' | 'dsh' | 'generic'
export interface WorkbenchMcpConfiguration { text: string; filename: string; mediaType: string; destination: string; instructions: string }

/** JSON quoting is also valid for these TOML basic strings; DEL must be escaped. */
const tomlString = (value: string) => JSON.stringify(value).replace(/\u007f/g, '\\u007f')

/** Export only the allowlisted transport fields, even if discovery adds more data. */
export function workbenchMcpConfiguration(info: WorkbenchMcpInfo, client: WorkbenchMcpClient): WorkbenchMcpConfiguration {
  const discovered = info.config.mcpServers.fuxian
  const server = { command: discovered.command, args: [...discovered.args] }
  if (client === 'codex') return {
    text: `[mcp_servers.fuxian]\ncommand = ${tomlString(server.command)}\nargs = [${server.args.map(tomlString).join(', ')}]\n`,
    filename: 'fuxian-codex-mcp.toml', mediaType: 'text/plain', destination: 'Codex · ~/.codex/config.toml',
    instructions: '在 Codex 的 MCP 配置中合并此段；如果已有 [mcp_servers.fuxian]，请修改该段，不要重复添加同名表。保存后按客户端提示重新加载 MCP。',
  }
  const text = JSON.stringify({ mcpServers: { fuxian: server } }, null, 2) + '\n'
  if (client === 'cursor') return { text, filename: 'fuxian-cursor-mcp.json', mediaType: 'application/json', destination: 'Cursor · ~/.cursor/mcp.json 或项目 .cursor/mcp.json', instructions: '将 fuxian 项合并到 Cursor 的 mcpServers 中，保留原来的其他服务。在 Cursor 的 MCP 设置中确认工具已加载。' }
  if (client === 'dsh') return { text, filename: 'fuxian-dsh-mcp.json', mediaType: 'application/json', destination: 'DSH / Harness · 通用 stdio 参数', instructions: '这是通用 MCP JSON 示例，不是所有 DSH 版本都能直接导入。请在支持 stdio MCP 的 DSH / Harness 配置中填写 command 和 args，并按该版本文档启用 MCP 客户端。' }
  return { text, filename: 'fuxian-mcp.json', mediaType: 'application/json', destination: '其他支持 stdio MCP 的 AI 客户端', instructions: '在客户端的 MCP 服务列表中添加 fuxian，填写下方 command 和 args。保留已有服务；只支持 HTTP 的客户端不能直接使用此 stdio 配置。' }
}
