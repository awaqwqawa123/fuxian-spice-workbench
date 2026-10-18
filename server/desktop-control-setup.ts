import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

export type DesktopControlSetupStage = 'not-prepared' | 'prepared' | 'activated' | 'broken'
export type DesktopControlSetupAction = 'prepare' | 'activate' | 'restore' | 'repair'
const execute = promisify(execFile)

/** Only installation progress is exposed to the local page; paths and pipe tokens stay private. */
export async function readDesktopControlSetup(directory = join(homedir(), '.codex', 'desktop-control')): Promise<{ stage: DesktopControlSetupStage }> {
  let raw: string
  try { raw = await readFile(join(directory, 'install-state.json'), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { stage: 'not-prepared' }
    return { stage: 'broken' }
  }
  try {
    const state: unknown = JSON.parse(raw)
    if (!state || typeof state !== 'object' || !('launcher' in state) || typeof state.launcher !== 'string' || !isAbsolute(state.launcher)) return { stage: 'broken' }
    await access(state.launcher)
    const runtimeDirectory = dirname(state.launcher)
    const config = (await readFile(join(runtimeDirectory, 'desktop-control.config'), 'utf8')).replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/)
    if (config.length !== 5 || config[0] !== 'version=1' || !isAbsolute(config[1]) || !isAbsolute(config[2])) return { stage: 'broken' }
    await access(config[1]); await access(config[2])
    const runtime = JSON.parse(await readFile(join(runtimeDirectory, 'runtime.json'), 'utf8'))
    if (typeof runtime.realCodex !== 'string' || !isAbsolute(runtime.realCodex)) return { stage: 'broken' }
    await access(runtime.realCodex)
    for (const helper of ['codex-code-mode-host.exe', 'codex-windows-sandbox-setup.exe', 'codex-command-runner.exe']) await access(join(runtimeDirectory, helper))
    return { stage: 'active' in state && state.active === true ? 'activated' : 'prepared' }
  } catch { return { stage: 'broken' } }
}

/** Runs one fixed, bundled installer action. No command, path or arguments come from HTTP. */
export async function changeDesktopControlSetup(action: DesktopControlSetupAction, projectDirectory: string): Promise<{ stage: DesktopControlSetupStage }> {
  if (process.platform !== 'win32') throw new Error('windows-only')
  const script = join(projectDirectory, 'scripts', 'install-desktop-control.ps1')
  const mode = { prepare: 'Prepare', activate: 'Activate', restore: 'Restore', repair: 'Repair' }[action]
  try {
    await execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Mode', mode, ...(['prepare', 'repair'].includes(action) ? ['-NodePath', process.execPath] : [])], {
      cwd: projectDirectory, windowsHide: true, timeout: 120_000, maxBuffer: 32_000,
    })
  } catch (error) {
    const detail = `${(error as { stdout?: string }).stdout ?? ''}\n${(error as { stderr?: string }).stderr ?? ''}`
    if (/Official Codex executable was not found|Cannot locate official Codex binary/.test(detail)) throw new Error('codex-missing')
    if (/Installation is active/.test(detail)) throw new Error('already-active')
    if (/CODEX_CLI_PATH changed|changed by another tool/.test(detail)) throw new Error('entry-changed')
    if (/timed out|ETIMEDOUT/i.test(String((error as Error).message))) throw new Error('timeout')
    throw new Error('installer-failed')
  }
  return readDesktopControlSetup()
}
