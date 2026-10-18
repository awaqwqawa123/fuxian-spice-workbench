export interface DatasheetCandidate { id: string; title: string; url: string; manufacturer: string; matchNote?: string }
export interface DatasheetSearchResults { candidates: DatasheetCandidate[]; notices: string[]; sourceStatuses?: import('./model-search').ModelSearchSourceStatus[] }
export interface DatasheetDownload { id: string; fileName: string; url: string; bytesBase64: string; byteLength: number }
