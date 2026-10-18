import { fitDiodeForwardPoints } from './datasheet-diode-fit'
import { isManufacturerReference } from './model-reference'
import { spiceParameterNumber } from './model-parameter-values'
import { parseSpiceLibrary, type ImportedSpiceModel } from './spice-models'
import type { ApproximateParameter } from './model-search'

export type DatasheetCurveKind='diode-forward'|'mos-transfer'|'jfet-transfer'|'bjt-gain'|'opamp-gain-frequency'
/** Coordinates have already been calibrated from the original page into SI. */
export interface CurveFitPoint {x:number;y:number}
export interface CurveFitContext {
  temperatureC:number
  temperatureOrigin:'datasheet'|'user-assumption'
  page:number
  evidence:string
  evidenceKind?:'curve'|'maximum-rating'
  vdsV?:number
  /** Signed VGS is required; abs-current curves may use either single sign. */
  minimum?:number
  maximum?:number
  /** Workbench MOS1 instances use W=100u/L=10u. VDMOS/JFET do not use W/L. */
  mosWidthOverLength?:number
}
export interface CurveFitMetrics {
  inputCount:number;usedCount:number;temperatureC:number
  xMinimum?:number;xMaximum?:number;yMinimum?:number;yMaximum?:number
  /** Smallest/largest eigenvalue of the centered, scaled regression Gram matrix. */
  conditionRatio?:number
  maxAbsoluteResidual?:number;rmsAbsoluteResidual?:number
  maxRelativeResidual?:number;rmsRelativeResidual?:number
  residualQuantity?:'voltage'|'current'
}
export interface DatasheetCurveFitResult {parameters:ApproximateParameter[];limitations:string[];metrics:CurveFitMetrics;reason?:string}
export interface DatasheetCurveFitRequest {template:ImportedSpiceModel;curveKind:DatasheetCurveKind;points:readonly CurveFitPoint[];context:CurveFitContext}

/** Symmetric 2/3-column Gram spectrum, after centering/scaling each predictor. */
function conditionRatio(rows:number[][]):number {
  const n=rows[0].length,m=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>rows.reduce((sum,row)=>sum+row[i]*row[j],0)))
  for(let sweep=0;sweep<30;sweep++){
    let a=0,b=1
    for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)if(Math.abs(m[i][j])>Math.abs(m[a][b])){a=i;b=j}
    if(Math.abs(m[a][b])<1e-12*Math.max(1,...m.map((row,i)=>Math.abs(row[i]))))break
    const theta=.5*Math.atan2(2*m[a][b],m[b][b]-m[a][a]),c=Math.cos(theta),s=Math.sin(theta),aa=m[a][a],bb=m[b][b],ab=m[a][b]
    for(let k=0;k<n;k++)if(k!==a&&k!==b){const ka=m[k][a],kb=m[k][b];m[k][a]=m[a][k]=c*ka-s*kb;m[k][b]=m[b][k]=s*ka+c*kb}
    m[a][a]=c*c*aa-2*c*s*ab+s*s*bb;m[b][b]=s*s*aa+2*c*s*ab+c*c*bb;m[a][b]=m[b][a]=0
  }
  const values=m.map((row,i)=>row[i]);return Math.max(0,Math.min(...values))/Math.max(...values)
}

