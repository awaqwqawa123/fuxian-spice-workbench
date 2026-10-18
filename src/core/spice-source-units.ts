interface SourceToken { value:string; start:number; end:number }
/** Cadence voltage/current sources print explicit Vdc/Adc units. In ngspice
 * an unprefixed Adc starts with its atto multiplier, silently scaling 1 A to
 * 1e-18 A. Strip only proven unit suffixes from the appropriate source slots;
 * preserve the mantissa, exponent and SPICE multiplier verbatim.
 */
export function normalizePspiceSourceUnits(netlist:string):string {
  const replacements:{start:number;end:number;value:string}[]=[]
  const lines=[...netlist.matchAll(/[^\r\n]+(?:\r?\n|$)|\r?\n/g)]
  for(let index=0;index<lines.length;index++){
    // A complete SPICE netlist's first physical line is the circuit title.
    if(index===0)continue
    const first=lines[index],kind=first[0].match(/^\s*([IV])\S*\s+/i)?.[1].toUpperCase()
    if(!kind)continue
    let masked=first[0].replace(/(?:\s[;$]).*(?=\r?\n|$)/g,match=>' '.repeat(match.length))
    while(index+1<lines.length&&/^\s*\+/.test(lines[index+1][0])){
      const line=lines[++index][0]
      masked+=line.replace(/^(\s*)\+/,(_,space:string)=>space+' ').replace(/(?:\s[;$]).*(?=\r?\n|$)/g,match=>' '.repeat(match.length))
    }
    const tokens:SourceToken[]=[...masked.matchAll(/\{[^{}]*\}|[^\s(),]+|[(),]/g)].map(match=>({value:match[0],start:match.index,end:match.index+match[0].length}))
    if(tokens.length<4)continue
    const unit=kind==='I'?'Adc':'Vdc'
    const scalar=new RegExp(`^([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?(?:meg|[tgkmunpf])?)${unit}$`,'i')
    const convert=(token:SourceToken|undefined)=>{
      if(!token)return
      const match=token.value.match(scalar)
      if(match)replacements.push({start:first.index+token.start,end:first.index+token.end,value:match[1]})
    }
    let cursor=3
    if(!/^(?:DC|AC|PULSE|SIN|EXP|PWL|SFFM|AM)$/i.test(tokens[cursor].value))convert(tokens[cursor++])
    while(cursor<tokens.length){
      const keyword=tokens[cursor++].value.toUpperCase()
      if(keyword==='DC'){convert(tokens[cursor++]);continue}
      if(keyword==='AC'){
        convert(tokens[cursor++])
        // The optional AC phase is in degrees, never a current/voltage value.
        if(tokens[cursor]&&!/^(?:DC|PULSE|SIN|EXP|PWL|SFFM|AM)$/i.test(tokens[cursor].value))cursor++
        continue
      }
      if(keyword==='PULSE'&&tokens[cursor]?.value==='('){
        cursor++
        const levels:SourceToken[]=[]
        while(cursor<tokens.length&&tokens[cursor].value!==')'){
          if(tokens[cursor].value!==',')levels.push(tokens[cursor])
          cursor++
        }
        if(cursor===tokens.length)break
        convert(levels[0]);convert(levels[1]);cursor++;continue
      }
      // Other waveform grammars and expression units are not inferred.
      break
    }
  }
  let output=netlist
  for(const replacement of replacements.reverse())output=output.slice(0,replacement.start)+replacement.value+output.slice(replacement.end)
  return output
}
