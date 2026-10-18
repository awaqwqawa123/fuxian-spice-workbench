import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { chromium } from 'playwright-core'
import { parseProject } from '../src/core/circuit'
import { compileDrawing, terminalKey, terminalPosition, wirePoints, type Drawing, type XY } from '../src/core/drawing'
import { pinsFor } from '../src/core/devices'
import { schematicSvg } from '../src/core/export-svg'
import { layoutElectricalDifferences } from '../src/core/layout-electrical-equivalence'
import { redrawDrawingLayout } from '../src/core/redraw-layout'
import { autoLayoutDrawing, deviceCaptionRects } from '../src/core/schematic-layout'
import { symbolBodyRect } from '../src/core/wire-lead-route'
import { parseAiProposal } from '../src/core/ai'

const fixture=JSON.parse(readFileSync(new URL('../tests/fixtures/reported-drawing-674419a9.json',import.meta.url),'utf8'))
const project=parseProject(fixture.project,{allowDraft:true}),before=project.drawing!
const tag=process.argv[2]??'current'
if(!/^[a-z0-9-]+$/.test(tag))throw new Error('Evidence tag must use lowercase letters, numbers or hyphens')
const directory=fileURLToPath(new URL(`../docs/artifacts/reported-drawing-regression-20261002/${tag}/`,import.meta.url))
mkdirSync(directory,{recursive:true})
const variants={original:before,proposal:autoLayoutDrawing(before),aiProposal:parseAiProposal(JSON.stringify({summary:'整理真实原图',project}),project,{waveformIntent:'preserve'}).project.drawing!,redraw:redrawDrawingLayout(before)}
const segmentHit=(a:XY,b:XY,r:{left:number;right:number;top:number;bottom:number})=>a.x===b.x
  ?a.x>r.left&&a.x<r.right&&Math.max(Math.min(a.y,b.y),r.top)<Math.min(Math.max(a.y,b.y),r.bottom)
  :a.y===b.y&&a.y>r.top&&a.y<r.bottom&&Math.max(Math.min(a.x,b.x),r.left)<Math.min(Math.max(a.x,b.x),r.right)
