import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {selectDatasheetCurvePages,parseDatasheetFigures,type DatasheetFigure} from '../src/core/datasheet-curve-evidence'
export async function renderServerDatasheetFigures(bytes:Uint8Array,pages:readonly {number:number;text:string}[],requirements=''):Promise<DatasheetFigure[]>{
 const selected=selectDatasheetCurvePages(pages,requirements)
 if(!selected.length)return []
 const [{getDocument},{createCanvas}]=await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'),import('@napi-rs/canvas')])
 const task=getDocument({data:bytes.slice(),isEvalSupported:false,useSystemFonts:false,stopAtErrors:true,standardFontDataUrl:join(dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),'standard_fonts').replace(/\\/g,'/')+'/'})
 try{
  const document=await task.promise,figures:DatasheetFigure[]=[]
  for(const number of selected){
   const page=await document.getPage(number),natural=page.getViewport({scale:1}),viewport=page.getViewport({scale:Math.min(1200/natural.width,1650/natural.height)}),canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height))
   try{await page.render({canvasContext:canvas.getContext('2d') as unknown as CanvasRenderingContext2D,viewport,canvas:canvas as unknown as HTMLCanvasElement}).promise;let image=canvas.toBuffer('image/jpeg',75);if(image.byteLength>270000)image=canvas.toBuffer('image/jpeg',50);figures.push({page:number,mimeType:'image/jpeg',dataBase64:image.toString('base64'),width:canvas.width,height:canvas.height})}finally{page.cleanup()}
  }
  return parseDatasheetFigures(figures,pages.map(page=>page.number))
 }finally{await task.destroy()}
}
