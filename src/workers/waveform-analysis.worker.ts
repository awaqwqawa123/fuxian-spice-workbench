import { computeWaveformFftTask, type WaveformFftTask } from '../core/waveform-fft-task'

self.onmessage = (event: MessageEvent<WaveformFftTask>) => {
  self.postMessage(computeWaveformFftTask(event.data))
}