function audit(drawing:Drawing){
  const nodes=compileDrawing(drawing).nodes,paths=drawing.wires.map(w=>wirePoints(drawing,w)),overlaps:unknown[]=[],bodyHits:unknown[]=[],captionHits:unknown[]=[],foreignPinTouches:unknown[]=[]
  for(let i=0;i<drawing.wires.length;i++){
    const wire=drawing.wires[i],path=paths[i]
    for(const device of drawing.devices)for(let pin=0;pin<pinsFor(device).length;pin++){
      const at={device:device.id,pin},position=terminalPosition(drawing,at)
      if(nodes.get(terminalKey(wire.from))===nodes.get(terminalKey(at)))continue
      for(let k=1;k<path.length;k++){
        const a=path[k-1],b=path[k],on=a.x===b.x&&position.x===a.x&&position.y>=Math.min(a.y,b.y)&&position.y<=Math.max(a.y,b.y)||a.y===b.y&&position.y===a.y&&position.x>=Math.min(a.x,b.x)&&position.x<=Math.max(a.x,b.x)
        if(on)foreignPinTouches.push({wire:wire.id,pin:terminalKey(at),position,segment:[a,b]})
      }
    }
    for(const device of drawing.devices)for(let k=1;k<path.length;k++){
      if(segmentHit(path[k-1],path[k],symbolBodyRect(device,0)))bodyHits.push({wire:wire.id,device:device.id,segment:[path[k-1],path[k]]})
      if(deviceCaptionRects(device,0).some(r=>segmentHit(path[k-1],path[k],r)))captionHits.push({wire:wire.id,device:device.id,segment:[path[k-1],path[k]]})
    }
    for(let j=i+1;j<drawing.wires.length;j++){
      const other=drawing.wires[j]
      if(nodes.get(terminalKey(wire.from))===nodes.get(terminalKey(other.from)))continue
      for(let a=1;a<path.length;a++)for(let b=1;b<paths[j].length;b++){
        const p=path[a-1],q=path[a],r=paths[j][b-1],s=paths[j][b]
        const vertical=p.x===q.x&&r.x===s.x&&p.x===r.x,horizontal=p.y===q.y&&r.y===s.y&&p.y===r.y
        const length=vertical?Math.min(Math.max(p.y,q.y),Math.max(r.y,s.y))-Math.max(Math.min(p.y,q.y),Math.min(r.y,s.y)):horizontal?Math.min(Math.max(p.x,q.x),Math.max(r.x,s.x))-Math.max(Math.min(p.x,q.x),Math.min(r.x,s.x)):0
        if(length>0)overlaps.push({wires:[wire.id,other.id],nets:[nodes.get(terminalKey(wire.from)),nodes.get(terminalKey(other.from))],length,segments:[[p,q],[r,s]]})
      }
    }
  }
  return {electricalDifferences:layoutElectricalDifferences(project,{...project,drawing}),foreignNetOverlaps:overlaps,foreignPinTouches,bodyHits,captionHits,junctions:drawing.junctions.filter(j=>['J8','J19'].includes(j.id)),routes:Object.fromEntries(['W9','W11','W12','W38','W59','W62','W63'].map(id=>[id,paths[drawing.wires.findIndex(w=>w.id===id)]]))}
}
const report={source:fixture.source,variants:Object.fromEntries(Object.entries(variants).map(([name,drawing])=>[name,audit(drawing)]))}
writeFileSync(`${directory}/route-audit.json`,JSON.stringify(report,null,2)+'\n')
const browserPath=[process.env.TEST_BROWSER_EXECUTABLE,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p=>p&&existsSync(p))
if(!browserPath)throw new Error('No installed browser for review images')
const browser=await chromium.launch({executablePath:browserPath,headless:true})
try{
  const page=await browser.newPage({viewport:{width:1600,height:1000},deviceScaleFactor:1})
  for(const [name,drawing]of Object.entries(variants)){
    const svg=schematicSvg(drawing,{title:`Reported circuit — ${name}`,models:project.models,probes:project.probes})
    writeFileSync(`${directory}/${name}.svg`,svg)
    for(const [area,ids]of [['opamp',['U112','C32','R17']],['reference',['R53','C28','U101']]]as const){
      const devices=drawing.devices.filter(d=>ids.includes(d.id as never)),doc=new JSDOM(svg,{contentType:'image/svg+xml'}).window.document
      const root=doc.documentElement,content=doc.getElementById('schematic-content')!
      const translate=content.getAttribute('transform')!.match(/translate\(([-\d.]+) ([-\d.]+)\)/)!,dx=+translate[1],dy=+translate[2]
      const left=Math.min(...devices.map(d=>d.x))-200,top=Math.min(...devices.map(d=>d.y))-180,right=Math.max(...devices.map(d=>d.x))+240,bottom=Math.max(...devices.map(d=>d.y))+160
      root.setAttribute('viewBox',`${left+dx} ${top+dy} ${right-left} ${bottom-top}`);root.setAttribute('width',String(right-left));root.setAttribute('height',String(bottom-top))
      const crop=root.outerHTML
      writeFileSync(`${directory}/${name}-${area}.svg`,crop)
      await page.setContent(`<html><body style="margin:0;background:white">${crop}</body></html>`)
      await page.locator('svg').screenshot({path:`${directory}/${name}-${area}.png`})
    }
    const result=report.variants[name]
    console.log(name,JSON.stringify({foreignNetOverlaps:result.foreignNetOverlaps.length,foreignPinTouches:result.foreignPinTouches.length,bodyHits:result.bodyHits.length,captionHits:result.captionHits.length,routes:result.routes}))
  }
  const baseline=fileURLToPath(new URL('../docs/artifacts/reported-drawing-regression-20261002/baseline-0230f77/',import.meta.url))
  if(tag!=='baseline-0230f77'&&existsSync(`${baseline}/original-reference.png`)){
    const png=(path:string)=>`data:image/png;base64,${readFileSync(path).toString('base64')}`
    const rows=(['reference','opamp']as const).map(area=>`<section><h2>${area==='reference'?'R53 / C28：共同干线与 T 分支':'U112：正负输入分开，反馈保留'}</h2><div class="row"><img src="${png(`${baseline}/original-${area}.png`)}"><img src="${png(`${directory}/aiProposal-${area}.png`)}"></div></section>`).join('')
    await page.setViewportSize({width:1500,height:2000})
    await page.setContent(`<html><head><meta charset="utf-8"><style>body{margin:0;background:#edf2ef;color:#263c34;font-family:"Microsoft YaHei",sans-serif}.comparison{width:1450px;padding:20px;box-sizing:border-box}.head,.row{display:grid;grid-template-columns:1fr 1fr;gap:16px}.head{font-size:22px;font-weight:bold;margin:12px 0}h2{font-size:20px;margin:16px 0 10px}.row{align-items:start;background:white;border:1px solid #bbc8c0}.row img{width:100%;height:auto}.note{font-size:14px;margin-top:14px}</style></head><body><main class="comparison"><h1>真实保存图：修改前后对照</h1><div class="head"><div>原保存图（修订 1）</div><div>新绘图器：实际 AI 方案入口</div></div>${rows}<div class="note">两列均直接取自生产 SVG 的浏览器截图，保留周围电路与实际模型；没有重画参考图。电气网络、器件参数与模型保持一致。</div></main></body></html>`)
    await page.locator('img').evaluateAll(images=>Promise.all(images.map(image=>(image as HTMLImageElement).decode())))
    await page.locator('.comparison').screenshot({path:`${directory}/before-after.png`})
  }
}finally{await browser.close()}
