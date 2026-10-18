import type {CurveFitPoint} from './datasheet-curve-fit'
export function fitOpAmpGainCurve(points:readonly CurveFitPoint[]):{gain:number;gbw:number;poleHz:number;maxResidualDb:number;reason?:string}{
 const fail=(reason:string)=>({gain:0,gbw:0,poleHz:0,maxResidualDb:0,reason})
 if(points.length<4||points.length>60||points.some(point=>!Number.isFinite(point.x)||!Number.isFinite(point.y)||point.x<=0||point.y< -80||point.y>240))return fail('运放幅频曲线需要 4～60 个有效 Hz/dB 点。')
 const ordered=[...points].sort((a,b)=>a.x-b.x)
 if(ordered.at(-1)!.x/ordered[0].x<100||new Set(ordered.map(point=>point.x)).size!==ordered.length)return fail('幅频点须跨越至少两十倍频程且频率不重复。')
 const evaluate=(logPole:number)=>{const pole=Math.exp(logPole),values=ordered.map(point=>point.y+10*Math.log10(1+(point.x/pole)**2)),gainDb=values.reduce((sum,value)=>sum+value,0)/values.length;return {pole,gainDb,error:values.reduce((sum,value)=>sum+(value-gainDb)**2,0)/values.length,residual:Math.max(...values.map(value=>Math.abs(value-gainDb)))}}
 let left=Math.log(ordered[0].x/10),right=Math.log(ordered.at(-1)!.x*10)
 for(let step=0;step<90;step++){const one=left+(right-left)/3,two=right-(right-left)/3;if(evaluate(one).error<evaluate(two).error)right=two;else left=one}
 const fit=evaluate((left+right)/2),gain=10**(fit.gainDb/20),gbw=gain*fit.pole
 if(ordered[0].x>fit.pole/4||ordered.at(-1)!.x<fit.pole*4)return fail('曲线未同时覆盖低频平台和主极点后的下降区，不能独立确定增益与带宽。')
 if(fit.residual>2||gain<10||gain>1e12||!Number.isFinite(gbw)||gbw<=0||gbw>1e10)return fail('曲线偏离单主极点模型，或增益/带宽超出可校验范围；不能将多极点曲线强行套用。')
 return {gain,gbw,poleHz:fit.pole,maxResidualDb:fit.residual}
}
