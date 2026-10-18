import type { ModelAssessment, ModelAssessmentStatus } from '../core/modeling-assessment'
import type { ImportedSpiceModel } from '../core/spice-models'
import type { ModelReferenceAdjustment } from '../core/model-reference'
import { equivalentModelParameterValues } from '../core/model-parameter-values'

const labels: Record<ModelAssessmentStatus, string> = {
  adjusted: '实际修改', unchanged: '数值一致', inherited: '沿用参考', unmapped: '尚未映射', missing: '缺少依据',
}
const syntaxLabels = { passed: '语法检查通过', failed: '语法检查未通过', unchecked: '语法检查尚未记录' }
export function equivalentReviewValues(before: string, after: string): boolean {
  if (equivalentModelParameterValues(before, after)) return true
  const a = before.trim().match(/^(\S+)\s+([A-Za-zΩμµ]+)$/), b = after.trim().match(/^(\S+)\s+([A-Za-zΩμµ]+)$/)
  return Boolean(a && b && a[2] === b[2] && equivalentModelParameterValues(a[1], b[1]))
}

/** Older results retain their recorded edits without inventing target coverage. */
export function legacyModelingAssessment(model?: ImportedSpiceModel, origin?: 'downloaded' | 'derived', adjustments: ModelReferenceAdjustment[] = []): ModelAssessment {
  return { version: 1, status: model ? origin === 'downloaded' ? 'original' : 'partial' : 'blocked', family: model?.type ?? '待确认器件类型',
    summary: model ? '旧记录未保存逐项建模覆盖评估。以下只呈现已记录的参数变化，不能据此判断目标器件已完整建模。' : '旧结果没有可导入候选，也未记录具体阻塞评估。需要补齐可核对的建模资料后继续。',
    items: [...adjustments.map(item => ({ label: item.key, key: item.key, status: equivalentReviewValues(item.before,item.after) ? 'unchanged' as const : 'adjusted' as const, before: item.before, after: item.after, ...(item.source ? { evidence: item.source } : {}), reason: item.explanation || '这份记录中的参数调整；目标行为仍需核对。' })),
      { label: '目标指标、模板与方程映射', status: 'missing', reason: model ? '这份旧记录未包含完整覆盖清单。请补充规格书或重新评估参考模型，明确已覆盖与尚未建模的指标。' : '未记录可校准参考模板、明确端口对应关系和有测试条件的数据证据。请提供原厂模型，或同功能参考源码与规格书，再继续建模。' }],
    validation: { syntax: 'unchecked', simulation: 'not-run' } }
}

/** Coverage is visible before saving or placing a model, including old results. */
export default function ModelingScopePanel({ assessment, legacy = false }: { assessment: ModelAssessment; legacy?: boolean }) {
  const gaps = assessment.items.filter(item => item.status === 'missing' || item.status === 'unmapped')
  const familyLabels:Record<string,string>={D:'二极管',BJT:'三极管',NPN:'NPN 三极管',PNP:'PNP 三极管',MOS:'MOS 管',NMOS:'N 沟道 MOS 管',PMOS:'P 沟道 MOS 管',JFET:'结型场效应管',NJF:'N 沟道 JFET',PJF:'P 沟道 JFET',shunt:'可调分流基准',opamp:'运算放大器',LDO:'低压差稳压器',IC:'集成器件',SUBCKT:'子电路器件'}
  const visible = assessment.items.slice(0,8), remaining=assessment.items.slice(8)
  const renderItems=(items:ModelAssessment['items'])=><div className="modeling-scope-items">{items.map((item, index) => <article key={`${item.key ?? item.label}-${index}`} data-coverage-status={item.status}>
    <div className="modeling-scope-item-heading"><strong>{item.label}{item.key && <code>{item.key}</code>}</strong><span>{labels[item.status]}</span></div>
    {item.targetValue && <p>目标规格：<b>{item.targetValue}</b></p>}
    {(item.before || item.after) && <p className="modeling-scope-values">{item.status === 'adjusted' ? <>参考值 <code>{item.before ?? '未记录'}</code> → 当前值 <code>{item.after ?? '未记录'}</code></> : <>当前值 <code>{item.after ?? item.before}</code>{item.status === 'unchanged' && ' · 与参考值一致，未修改'}</>}</p>}
    <p>{item.reason}</p>
    {item.evidence && <details><summary>查看数据依据</summary><p>{item.evidence}</p></details>}
  </article>)}</div>
  return <section className={`modeling-scope is-${assessment.status}`} aria-label="建模覆盖与缺项">
    <header><h4>建模覆盖与缺项</h4><span>{familyLabels[assessment.family]??assessment.family}</span></header>
    <p className="modeling-scope-summary">{assessment.summary}</p>
    <p className="modeling-scope-verification">{legacy && assessment.status !== 'blocked' ? '这份旧模型的目标覆盖范围尚未完整记录；电气行为未验证。' : assessment.status === 'partial' ? '近似模型仅覆盖下列已记录的行为，尚不完整；电气行为未验证。' : assessment.status === 'blocked' ? '当前无法形成有依据的可导入模型；资料与任务仍可保留，补齐缺项后继续。' : '保留原始模型不代表已匹配目标器件；电气行为未验证。'}{syntaxLabels[assessment.validation.syntax]}；尚未运行仿真验证。</p>
    {!assessment.items.some(item => item.status === 'adjusted') && <p className="modeling-scope-zero">当前未记录参数数值变化。相同数值或已提取的指标不会计为修改。</p>}
    {renderItems(visible)}
    {remaining.length>0&&<details className="modeling-scope-all"><summary>查看其余 {remaining.length} 项核对结果 · 共 {assessment.items.length} 项</summary>{renderItems(remaining)}</details>}
    {gaps.length > 0 && <p className="modeling-scope-next">下一步：补充上述缺项对应的规格书测试条件或曲线；需要新的器件行为时，提供同功能参考模型与明确端口定义，再重新核对模型并运行仿真。</p>}
  </section>
}
