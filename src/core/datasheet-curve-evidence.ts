export interface DatasheetFigure {page:number;mimeType:'image/png'|'image/jpeg';dataBase64:string;width:number;height:number}
export interface CurveCalibration {left:number;top:number;right:number;bottom:number;xMin:number;xMax:number;yMin:number;yMax:number;xScale:'linear'|'log';yScale:'linear'|'log';xUnit:string;yUnit:string}
export interface CurvePixelPoint {x:number;y:number}
const scales:Record<string,number>={V:1,mV:1e-3,uV:1e-6,A:1,mA:1e-3,uA:1e-6,nA:1e-9,Hz:1,kHz:1e3,MHz:1e6,dB:1}

/** Check real raster geometry before treating pixel locations as evidence. */
function imageDimensions(bytes: string, mime: DatasheetFigure['mimeType']): {width:number;height:number} {
 const byte=(offset:number)=>bytes.charCodeAt(offset),u16=(offset:number)=>(byte(offset)<<8)|byte(offset+1)
 if(mime==='image/png'){
  if(bytes.slice(0,8)!=='\x89PNG\r\n\x1a\n'||bytes.length<45||bytes.slice(12,16)!=='IHDR'||byte(11)!==13||bytes.slice(-8,-4)!=='IEND')throw new Error('PNG 曲线图片结构不完整')
  const u32=(offset:number)=>byte(offset)*16777216+byte(offset+1)*65536+byte(offset+2)*256+byte(offset+3)
  return {width:u32(16),height:u32(20)}
 }
 if(byte(0)!==255||byte(1)!==216||bytes.slice(-2)!=='\xff\xd9')throw new Error('JPEG 曲线图片结构不完整')
 let offset=2,dimensions:{width:number;height:number}|undefined
 while(offset<bytes.length-2){
  if(byte(offset)!==255)throw new Error('JPEG 曲线图片段标记不完整')
  while(byte(offset)===255)offset++
  const marker=byte(offset++)
  if(marker===0xd9)break
  if(marker===0xd8||marker===1||marker>=0xd0&&marker<=0xd7)continue
  const length=u16(offset)
  if(length<2||offset+length>bytes.length-2)throw new Error('JPEG 曲线图片段已截断')
  if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
   if(length<8)throw new Error('JPEG 曲线尺寸段不完整')
   dimensions={width:u16(offset+5),height:u16(offset+3)}
  }
  if(marker===0xda){if(!dimensions)break;return dimensions}
  offset+=length
 }
 throw new Error('JPEG 曲线图片缺少真实尺寸或图像扫描数据')
}

export function parseDatasheetFigures(raw:unknown,pages:readonly number[]):DatasheetFigure[]{
 if(raw===undefined)return []
 if(!Array.isArray(raw)||raw.length>3)throw new Error('每份规格书最多附加三张曲线页')
 let total=0
 const seen=new Set<number>()
 return raw.map(value=>{
  if(!value||typeof value!=='object')throw new Error('曲线页数据格式错误')
  const figure=value as DatasheetFigure
  if(!Number.isInteger(figure.page)||!pages.includes(figure.page)||!['image/png','image/jpeg'].includes(figure.mimeType)||typeof figure.dataBase64!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(figure.dataBase64)||figure.dataBase64.length>360000)throw new Error('曲线图片必须属于这份规格书的页码，格式为 PNG 或 JPEG')
  if(!Number.isInteger(figure.width)||!Number.isInteger(figure.height)||figure.width<64||figure.height<64||figure.width>1800||figure.height>2500||figure.width*figure.height>3_500_000)throw new Error('曲线页尺寸超出可读取范围')
  if(seen.has(figure.page))throw new Error('曲线页码重复，不能将不同图像悄然混成一页')
  seen.add(figure.page)
  let bytes:string
  try{bytes=atob(figure.dataBase64)}catch{throw new Error('曲线图片不是有效 Base64')}
  total+=bytes.length
  if(bytes.length<16||bytes.length>270000||total>700000)throw new Error('曲线图片过大，请截取相关图页')
  const png=bytes.charCodeAt(0)===137&&bytes.slice(1,4)==='PNG',jpeg=bytes.charCodeAt(0)===255&&bytes.charCodeAt(1)===216&&bytes.charCodeAt(2)===255
  if(figure.mimeType==='image/png'?!png:!jpeg)throw new Error('曲线图片声明与实际文件头不一致')
  const actual=imageDimensions(bytes,figure.mimeType)
  if(actual.width!==figure.width||actual.height!==figure.height)throw new Error('曲线图片的实际像素尺寸与声明尺寸不一致')
  return {page:figure.page,mimeType:figure.mimeType,dataBase64:figure.dataBase64,width:figure.width,height:figure.height}
 })
}

