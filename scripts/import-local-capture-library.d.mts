export interface LocalCaptureFileSelection { path: string; sha256: string }
export interface LocalCaptureSelection {
  schemaVersion: number
  selectionKind: string
  olbs: (LocalCaptureFileSelection & { targetPath: string })[]
  vca821?: { zip: LocalCaptureFileSelection; sub: LocalCaptureFileSelection; asy: LocalCaptureFileSelection; tinaMacro?: LocalCaptureFileSelection }
}
export interface LocalCaptureImportResult {
  files: number
  bytes: number
  kinds: Record<string, number>
  extensions: Record<string, number>
  captureOlbFiles: number
  convertedParts: number
  verified: boolean
  failures: { path: string; reason: string }[]
}
export function importLocalCaptureLibrary(options: { selection: LocalCaptureSelection; libraryRoot?: string; python?: string; pythonPackages?: string }): LocalCaptureImportResult
export function verifyLocalCaptureLibrary(libraryRoot: string): LocalCaptureImportResult
