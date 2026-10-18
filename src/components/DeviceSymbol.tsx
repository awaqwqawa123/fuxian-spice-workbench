import { memo, type ReactNode } from 'react'
import type { Device } from '../core/drawing'
import { defaultModelSymbol, type ModelSymbol } from '../core/model-symbol'
import ModelBoxSymbol from './ModelBoxSymbol'
import { LtspiceSymbolGraphic } from './LtspiceSymbol'
import {GroundSymbolGraphic} from './NetSymbolGraphic'

/** Symbols shared by the canvas, parts library and standalone SVG exporter. */
export const DeviceSymbol = memo(function DeviceSymbol({ device, modelType, symbol:customSymbol, showPinLabels=true }: { device: Device; modelType?:string; symbol?:ModelSymbol; showPinLabels?:boolean }) {
  if(device.kind==='X'&&customSymbol?.shape==='ltspice')return <LtspiceSymbolGraphic showPinLabels={showPinLabels} device={device} symbol={customSymbol as Parameters<typeof LtspiceSymbolGraphic>[0]['symbol']}/>
  if(device.kind==='X')return <ModelBoxSymbol showPinLabels={showPinLabels} device={device} symbol={customSymbol??defaultModelSymbol('X',device.value,'box',device.pins)}/>
  if(customSymbol?.shape==='box')return <ModelBoxSymbol showPinLabels={showPinLabels} device={device} symbol={customSymbol}/>
  const common = { fill:'none',stroke:'currentColor',strokeWidth:2,strokeLinecap:'round' as const,strokeLinejoin:'round' as const }
  const paper = '#fcfdfb'
  let symbol:ReactNode
  const labels:{x:number;y:number;text:string;size?:number}[]=[]
  switch(device.kind){
    case 'GND':symbol=<GroundSymbolGraphic style={device.groundStyle}/>;break
    case 'R':symbol=<><path d="M -40 0 H -24 M 24 0 H 40"/><rect x="-24" y="-10" width="48" height="20" fill={paper}/></>;break
    case 'C':symbol=<path d="M -40 0 H -7 M 7 0 H 40 M -7 -22 V 22 M 7 -22 V 22"/>;break
    case 'L':symbol=<path d="M -40 0 H -28 C -28 -24 -14 -24 -14 0 C -14 -24 0 -24 0 0 C 0 -24 14 -24 14 0 C 14 -24 28 -24 28 0 H 40"/>;break
    case 'D':symbol=<><path d="M -40 0 H -18 M 18 0 H 40 M 18 -22 V 22"/><path d="M -18 -22 L 18 0 L -18 22 Z" fill={paper}/>{(customSymbol?.family==='zener-diode'||device.value.startsWith('D_ZENER'))&&<path d="M 18 -22 H 25 M 18 22 H 11"/>}{(customSymbol?.family==='schottky-diode'||device.value==='D_SCHOTTKY')&&<path d="M 18 -22 H 25 V -16 M 18 22 H 11 V 16"/>}{(customSymbol?.family==='led'||device.value.startsWith('D_LED_'))&&<path d="M -2 -27 L 9 -38 M 4 -38 H 9 V -33 M 11 -24 L 22 -35 M 17 -35 H 22 V -30"/>}{customSymbol?.family==='photodiode'&&<path d="M 9 -38 L -2 -27 M -2 -32 V -27 H 3 M 22 -35 L 11 -24 M 11 -29 V -24 H 16"/>}{customSymbol?.family==='varactor'&&<path d="M 25 -22 V 22"/>}</>;break
    case 'Q':symbol=<><circle r="29"/><path d="M -40 0 H -12 M -12 -21 V 21 M -12 -12 L 20 -30 V -40 M -12 12 L 20 30 V 40"/><path d={(modelType?modelType==='PNP':device.value.startsWith('Q_PNP'))?'M 1 19 L 12 19 L 7 28 Z':'M 17 29 L 7 18 L 3 27 Z'} fill="currentColor"/></>;break
    case 'M':symbol=<>{device.value.includes('DEPLETION')&&<path d="M -10 -24 V 24"/>}<path d="M -40 0 H -18 M -18 -24 V 24 M -10 -24 V -10 M -10 -6 V 6 M -10 10 V 24 M -10 -18 H 20 V -40 M -10 18 H 20 V 40"/><path d={(modelType?modelType==='PMOS':device.value.startsWith('M_PMOS'))?'M -8 0 L 2 -6 V 6 Z':'M 8 0 L -2 -6 V 6 Z'} fill="currentColor"/></>;break
    case 'J':symbol=<><circle r="29"/><path d="M -40 0 H -8 M -8 -22 V 22 M -8 -18 H 20 V -40 M -8 18 H 20 V 40"/><path d={(modelType?modelType==='PJF':device.value==='J_PJFET')?'M -29 0 L -18 -6 V 6 Z':'M -11 0 L -22 -6 V 6 Z'} fill="currentColor"/></>;break
    case 'OPA':
    case 'CMP':symbol=<><path d="M -40 -20 H -26 M -40 20 H -26 M 40 0 H 60 M 0 -60 V -26 M 0 26 V 60"/><path d="M -26 -42 L 40 0 L -26 42 Z" fill={paper}/><path d="M -21 -18 H -9 M -15 -24 V -12 M -21 18 H -9"/>{device.kind==='CMP'&&<path d="M -3 8 H 4 V -8 H 13"/>}</>;labels.push({x:9,y:-42,text:'V+',size:8},{x:9,y:48,text:'V−',size:8});break
    case 'OP':symbol=<><path d="M -40 -20 H -26 M -40 20 H -26 M 30 0 H 40"/><path d="M -26 -36 L 30 0 L -26 36 Z" fill={paper}/><path d="M -20 -16 H -8 M -14 -22 V -10 M -20 16 H -8"/></>;break
    case 'I':symbol=<><path d="M -40 0 H -25 M 25 0 H 40"/><circle r="25" fill={paper}/><path d="M -13 0 H 13 M 5 -7 L 13 0 L 5 7"/></>;break
    case 'V':symbol=<><path d="M -40 0 H -25 M 25 0 H 40"/><circle r="25" fill={paper}/>{device.params?.waveform&&device.params.waveform!=='dc'?<g transform={`rotate(${-device.rotation})`}><path d={device.params.waveform==='sine'?'M -17 0 C -11 -22 -5 -22 0 0 C 5 22 11 22 17 0':device.params.waveform==='pwl'||device.params.waveform==='expression'?'M -17 11 L -8 -5 L 0 3 L 8 -13 L 17 6':device.params.width==='1ps'?'M -17 10 L -8 -10 L 8 10 L 17 -10':'M -17 10 H -10 V -10 H 6 V 10 H 17'}/></g>:<><g transform={`translate(-10 0) rotate(${-device.rotation})`}><path d="M -6 0 H 6 M 0 -6 V 6"/></g><g transform={`translate(12 0) rotate(${-device.rotation})`}><path d="M -5 0 H 5"/></g></>}</>;break
    case 'SW':
      symbol=<><path d="M -40 0 H -19 M 19 0 H 40"/><circle cx="-17" r="2.5" fill={paper}/><circle cx="17" r="2.5" fill={paper}/><path d={device.value==='ON'?'M -15 0 H 15':'M -15 -1 L 15 -20'}/></>
      labels.push({x:0,y:23,text:device.value==='ON'?'闭合':'断开',size:10});break
    case 'VSW':
      symbol=<><rect x="-29" y="-34" width="58" height="56" rx="5" fill={paper}/><path d="M -40 -20 H -17 M 17 -20 H 40 M -15 -20 L 13 -31 M -20 40 V 22 M 20 40 V 22 M -7 11 H 7"/><path d="M 0 7 V -4" strokeDasharray="3 3"/><circle cx="-17" cy="-20" r="2"/><circle cx="17" cy="-20" r="2"/></>
      labels.push({x:-20,y:14,text:'+',size:14},{x:20,y:14,text:'−',size:14});break
    case 'RELAY':
      symbol=<><rect x="-48" y="-49" width="94" height="98" rx="5" fill={paper} strokeDasharray="5 3"/><path d="M -60 -20 H -34 V -17 M -60 20 H -34 V 17 M -34 -17 C -17 -17 -17 -6 -34 -6 C -17 -6 -17 6 -34 6 C -17 6 -17 17 -34 17 M 60 -40 H 30 V -25 M 60 40 H 30 V 25 M 60 0 H 8 L 28 24"/><path d="M -19 0 H 4" strokeDasharray="3 3"/><circle cx="8" cy="0" r="2.3" fill={paper}/><circle cx="30" cy="-25" r="2.3" fill={paper}/><circle cx="30" cy="25" r="2.3" fill={paper}/></>
      labels.push({x:-36,y:-31,text:'+',size:12},{x:-36,y:34,text:'−',size:12},{x:14,y:-38,text:'NO',size:8},{x:26,y:-7,text:'COM',size:8},{x:14,y:41,text:'NC',size:8});break
    case 'LDO':
      symbol=<><rect x="-38" y="-30" width="76" height="60" rx="4" fill={paper}/><path d="M -60 0 H -38 M 38 0 H 60 M 0 30 V 60"/></>
      labels.push({x:0,y:-13,text:'LDO',size:13},{x:-25,y:5,text:'IN',size:9},{x:23,y:5,text:'OUT',size:9},{x:0,y:24,text:'GND',size:9});break
    case 'XFMR':
      symbol=<><path d="M -40 -40 H -24 V -30 C -3 -30 -3 -15 -24 -15 C -3 -15 -3 0 -24 0 C -3 0 -3 15 -24 15 C -3 15 -3 30 -24 30 V 40 H -40 M 40 -40 H 24 V -30 C 3 -30 3 -15 24 -15 C 3 -15 3 0 24 0 C 3 0 3 15 24 15 C 3 15 3 30 24 30 V 40 H 40 M -4 -32 V 32 M 4 -32 V 32"/><circle cx="-31" cy="-26" r="2.3" fill="currentColor"/><circle cx="31" cy="-26" r="2.3" fill="currentColor"/></>
      labels.push({x:-31,y:10,text:'P',size:9},{x:32,y:10,text:'S',size:9});break
    default:{const exhaustive:never=device.kind;throw new Error(`未定义的器件符号：${exhaustive}`)}
  }
  const angle=device.rotation*Math.PI/180
  return <g data-symbol={device.kind}>
    <g {...common} transform={`rotate(${device.rotation}) scale(${device.mirrored?-1:1} 1)`}>{symbol}</g>
    {labels.map((label,index)=>{
      const x=label.x*(device.mirrored?-1:1),y=label.y
      // Keep internal labels readable when the component is rotated or mirrored.
      return <text key={index} x={Math.round(x*Math.cos(angle)-y*Math.sin(angle))} y={Math.round(x*Math.sin(angle)+y*Math.cos(angle))} fill="currentColor" stroke="none" textAnchor="middle" fontFamily="Consolas, 'Microsoft YaHei', monospace" fontSize={label.size??10}>{label.text}</text>
    })}
  </g>
})
