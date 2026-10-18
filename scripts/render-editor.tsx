import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync,writeFileSync } from 'node:fs'
import EditorCanvas from '../src/components/EditorCanvas'
import { editorTemplate } from '../src/core/editor'

const p=editorTemplate('rc-lowpass')
let svg=renderToStaticMarkup(<EditorCanvas drawing={p.drawing!} selection={['C1']} onSelect={()=>{}} tool="select" onTool={()=>{}} rotation={0} onChange={()=>{}} onStatus={()=>{}} zoom={1} onZoom={()=>{}} resetView={0} fitSelection={0} showNodes={false} wireBend="hv" onWireBend={()=>{}} clipboard={null} onPaste={()=>{}}/>)
const css=readFileSync(new URL('../src/editor.css',import.meta.url),'utf8').replaceAll('var(--mono)','"Consolas", monospace')
svg=svg.replace(/class="editor-canvas[^"]*"/,'class="editor-evidence"').replace('<svg ','<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="640" ')
svg=svg.replace(/(<svg[^>]*>)/,`$1<style>${css}</style>`)
writeFileSync(new URL('../verification/editor-canvas.svg',import.meta.url),svg)
console.log('Saved static rendering of the actual EditorCanvas component (not a browser screenshot).')
