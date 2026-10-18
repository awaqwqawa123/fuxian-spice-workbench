export function nearestSample(x:readonly number[], target:number, logarithmic=false):number {
  const transform=(v:number)=>logarithmic?Math.log10(v):v
  const value=transform(target),direction=x.length>1&&x.at(-1)!<x[0]?-1:1
  let low=0,high=x.length-1
  while(low<high){const mid=(low+high)>>1;if(transform(x[mid])*direction<value*direction)low=mid+1;else high=mid}
  return low>0&&Math.abs(transform(x[low-1])-value)<Math.abs(transform(x[low])-value)?low-1:low
}
export function measureCursors(x:readonly number[],y:readonly number[],a:number,b:number) {
  if(!Number.isInteger(a)||!Number.isInteger(b)||a<0||b<0||a>=x.length||b>=x.length||x.length!==y.length)throw new Error('游标超出采样范围')
  return {ax:x[a],ay:y[a],bx:x[b],by:y[b],dx:x[b]-x[a],dy:y[b]-y[a]}
}
