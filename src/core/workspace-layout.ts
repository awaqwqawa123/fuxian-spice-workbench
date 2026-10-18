import type { InspectorTab } from '../components/InspectorTabs'

export type WorkspaceLeftPanel = 'projects' | 'library'
export type SidebarId = 'left' | 'right' | 'ai'

export type WorkspaceLayoutState = {
  leftOpen: boolean
  rightOpen: boolean
  aiOpen: boolean
  priority: SidebarId
  leftPanel: WorkspaceLeftPanel
  rightPanel: InspectorTab
  maximized: boolean
  restore: { leftOpen: boolean; rightOpen: boolean; aiOpen: boolean } | null
}

export type WorkspaceLayoutAction =
  | { type: 'panel-left'; panel: WorkspaceLeftPanel }
  | { type: 'toggle-left' }
  | { type: 'panel-right'; panel: InspectorTab }
  | { type: 'toggle-right' }
  | { type: 'close-right' }
  | { type: 'open-ai' }
  | { type: 'close-ai' }
  | { type: 'toggle-maximize' }

export function createWorkspaceLayout(): WorkspaceLayoutState {
  return { leftOpen: true, rightOpen: false, aiOpen: false, priority: 'left', leftPanel: 'library', rightPanel: 'device', maximized: false, restore: null }
}

export function workspaceLayoutReducer(state: WorkspaceLayoutState, action: WorkspaceLayoutAction): WorkspaceLayoutState {
  switch (action.type) {
    case 'toggle-maximize':
      return state.maximized
        ? { ...state, ...(state.restore ?? { leftOpen: true, rightOpen: false, aiOpen: false }), maximized: false, restore: null }
        : { ...state, leftOpen: false, rightOpen: false, aiOpen: false, maximized: true, restore: { leftOpen: state.leftOpen, rightOpen: state.rightOpen, aiOpen: state.aiOpen } }
    case 'panel-left':
      return { ...state, leftOpen: true, leftPanel: action.panel, priority: 'left', maximized: false, restore: null }
    case 'toggle-left':
      return { ...state, leftOpen: !state.leftOpen, priority: 'left', maximized: false, restore: null }
    case 'panel-right':
      return { ...state, rightOpen: true, rightPanel: action.panel, priority: 'right', maximized: false, restore: null }
    case 'toggle-right':
      return { ...state, rightOpen: !state.rightOpen, priority: 'right', maximized: false, restore: null }
    case 'close-right':
      return { ...state, rightOpen: false, maximized: false, restore: null }
    case 'open-ai':
      return { ...state, aiOpen: true, priority: 'ai', maximized: false, restore: null }
    case 'close-ai':
      return { ...state, aiOpen: false, maximized: false, restore: null }
  }
}
