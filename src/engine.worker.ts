import { Simulation } from 'eecircuit-engine'
import { generateNetlist, parseProject, projectKey } from './core/circuit'
import { processResult, type Result } from './core/results'
import { runSolver } from './core/solver-run'
import { expandProjectSweep } from './core/simulation-experiment'

// Each job gets an isolated worker. Terminating it also terminates the solver.
self.onmessage = async (event: MessageEvent) => {
  try {
    const project = parseProject(event.data)
    const start = performance.now()
    const runs=expandProjectSweep(project),results:Result[]=[]
    for(let index=0;index<runs.length;index++){
      const run=runs[index],prefix=project.sweep?`扫描 ${index+1}/${runs.length} · ${run.label}：`:''
      try {
        const netlist=generateNetlist(run.project),runStart=performance.now()
        self.postMessage({ type: 'progress', message: `${prefix}正在初始化 ngspice…` })
        const simulation = new Simulation()
        await simulation.start()
        self.postMessage({ type: 'progress', message: `${prefix}正在求解电路…` })
        const solved=await runSolver(simulation,netlist,run.project.analysis,message=>self.postMessage({type:'progress',message:prefix+message}))
        const engine = simulation.getInitInfo().match(/ngspice-[\d.]+/)?.[0] ?? 'ngspice'
        const result = processResult(solved.raw, run.project, solved.netlist, performance.now() - runStart, engine, solved.log, solved.warnings)
        if(project.sweep)result.sweepLabel=run.label
        results.push(result)
      } catch(error) {throw new Error(prefix+(error instanceof Error?error.message:String(error)))}
    }
    const result=project.sweep?{...results[0],key:projectKey(project),experiment:structuredClone(project),sweepResults:results,elapsed:performance.now()-start}:results[0]
    self.postMessage({ type: 'result', result })
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
