import { DRAWING_BOUNDS, GRID, snap, type Device, type Drawing } from './drawing'

export type LayoutOperation = 'align-horizontal' | 'align-vertical' | 'distribute-horizontal' | 'distribute-vertical'

/**
 * Arrange device centers on the existing sheet grid. Wires keep their terminal
 * references and follow the moved pins; selected junctions and labels are not
 * independently moved. Alignment uses the first selected device as its anchor.
 * Distribution preserves the two outside centers along the chosen axis, orders
 * ties by the other coordinate and then ID, and rounds intermediate centers to
 * the nearest grid point. A gap smaller than one grid step is rejected.
 */
export function layoutSelection(d: Drawing, ids: string[], operation: LayoutOperation): Drawing {
  const byId = new Map(d.devices.map(device => [device.id, device]))
  const selected = [...new Set(ids)].flatMap(id => {
    const device = byId.get(id)
    return device ? [device] : []
  })
  const distribute = operation.startsWith('distribute-')
  const minimum = distribute ? 3 : 2
  if (selected.length < minimum) throw new Error(distribute ? '均匀分布至少需要选择 3 个器件。' : '对齐至少需要选择 2 个器件。')

  // Horizontal alignment forms a row (same y); horizontal distribution spaces x.
  const horizontal = operation.endsWith('-horizontal')
  const axis: 'x' | 'y' = distribute ? (horizontal ? 'x' : 'y') : (horizontal ? 'y' : 'x')
  const otherAxis = axis === 'x' ? 'y' : 'x'
  const targets = new Map<string, number>()
  if (distribute) {
    const ordered = [...selected].sort((a, b) => a[axis] - b[axis] || a[otherAxis] - b[otherAxis] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const first = ordered[0][axis], last = ordered[ordered.length - 1][axis]
    if (last - first < (ordered.length - 1) * GRID) throw new Error('器件之间的空间不足，请先拉开两端器件，至少为每个间隔留出一格。')
    ordered.forEach((device, index) => targets.set(device.id, index === 0 ? first : index === ordered.length - 1 ? last : snap(first + (last - first) * index / (ordered.length - 1))))
  } else {
    const anchor = selected[0][axis]
    selected.forEach(device => targets.set(device.id, anchor))
  }

  let changed = false
  const devices = d.devices.map((device): Device => {
    const target = targets.get(device.id)
    if (target === undefined) return device
    if (!Number.isFinite(target) || target % GRID !== 0 || target < DRAWING_BOUNDS.min || target > DRAWING_BOUNDS.max) throw new Error('排列后器件会超出画布或偏离网格，请先调整器件位置。')
    if (target === device[axis]) return device
    changed = true
    return { ...device, [axis]: target }
  })
  return changed ? { ...d, devices } : d
}
