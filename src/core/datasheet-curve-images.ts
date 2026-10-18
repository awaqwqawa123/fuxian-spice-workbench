import {DatasheetStandardFontFactory} from './datasheet-pdf-fonts'
import {parseDatasheetFigures,selectDatasheetCurvePages,type DatasheetFigure} from './datasheet-curve-evidence'
export async function renderBrowserDatasheetFigures(bytes:Uint8Array,pages:readonly {number:number;text:string}[],options:{requirements?:string;curvePages?:number[]}={}):Promise<DatasheetFigure[]>{
 const selected=options.curvePages??selectDatasheetCurvePages(pages,options.requirements)
 if(selected.length>3||selected.some(number=>!Number.isInteger(number)||!pages.some(page=>page.number===number)))throw new Error('请选择规格书内最多三页曲线图')
 if(!selected.length)return []
 const {getDocument}=await import('pdfjs-dist')
 const task=getDocument({data:bytes.slice(),isEvalSupported:false,useSystemFonts:false,stopAtErrors:true,StandardFontDataFactory:DatasheetStandardFontFactory,useWorkerFetch:false})
 try{
  const document=await task.promise,figures:DatasheetFigure[]=[]
  for(const number of selected){
   const page=await document.getPage(number),natural=page.getViewport({scale:1}),viewport=page.getViewport({scale:Math.min(1200/natural.width,1650/natural.height)})
   const canvas=window.document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height)
   const context=canvas.getContext('2d');if(!context)throw new Error('浏览器无法绘制规格书曲线页')
   try{await page.render({canvasContext:context,viewport,canvas}).promise;let url=canvas.toDataURL('image/jpeg',.75);if(url.length>360000)url=canvas.toDataURL('image/jpeg',.5);figures.push({page:number,mimeType:'image/jpeg',dataBase64:url.split(',')[1],width:canvas.width,height:canvas.height})}finally{page.cleanup();canvas.width=0;canvas.height=0}
  }
  return parseDatasheetFigures(figures,pages.map(page=>page.number))
 }finally{await task.destroy()}
}
