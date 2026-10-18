/** A bounded, data-only representation of an LTspice .asy file. No SVG or SPICE text is executed. */
export interface LtspiceSymbolPrimitive {
  type: 'line' | 'rectangle' | 'circle' | 'arc' | 'polygon' | 'polyline'
  coords: number[]
  /** Original OrCAD style codes. Absent means the existing drawing default. */
  lineStyle?: number
  lineWidth?: number
  fillStyle?: number
}
export interface LtspiceSymbolPin {
  index: number; label: string; x: number; y: number
  labelVisible?: boolean; numberVisible?: boolean; number?: string
  bodyX?: number; bodyY?: number; labelRotate?: boolean
}
export interface SymbolAnnotation {
  text: string; x: number; y: number; size: number
  fontFamily?: string; fontWeight?: number; italic?: boolean
  rotation?: number; anchor?: 'start'|'middle'|'end'
  /** Native placement window; renderer substitutes the placed device value. */
  binding?: 'reference'|'value'
}
export interface LtspiceSymbol {
  version: 1
  shape: 'ltspice'
  title: string
  pins: LtspiceSymbolPin[]
  /** Original package terminals absent from the electrical template. */
  physicalPins?: Omit<LtspiceSymbolPin,'index'>[]
  geometry: LtspiceSymbolPrimitive[]
  annotations?: SymbolAnnotation[]
}
export interface LtspiceAsy {
  symbol: LtspiceSymbol
  value: string
  value2: string
  spiceModel: string
  modelFile: string
  prefix: string
  description: string
}

const printable=(value:string,max:number)=>value.trim().slice(0,max).replace(/[\x00-\x1f\x7f]/g,'')
const integer=(text:string)=>{const value=Number(text);if(!Number.isSafeInteger(value)||Math.abs(value)>4096)throw new Error('LTspice 符号坐标超出支持范围');return value}

/** Require an explicit, unique 1-based SpiceOrder; array index is the SPICE port position. */
export function parseLtspiceAsy(text:string,name:string):LtspiceAsy {
  if(typeof text!=='string'||text.length>128*1024)throw new Error('LTspice 符号文件超过 128 KB')
  const attributes:Record<string,string>={},rawPins:{x:number;y:number;name?:string;order?:number}[]=[],rawGeometry:LtspiceSymbolPrimitive[]=[],rawAnnotations:{text:string;x:number;y:number;size:number}[]=[]
  let currentPin:typeof rawPins[number]|undefined
  for(const rawLine of text.replace(/^\uFEFF/,'').split(/\r?\n/)){
    const line=rawLine.trim();if(!line)continue
    const [command,...tokens]=line.split(/\s+/),key=command.toUpperCase()
    if(key==='SYMATTR'){
      const match=line.match(/^SYMATTR\s+(\S+)\s+(.+)$/i)
      if(match)attributes[match[1].toLowerCase()]=printable(match[2],500)
    }else if(key==='PIN'){
      if(tokens.length<2)throw new Error('LTspice PIN 缺少坐标')
      currentPin={x:integer(tokens[0]),y:integer(tokens[1])};rawPins.push(currentPin)
    }else if(key==='PINATTR'){
      if(!currentPin)throw new Error('PINATTR 前缺少 PIN')
      const match=line.match(/^PINATTR\s+(\S+)\s+(.+)$/i)
      if(!match)continue
      if(match[1].toLowerCase()==='pinname')currentPin.name=printable(match[2],24)
      if(match[1].toLowerCase()==='spiceorder')currentPin.order=integer(match[2])
    }else if(key==='TEXT'){
      const match=line.match(/^TEXT\s+(-?\d+)\s+(-?\d+)\s+\S+\s+\d+\s+(.+)$/i)
      if(match){const x=integer(match[1]),y=integer(match[2]);for(const [index,text] of match[3].split(/\\n/).entries())if(text.trim())rawAnnotations.push({text:printable(text,180),x,y:y+index*14,size:8});if(rawAnnotations.length>128)throw new Error('LTspice 文字标记超过 128 个')}
    }else if(['LINE','RECTANGLE','CIRCLE','ARC'].includes(key)){
      const count=key==='ARC'?8:4
      if(tokens.length<count+1)throw new Error(`${key} 图形坐标不足`)
      // Normal and Dash variants are display styles, never parsed as markup.
      rawGeometry.push({type:key.toLowerCase() as LtspiceSymbolPrimitive['type'],coords:tokens.slice(1,count+1).map(integer)})
      if(rawGeometry.length>256)throw new Error('LTspice 符号图元超过 256 个')
    }
  }
  if(rawPins.length<2||rawPins.length>32)throw new Error('LTspice 符号须有 2～32 个引脚')
  const pinsByOrder=[...rawPins].sort((a,b)=>(a.order??0)-(b.order??0))
  if(pinsByOrder.some((pin,index)=>pin.order!==index+1))throw new Error('LTspice SpiceOrder 必须从 1 连续排列且不可重复')
  // LTspice coordinates use 16 units per standard terminal step; canvas uses 10.
  // Center the imported symbol so device placement and rotation share one origin.
  const allX=[...rawPins.map(pin=>pin.x),...rawGeometry.flatMap(item=>item.coords.filter((_,index)=>index%2===0))]
  const allY=[...rawPins.map(pin=>pin.y),...rawGeometry.flatMap(item=>item.coords.filter((_,index)=>index%2===1))]
  const centerX=Math.round((Math.min(...allX)+Math.max(...allX))/32)*16
  const centerY=Math.round((Math.min(...allY)+Math.max(...allY))/32)*16
  const scale=(value:number,center:number)=>Math.round((value-center)*0.625*10)/10
  const pins=pinsByOrder.map((pin,index)=>({index,label:pin.name||`P${index+1}`,x:Math.round(scale(pin.x,centerX)/10)*10,y:Math.round(scale(pin.y,centerY)/10)*10}))
  if(new Set(pins.map(pin=>`${pin.x},${pin.y}`)).size!==pins.length)throw new Error('LTspice 引脚映射到画布网格后重叠')
  const geometry=rawGeometry.map(item=>({type:item.type,coords:item.coords.map((coord,index)=>scale(coord,index%2?centerY:centerX))}))
  const annotations=rawAnnotations.map(item=>({...item,x:scale(item.x,centerX),y:scale(item.y,centerY)}))
  return {symbol:{version:1,shape:'ltspice',title:printable(attributes.value||attributes.value2||name,32),pins,geometry,...(annotations.length?{annotations}:{})},value:attributes.value||'',value2:attributes.value2||'',spiceModel:attributes.spicemodel||'',modelFile:attributes.modelfile||'',prefix:attributes.prefix||'',description:attributes.description||''}
}

export function validateLtspicePinOrder(symbol:LtspiceSymbol,modelPins:readonly string[]):void {
  if(symbol.pins.length!==modelPins.length)throw new Error(`符号 ${symbol.pins.length} 个引脚与 .subckt ${modelPins.length} 个端口不一致`)
  for(let index=0;index<symbol.pins.length;index++)if(symbol.pins[index].index!==index)throw new Error('符号电气引脚顺序不连续')
  // Names can differ (e.g. In+ versus INP), but a purely numeric pin name is
  // not proof of package pin numbering. Require explicit human review in UI.
}
