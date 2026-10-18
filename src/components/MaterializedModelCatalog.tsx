import type { ImportedSpiceModel } from '../core/spice-models'
import type { ModelDownloadPreview } from '../core/model-search'
import DeviceModelResults from './DeviceModelResults'

/** Browse public devices, rather than every original library file.
 * Originals remain in the owned local archive. */
export default function MaterializedModelCatalog({query,projectModels,onPlaceModel,onImportAndPlaceModel,revision=0}:{
  query:string
  projectModels:ImportedSpiceModel[]
  onPlaceModel:(model:ImportedSpiceModel)=>void
  onImportAndPlaceModel:(model:ImportedSpiceModel,preview:ModelDownloadPreview)=>void|Promise<void>
  revision?:number
}){
  return <DeviceModelResults key={revision} query={query} projectModels={projectModels} remoteOnly onPlaceModel={onPlaceModel} onImportAndPlaceModel={onImportAndPlaceModel}/>
}
