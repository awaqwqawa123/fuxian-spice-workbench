import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, writeFileSync } from 'node:fs'
import { newProject } from '../src/core/circuit'
import type { Result } from '../src/core/results'
import Schematic from '../src/components/Schematic'
import Waveform from '../src/components/Waveform'

const result = JSON.parse(readFileSync(new URL('../verification/baseline-result.json', import.meta.url), 'utf8')) as Result
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8').replaceAll('var(--mono)', '"Consolas", monospace')
const circuits = (['rc-lowpass', 'rc-highpass', 'rlc-lowpass'] as const).map((id,i) => {
  const project = newProject(id)
  const svg = renderToStaticMarkup(<Schematic project={project} selected="C1" zoom={1} onSelect={() => {}} />).replace('class="schematic"', '')
  return `<g transform="translate(${30+i*380} 105)"><rect width="365" height="245" rx="8" fill="#fcfdfb" stroke="#dfe6e3"/><text x="20" y="32" font-size="15" fill="#49684f">${project.title}</text>${svg.replace('<svg ', '<svg x="3" y="40" width="355" height="195" ')}</g>`
})
const plot = renderToStaticMarkup(<Waveform result={result} comparison={null} phase={false} />).match(/<svg[\s\S]*?<\/svg>/)![0]
const artifact = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="710" viewBox="0 0 1200 710"><style>${css}</style><rect width="1200" height="710" fill="#f3f5f5"/><g font-family="Microsoft YaHei, sans-serif"><text x="32" y="50" font-size="26" fill="#285b4c">伏线 · 原理图与实际仿真数据</text><text x="32" y="77" font-size="12" fill="#809783">由应用组件静态渲染，用于检查电路符号与曲线；并非浏览器页面截图。</text>${circuits.join('')}<rect x="30" y="372" width="1125" height="296" rx="8" fill="white" stroke="#dfe6e3"/><text x="53" y="401" font-size="14" fill="#497050">RC 低通 / 1.6 kΩ + 100 nF / ngspice 45.2 / 401 点</text>${plot.replace('<svg ', '<svg x="42" y="420" width="1100" height="228" ')}<text x="32" y="694" font-size="11" fill="#899a87">实测 −3 dB 频率 ${result.cutoff?.toFixed(3)} Hz · 所有波形点来自 ngspice 求解器</text></g></svg>`
writeFileSync(new URL('../verification/components.svg', import.meta.url), artifact)
console.log('Saved verification/components.svg')
