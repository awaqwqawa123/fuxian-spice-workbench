export const siteSessionSites = [
  { id: 'semiee', label: '半导小芯' },
  { id: 'lcsc', label: '立创商城' },
  { id: 'google', label: 'Google' },
  { id: 'alldatasheet', label: 'AllDataSheet' },
] as const

export type SiteSessionId = typeof siteSessionSites[number]['id']
export type SiteSessionState = 'not-connected' | 'login-open' | 'saved' | 'ready' | 'needs-action' | 'error'
export interface SiteSessionStatus {
  id: SiteSessionId
  label: string
  state: SiteSessionState
  detail: string
  updatedAt?: string
}
export interface SiteBrowserStatus {
  available: boolean
  browserName?: string
  running: boolean
  sites: SiteSessionStatus[]
}
export function isSiteSessionId(value: unknown): value is SiteSessionId {
  return typeof value === 'string' && siteSessionSites.some(site => site.id === value)
}
