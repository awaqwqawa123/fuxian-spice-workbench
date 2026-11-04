import assert from 'node:assert/strict'
import test from 'node:test'
import { previewUserLibrarySpiceFile, USER_SPICE_FILE_ACCEPT } from '../src/core/user-library-spice-import'

test('SPICE file preview supports textual extensions, UTF-16 and self-contained ordered subcircuits', () => {
  const text = '.model IMPORT_NPN NPN(IS=1f BF=120)\n.subckt IMPORT_RC IN OUT REF\nR1 IN OUT 1k\nC1 OUT REF 1n\n.ends IMPORT_RC'
  for (const extension of ['lib', 'mod', 'model', 'cir', 'sp', 'spice', 'spi', 'inc', 'ckt', 'sub', 'txt', 'dio', 'bjt', 'mos']) {
    assert.ok(USER_SPICE_FILE_ACCEPT.includes(`.${extension}`))
    const preview = previewUserLibrarySpiceFile(`reference.${extension.toUpperCase()}`, new TextEncoder().encode(text))
    assert.equal(preview.models.length, 2)
    assert.equal(preview.models[0].source.label, `reference.${extension.toUpperCase()}`)
    assert.deepEqual(preview.models.find(model => model.id === 'IMPORT_RC')!.pins, ['IN', 'OUT', 'REF'])
  }
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  assert.equal(previewUserLibrarySpiceFile('utf16.lib', bytes).models.length, 2)
  assert.throws(() => previewUserLibrarySpiceFile('backup.json', new TextEncoder().encode('{}')), /导入备份/)
  assert.throws(() => previewUserLibrarySpiceFile('large.lib', new Uint8Array(4 * 1024 * 1024 + 1)), /4 MB/)
  for (const input of ['.protect\n.model HIDDEN D(IS=1n)\n.unprotect', '.include missing.lib\n.model DEPENDENT D(IS=1n)']) {
    const preview = previewUserLibrarySpiceFile('unsupported.lib', new TextEncoder().encode(input))
    assert.equal(preview.models.length, 0)
    assert.ok(preview.diagnostics.some(item => item.severity === 'error'))
  }
})
