import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

export function runtimeCache(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const path = (req.url ?? '/').split('?')[0]
  // Only content-addressed build assets are immutable. Project data, model
  // APIs and the application shell must never return stale user state.
  const immutable = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9.]+$/.test(path)
  res.setHeader('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : path.startsWith('/api/') ? 'no-store' : 'no-cache')
  next()
}

export function runtimeCachePlugin(): Plugin {
  return { name: 'built-runtime-cache', configurePreviewServer(server) { server.middlewares.use(runtimeCache) } }
}
