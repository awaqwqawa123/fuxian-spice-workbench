import type { Project } from './circuit'
import { compileDrawing, parseDrawing, terminalKey, type DeviceKind } from './drawing'
import { deviceCatalog, pinsFor } from './devices'

export type CircuitGraphSection = 'components' | 'nets' | 'terminals'
export interface CircuitGraphQuery {
  section: CircuitGraphSection
  deviceIds?: string[]
  netIds?: string[]
  offset: number
  limit: number
}
export interface CircuitGraphPin {
  /** Index in the drawing's electrical terminal array, never a package number. */
  pinIndex: number
  name: string
  netId: string
  physicalPinNumber?: string
}
export interface CircuitGraphComponent {
  deviceId: string
  kind: DeviceKind
  value: string
  pinOrdering: 'drawing-terminals' | 'subcircuit-ports'
  pins: CircuitGraphPin[]
  /** Display-only original symbol pins have no inferred electrical connection. */
  physicalOnlyPins?: { name: string; physicalPinNumber?: string }[]
}
export interface CircuitGraphNet {
  netId: string
  ground: boolean
  componentCount: number
  terminalCount: number
  junctionCount: number
  labelCount: number
}
export interface CircuitGraphTerminal extends CircuitGraphPin { deviceId: string }
export interface CircuitSemanticGraph {
  schemaVersion: 1
  section: CircuitGraphSection
  items: (CircuitGraphComponent | CircuitGraphNet | CircuitGraphTerminal)[]
  /** Matching entries before pagination; summary always describes the full drawing. */
  total: number
  offset: number
  limit: number
  nextOffset: number | null
  summary: { components: number; nets: number; terminals: number; junctions: number; wires: number; labels: number }
  compiler: {
    name: 'compileDrawing'
    pinIndexMeaning: 'drawing-terminal-index'
    netIdScope: 'project-snapshot'
    sourceId: string | null
    inputNetId: string | null
    outputNetId: string | null
    connectivityIssueCount: number
  }
  issues: string[]
  issueCount: number
}

const idListSchema = { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$' } }
export const circuitGraphQueryProperties = {
  section: { type: 'string', enum: ['components', 'nets', 'terminals'], default: 'components' },
  deviceIds: idListSchema,
  netIds: idListSchema,
  offset: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
  limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
}

export function parseCircuitGraphQuery(input: unknown): CircuitGraphQuery {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('graph_query_invalid: expected query object')
  const raw = input as Record<string, unknown>
  if (Object.keys(raw).some(key => !Object.hasOwn(circuitGraphQueryProperties, key))) throw new Error('graph_query_invalid: unsupported query field')
  const section = raw.section === undefined ? 'components' : raw.section, offset = raw.offset === undefined ? 0 : raw.offset, limit = raw.limit === undefined ? 50 : raw.limit
  if (!['components', 'nets', 'terminals'].includes(String(section)) || typeof section !== 'string') throw new Error('graph_query_invalid: unsupported section')
  if (!Number.isInteger(offset) || (offset as number) < 0 || (offset as number) > 100000) throw new Error('graph_query_invalid: offset must be an integer from 0 to 100000')
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new Error('graph_query_invalid: limit must be an integer from 1 to 100')
  const ids = (key: 'deviceIds' | 'netIds') => {
    const value = raw[key]
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.length < 1 || value.length > 32 || value.some(id => typeof id !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,64}$/.test(id)) || new Set(value).size !== value.length) throw new Error(`graph_query_invalid: ${key} must contain 1 to 32 unique exact IDs`)
    return [...value] as string[]
  }
  const deviceIds = ids('deviceIds'), netIds = ids('netIds')
  return { section: section as CircuitGraphSection, offset: offset as number, limit: limit as number, ...(deviceIds ? { deviceIds } : {}), ...(netIds ? { netIds } : {}) }
}

