import type { ModelParameterSummary as Summary } from '../core/model-parameters'

export default function ModelParameterSummary({summary,draft=false}:{summary:Summary;draft?:boolean}) {
  return <section className="model-parameter-summary" aria-label={draft?'模型草稿关键参数':'当前模型关键参数'}>
    <header><strong>{summary.title}</strong><span>{draft?'未应用草稿':'当前生效'}</span></header>
    {summary.description&&<p aria-label="模型说明">{summary.description}</p>}
    {summary.forwardReference&&<aside className="model-forward-reference" aria-label="LED 正向压降参考"><strong>LED 正向压降 VF（模型参考）</strong><dl>{summary.forwardReference.points.map(point=><div key={point.current}><dt>{point.current*1000} mA · {summary.forwardReference!.temperature}℃</dt><dd><strong>约 {point.voltage.toFixed(2)} V</strong></dd></div>)}</dl><p>压降随电流、温度变化，不是固定的电压设定值。以上为此通用模型的方程估算；实际电路压降请运行仿真并测量 LED 两端电压。此模型不代表具体厂商 LED。</p></aside>}
    {summary.rows.length>0&&<dl>{summary.rows.map(row=><div key={row.key} title={`${row.note}；来源：${row.source}`}><dt><span>{row.label}</span><code>{row.key}</code></dt><dd><strong>{row.value}{row.unit&&` ${row.unit}`}</strong><small>{row.source}</small></dd></div>)}</dl>}
    <p>{summary.note}</p>
  </section>
}
