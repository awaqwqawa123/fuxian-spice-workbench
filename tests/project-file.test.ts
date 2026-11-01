import assert from 'node:assert/strict'
import test from 'node:test'
import { strToU8, strFromU8, unzipSync, zipSync } from 'fflate'
import { createProjectArchive, readProjectFile, projectFileName, MAX_PROJECT_FILE_BYTES } from '../src/core/project-file'
import { editorTemplate } from '../src/core/editor'
import { generateNetlist, parseProject, type Project } from '../src/core/circuit'
import { parseSpiceLibrary } from '../src/core/spice-models'
import { initialSimulationProfiles } from '../src/core/simulation-profiles'
import { defaultReportConfiguration } from '../src/core/report-settings'

function file(bytes: Uint8Array, name = '测试工程.fuxian', size = bytes.length) {
  return { name, size, arrayBuffer: async () => new Uint8Array(bytes).buffer, text: async () => strFromU8(bytes) }
}
function fixture(): Project {
  const project = editorTemplate('rc-lowpass')
  project.title = '带原符号的独立工程'
  const model = parseSpiceLibrary('.subckt FXBUF IN OUT\nRinner IN OUT 1k\n.ends FXBUF', { label: '用户自建原始模型', license: 'MIT', attribution: '测试作者' }).models[0]
  assert.ok(model)
  model.symbol = { version: 1, shape: 'ltspice', origin: 'imported', title: '原始符号', source: { label: 'FXBUF.asy', sha256: 'a'.repeat(64) },
    pins: [{ index: 0, label: 'IN', number: '3', x: -40, y: 0 }, { index: 1, label: 'OUT', number: '1', x: 40, y: 0 }],
    geometry: [{ type: 'rectangle', coords: [-20, -20, 20, 20] }, { type: 'line', coords: [-40, 0, -20, 0] }, { type: 'line', coords: [20, 0, 40, 0] }],
    annotations: [{ text: '器件内部原始文字', x: 0, y: -30, size: 10 }],
  }
  project.models = [model]
  project.drawing!.devices = project.drawing!.devices.map(device => device.id === 'R1' ? { ...device, id: 'X1', kind: 'X', value: model.id, pins: model.pins, pinPositions: model.symbol!.pins.map(pin => ({ x: pin.x!, y: pin.y! })) } : device)
  project.drawing!.wires = project.drawing!.wires.map(wire => ({ ...wire, from: 'device' in wire.from && wire.from.device === 'R1' ? { ...wire.from, device: 'X1' } : wire.from, to: 'device' in wire.to && wire.to.device === 'R1' ? { ...wire.to, device: 'X1' } : wire.to }))
  project.probes = [{ id: 'P1', kind: 'voltage', positive: { device: 'C1', pin: 0 }, positiveLayout: { offset: { x: 40, y: -30 } } }, { id: 'P2', kind: 'voltage', positive: { device: 'X1', pin: 0 }, negative: { device: 'C1', pin: 0 } }]
  const profiles = initialSimulationProfiles(project)
  profiles.profiles.push({ id: 'transient', name: '瞬态细节', settings: { ...structuredClone(profiles.profiles[0].settings), analysis: 'tran', tran: { stop: '20ms', step: '1us' } } })
  const panels = Array.from({ length: 4 }, () => ({ source: 'signals' as const, display: 'magnitude' as const, ids: ['probe:P1', 'probe:P2'] }))
  project.waveformSetup = { version: 1, profiles, diagrams: [{ id: 'chart', title: '输出视图', profileId: 'transient', x: 700, y: 620, width: 640, height: 360, view: { analysis: 'tran', layout: 2, panels, domain: [0, .25], cursors: { a: null, b: null }, splitDirection: 'rows', splitRatio: 55, activePanel: 1 } }] }
  project.report = { ...defaultReportConfiguration(), details: { author: '测试作者', revision: '2.1', purpose: '可迁移工程' } }
  return project
}

test('single project file preserves original symbols, electrical netlist, probes, profiles, plots and report across migration', async () => {
  const project = fixture(), original = structuredClone(project), archive = createProjectArchive(project), entries = unzipSync(archive)
  assert.deepEqual(Object.keys(entries).sort(), ['README.txt', 'manifest.json', 'project.json'])
  const reopened = await readProjectFile(file(archive))
  assert.equal(reopened.format, '伏线工程包')
  assert.deepEqual(reopened.project, parseProject(project, { allowDraft: true }))
  assert.equal(generateNetlist(reopened.project), generateNetlist(project))
  assert.deepEqual(reopened.project.models![0].symbol, project.models![0].symbol)
  assert.deepEqual(reopened.project.waveformSetup, project.waveformSetup)
  assert.deepEqual(reopened.project.probes, project.probes)
  assert.deepEqual(project, original, 'export must never rewrite the source project')
  assert.deepEqual(reopened.warnings, [])
  const manifest = JSON.parse(strFromU8(entries['manifest.json']))
  assert.equal(manifest.resultPolicy, 'configuration-only')
  assert.equal(manifest.models.symbols, 1)
  assert.ok(strFromU8(entries['README.txt']).includes('不包含求解器采样'))
})

