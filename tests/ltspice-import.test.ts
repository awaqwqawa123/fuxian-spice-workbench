import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { generateNetlist, parseProject, validateProject, type Project } from '../src/core/circuit'
import { compileDrawing, pinPosition, terminalKey, terminalPosition, wirePoints } from '../src/core/drawing'
import { importLtspiceSchematic } from '../src/core/ltspice-import'
import { applySimulationProfile, simulationReferenceWarning } from '../src/core/simulation-profiles'
import { simulate } from './simulate'

const rc = readFileSync(new URL('./fixtures/ltspice-rc.asc', import.meta.url), 'utf8')
const diode = readFileSync(new URL('./fixtures/ltspice-selfcontained-diode.asc', import.meta.url), 'utf8')
const asy = readFileSync(new URL('./fixtures/ltspice-import-buffer.asy', import.meta.url), 'utf8')
const circuit = (body: string) => `Version 4\nSHEET 1 2000 1200\n${body}\nTEXT 0 0 Left 2 !.op`
const voltage = 'SYMBOL voltage 0 0 R0\nSYMATTR InstName V1\nSYMATTR Value 5\nFLAG 0 16 in\nFLAG 0 96 0'
const electric = (p: Project) => generateNetlist(p).split('\n').filter(line => /^[RCLVIDQJMX][0-9]/.test(line)).sort()
const topology = (p: Project) => compileDrawing(p.drawing!)

test('ASC imports original RC wire endpoints and relative positions without rebuilding layout', () => {
  const { project, warnings } = importLtspiceSchematic(rc, { sourceName: 'RC.asc' })
  assert.deepEqual(validateProject(project), [])
  assert.equal(project.title, 'RC')
  assert.deepEqual(electric(project), ['C1 out 0 0.000001', 'R1 in out 1000', 'V1 in 0 DC 0 AC 1 0'])
  const d = project.drawing!, r = d.devices.find(device => device.id === 'R1')!, c = d.devices.find(device => device.id === 'C1')!, v = d.devices.find(device => device.id === 'V1')!
  assert.ok(v.x < r.x && r.x < c.x)
  assert.equal(r.rotation, 0)
  const segments = d.wires.map(wire => wirePoints(d, wire))
  assert.ok(segments.some(points => points[0].x === 200 && points[0].y === 240 && points.at(-1)!.x === 440 && points.at(-1)!.y === 240))
  assert.ok(d.labels!.some(label => label.name === 'IN' && terminalPosition(d, label.at).x === 200 && terminalPosition(d, label.at).y === 240))
  assert.ok(warnings.some(warning => warning.includes('局部引线')))
  assert.ok(!warnings.some(warning => warning.includes('文本网表不含原始图面')))
  assert.deepEqual(parseProject(JSON.parse(JSON.stringify(project))), project)
})

test('all standard ASC rotations and mirrors preserve actual pin order and original anchor positions', () => {
  const offsets = {
    R0: [[16, 16], [16, 96]], R90: [[-16, 16], [-96, 16]], R180: [[-16, -16], [-16, -96]], R270: [[16, -16], [96, -16]],
    M0: [[-16, 16], [-16, 96]], M90: [[16, 16], [96, 16]], M180: [[16, -16], [16, -96]], M270: [[-16, -16], [-96, -16]],
  }
  for (const [orientation, pins] of Object.entries(offsets)) {
    const body = `${voltage}\nSYMBOL res 400 304 ${orientation}\nSYMATTR InstName R1\nSYMATTR Value 1k\nFLAG ${400 + pins[0][0]} ${304 + pins[0][1]} in\nFLAG ${400 + pins[1][0]} ${304 + pins[1][1]} 0`
    const { project } = importLtspiceSchematic(circuit(body)), compiled = topology(project)
    assert.deepEqual(compiled.elements.find(element => element.device.id === 'R1')!.nodes, ['in', '0'], orientation)
    const label = project.drawing!.labels!.find(label => label.name === 'in' && terminalPosition(project.drawing!, label.at).x === (400 + pins[0][0]) * 1.25)!
    assert.ok(label, orientation)
    assert.deepEqual({ x: terminalPosition(project.drawing!, label.at).x, y: terminalPosition(project.drawing!, label.at).y }, { x: (400 + pins[0][0]) * 1.25, y: (304 + pins[0][1]) * 1.25 }, orientation)
    assert.equal(project.drawing!.devices.find(device => device.id === 'R1')!.mirrored ?? false, orientation.startsWith('M'))
  }
})

