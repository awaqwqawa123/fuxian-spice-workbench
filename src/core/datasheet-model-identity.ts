import type {DatasheetText} from './datasheet-pdf-text'
import {identifyDatasheetParts} from './datasheet-part-identification'

/** Later ordering pages prove an exact suffix; unrelated application mentions do not. */
export function hasDatasheetPartEvidence(document:Pick<DatasheetText,'fileName'|'pages'>,part:string):boolean{
 const target=part.trim()
 if(!/^[a-z0-9_][a-z0-9_.-]{0,47}$/i.test(target))return false
 const identified=identifyDatasheetParts(document,target)
 if(identified.candidates.length)return identified.candidates.some(candidate=>candidate.part.toUpperCase()===target.toUpperCase())
 const escaped=target.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),pattern=new RegExp(`(^|[^a-z0-9_.-])${escaped}(?=$|[^a-z0-9_.-])`,'i')
 return document.pages.slice(0,3).some(page=>page.text.split(/\r?\n/).some(line=>!line.includes('\uFFFD')&&pattern.test(line)))
}
/** Full orderable identity remains in evidence; only the SPICE declaration uses an alias. */
export function datasheetModelName(part:string):string{
 const full=part.trim().toUpperCase(),safe=full.replace(/[^a-z0-9_.-]/gi,'_')
 if(safe.length<=32)return safe
 let hash=2166136261
 for(const character of full){hash^=character.charCodeAt(0);hash=Math.imul(hash,16777619)}
 return safe.slice(0,23)+'_'+(hash>>>0).toString(16).padStart(8,'0').toUpperCase()
}
