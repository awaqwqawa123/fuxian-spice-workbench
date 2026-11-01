import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function runtimeOptions(args = process.argv.slice(2), env = process.env, root = process.cwd()) {
  const unknown = args.filter(arg => !['--dev', '--production'].includes(arg))
  if (unknown.length) throw new Error(`Unknown launch option: ${unknown.join(', ')}`)
  if (args.includes('--dev') && args.includes('--production')) throw new Error('Choose one runtime mode')
  const mode = args.includes('--dev') ? 'development' : args.includes('--production') ? 'production' : (env.FUXIAN_MODE || 'production')
  if (!['development', 'production'].includes(mode)) throw new Error('FUXIAN_MODE must be production or development')
  const port = Number(env.FUXIAN_PORT ?? 3032)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('FUXIAN_PORT must be a valid local port')
  if (mode === 'production' && !existsSync(join(root, 'dist', 'index.html'))) {
    throw new Error('Built frontend missing. Run npm run build once, or use npm run start:debug for source development. Portable users: fully extract the ZIP including dist/.')
  }
  return { mode, port }
}