test('M90 and M270 agree with the independently emitted native LTspice netlist', () => {
  const asc = readFileSync(new URL('./fixtures/ltspice-import-mirror-reference.asc', import.meta.url), 'utf8')
  const net = readFileSync(new URL('./fixtures/ltspice-import-mirror-reference.net', import.meta.url), 'utf8')
  // Native test resistors are intentionally isolated to make pin identity
  // visible. Complete each named net at a grounded load for workbench checks.
  const complete = asc + '\n' + [['m90_p1', 'in'], ['m90_p2', '0'], ['m270_p1', 'in'], ['m270_p2', '0']].map(([name, end], index) => `SYMBOL res ${800 + index * 160} 800 R0\nSYMATTR InstName R${index + 3}\nSYMATTR Value 10k\nFLAG ${816 + index * 160} 816 ${name}\nFLAG ${816 + index * 160} 896 ${end}`).join('\n')
  const project = importLtspiceSchematic(complete).project
  for (const line of net.split(/\r?\n/).filter(line => /^R[12]\b/.test(line))) {
    const [id, ...tokens] = line.split(/\s+/)
    assert.deepEqual(topology(project).elements.find(element => element.device.id === id)!.nodes, tokens.slice(0, 2))
  }
})

test('a bare crossing stays separate while an original endpoint creates a real T branch', () => {
  const base = `${voltage}\nSYMBOL res 240 16 R270\nSYMATTR InstName R1\nSYMATTR Value 1k\nFLAG 336 0 0\nWIRE 0 0 256 0\nWIRE 0 0 0 16\nSYMBOL res 112 -176 R0\nSYMATTR InstName R2\nSYMATTR Value 2k\nFLAG 128 -160 0\nWIRE 128 -80 128 80\nSYMBOL res 112 64 R0\nSYMATTR InstName R3\nSYMATTR Value 3k\nFLAG 128 160 0`
  const separate = importLtspiceSchematic(circuit(base)).project
  assert.deepEqual(topology(separate).elements.find(element => element.device.id === 'R2')!.nodes, ['0', 'asc_n1'])
  assert.equal(topology(separate).elements.find(element => element.device.id === 'R1')!.nodes[0], 'in')
  const joined = importLtspiceSchematic(circuit(base.replace('WIRE 128 -80 128 80', 'WIRE 128 -80 128 0\nWIRE 128 0 128 80'))).project
  assert.deepEqual(topology(joined).elements.find(element => element.device.id === 'R2')!.nodes, ['0', 'in'])
  const center = joined.drawing!.junctions.find(junction => junction.x === 160 && junction.y === 0)!
  assert.ok(center)
  assert.ok(joined.drawing!.wires.filter(wire => terminalKey(wire.from) === center.id || terminalKey(wire.to) === center.id).length >= 3)
})

test('IOPINs, disconnected flags, numeric node aliases and negative original coordinates survive serialization', () => {
  const text = circuit(`${voltage}\nSYMBOL res -176 -16 R0\nSYMATTR InstName R1\nSYMATTR Value 1k\nFLAG -160 0 in\nIOPIN -160 0 In\nFLAG -160 80 0\nFLAG -320 -160 2\nIOPIN -320 -160 Out`)
  const { project, warnings } = importLtspiceSchematic(text)
  const d = project.drawing!
  assert.ok(d.labels!.some(label => label.style === 'input' && label.name === 'in'))
  const isolated = d.labels!.find(label => label.style === 'output')!
  assert.ok(isolated)
  assert.deepEqual({ x: terminalPosition(d, isolated.at).x, y: terminalPosition(d, isolated.at).y }, { x: -400, y: -200 })
  assert.ok(warnings.some(warning => warning.includes('2')))
  assert.deepEqual(parseProject(JSON.parse(JSON.stringify(project))), project)
})

