export interface LegacyDiodeStateDiagnostic {
  model: string
  severity: 'notice' | 'error'
  message: string
}

export interface LegacyDiodeStateResult {
  netlist: string
  convertedModels: string[]
  diagnostics: LegacyDiodeStateDiagnostic[]
}

interface LogicalLine {
  text: string
  start: number
  end: number
}

interface MacroBlock {
  id: string
  header: LogicalLine
  body: LogicalLine[]
}

const adapterMarker = '* Execution compatibility: '

/** Execution-only adapter for the verified Cadence di.lib one-diode macro family.
 * Call only with the COMPLETE invocation netlist and roots whose retained source
 * identifies di.lib. An isolated definition cannot rule out instance overrides.
 * Original records, checksums, model pins and saved definitions stay untouched.
 * Unknown STATE expressions remain errors; OFF is not a dynamic ngspice flag.
 */
export function normalizeLegacyDiodeDefaultStates(
  netlist: string,
  sourceVerifiedRoots: readonly string[],
): LegacyDiodeStateResult {
  const eligible = new Set(sourceVerifiedRoots.map(id => id.toLowerCase()))
  const diagnostics: LegacyDiodeStateDiagnostic[] = []
  const convertedModels: string[] = []
  if (!eligible.size) return { netlist, diagnostics, convertedModels }

  const rawLines = netlist.split('\n')
  const lines: LogicalLine[] = []
  for (let i = 0; i < rawLines.length; i++) {
    const text = rawLines[i].trim()
    if (/^\+/.test(text) && lines.length) {
      const last = lines.at(-1)!
      last.text += ' ' + text.slice(1).trim()
      last.end = i
    } else {
      lines.push({ text, start: i, end: i })
    }
  }

  const blocks: MacroBlock[] = []
  let block: MacroBlock | undefined
  for (const line of lines) {
    if (line.text.startsWith('*') || !line.text) continue
    const start = /^\.subckt\s+(\S+)/i.exec(line.text)
    if (start) {
      if (block) return {
        netlist, convertedModels,
        diagnostics: [{ model: block.id, severity: 'error', message: '嵌套子电路尚未验证 STATE 范围，未转换原定义。' }],
      }
      block = { id: start[1], header: line, body: [] }
      continue
    }
    if (/^\.ends\b/i.test(line.text)) {
      if (block) blocks.push(block)
      block = undefined
      continue
    }
    block?.body.push(line)
  }
  if (block) return {
    netlist, convertedModels,
    diagnostics: [{ model: block.id, severity: 'error', message: '子电路定义未闭合，未转换原定义。' }],
  }

  const roots = blocks.filter(item => eligible.has(item.id.toLowerCase()) &&
    item.body.some(line => /\{STATE\}/i.test(line.text) || rawLines[line.start - 1]?.trim() === `${adapterMarker}${item.id} di.lib default STATE=1; native PSpice DC/transient verified; original source retained`))
  if (!roots.length) return { netlist, diagnostics, convertedModels }
  const override = lines.find(line => !line.text.startsWith('*') && (
    (/^X\S*\s/i.test(line.text) && /\b(?:STATE(?:_FACTOR)?|IC)\s*=/i.test(line.text)) ||
    (/^\.(?:param|func)\b/i.test(line.text) && /\b(?:STATE(?:_FACTOR)?|IC)\b/i.test(line.text)) ||
    (/^\.tran\b/i.test(line.text) && /\bUIC\b/i.test(line.text))
  ))
  if (override) return {
    netlist, convertedModels,
    diagnostics: roots.map(({ id }) => ({
      model: id, severity: 'error',
      message: `调用网表包含 STATE/IC 覆盖、作用域表达式或 UIC 初始条件（${override.text.slice(0, 100)}）；保留原定义，需要原生 PSpice 或已验证的专项转换。`,
    })),
  }

  const definitionCounts = new Map<string, number>()
  for (const { id } of roots) definitionCounts.set(id.toLowerCase(), (definitionCounts.get(id.toLowerCase()) ?? 0) + 1)
  const replacements = new Map<number, { end: number; text: string }>()
  const constant = (value: string, expected: number) =>
    /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number(value) === expected

  for (const { id, header, body } of roots) {
    const fail = (message: string) => diagnostics.push({ model: id, severity: 'error', message })
    // di.lib also contains other macros. Only this positional state argument is
    // our responsibility; existing compatible definitions must not be blocked.
    if (!body.some(line => /\{STATE\}/i.test(line.text) || rawLines[line.start - 1]?.trim() === `${adapterMarker}${id} di.lib default STATE=1; native PSpice DC/transient verified; original source retained`)) continue
    if (definitionCounts.get(id.toLowerCase()) !== 1) {
      fail('重复根定义无法确认 STATE 作用域，未转换原定义。')
      continue
    }
    const state = [...header.text.matchAll(/\bSTATE\s*=\s*([^\s]+)/gi)]
    const factor = [...header.text.matchAll(/\bSTATE_FACTOR\s*=\s*([^\s]+)/gi)]
    const ic = [...header.text.matchAll(/\bIC\s*=\s*([^\s]+)/gi)]
    const ports = header.text.split(/\bPARAMS\s*:/i)[0].trim().split(/\s+/).slice(2)
    const devices = body.filter(line => !/^\./.test(line.text))
    const cards = body.filter(line => /^\.model\b/i.test(line.text))
    if (state.length !== 1 || !constant(state[0][1], 1) || factor.length !== 1 || !constant(factor[0][1], 0) || ports.length !== 2) {
      fail('该宏不是已验证的两端 di.lib 默认 STATE=1、STATE_FACTOR=0 形式；未转换原定义。')
      continue
    }
    const remainingHeader = header.text.replace(/\b(?:STATE(?:_FACTOR)?|IC)\s*=\s*[^\s]+/gi, '')
    if (ic.length !== 1 || !constant(ic[0][1], 1.10250e-36) || /\b(?:STATE(?:_FACTOR)?|IC)\b/i.test(remainingHeader) || cards.some(card => /\b(?:STATE(?:_FACTOR)?|IC)\b/i.test(card.text))) {
      fail('IC 默认值或 STATE/IC 表达式不属于已验证原库形式；未转换原定义。')
      continue
    }
    if (devices.length !== 1 || cards.length !== 1 || !/^\.model\s+\S+\s+D\b/i.test(cards[0].text) || body.length !== 2) {
      fail('该宏含额外器件或作用域语句，不属于已核对单二极管族；未转换原定义。')
      continue
    }
    const device = devices[0]
    const terminals = device.text.split(/\s+/)
    const localModel = /^\.model\s+(\S+)/i.exec(cards[0].text)?.[1]
    if (terminals[1].toLowerCase() !== ports[0].toLowerCase() || terminals[2].toLowerCase() !== ports[1].toLowerCase() || terminals[3].toLowerCase() !== localModel?.toLowerCase()) {
      fail('二极管端口或本地模型对应关系与已验证原库形式不一致；未转换原定义。')
      continue
    }
    const match = /^(D\S*\s+\S+\s+\S+\s+\S+\s+(?:AREA=)?\{AREA\})\s+\{STATE\}(\s+IC=\{IC\}\s*)$/i.exec(device.text)
    // A second full-netlist pass must not claim the already-adapted definition
    // is incompatible. Require our exact marker adjacent to the execution card.
    if (!match && rawLines[device.start - 1]?.trim() === `${adapterMarker}${id} di.lib default STATE=1; native PSpice DC/transient verified; original source retained`) continue
    if (!match) {
      fail('二极管 STATE 尾项或 AREA/IC 表达式与已验证原库形式不一致；未转换原定义。')
      continue
    }
    // AREA remains explicit for ngspice. The positional source spelling and IC
    // are preserved in the retained library source rather than rewritten there.
    const area = match[1].replace(/\s+\{AREA\}$/i, ' AREA={AREA}')
    replacements.set(device.start, {
      end: device.end,
      text: `${adapterMarker}${id} di.lib default STATE=1; native PSpice DC/transient verified; original source retained\n${area}${match[2]}`,
    })
    convertedModels.push(id)
    diagnostics.push({
      model: id, severity: 'notice',
      message: '原库默认 STATE=1 已通过原生 PSpice 对照；当前完整调用网表无 STATE/IC 覆盖且不使用 UIC，执行采用默认启动状态，AREA 和 IC 保留。',
    })
  }

  // An error retains the corresponding source card so uncertain definitions
  // still fail visibly rather than silently losing a positional argument.
  const output: string[] = []
  for (let i = 0; i < rawLines.length; i++) {
    const replacement = replacements.get(i)
    if (replacement) {
      output.push(replacement.text)
      i = replacement.end
    } else output.push(rawLines[i])
  }
  return { netlist: output.join('\n'), convertedModels, diagnostics }
}