/** Uses the same terminal unions and net naming as the production netlist compiler. */
export function readCircuitSemanticGraph(project: Project, input: CircuitGraphQuery): CircuitSemanticGraph {
  const query = parseCircuitGraphQuery(input)
  if (project.template !== 'custom') throw new Error('graph_template_unsupported: convert the template to an editable drawing first')
  let drawing: ReturnType<typeof parseDrawing>, compiled: ReturnType<typeof compileDrawing>
  try {
    drawing = parseDrawing(project.drawing)
    compiled = compileDrawing(drawing)
  } catch {
    // Parser errors can contain input values; expose a fixed message to external callers.
    throw new Error('graph_drawing_invalid: drawing contains malformed or dangling electrical references')
  }
  const issues = [...compiled.errors]
  const components: CircuitGraphComponent[] = drawing.devices.map(device => {
    const model = project.models?.find(item => item.kind === device.kind && item.id.toLowerCase() === device.value.toLowerCase())
    const matchingModelPorts = device.kind !== 'X' || Boolean(model && JSON.stringify(device.pins) === JSON.stringify(model.pins))
    if (device.kind === 'X' && !model) issues.push(`${device.id}: subcircuit model evidence is unavailable; electrical port assignment requires review`)
    if (device.kind === 'X' && model && !matchingModelPorts) issues.push(`${device.id}: drawing subcircuit ports do not match the selected model; electrical port assignment requires review`)
    const pins = pinsFor(device).map(pinIndex => {
      const symbolPin = matchingModelPorts ? model?.symbol?.pins.find(pin => pin.index === pinIndex) : undefined
      return {
        pinIndex,
        name: device.kind === 'X' ? device.pins![pinIndex] : deviceCatalog[device.kind].pins[pinIndex],
        netId: compiled.nodes.get(terminalKey({ device: device.id, pin: pinIndex }))!,
        ...(symbolPin?.number ? { physicalPinNumber: symbolPin.number } : {}),
      }
    })
    const physicalOnlyPins = model?.symbol?.physicalPins?.map(pin => ({ name: pin.label, ...(pin.number ? { physicalPinNumber: pin.number } : {}) }))
    return { deviceId: device.id, kind: device.kind, value: device.value, pinOrdering: device.kind === 'X' ? 'subcircuit-ports' : 'drawing-terminals', pins, ...(physicalOnlyPins?.length ? { physicalOnlyPins } : {}) }
  })
  const terminals: CircuitGraphTerminal[] = components.flatMap(component => component.pins.map(pin => ({ deviceId: component.deviceId, ...pin })))
  const nets: CircuitGraphNet[] = [...new Set(compiled.nodes.values())].sort().map(netId => {
    const endpoints = terminals.filter(pin => pin.netId === netId)
    return {
      netId, ground: netId === '0', componentCount: new Set(endpoints.map(pin => pin.deviceId)).size, terminalCount: endpoints.length,
      junctionCount: drawing.junctions.filter(junction => compiled.nodes.get(junction.id) === netId).length,
      labelCount: (drawing.labels ?? []).filter(label => compiled.nodes.get(terminalKey(label.at)) === netId).length,
    }
  })
  const knownDevices = new Set(components.map(item => item.deviceId)), knownNets = new Set(nets.map(item => item.netId))
  if (query.deviceIds?.some(id => !knownDevices.has(id))) throw new Error('graph_device_not_found: at least one deviceId does not exist in the selected snapshot')
  if (query.netIds?.some(id => !knownNets.has(id))) throw new Error('graph_net_not_found: at least one netId does not exist in the selected snapshot')
  let matching: CircuitSemanticGraph['items']
  if (query.section === 'components') matching = components.filter(item => (!query.deviceIds || query.deviceIds.includes(item.deviceId)) && (!query.netIds || item.pins.some(pin => query.netIds!.includes(pin.netId))))
  else if (query.section === 'nets') matching = nets.filter(item => (!query.netIds || query.netIds.includes(item.netId)) && (!query.deviceIds || terminals.some(pin => pin.netId === item.netId && query.deviceIds!.includes(pin.deviceId))))
  else matching = terminals.filter(item => (!query.deviceIds || query.deviceIds.includes(item.deviceId)) && (!query.netIds || query.netIds.includes(item.netId)))
  const items = matching.slice(query.offset, query.offset + query.limit)
  const actualSource = drawing.devices.find(device => device.kind === 'V' && device.id === drawing.sourceId)
  return {
    schemaVersion: 1, section: query.section, items, total: matching.length, offset: query.offset, limit: query.limit,
    nextOffset: query.offset + items.length < matching.length ? query.offset + items.length : null,
    summary: { components: components.length, nets: nets.length, terminals: terminals.length, junctions: drawing.junctions.length, wires: drawing.wires.length, labels: drawing.labels?.length ?? 0 },
    compiler: { name: 'compileDrawing', pinIndexMeaning: 'drawing-terminal-index', netIdScope: 'project-snapshot', sourceId: actualSource?.id ?? null, inputNetId: actualSource ? compiled.nodes.get(terminalKey({ device: actualSource.id, pin: 0 }))! : null, outputNetId: drawing.output ? compiled.nodes.get(terminalKey(drawing.output))! : null, connectivityIssueCount: compiled.errors.length },
    issues: issues.slice(0, 50).map(issue => issue.slice(0, 240)), issueCount: issues.length,
  }
}