test('inline nonlinear diode definition and selected analysis are preserved', () => {
  const { project } = importLtspiceSchematic(diode)
  assert.deepEqual(validateProject(project), [])
  assert.equal(project.analysis, 'op')
  assert.equal(project.models?.find(model => model.id === 'DIMPORT')?.spice, '.model DIMPORT D(IS=1n N=1.5 RS=0.1)')
  assert.deepEqual(topology(project).elements.find(element => element.device.id === 'D1')!.nodes, ['out', '0'])
})

test('stock BJT, JFET and four-terminal MOS retain real terminal ordering and body node', () => {
  const text = circuit(`${voltage}\nSYMBOL npn 256 256 R0\nSYMATTR InstName Q1\nSYMATTR Value IMPORT_Q\nFLAG 320 256 out\nFLAG 256 304 in\nFLAG 320 352 0\nSYMBOL njf 640 256 R0\nSYMATTR InstName J1\nSYMATTR Value IMPORT_J\nFLAG 688 256 out\nFLAG 640 320 in\nFLAG 688 352 0\nSYMBOL nmos4 1024 256 R0\nSYMATTR InstName M1\nSYMATTR Value IMPORT_M\nFLAG 1072 256 out\nFLAG 1024 336 in\nFLAG 1072 352 0\nFLAG 1072 304 bulk\nSYMBOL voltage 1408 0 R0\nSYMATTR InstName V2\nSYMATTR Value -1\nFLAG 1408 16 bulk\nFLAG 1408 96 0`)
  const { project } = importLtspiceSchematic(text, { modelText: '.model IMPORT_Q NPN(IS=1f BF=100)\n.model IMPORT_J NJF(VTO=-2 BETA=1m)\n.model IMPORT_M NMOS(LEVEL=1 VTO=1 KP=1m)' })
  const compiled = topology(project)
  assert.deepEqual(compiled.elements.find(element => element.device.id === 'Q1')!.nodes, ['out', 'in', '0'])
  assert.deepEqual(compiled.elements.find(element => element.device.kind === 'J')!.nodes, ['out', 'in', '0'])
  const mos = compiled.elements.find(element => element.device.kind === 'X')!
  assert.deepEqual(mos.nodes, ['out', 'in', '0', 'bulk'])
  assert.ok(project.models!.some(model => model.spice.includes('IMPORT_M') && model.kind === 'X'))
  assert.deepEqual(parseProject(JSON.parse(JSON.stringify(project))), project)
})

test('actual custom ASY geometry keeps SpiceOrder, U instance mapping, rotations and mirrors', () => {
  const local = [[-48, -16], [-48, 16], [48, 0]]
  for (const orientation of ['R0', 'R90', 'R180', 'R270', 'M0', 'M90', 'M180', 'M270']) {
    const angle = Number(orientation.slice(1)) * Math.PI / 180, c = Math.round(Math.cos(angle)), s = Math.round(Math.sin(angle)), m = orientation.startsWith('M') ? -1 : 1
    const coords = local.map(([x, y]) => [256 + m * (x * c - y * s), 256 + x * s + y * c])
    const flags = coords.map(([x, y], index) => `FLAG ${x} ${y} ${['in', '0', 'out'][index]}`).join('\n')
    const text = circuit(`${voltage}\nSYMBOL Custom\\buffer 256 256 ${orientation}\nSYMATTR InstName U1\n${flags}\nSYMBOL res 496 16 R0\nSYMATTR InstName R1\nSYMATTR Value 1k\nFLAG 512 32 out\nFLAG 512 112 0`)
    const { project, warnings } = importLtspiceSchematic(text, { symbols: { 'custom/buffer.asy': asy }, modelText: '.subckt IMPORT_BUFFER IN REF OUT\nR1 IN OUT 1k\nR2 OUT REF 1k\n.ends IMPORT_BUFFER' })
    const device = project.drawing!.devices.find(device => device.kind === 'X')!
    assert.deepEqual(device.pins, ['IN', 'REF', 'OUT'], orientation)
    assert.deepEqual(topology(project).elements.find(element => element.device.id === device.id)!.nodes, ['in', '0', 'out'], orientation)
    coords.forEach(([x, y], pin) => assert.deepEqual(pinPosition(device, pin), { x: x * 1.25, y: y * 1.25 }, orientation))
    assert.equal(project.models!.find(model => model.id === 'IMPORT_BUFFER')!.symbol!.shape, 'ltspice')
    assert.equal(project.models!.find(model => model.id === 'IMPORT_BUFFER')!.symbol!.source!.sha256, createHash('sha256').update(asy).digest('hex'))
    assert.ok(warnings.some(warning => warning.includes('XU1')))
    assert.deepEqual(parseProject(JSON.parse(JSON.stringify(project))), project)
  }
})

