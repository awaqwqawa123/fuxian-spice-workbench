import assert from 'node:assert/strict'
import test from 'node:test'
import { ASSISTANT_SETTINGS_KEY, readAssistantSettings, persistAssistantSettings } from '../src/core/assistant-settings'

test('MCP is the default and connection selection persists without exporting account credentials',()=>{
  const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value)}}
  const settings=readAssistantSettings(storage)
  assert.equal(settings.connectionMode,'mcp')
  settings.connectionMode='native';settings.api.apiKey='PRIVATE-KEY';settings.nativeModels.codex='chosen-local-model'
  persistAssistantSettings(settings,storage)
  assert.equal(readAssistantSettings(storage).connectionMode,'native')
  assert.equal(readAssistantSettings(storage).nativeModels.codex,'chosen-local-model')
  assert.ok(!storage.getItem(ASSISTANT_SETTINGS_KEY)!.includes('PRIVATE-KEY'))
  settings.connectionMode='mcp';persistAssistantSettings(settings,storage)
  assert.equal(readAssistantSettings(storage).connectionMode,'mcp')
  values.set(ASSISTANT_SETTINGS_KEY,JSON.stringify({connectionMode:'unknown',nativeModels:{codex:'preserved'}}))
  assert.equal(readAssistantSettings(storage).connectionMode,'mcp')
  assert.equal(readAssistantSettings(storage).nativeModels.codex,'preserved')
})
