import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const code = await new Promise(resolve => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('start-hapi-local.mjs', import.meta.url))], { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true })
  child.once('error', () => resolve(1))
  child.once('exit', resolve)
})
if (code !== 0) console.warn('HAPI 尚未就绪，电路工作台仍可使用；AI 助手会显示连接状态。参见 docs/hapi-local.md。')
await import('./serve-local.mjs')
