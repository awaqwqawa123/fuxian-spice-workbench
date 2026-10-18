import type { DatasheetParameter } from './datasheet-model'
import { equivalentModelParameterValues } from './model-parameter-values'

export interface DiodeForwardPoint { currentA:number; voltageV:number; temperatureC:number; page:number; evidence:string;quote?:string }

/** Fit only an overdetermined/independent static Shockley forward branch at one
 * explicitly stated temperature. No recovery, capacitance or ratings are fitted.
 * Solves V=N*VT*ln(I)-N*VT*ln(IS)+RS*I; exact Shockley residual is checked below. */
export function fitDiodeForwardPoints(points:readonly DiodeForwardPoint[]):{parameters:DatasheetParameter[];reason?:string}{
  const fail=(reason:string)=>({parameters:[],reason})
  if(points.length<3)return fail('正向曲线少于三个独立、同温度的典型 VF/IF 点，不能同时确定 IS、N 和 RS。')
  if(points.length>60||points.some(point=>![point.currentA,point.voltageV,point.temperatureC].every(Number.isFinite)||point.currentA<=0||point.voltageV<=0||point.temperatureC< -50||point.temperatureC>150))return fail('正向曲线点或温度超出可检查范围。')
  const temperature=points[0].temperatureC
  if(points.some(point=>point.temperatureC!==temperature))return fail('正向曲线混合了不同明确温度，必须选择工作温度后拟合，未取第一组。')
  const unique:DiodeForwardPoint[]=[]
  for(const point of points){
    const duplicate=unique.find(item=>equivalentModelParameterValues(String(item.currentA),String(point.currentA)))
    if(duplicate){if(!equivalentModelParameterValues(String(duplicate.voltageV),String(point.voltageV)))return fail('相同温度和电流存在冲突的典型 VF，未取第一行。');continue}
    unique.push(point)
  }
  if(unique.length<3)return fail('正向曲线缺少三个不同电流下的独立测量点。')
  const currents=unique.map(point=>point.currentA),maximum=Math.max(...currents),minimum=Math.min(...currents)
  if(maximum/minimum<10)return fail('正向曲线电流跨度不足十倍，IS/N/RS 拟合病态，不能可靠分离系数。')
  const center=unique.reduce((sum,point)=>sum+Math.log(point.currentA),0)/unique.length
  const matrix=Array.from({length:3},()=>[0,0,0,0])
  for(const point of unique){
    const row=[Math.log(point.currentA)-center,point.currentA/maximum,1]
    for(let i=0;i<3;i++){for(let j=0;j<3;j++)matrix[i][j]+=row[i]*row[j];matrix[i][3]+=row[i]*point.voltageV}
  }
  for(let column=0;column<3;column++){
    let pivot=column
    for(let i=column+1;i<3;i++)if(Math.abs(matrix[i][column])>Math.abs(matrix[pivot][column]))pivot=i
    if(Math.abs(matrix[pivot][column])<1e-9)return fail('正向曲线拟合矩阵病态，不能可靠分离 IS/N/RS。')
    ;[matrix[column],matrix[pivot]]=[matrix[pivot],matrix[column]]
    const divisor=matrix[column][column]
    for(let j=column;j<4;j++)matrix[column][j]/=divisor
    for(let i=0;i<3;i++)if(i!==column){const multiple=matrix[i][column];for(let j=column;j<4;j++)matrix[i][j]-=multiple*matrix[column][j]}
  }
  const thermal=8.617333262145e-5*(temperature+273.15),slope=matrix[0][3],n=slope/thermal,rs=matrix[1][3]/maximum,is=Math.exp(center-matrix[2][3]/slope)
  if(![n,rs,is].every(Number.isFinite)||n<.5||n>4||rs<=0||rs>1e4||rs*maximum<.0005||is<1e-24||is>1e-3||minimum/is<1e5)return fail('正向曲线不能形成合理且独立的正 IS/N/RS 系数，串联电阻效应不足 0.5 mV，或不满足指数正向区假设。')
  const residual=Math.max(...unique.map(point=>Math.abs(point.voltageV-(n*thermal*Math.log1p(point.currentA/is)+rs*point.currentA))))
  if(residual>.005)return fail(`正向曲线最大电压残差 ${residual.toPrecision(4)} V 超过 5 mV；该方程不能代表这些点。`)
  const evidence=points.map(point=>point.evidence).join('；')
  const citations=points.map(point=>({page:point.page,quote:point.quote??point.evidence.replace(/^第\s+\d+\s+页：\s*/, '')}))
  const note=`固定 TJ=${temperature}°C 的 ${unique.length} 个独立典型正向点，电流跨度 ${(maximum/minimum).toPrecision(4)} 倍；Shockley+串联电阻静态拟合，最大残差 ${residual.toPrecision(4)} V。仅覆盖此温度和测量电流段，动态、温漂、反向特性继承模板且未拟合。`
  return {parameters:[['IS',is],['N',n],['RS',rs],['TNOM',temperature]].map(([key,value])=>({id:`diode-fit-${key}`,page:points[0].page,label:`多点正向静态拟合 ${key}`,key:String(key),value:Number(value).toPrecision(12),evidence,quote:citations.map(item=>item.quote).join('\n'),citations,conditions:`TJ=${temperature}°C; IF=${minimum}..${maximum}A`,basis:'典型值',note}))}
}