const stringSchema = { type: 'string' }
const nullableStringSchema = { anyOf: [stringSchema, { type: 'null' }] }
const countSchema = { type: 'integer', minimum: 0 }
const objectSchema = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false })
const pinProperties = { pinIndex: { type: 'integer', minimum: 0, maximum: 31 }, name: stringSchema, netId: stringSchema, physicalPinNumber: stringSchema }
const pinSchema = objectSchema(pinProperties, ['pinIndex', 'name', 'netId'])
const componentSchema = objectSchema({ deviceId: stringSchema, kind: { type: 'string', enum: Object.keys(deviceCatalog) }, value: stringSchema, pinOrdering: { type: 'string', enum: ['drawing-terminals', 'subcircuit-ports'] }, pins: { type: 'array', maxItems: 32, items: pinSchema }, physicalOnlyPins: { type: 'array', maxItems: 32, items: objectSchema({ name: stringSchema, physicalPinNumber: stringSchema }, ['name']) } }, ['deviceId', 'kind', 'value', 'pinOrdering', 'pins'])
const netSchema = objectSchema({ netId: stringSchema, ground: { type: 'boolean' }, componentCount: countSchema, terminalCount: countSchema, junctionCount: countSchema, labelCount: countSchema })
const terminalSchema = objectSchema({ deviceId: stringSchema, ...pinProperties }, ['deviceId', 'pinIndex', 'name', 'netId'])
export const circuitGraphOutputSchema = objectSchema({
  schemaVersion: { type: 'integer', const: 1 }, section: circuitGraphQueryProperties.section,
  items: { type: 'array', maxItems: 100, items: { oneOf: [componentSchema, netSchema, terminalSchema] } },
  total: countSchema, offset: circuitGraphQueryProperties.offset, limit: circuitGraphQueryProperties.limit,
  nextOffset: { anyOf: [countSchema, { type: 'null' }] },
  summary: objectSchema({ components: countSchema, nets: countSchema, terminals: countSchema, junctions: countSchema, wires: countSchema, labels: countSchema }),
  compiler: objectSchema({ name: { type: 'string', const: 'compileDrawing' }, pinIndexMeaning: { type: 'string', const: 'drawing-terminal-index' }, netIdScope: { type: 'string', const: 'project-snapshot' }, sourceId: nullableStringSchema, inputNetId: nullableStringSchema, outputNetId: nullableStringSchema, connectivityIssueCount: countSchema }),
  issues: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 240 } }, issueCount: countSchema,
})
