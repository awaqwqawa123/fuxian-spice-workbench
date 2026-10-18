import type { Plugin } from 'vite'
import { createAgentModelService } from './agent-model-service'
import { createDatasheetMiddleware } from './datasheet-search'
import { createLcscProductMiddleware } from './lcsc-source'
import { createModelSearchMiddleware } from './model-search'
import { getSiteBrowserManager } from './site-browser'
import { installSiteSearchManager } from './site-access'
import { createSiteSessionMiddleware } from './site-session-middleware'

export function modelSearchPlugin():Plugin {
  const install=(server:{middlewares:{use:(middleware:ReturnType<typeof createModelSearchMiddleware>)=>unknown}})=>{
    const browser = getSiteBrowserManager()
    installSiteSearchManager(browser)
    server.middlewares.use(createSiteSessionMiddleware(browser))
    // Independent UI tasks reuse the agent's real tools without a chat/session.
    server.middlewares.use(createModelSearchMiddleware(createAgentModelService()))
    server.middlewares.use(createDatasheetMiddleware())
    server.middlewares.use(createLcscProductMiddleware())
  }
  return {name:'fuxian-model-search',configureServer:install,configurePreviewServer:install,
    closeServer:async()=>{await getSiteBrowserManager().close()},
    closePreviewServer:async()=>{await getSiteBrowserManager().close()}}
}
