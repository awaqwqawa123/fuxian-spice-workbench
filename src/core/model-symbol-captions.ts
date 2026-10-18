import type { ModelSymbol } from './model-symbol'

/** Explicit OLB display flags define both visible and hidden original labels.
 * Canvas and export must not add replacement captions over that source layout. */
export function hasOriginalOlbCaptions(symbol:ModelSymbol|undefined):boolean {
  return symbol?.shape==='ltspice'&&symbol.origin==='imported'&&symbol.pins.length>0&&symbol.pins.every(pin=>{
    const display=pin as typeof pin & {labelVisible?:boolean;numberVisible?:boolean}
    return typeof display.labelVisible==='boolean'&&typeof display.numberVisible==='boolean'
  })
}
