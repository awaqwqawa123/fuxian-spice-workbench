import { circuitGraph, type Part, type Project } from '../core/circuit'

function Symbol({ part, project }: { part: Part; project: Project }) {
  if (part.kind === 'V') return <><line x1="0" y1="-60" x2="0" y2="-28" /><circle r="28" /><line x1="0" y1="28" x2="0" y2="60" /><path d={project.analysis === 'op' ? 'M -7 -10 H 7 M 0 -17 V -3 M -7 12 H 7' : project.analysis === 'tran' && project.source.waveform === 'square' ? 'M -18 10 H -9 V -10 H 9 V 10 H 18' : 'M -17 0 C -13 -22 -5 -22 0 0 S 13 22 17 0'} /></>
  const symbol = part.kind === 'R' ? <><path d="M -50 0 H -28 M 28 0 H 50" /><rect x="-28" y="-10" width="56" height="20" /></>
    : part.kind === 'C' ? <><path d="M -50 0 H -7 M 7 0 H 50 M -7 -22 V 22 M 7 -22 V 22" /></>
      : <><path d="M -50 0 H -28 C -28 -25 -14 -25 -14 0 C -14 -25 0 -25 0 0 C 0 -25 14 -25 14 0 C 14 -25 28 -25 28 0 H 50" /></>
  return <g transform={part.vertical ? 'rotate(90)' : undefined}>{part.vertical && <path d="M -60 0 H -50 M 50 0 H 60" />}{symbol}</g>
}
const Ground = ({ x }: { x: number }) => <g className="ground" transform={`translate(${x} 250)`}><path d="M 0 0 V 12 M -17 12 H 17 M -11 18 H 11 M -5 24 H 5" /><text x="0" y="45" textAnchor="middle">GND</text></g>
export default function Schematic({ project, selected, onSelect, zoom }: { project: Project; selected: string; onSelect: (id: string) => void; zoom: number }) {
  const graph = circuitGraph(project)
  return <svg className="schematic" viewBox={`${425 - 425 / zoom} ${165 - 165 / zoom} ${850 / zoom} ${330 / zoom}`} role="img" aria-label={`${project.title}，点击元件修改参数`}>
    <g className="wires">{graph.wires.map((w, i) => <line key={i} x1={w[0]} y1={w[1]} x2={w[2]} y2={w[3]} />)}</g>
    <circle className="node-dot input" cx="130" cy="130" r="4" /><text className="node-name input" x="130" y="102" textAnchor="middle">VIN</text>
    <circle className="node-dot output" cx={graph.outX} cy="130" r="4" /><text className="node-name output" x={graph.outX} y="102" textAnchor="middle">VOUT</text>
    <Ground x={130} /><Ground x={graph.outX} />
    {graph.parts.map(part => <g key={part.id} transform={`translate(${part.x} ${part.y})`} className={`part ${selected === part.id ? 'selected' : ''}`} role="button" tabIndex={0} aria-label={`编辑 ${part.id} ${part.value}`} onClick={() => onSelect(part.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(part.id) } }}>
      <rect className="part-hit" x={part.vertical ? -44 : -57} y={part.vertical ? -69 : -49} width={part.vertical ? 88 : 114} height={part.vertical ? 138 : 98} rx="12" />
      <g className="symbol"><Symbol part={part} project={project} /></g>
      <text className="part-label" x={part.vertical ? 45 : 0} y={part.vertical ? -9 : -28} textAnchor={part.vertical ? 'start' : 'middle'}>{part.id}</text>
      <text className="part-value" x={part.vertical ? 45 : 0} y={part.vertical ? 15 : 32} textAnchor={part.vertical ? 'start' : 'middle'}>{part.value}{part.kind === 'R' && !/(?:Ω|ohms?|欧姆)$/i.test(part.value) ? 'Ω' : ''}</text>
      {part.kind === 'V' && project.analysis !== 'op' && <text className="part-extra" x="45" y="36">{project.analysis === 'ac' ? 'AC 1 V' : project.source.frequency}</text>}
    </g>)}
  </svg>
}
