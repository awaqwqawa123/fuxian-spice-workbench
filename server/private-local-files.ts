import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

// These runtime directories contain tokens, project snapshots and local conversations.
// Deny direct and /@fs access before Vite's static and transform middleware.
export const PRIVATE_LOCAL_DENY = ['**/.hapi-local/**', '**/.desktop-circuit/**', '**/.hapi-bridge/**', '**/.desktop-control/**', '**/.codex-sessions/**', '**/.codex/desktop-control/**']
export function privateLocalFiles(req: IncomingMessage, res: ServerResponse, next: () => void) {
  let path = (req.url ?? '').split('?')[0]
  try { for (let n = 0; n < 3; n++) { const decoded = decodeURIComponent(path); if (decoded === path) break; path = decoded } }
  catch { res.writeHead(400); res.end(); return }
  if (/(?:^|[/\\])\.(?:hapi-local|desktop-circuit|hapi-bridge|desktop-control|codex-sessions)(?:[/\\]|$)/i.test(path) || /(?:^|[/\\])\.codex[/\\]desktop-control(?:[/\\]|$)/i.test(path)) {
    res.writeHead(403, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' }); res.end('Private local data'); return
  }
  next()
}
export function privateLocalFilesPlugin(): Plugin {
  return { name: 'protect-local-runtime-data', enforce: 'pre', configureServer(server) { server.middlewares.use(privateLocalFiles) }, configurePreviewServer(server) { server.middlewares.use(privateLocalFiles) } }
}
