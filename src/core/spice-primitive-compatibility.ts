/** Compatibility lowering applies to validated execution text only. Keep the
 * imported source in the model record; never write this output back to it. */
export interface PrimitiveCompatibilityFinding {
  model: string
  parameter: string
  originalValue: string
  kind: 'equivalent-default' | 'engine-domain-limit'
  message: string
}
export interface PrimitiveCompatibilityResult { spice: string; findings: PrimitiveCompatibilityFinding[] }

const numeric=/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(t|g|meg|k|m|u|n|p|f)?$/i
const scales:Record<string,number>={t:1e12,g:1e9,meg:1e6,k:1e3,m:1e-3,u:1e-6,n:1e-9,p:1e-12,f:1e-15}
function constant(raw:string){const match=numeric.exec(raw);return match?Number(match[1])*(scales[match[2]?.toLowerCase()]??1):undefined}
// Compare the written mantissa, so a nonzero value that underflows JavaScript
// arithmetic cannot accidentally be treated as an exact zero.
function exactZero(raw:string){const match=numeric.exec(raw);return Boolean(match&&!/[1-9]/.test(match[1].split(/e/i)[0]))}

/** ngspice's diode IKF default is zero (high injection disabled). Explicit zero
 * trips its "too small" warning while the implicit default runs the identical
 * disabled equation. Only exact numeric zero can use that equivalent default.
 * Nonzero IKF and BJT values outside engine limits retain their original values.
 * Model-card scope keeps device instances, comments and parameter expressions
 * outside this conversion. Existing canonical importer emits one-line cards. */
export function primitiveModelCompatibility(spice:string):PrimitiveCompatibilityResult {
  const findings:PrimitiveCompatibilityFinding[]=[]
  const lowered=spice.split('\n').map(line=>{
    const card=/^(\s*\.model\s+(\S+)\s+(D|NPN|PNP)\s*\()([^()]*)\)(\s*)$/i.exec(line)
    if(!card)return line
    const [,header,model,type,body,trailing]=card
    const assignments=[...body.matchAll(/(?:^|[\s,])([a-z][a-z0-9_]*)\s*=\s*([^\s,]+)/gi)]
    const zero=assignments.filter(item=>item[1].toUpperCase()==='IKF')
    if(type.toUpperCase()==='D'&&zero.length===1&&exactZero(zero[0][2])){
      const token=zero[0],start=token.index!,remainder=body.slice(0,start)+body.slice(start+token[0].length)
      findings.push({model,parameter:'IKF',originalValue:token[2],kind:'equivalent-default',message:'原定义 IKF=0 保留；执行时使用 ngspice 相同的零默认值（禁用高注入效应），不裁剪非零参数。'})
      return `* Execution compatibility: ${model} original IKF=${token[2]}; identical ngspice default 0 (high injection disabled)\n${header}${remainder.trim()})${trailing}`
    }
    if(type.toUpperCase()==='NPN'||type.toUpperCase()==='PNP')for(const assignment of assignments){
      const parameter=assignment[1].toUpperCase(),value=constant(assignment[2])
      if(value===undefined)continue
      const limit=['NK','NKF'].includes(parameter)?1:['MJE','MJC'].includes(parameter)?.999:undefined
      if(limit!==undefined&&value>limit)findings.push({model,parameter,originalValue:assignment[2],kind:'engine-domain-limit',message:`原参数 ${parameter}=${assignment[2]} 超出当前 ngspice 上限 ${limit}；引擎会自行限幅，未修改源码，不能视为原模型精度已保留。`})
    }
    return line
  }).join('\n')
  return {spice:lowered,findings}
}