export function selectDatasheetCurvePages(pages:readonly {number:number;text:string}[],requirements=''):number[]{
 const preferred=/op.?amp|运放|带宽|频率|放大/i.test(requirements)?/open.loop\s+gain|gain.bandwidth|frequency\s+response|幅频|增益带宽/gi:/mos|jfet|场效应|栅极|vgs|漏极/i.test(requirements)?/transfer\s+characteristics|drain\s+current|gate.source\s+voltage|转移特性|漏极电流/gi:/diode|led|二极管|正向|vf\b|整流/i.test(requirements)?/forward\s+(?:voltage|current|characteristics?)|正向特性|正向电流/gi:undefined
 return pages.map(page=>({number:page.number,score:(page.text.match(/typical\s+(?:performance|characteristics)|characteristic\s+curves?|典型特性|特性曲线|正向特性|输出特性|转移特性|forward\s+(?:current|voltage|characteristics?)|drain\s+current|(?:transfer|output)\s+characteristics|open.loop\s+gain|gain\s+(?:versus|vs\.?)\s+frequency|frequency\s+response/gi)??[]).length+(preferred?(page.text.match(preferred)??[]).length*4:0)}))
  .filter(page=>page.score>0).sort((a,b)=>b.score-a.score||a.number-b.number).slice(0,3).map(page=>page.number).sort((a,b)=>a-b)
}

export function calibratedCurvePoints(figure:DatasheetFigure,calibration:CurveCalibration,points:readonly CurvePixelPoint[]):{x:number;y:number}[]{
 const values=[calibration.left,calibration.top,calibration.right,calibration.bottom,calibration.xMin,calibration.xMax,calibration.yMin,calibration.yMax]
 if(values.some(value=>!Number.isFinite(value))||calibration.left<0||calibration.top<0||calibration.right>figure.width||calibration.bottom>figure.height||calibration.right-calibration.left<40||calibration.bottom-calibration.top<40||calibration.xMax<=calibration.xMin||calibration.yMax<=calibration.yMin)throw new Error('请按原图校准坐标轴边界和范围')
 if(!['linear','log'].includes(calibration.xScale)||!['linear','log'].includes(calibration.yScale)||calibration.xScale==='log'&&calibration.xMin<=0||calibration.yScale==='log'&&calibration.yMin<=0)throw new Error('对数坐标的范围必须严格为正')
 const xUnit=calibration.xUnit.replace(/[μµ]/g,'u'),yUnit=calibration.yUnit.replace(/[μµ]/g,'u')
 if(!Object.hasOwn(scales,xUnit)||!Object.hasOwn(scales,yUnit))throw new Error('请明确曲线坐标单位：V、mV、A、mA、uA、Hz、kHz、MHz 或 dB')
 if(!Array.isArray(points)||points.length<3||points.length>60)throw new Error('曲线需要 3～60 个原图采样点')
 const interpolate=(ratio:number,minimum:number,maximum:number,scale:string)=>scale==='log'?Math.exp(Math.log(minimum)+ratio*Math.log(maximum/minimum)):minimum+ratio*(maximum-minimum)
 return points.map(point=>{
  if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y)||point.x<calibration.left||point.x>calibration.right||point.y<calibration.top||point.y>calibration.bottom)throw new Error('曲线采样点必须落在已校准的原图坐标区域内')
  return {x:interpolate((point.x-calibration.left)/(calibration.right-calibration.left),calibration.xMin,calibration.xMax,calibration.xScale)*scales[xUnit],y:interpolate((calibration.bottom-point.y)/(calibration.bottom-calibration.top),calibration.yMin,calibration.yMax,calibration.yScale)*scales[yUnit]}
 })
}
