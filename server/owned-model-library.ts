import { join, resolve } from 'node:path'

/** Software-owned files travel with the application folder. HTTP callers never
 * choose these paths. The environment override is for local service deployment. */
export function ownedModelLibraryRoot(): string {
  return resolve(process.env.SPICE_OWNED_MODEL_LIBRARY_DIR || join(process.cwd(), 'model-library'))
}
