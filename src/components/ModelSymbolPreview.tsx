import type { ImportedSpiceModel } from '../core/spice-models'
import { modelSymbolOriginLabel } from '../core/model-symbol'
import { DeviceSymbol } from './DeviceSymbol'
import ModelBoxSymbol from './ModelBoxSymbol'
import { localPin } from '../core/devices'
import { LtspiceSymbolPreview } from './LtspiceSymbol'
import type { LtspiceSymbol } from '../core/ltspice-symbol'
import { presentedModelSymbol } from '../core/model-symbol-presentation'
import type { ModelSymbol } from '../core/model-symbol'

/** Circuit terminals, not package pin numbers. Geometry matches DeviceSymbol. */
const terminals = {
  D: [{ name: 'A', x: -40, y: 0, labelX: -40, labelY: -12 }, { name: 'K', x: 40, y: 0, labelX: 40, labelY: -12 }],
  Q: [{ name: 'B', x: -40, y: 0, labelX: -40, labelY: -12 }, { name: 'C', x: 20, y: -40, labelX: 34, labelY: -38 }, { name: 'E', x: 20, y: 40, labelX: 34, labelY: 44 }],
  J: [{ name: 'G', x: -40, y: 0, labelX: -40, labelY: -12 }, { name: 'D', x: 20, y: -40, labelX: 34, labelY: -38 }, { name: 'S', x: 20, y: 40, labelX: 34, labelY: 44 }],
  M: [{ name: 'G', x: -40, y: 0, labelX: -40, labelY: -12 }, { name: 'D', x: 20, y: -40, labelX: 34, labelY: -38 }, { name: 'S', x: 20, y: 40, labelX: 34, labelY: 44 }],
} as const

export default function ModelSymbolPreview({ model }: { model: ImportedSpiceModel }) {
  return <ModelSymbolGraphic model={model} symbol={presentedModelSymbol(model)}/>
}

/** Catalog pages already carry reviewed geometry; never parse SPICE just to draw a card. */
export function ModelSymbolGraphic({ model, symbol }: { model: Pick<ImportedSpiceModel, 'id' | 'kind' | 'type' | 'pins'>; symbol?: ModelSymbol }) {
  if(model.kind==='X'){
    if(symbol?.shape==='ltspice')return <LtspiceSymbolPreview symbol={symbol as LtspiceSymbol} className="model-symbol-preview" label={`${model.id} ${modelSymbolOriginLabel(symbol)} · ${symbol.pins.map(pin=>pin.label).join(' / ')}`}/>
    const device={id:'preview',kind:'X' as const,value:model.id,x:0,y:0,rotation:0 as const,pins:model.pins}
    const points=model.pins.map((name,index)=>({name,...localPin('X',index,device)}))
    const extent=Math.max(70,...points.map(point=>Math.max(Math.abs(point.x),Math.abs(point.y))))+22
    return <svg className="model-symbol-preview" viewBox={`${-extent} ${-extent} ${2*extent} ${2*extent}`} role="img" aria-label={`${model.id} · SUBCKT · ${symbol?.pins.map(pin=>pin.label).join(' / ')??model.pins.join(' / ')}`} data-model-type="SUBCKT"><DeviceSymbol device={device} symbol={symbol}/>{points.map((point,index)=><circle key={index} className="model-symbol-terminal" cx={point.x} cy={point.y} r="2" fill="currentColor"/>)}</svg>
  }
  const points = terminals[model.kind]
  const label = `${model.id} · ${model.type} 原理图符号 · 逻辑端子 ${model.pins.join(' / ')}`
  return <svg className="model-symbol-preview" viewBox="-56 -56 112 112" role="img" aria-label={label} data-model-type={model.type}>
    <title>{label}</title>
    {symbol?.shape==='box'?<ModelBoxSymbol device={{ id: 'preview', kind: model.kind, value: model.id, x: 0, y: 0, rotation: 0 }} symbol={symbol}/>:<DeviceSymbol device={{ id: 'preview', kind: model.kind, value: model.id, x: 0, y: 0, rotation: 0 }} modelType={model.type} symbol={symbol}/>}
    {points.map(point => <g key={point.name} className="model-symbol-terminal" data-terminal={point.name}>
      <circle cx={point.x} cy={point.y} r={2} fill="currentColor"/>
      {!symbol||symbol.shape!=='box'?<text x={point.labelX} y={point.labelY} textAnchor="middle" fontSize={12} fontFamily="Consolas, monospace" fill="currentColor">{point.name}</text>:null}
    </g>)}
  </svg>
}
