/** Deterministic text width for the shared canvas/SVG geometry. Wide glyphs
 * occupy two monospace columns; UTF-16 length is not a display width. This is a
 * conservative estimate, not a replacement for rendered-font acceptance. */
export function captionTextWidth(text:string,fontSize:number,latinAdvance=.62):number {
  let columns=0
  for(const char of text){
    const code=char.codePointAt(0)!
    if(/\p{Mark}/u.test(char)||code===0x200d||code===0xfe0e||code===0xfe0f)continue
    const wide=code>=0x1100&&(
      code<=0x115f||code===0x2329||code===0x232a||
      code>=0x2e80&&code<=0xa4cf&&code!==0x303f||
      code>=0xac00&&code<=0xd7a3||code>=0xf900&&code<=0xfaff||
      code>=0xfe10&&code<=0xfe19||code>=0xfe30&&code<=0xfe6f||
      code>=0xff00&&code<=0xff60||code>=0xffe0&&code<=0xffe6||
      code>=0x1f000&&code<=0x1faff||code>=0x20000&&code<=0x3ffff
    )
    columns+=wide?2:1
  }
  return Math.max(fontSize*.7,columns*fontSize*latinAdvance)
}
