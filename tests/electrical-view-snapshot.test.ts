import assert from 'node:assert/strict'
import test from 'node:test'
import { editorTemplate } from '../src/core/editor'
import { createElectricalViewSnapshot } from '../src/core/electrical-view-snapshot'
import { initialSimulationProfiles } from '../src/core/simulation-profiles'

test('waveform cursor/display edits reuse electrical snapshot, genuine electrical edits invalidate it', () => {
  const select=createElectricalViewSnapshot(),base=editorTemplate('rc-lowpass')
  const original=structuredClone(base),first=select(base)
  for(let index=0;index<100;index++){
    const next={...base,title:`display ${index}`,waveformSetup:{version:1 as const,profiles:initialSimulationProfiles(base),diagrams:[]}}
    assert.equal(select(next),first)
  }
  assert.deepEqual(base,original)
  const changed={...base,drawing:{...base.drawing!,devices:base.drawing!.devices.map(part=>part.id==='R1'?{...part,value:'2k'}:part)}}
  assert.equal(select(changed),changed)
  const settings={...changed,tran:{...changed.tran,stop:'20ms'}}
  assert.equal(select(settings),settings)
  const model={...settings,models:[]}
  assert.equal(select(model),model)
  assert.equal(select(base),base,'undo restores actual prior electrical snapshot')
  assert.notEqual(createElectricalViewSnapshot()(structuredClone(base)),base,'cache scope is per editor')
})
