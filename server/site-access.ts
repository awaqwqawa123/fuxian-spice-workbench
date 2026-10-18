import type { ModelSearchSourceStatus } from '../src/core/model-search'
import type { SiteSessionId } from '../src/core/site-sessions'

export interface SiteSearchManager {
  /** Undefined means the user has not enabled this site; every other status is authoritative. */
  search(site: SiteSessionId, query: string): Promise<ModelSearchSourceStatus | undefined>
}

let defaultManager: SiteSearchManager | undefined

/** Attach the one local browser manager before Vite accepts model requests. */
export function installSiteSearchManager(manager: SiteSearchManager) { defaultManager = manager }

/** Enabled sessions never fall back to anonymous search behind the user's back. */
export function createSiteSearchSource<T extends ModelSearchSourceStatus>(site: SiteSessionId, anonymous: (query: string) => Promise<T>, searchTerm: (query: string) => string = query => query, manager: () => SiteSearchManager | undefined = () => defaultManager) {
  return async (query: string): Promise<ModelSearchSourceStatus> => {
    const term = searchTerm(query)
    const connected = await manager()?.search(site, term)
    return connected ?? anonymous(term)
  }
}
