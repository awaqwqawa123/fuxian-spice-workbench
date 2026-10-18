import index from './wurth-model-declaration-index.json'

export interface WurthModelDeclaration { name: string; kind: 'subckt' | 'model'; pins?: string[] }
export interface WurthModelFile { path: string; size: number; sha256: string; names: string[]; declarations: WurthModelDeclaration[] }
export interface WurthModelCatalog {
  repo: string; revision: string; rootPath: string; label: string; archiveSha256: string
  stats: { sourceFiles: number; oversizedFiles: number; encryptedFiles: number; emptyFiles: number; helperDeclarations: number }
  files: WurthModelFile[]; license: string; attribution: string
}

/** Metadata only. Original model terms and disclaimers must accompany any download. */
export const WURTH_MODEL_CATALOGS: readonly WurthModelCatalog[] = index.catalogs.map(catalog => ({
  ...catalog,
  files: catalog.files as WurthModelFile[],
  license: 'Würth Elektronik 厂商模型；原文件标注 All Rights Reserved，保留原版权及使用条款；下载不代表获得再分发授权',
  attribution: `Würth Elektronik eiSos EDA Team；来自官方仓库 ${catalog.repo} 的固定提交 ${catalog.revision}；完整版权与免责声明见下载原件`,
}))

/** Tests/hosts may inject a reviewed catalog without changing the bundled catalog. */
export function getWurthModelCatalogs(catalogs: readonly WurthModelCatalog[] = WURTH_MODEL_CATALOGS) { return catalogs }

/** Exact snapshot paths include bounded dependency files with no independent declarations. */
export function registeredWurthModelPath(repo: string, revision: string, path: string, catalogs: readonly WurthModelCatalog[] = WURTH_MODEL_CATALOGS): boolean {
  return catalogs.some(catalog => catalog.repo === repo && catalog.revision === revision && catalog.files.some(file => file.path === path))
}