export function fitDatasheetCurve({template,curveKind,points,context}:DatasheetCurveFitRequest):DatasheetCurveFitResult {
  const limitations:string[]=[],metrics:CurveFitMetrics={inputCount:points.length,usedCount:0,temperatureC:context.temperatureC}
  const fail=(reason:string):DatasheetCurveFitResult=>({parameters:[],limitations,metrics,reason})
  if(!isManufacturerReference(template))return fail('拟合需要可追溯厂商模型模板，未改动模板。')
  if(points.length<3||points.length>60||points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)))return fail('曲线需要 3–60 个有限、已校准为 SI 的原图点。')
  if(!Number.isFinite(context.temperatureC)||context.temperatureC< -50||context.temperatureC>150)return fail('曲线温度必须是 -50 至 150°C 的单一明确数值。')
  if(!['datasheet','user-assumption'].includes(context.temperatureOrigin))return fail('必须说明曲线温度来自规格书还是用户假设，不能编造温度。')
  if(!Number.isInteger(context.page)||context.page<1||!context.evidence?.trim()||context.evidence.length>1200||/[\x00-\x1f]/.test(context.evidence))return fail('需要原曲线页码和可追溯的单行证据，不能从额定表生成曲线点。')
  if(context.evidenceKind==='maximum-rating')return fail('最大额定值不是转移/正向特性曲线，不能用作拟合点。')
  if(context.temperatureOrigin==='user-assumption')limitations.push(`温度 ${context.temperatureC}°C 是用户假设，原图未证明该温度下的器件表现；不能标为手册实测温度。`)
  limitations.push('只拟合选取的单温度曲线片段；不证明点外行为、温漂、动态、噪声或完整器件精度。')
  const rawMin=Math.min(...points.map(p=>p.x)),rawMax=Math.max(...points.map(p=>p.x)),minimum=context.minimum??rawMin,maximum=context.maximum??rawMax
  if(![minimum,maximum].every(Number.isFinite)||minimum>=maximum||minimum<rawMin||maximum>rawMax)return fail('工作范围必须位于已读取曲线点的横轴范围内，不能点外外推。')
  const selected=points.filter(p=>p.x>=minimum&&p.x<=maximum).sort((a,b)=>a.x-b.x),unique:CurveFitPoint[]=[]
  for(const p of selected){const prior=unique.at(-1);if(prior?.x===p.x){if(prior.y!==p.y)return fail(`横轴 ${p.x} 存在冲突电流/电压点，请重新核对原图。`)}else unique.push({...p})}
  metrics.usedCount=unique.length
  if(unique.length<3)return fail('工作范围内少于三个独立点，不能识别模型参数。')
  metrics.xMinimum=unique[0].x;metrics.xMaximum=unique.at(-1)!.x;metrics.yMinimum=Math.min(...unique.map(p=>p.y));metrics.yMaximum=Math.max(...unique.map(p=>p.y))
  const parsed=parseSpiceLibrary(template.spice,template.source),canonical=parsed.models.length===1?parsed.models[0]:undefined
  if(!canonical||parsed.diagnostics.some(d=>d.severity==='error')||canonical.kind!==template.kind||canonical.type!==template.type||canonical.technology!==template.technology)return fail('模板类型、技术或源码不一致，需重新导入厂商模板。')
  const numbers=new Map<string,number>(),invalid=new Set<string>()
  for(const match of canonical.spice.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\s*=\s*([^\s(),]+)/g)){const key=match[1].toUpperCase(),value=spiceParameterNumber(match[2]);if(value===undefined)invalid.add(key);else numbers.set(key,value)}
  const evidence=`第 ${context.page} 页曲线：${context.evidence.trim()}；${context.temperatureOrigin==='datasheet'?'手册温度':'用户假设温度'} ${context.temperatureC}°C；横轴 ${metrics.xMinimum}..${metrics.xMaximum} SI；${unique.length} 个校准点`
  const parameter=(key:string,value:number):ApproximateParameter=>({key,value:value.toPrecision(12),evidence})
  if(curveKind==='bjt-gain')return fail('仅 hFE 曲线不能独立确定 BF、IKF、ISE/NE 与偏置影响；当前不支持据此强填 BJT 参数。')
  if(curveKind==='opamp-gain-frequency')return fail('幅频曲线不能直接映射未知厂商子电路内部极点/增益参数；当前不支持此类模板拟合。')
  if(curveKind==='diode-forward'){
    if(canonical.kind!=='D')return fail('二极管正向曲线需要 D 模板，不能套用其他器件。')
    for(const key of ['ISR','IKF','TRS1','TRS2'])if(invalid.has(key)||numbers.has(key)&&numbers.get(key)!==0)return fail(`模板 ${key} 会影响正向曲线，当前三参数方程不能消除该影响。`)
    if(unique.some(p=>p.x<=0||p.y<=0))return fail('二极管曲线横轴为正向 V，纵轴为正向 A，不能混入反向点。')
    const logs=unique.map(p=>Math.log(p.y)),currents=unique.map(p=>p.y),mean=(values:number[])=>values.reduce((a,b)=>a+b,0)/values.length,lc=mean(logs),ic=mean(currents),ls=Math.max(...logs.map(x=>Math.abs(x-lc))),is=Math.max(...currents.map(x=>Math.abs(x-ic)))
    metrics.conditionRatio=ls&&is?conditionRatio(unique.map((p,i)=>[(logs[i]-lc)/ls,(p.y-ic)/is,1])):0
    if(metrics.conditionRatio<1e-5)return fail('正向曲线矩阵条件比不足，无法可靠分离 IS/N/RS。')
    const fitted=fitDiodeForwardPoints(unique.map(p=>({voltageV:p.x,currentA:p.y,temperatureC:context.temperatureC,page:context.page,evidence})))
    if(fitted.reason)return fail(fitted.reason)
    const values=Object.fromEntries(fitted.parameters.map(p=>[p.key!,Number(p.value)])),thermal=8.617333262145e-5*(context.temperatureC+273.15)
    const residuals=unique.map(p=>p.x-(values.N*thermal*Math.log1p(p.y/values.IS)+values.RS*p.y))
    metrics.residualQuantity='voltage';metrics.maxAbsoluteResidual=Math.max(...residuals.map(Math.abs));metrics.rmsAbsoluteResidual=Math.sqrt(residuals.reduce((sum,r)=>sum+r*r,0)/residuals.length)
    limitations.push('仅确定 IS/N/RS/TNOM；反向恢复、结电容与反向击穿等沿用模板，未从这条曲线拟合。')
    return {parameters:fitted.parameters.map(p=>({key:p.key!,value:p.value,evidence})),limitations,metrics}
  }
  const mos=curveKind==='mos-transfer',jfet=curveKind==='jfet-transfer'
  if(!mos&&!jfet)return fail('不支持的曲线类型。')
  if(mos?canonical.kind!=='M':canonical.kind!=='J')return fail('曲线与厂商模板的器件类型不一致。')
  if(mos&&canonical.technology!=='VDMOS'&&(invalid.has('LEVEL')||(numbers.get('LEVEL')??1)!==1))return fail('转移曲线平方律仅支持 MOS Level 1 或受支持的 VDMOS；不能套用 Level 2/3、BSIM。')
  const relevant=['RS','RD','LAMBDA','TNOM',...(mos?canonical.technology==='VDMOS'?['THETA','RQ','RDS','SUBSHIFT','KSUBTHRES']:['RSH','LD']:['B'])]
  if(relevant.some(key=>invalid.has(key)))return fail(`模板 ${relevant.filter(key=>invalid.has(key)).join('/')} 不是可解析常数，不能忽略其曲线影响。`)
  for(const key of mos?canonical.technology==='VDMOS'?['THETA','RQ','SUBSHIFT','KSUBTHRES']:['RSH','LD']:['B'])if(numbers.has(key)&&numbers.get(key)!==0&&!(jfet&&key==='B'&&numbers.get(key)===1))return fail(`模板 ${key} 改变平方律/几何关系，当前拟合不支持。`)
  const polarity=['PMOS','PJF'].includes(canonical.type)?-1:1,vds=polarity*(context.vdsV??NaN)
  if(!Number.isFinite(vds)||vds<=0)return fail('转移曲线必须给出原图有证据的 VDS 测试电压及正确 N/P 极性。')
  const rs=numbers.get('RS')??0,rd=numbers.get('RD')??0,lambda=numbers.get('LAMBDA')??0,rds=numbers.get('RDS')
  if(rs<0||rd<0||lambda<0||rds!==undefined&&rds<=0)return fail('模板串联电阻、输出电阻或 LAMBDA 超出当前可校正范围。')
  const ratio=mos&&canonical.technology!=='VDMOS'?(context.mosWidthOverLength??10):1
  if(!Number.isFinite(ratio)||ratio<=0||ratio>1e8)return fail('MOS W/L 必须为有限正值。')
  if(mos&&canonical.technology!=='VDMOS'&&!context.mosWidthOverLength)limitations.push('KP 采用工作台实例 W=100µm、L=10µm（W/L=10），更改实例几何会改变电流。')
  limitations.push(`假定体端接源极；固定 VDS=${context.vdsV}V，沿用模板 RS=${rs}Ω、RD=${rd}Ω、LAMBDA=${lambda}/V，逐点消除其静态影响；这些参数没有重新拟合。`)
  const signs=new Set(unique.filter(p=>p.y!==0).map(p=>Math.sign(p.y)))
  if(signs.size>1||unique.some(p=>p.y===0))return fail('转移曲线电流不能为零或跨越正反方向；需选取同一导通支路。')
  const normalized=unique.map(p=>{
    const total=Math.abs(p.y),internalVds=vds-total*(rs+rd),current=total-(rds?internalVds/rds:0)
    return {point:p,x:polarity*p.x-total*rs,root:Math.sqrt(current/(1+lambda*internalVds)),current,internalVds,total}
  }).sort((a,b)=>a.x-b.x)
  if(normalized.some(p=>p.current<=0||p.internalVds<=0||!Number.isFinite(p.root)))return fail('模板串联压降/漏电修正后没有正的有效通道电流或 VDS。')
  if(jfet&&normalized.some(p=>p.x>1e-8))return fail('JFET 所选点使栅结正偏；平方律夹断模型不能代表此曲线段。')
  const currents=normalized.map(p=>p.current)
  if(Math.max(...currents)/Math.min(...currents)<4)return fail('转移电流跨度不足四倍，阈值与跨导系数不能可靠分离。')
  const xc=normalized.reduce((sum,p)=>sum+p.x,0)/normalized.length,yc=normalized.reduce((sum,p)=>sum+p.root,0)/normalized.length,spread=Math.max(...normalized.map(p=>Math.abs(p.x-xc)))
  if(spread<1e-4*Math.max(1,Math.abs(xc)))return fail('栅压跨度过窄，阈值截距拟合病态。')
  metrics.conditionRatio=conditionRatio(normalized.map(p=>[(p.x-xc)/spread,1]))
  if(metrics.conditionRatio<1e-5)return fail('转移拟合矩阵条件比不足。')
  const factor=mos ? .5*ratio : 1
  const sumXX=normalized.reduce((sum,p)=>sum+(p.x-xc)**2,0),slope=normalized.reduce((sum,p)=>sum+(p.x-xc)*(p.root-yc),0)/sumXX,threshold=xc-yc/slope,coefficient=slope*slope/factor
  if(![slope,threshold,coefficient].every(Number.isFinite)||slope<=0||coefficient<=0||coefficient>1e6||coefficient<1e-15||(mos?!(threshold>0&&threshold<1000):!(threshold<0&&threshold> -1000)))return fail('曲线不能形成当前模板极性下合理的阈值和跨导系数。')
  if(normalized.some(p=>p.x<=threshold||p.internalVds<p.x-threshold))return fail('所选点不全在饱和区：必须逐点满足内部 |VDS| >= 归一化 VGS − VTO，不能把线性区套入饱和平方律。')
  if(Math.abs(threshold-xc)>20*spread)return fail('阈值截距距测量区间过远，外推病态，未生成参数。')
  const absolute=normalized.map(p=>{const predicted=factor*coefficient*(p.x-threshold)**2*(1+lambda*p.internalVds)+(rds?p.internalVds/rds:0);return predicted-p.total}),relative=absolute.map((r,i)=>r/normalized[i].total)
  metrics.residualQuantity='current';metrics.maxAbsoluteResidual=Math.max(...absolute.map(Math.abs));metrics.rmsAbsoluteResidual=Math.sqrt(absolute.reduce((sum,r)=>sum+r*r,0)/absolute.length);metrics.maxRelativeResidual=Math.max(...relative.map(Math.abs));metrics.rmsRelativeResidual=Math.sqrt(relative.reduce((sum,r)=>sum+r*r,0)/relative.length)
  if(metrics.maxRelativeResidual>.05||metrics.rmsRelativeResidual>.03)return fail(`平方律电流残差超限：最大 ${(100*metrics.maxRelativeResidual).toPrecision(4)}%、RMS ${(100*metrics.rmsRelativeResidual).toPrecision(4)}%；未生成参数。`)
  const parameters=[parameter('VTO',mos?polarity*threshold:threshold),parameter(mos?'KP':'BETA',coefficient)]
  const tnom=numbers.get('TNOM')??27
  if(context.temperatureC!==tnom){parameters.push(parameter('TNOM',context.temperatureC));limitations.push(`须同步应用 TNOM=${context.temperatureC}°C；保留模板 TNOM=${tnom}°C 会让求解器二次温度换算，不能只应用 VTO/跨导系数。`)}
  else limitations.push(`拟合温度与模板 TNOM=${tnom}°C 一致，保留原 TNOM；温度系数仍未拟合。`)
  if(jfet)limitations.push('NJF/PJF 都输出负模型 VTO；P 沟道外部正 VGS 转换为内部负栅压，BETA 不交换端子。')
  return {parameters,limitations,metrics}
}
