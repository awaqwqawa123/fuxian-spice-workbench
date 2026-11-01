import { join, resolve } from 'node:path'
import { realpathSync } from 'node:fs'

/** Software-owned files travel with the application folder. HTTP callers never
 * choose these paths. The environment override is for local service deployment. */
export function ownedModelLibraryRoot(): string {
  const root=resolve(process.env.SPICE_OWNED_MODEL_LIBRARY_DIR || join(process.cwd(), 'model-library'))
  // A Windows junction and its real path identify the same owned library.
  // Keep its cache scope stable when the launcher switches between those paths.
  try{return realpathSync.native(root)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return root;throw error}
}