test('initial conditions and every analysis profile reference the rebuilt original drawing', () => {
  const { project } = importLtspiceSchematic(rc.replace('!.ac dec 100 1 100k', '!.ic v(out)=0.2\\n.nodeset v(in)=0.1\\n.ac dec 100 1 100k\\n.tran 0 2m 0 1u'))
  const compiled = topology(project)
  assert.equal(compiled.nodes.get(terminalKey(project.initialConditions![0].at)), 'out')
  for (const profile of project.waveformSetup!.profiles.profiles) {
    assert.equal(simulationReferenceWarning(project, profile), null)
    assert.deepEqual(validateProject(applySimulationProfile(project, profile)), [])
  }
})

test('Version 4.1 and an 8-unit source grid use one uniform scale without rounding endpoints', () => {
  const shifted = rc.replace('Version 4', 'Version 4.1').replace('WIRE 352 192 160 192', 'WIRE 352 192 168 192\nWIRE 168 192 160 192')
  const { project, warnings } = importLtspiceSchematic(shifted)
  assert.deepEqual(electric(project), ['C1 out 0 0.000001', 'R1 in out 1000', 'V1 in 0 DC 0 AC 1 0'])
  assert.ok(project.drawing!.junctions.some(junction => junction.x === 420 && junction.y === 480))
  assert.ok(warnings.some(warning => warning.includes('8→20')))
})

test('unknown symbols, duplicate references, conflicting flags, unresolved includes and unsafe directives fail specifically', () => {
  assert.throws(() => importLtspiceSchematic(rc.replace('SYMBOL cap', 'SYMBOL proprietary\\secret')), /secret\.asy/)
  assert.throws(() => importLtspiceSchematic(rc.replace('InstName C1', 'InstName r1')), /InstName r1.*重复/)
  assert.throws(() => importLtspiceSchematic(rc.replace('FLAG 704 192 OUT', 'FLAG 704 192 OUT\nFLAG 704 192 OTHER')), /冲突 FLAG OUT \/ OTHER/)
  assert.throws(() => importLtspiceSchematic(`${rc}\nTEXT 0 0 Left 2 !.include missing.lib`), /未展开/)
  assert.throws(() => importLtspiceSchematic(`${rc}\nTEXT 0 0 Left 2 !.control\\nshell calc\\n.endc`), /control|禁止|不支持|无法/)
  assert.throws(() => importLtspiceSchematic(rc.replace('SYMATTR Value 1k', 'SYMATTR Value 1k\nSYMATTR Value 2k')), /重复/)
  assert.throws(() => importLtspiceSchematic(rc.replace('WIRE 352 192 160 192', 'WIRE 352 192 160 176')), /斜线/)
  assert.throws(() => importLtspiceSchematic(`${rc}\nFLAG 100000 100000 remote`), /范围|保真/)
  assert.throws(() => importLtspiceSchematic(circuit(`${voltage}\nSYMBOL Custom 256 256 R0\nSYMATTR InstName U1`), { symbols: { 'custom.asy': asy.replace('SpiceOrder 3', 'SpiceOrder 1') } }), /SpiceOrder/)
})

test('real ngspice executes RC frequency response and inline diode operating point', async () => {
  const rcProject = importLtspiceSchematic(rc).project
  const response = await simulate(rcProject)
  const target = 1 / (2 * Math.PI * 0.001), index = response.x.reduce((best, frequency, i) => Math.abs(frequency - target) < Math.abs(response.x[best] - target) ? i : best, 0)
  assert.ok(Math.abs(response.magnitude[index] + 3.0103) < 0.1)
  const nonlinear = await simulate(importLtspiceSchematic(diode).project)
  assert.ok(nonlinear.vout[0] > 0.55 && nonlinear.vout[0] < 0.65, `diode voltage ${nonlinear.vout[0]}`)
})
