import type { Result } from './results'
import type { WaveformSignal } from './waveform-workspace'
import { fftWaveform, type FftOptions, type FftResult } from './waveform-analysis'

export interface WaveformFftTask {
  sequence: number
  resultId: string
  analysis: Result['analysis']
  x: number[]
  signal: WaveformSignal
  options: FftOptions
}
export type WaveformFftReply = { sequence: number; resultId: string; data?: FftResult; error?: string }

/** Send only the chosen original series; exclude unrelated solver vectors and project data. */
export function computeWaveformFftTask(task: WaveformFftTask): WaveformFftReply {
  try {
    return { sequence: task.sequence, resultId: task.resultId, data: fftWaveform({ analysis: task.analysis, x: task.x } as Result, task.signal, task.options) }
  } catch (error) {
    return { sequence: task.sequence, resultId: task.resultId, error: error instanceof Error ? error.message : String(error) }
  }
}
