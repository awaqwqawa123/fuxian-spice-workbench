export const MIN_CANVAS_ZOOM = .05
export const MAX_CANVAS_ZOOM = 20

export function clampCanvasZoom(zoom:number) {
  return Math.max(MIN_CANVAS_ZOOM,Math.min(MAX_CANVAS_ZOOM,zoom))
}

export function stepCanvasZoom(zoom:number,direction:1|-1) {
  return clampCanvasZoom(zoom*Math.pow(1.25,direction))
}
