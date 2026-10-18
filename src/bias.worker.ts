import { Simulation } from 'eecircuit-engine'
import { parseProject } from './core/circuit'
import { buildBiasNetlist, attachBiasCurrents } from './core/bias-netlist'
import { processResult } from './core/results'
import { runSolver } from './core/solver-run'

// Dedicated and terminable OP job. Its private instrumentation and vectors never
// enter the saved schematic or the ordinary waveform simulation worker.
self.onmessage = async (event: MessageEvent) => {
  try {
    const project = parseProject(event.data)
    const start = performance.now()
    const { netlist, channels } = buildBiasNetlist(project)
    self.postMessage({ type: 'progress', message: '正在初始化直流工作点计算…' })
    const simulation = new Simulation()
    await simulation.start()
    self.postMessage({ type: 'progress', message: '正在计算节点电压和器件引脚电流…' })
    const solved = await runSolver(simulation, netlist, 'op', message => self.postMessage({ type: 'progress', message }))
    const engine = simulation.getInitInfo().match(/ngspice-[\d.]+/)?.[0] ?? 'ngspice'
    const result = attachBiasCurrents(processResult(solved.raw, project, solved.netlist, performance.now() - start, engine, solved.log, solved.warnings), channels)
    self.postMessage({ type: 'result', result })
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
