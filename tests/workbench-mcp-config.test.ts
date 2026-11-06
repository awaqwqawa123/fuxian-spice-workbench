import assert from 'node:assert/strict'
import test from 'node:test'
import { workbenchMcpConfiguration } from '../src/core/workbench-mcp-config'
import type { WorkbenchMcpInfo } from '../src/core/workbench-mcp-client'

const info:WorkbenchMcpInfo={ready:true,protocol:'MCP',transport:'stdio',applicationMode:'review',message:'ready',toolCount:23,capabilities:[],config:{mcpServers:{fuxian:{command:'C:\\Program Files\\伏线\\node.exe',args:['E:\\my "quoted" folder\\bridge.mjs','--connection','E:\\工作台\\connection.json']}}}}

test('Codex export quotes actual Windows paths and preserves every stdio argument as TOML strings',()=>{
  const config=workbenchMcpConfiguration(info,'codex')
  assert.equal(config.filename,'fuxian-codex-mcp.toml')
  assert.match(config.text,/^\[mcp_servers\.fuxian\]\n/)
  assert.ok(config.text.includes(`command = ${JSON.stringify(info.config.mcpServers.fuxian.command)}\n`))
  const argsLine=config.text.split('\n').find(line=>line.startsWith('args = '))!
  assert.deepEqual(JSON.parse(argsLine.slice(7)),info.config.mcpServers.fuxian.args)
  assert.match(config.instructions,/不要重复添加同名表/)
})

test('JSON client exports only command/args and do not leak extra discovery properties',()=>{
  const extended=structuredClone(info)
  Object.assign(extended.config.mcpServers.fuxian,{token:'must-not-export',env:{SECRET:'must-not-export'}})
  for(const client of ['cursor','dsh','generic'] as const){
    const config=workbenchMcpConfiguration(extended,client)
    assert.deepEqual(JSON.parse(config.text),info.config)
    assert.equal(config.mediaType,'application/json')
    assert.doesNotMatch(config.text,/must-not-export|token|SECRET/)
  }
  assert.match(workbenchMcpConfiguration(info,'dsh').instructions,/通用 MCP JSON 示例.*不是所有 DSH 版本/)
})
