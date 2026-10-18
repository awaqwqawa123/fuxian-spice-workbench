import { Simulation } from 'eecircuit-engine'
import { expandRawNetlist, prepareRawNetlist, rawNetlistResult, type RawNetlistResult } from './core/raw-netlist'
import { runSolver } from './core/solver-run'

self.onmessage=async(event:MessageEvent)=>{
  try{
    const prepared=prepareRawNetlist(String(event.data.netlist??'')),start=performance.now()
    self.postMessage({type:'progress',message:'正在初始化 ngspice…'})
    const simulation=new Simulation();await simulation.start()
    const plans=expandRawNetlist(prepared),runs:RawNetlistResult[]=[]
    let totalPoints=0,totalValues=0
    for(const [index,plan] of plans.entries()){
      const runStart=performance.now()
      self.postMessage({type:'progress',message:`正在仿真手工网表${plans.length>1?` ${index+1}/${plans.length} · ${plan.sweepLabel}`:''}…`})
      const solved=await runSolver(simulation,plan.executable,plan.analysis,message=>self.postMessage({type:'progress',message})),raw=solved.raw
      totalPoints+=raw.numPoints;totalValues+=raw.numPoints*raw.data.length
      if(totalPoints>500_000||totalValues>2_000_000)throw new Error('STEP 总结果超过 500,000 点或 2,000,000 个采样数值，请减少组数或用 .save 限定向量。')
      runs.push(rawNetlistResult(raw,{...plan,executable:solved.netlist},{engine:simulation.getInitInfo().match(/ngspice-[\d.]+/)?.[0]??'ngspice',elapsed:performance.now()-runStart,log:solved.log,measurementLog:solved.runLog,warnings:solved.warnings}))
    }
    const result={...runs[0],elapsed:performance.now()-start,...(prepared.step?{sweepResults:runs}:{})}
    self.postMessage({type:'result',result})
  }catch(error){self.postMessage({type:'error',message:error instanceof Error?error.message:String(error)})}
}
