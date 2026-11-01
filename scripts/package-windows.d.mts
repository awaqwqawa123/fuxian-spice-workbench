export function portableDependencyPaths(lock: { packages?: Record<string, unknown> }, moduleRoot: string): string[]
export function assertPublicSnapshot(root: string): void
export function portableLauncherFiles(): Record<string, string>
export function writePortableLaunchers(output: string): void
export function packageWindows(options: { root: string; output: string; nodePath: string; modules?: string; zip?: boolean }): { output: string; archive?: string; version: string; dependencies: number }
