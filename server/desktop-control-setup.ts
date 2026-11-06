import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, readFile, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { CodexInstallationStore, validateCodexExecutable } from './codex-installation'

export type DesktopControlSetupStage = 'not-prepared' | 'prepared' | 'activated' | 'broken'
export type DesktopControlSetupAction = 'prepare' | 'activate' | 'restore' | 'repair'
const execute = promisify(execFile)

async function effectiveCodexExecutable(projectDirectory: string, environment: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const selected = await new CodexInstallationStore(join(projectDirectory, '.desktop-circuit')).selectedExecutable()
  if (selected) return selected
  // Ignore the process-global store: this software root already supplied its
  // own setting. Automatic discovery must match the CLI's env/PATH/default order.
  const automatic = await (await import('./codex-runtime')).findCodexExecutable(environment, { ignoreConfigured: true })
  return automatic ? validateCodexExecutable(automatic) : null
}

/** Only installation progress is exposed to the local page; paths and pipe tokens stay private. */
export async function readDesktopControlSetup(directory = join(homedir(), '.codex', 'desktop-control'), projectDirectory?: string, environment: NodeJS.ProcessEnv = process.env): Promise<{ stage: DesktopControlSetupStage }> {
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
    const expected = projectDirectory ? await effectiveCodexExecutable(projectDirectory, environment) : null
    if (projectDirectory && (!expected || (await realpath(runtime.realCodex)).toLowerCase() !== expected.toLowerCase())) return { stage: 'broken' }
    if (projectDirectory) {
      const sourceDirectory = join(projectDirectory, 'scripts', 'desktop-broker')
      const files = (await readdir(sourceDirectory, { withFileTypes: true })).filter(file => file.isFile())
      if (!runtime.brokerSources || Object.keys(runtime.brokerSources).length !== files.length) return { stage: 'broken' }
      const hash = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex')
      for (const file of files) {
        const expected = await hash(join(sourceDirectory, file.name))
        if (typeof runtime.brokerSources[file.name] !== 'string' || runtime.brokerSources[file.name].toLowerCase() !== expected) return { stage: 'broken' }
        await access(join(runtimeDirectory, file.name))
        // Prepare embeds a per-installation path into launcher.cs. Compare its
        // original source manifest, never the generated file against the source.
        if (file.name !== 'launcher.cs' && await hash(join(runtimeDirectory, file.name)) !== expected) return { stage: 'broken' }
      }
      if (typeof runtime.launcherSha256 !== 'string' || (await hash(state.launcher)) !== runtime.launcherSha256.toLowerCase()) return { stage: 'broken' }
    }
    for (const helper of ['codex-code-mode-host.exe', 'codex-windows-sandbox-setup.exe', 'codex-command-runner.exe']) await access(join(runtimeDirectory, helper))
    return { stage: 'active' in state && state.active === true ? 'activated' : 'prepared' }
  } catch { return { stage: 'broken' } }
}

type InstallerExecutor = (file: string, args: string[], options: { cwd: string; windowsHide: boolean; timeout: number; maxBuffer: number }) => Promise<unknown>
/** Server/test seams are never accepted from HTTP. */
interface SetupOptions { execute?: InstallerExecutor; directory?: string; environment?: NodeJS.ProcessEnv }
/** Runs one fixed, bundled installer action. Only the validated private setting can select Codex. */
export async function changeDesktopControlSetup(action: DesktopControlSetupAction, projectDirectory: string, options: SetupOptions = {}): Promise<{ stage: DesktopControlSetupStage }> {
  if (process.platform !== 'win32') throw new Error('windows-only')
  const script = join(projectDirectory, 'scripts', 'install-desktop-control.ps1')
  const mode = { prepare: 'Prepare', activate: 'Activate', restore: 'Restore', repair: 'Repair' }[action]
  const selected = ['prepare', 'repair'].includes(action) ? await effectiveCodexExecutable(projectDirectory, options.environment) : null
  try {
    await (options.execute ?? execute)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Mode', mode, ...(['prepare', 'repair'].includes(action) ? ['-NodePath', process.execPath] : []), ...(selected ? ['-RealCodexPath', selected] : []), ...(options.directory ? ['-InstallDirectory', options.directory] : [])], {
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
  return readDesktopControlSetup(options.directory, projectDirectory, options.environment)
}