test('unknown account, chat and solver-state fields are excluded while a draft stays recoverable and reports missing models', async () => {
  const project = fixture() as Project & Record<string, unknown>
  Object.assign(project, { apiKey: 'secret-not-for-sharing', codexSessionId: 'private-chat', results: [{ samples: [1, 2, 3] }], desktopControl: { owner: 'desktop' } })
  project.drawing!.devices[1].value = 'MISSING_MODEL'
  project.tran.step = ''
  const archive = createProjectArchive(project), entries = unzipSync(archive), text = strFromU8(entries['project.json'])
  for (const value of ['secret-not-for-sharing', 'private-chat', 'desktopControl', 'samples']) assert.ok(!text.includes(value))
  const result = await readProjectFile(file(archive))
  assert.equal(result.project.tran.step, '')
  assert.equal(result.project.drawing!.devices[1].value, 'MISSING_MODEL')
  assert.ok(result.warnings.some(warning => warning.includes('X1') && warning.includes('MISSING_MODEL')))
  assert.ok(result.warnings.some(warning => warning.includes('未完成')))
})

test('legacy JSON remains supported and filenames are safe for Windows and sharing', async () => {
  const project = fixture(), result = await readProjectFile(file(strToU8(JSON.stringify(project)), '原有.JSON'))
  assert.equal(result.format, 'JSON 工程')
  assert.deepEqual(result.project, parseProject(project, { allowDraft: true }))
  assert.equal(projectFileName({ title: 'CON' }), '工程_CON.fuxian')
  assert.equal(projectFileName({ title: '电路/示例:*?  ' }), '电路_示例___.fuxian')
  assert.equal(projectFileName({ title: '...' }), '未命名电路.fuxian')
  assert.ok(projectFileName({ title: '电'.repeat(100) }).length <= 79)
})

test('archive rejects newer versions, damaged contents, foreign paths and metadata mismatches before loading a project', async () => {
  const archive = createProjectArchive(fixture()), entries = unzipSync(archive)
  const repack = (changes: Record<string, Uint8Array>) => zipSync({ ...entries, ...changes })
  const manifest = JSON.parse(strFromU8(entries['manifest.json']))
  await assert.rejects(readProjectFile(file(repack({ 'manifest.json': strToU8(JSON.stringify({ ...manifest, version: 99 })) }))), /版本/)
  await assert.rejects(readProjectFile(file(repack({ 'project.json': strToU8('{}') }))), /清单/)
  await assert.rejects(readProjectFile(file(zipSync({ ...entries, '../outside.json': strToU8('{}') }))), /目录|条目/)
  await assert.rejects(readProjectFile(file(archive.slice(0, -5))), /目录/)
  const stored = zipSync(entries, { level: 0 }), tampered = stored.slice()
  const offset = new TextDecoder().decode(stored).indexOf('伏线独立')
  // Corrupt a stored entry byte without changing its local/central checksum.
  assert.ok(offset > 0)
  const header = new DataView(tampered.buffer)
  const nameLength = header.getUint16(26, true), extraLength = header.getUint16(28, true)
  tampered[30 + nameLength + extraLength + 10] ^= 1
  await assert.rejects(readProjectFile(file(tampered)), /校验失败/)
})

test('size limits cover file metadata, actual input and central expanded lengths; no external includes are followed', async () => {
  const archive = createProjectArchive(fixture())
  await assert.rejects(readProjectFile(file(archive, 'large.fuxian', MAX_PROJECT_FILE_BYTES + 1)), /32 MB/)
  await assert.rejects(readProjectFile(file(new Uint8Array(MAX_PROJECT_FILE_BYTES + 1), 'large.fuxian', 1)), /32 MB/)
  const bomb = archive.slice(), view = new DataView(bomb.buffer), directory = view.getUint32(bomb.length - 22 + 16, true)
  view.setUint32(directory + 24, 0xffffffff, true)
  await assert.rejects(readProjectFile(file(bomb)), /大小限制/)
  await assert.rejects(readProjectFile(file(strToU8('not json'), 'bad.json')), /有效/)
  const external = fixture()
  external.models![0].spice = '.include "C:/private/vendor.lib"\n' + external.models![0].spice
  assert.throws(() => createProjectArchive(external), /外部 SPICE 库/)
  await assert.rejects(readProjectFile(file(strToU8(JSON.stringify(external)), 'external.json')), /外部 SPICE 库/)
})
