import { useRef, type ReactNode } from 'react'
import { useMotionSurface } from './MotionPresence'

/** Small UI notices opt in explicitly; live plot and canvas data stay untouched. */
export default function MotionRegion({ className, children }: { className: string; children: ReactNode }) {
  const region = useRef<HTMLDivElement>(null)
  useMotionSurface(region, { kind: 'menu' })
  return <div ref={region} className={className}>{children}</div>
}
