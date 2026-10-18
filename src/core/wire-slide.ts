import { rawWirePoints, terminalKey, terminalPosition, wirePoints, type Drawing, type Terminal, type Wire, type XY } from './drawing'
import { followWireEndpoints } from './wire-follow'

type Axis = 'x' | 'y'
interface Vertex { key:string; point:XY; terminal?:Terminal; wire?:Wire; index?:number; path?:XY[]; edges:Edge[] }
interface Edge { a:Vertex; b:Vertex; axis:Axis|null }
interface Graph { vertices:Vertex[]; edges:Edge[] }
const same=(a:XY,b:XY)=>a.x===b.x&&a.y===b.y
const graphs=new WeakMap<Drawing,Graph>()

function straightGraph(drawing:Drawing):Graph {
  const cached=graphs.get(drawing)
  if(cached)return cached
  const vertices=new Map<string,Vertex>(),edges:Edge[]=[]
  const terminalVertex=(terminal:Terminal)=>{
    const key=terminalKey(terminal)
    let vertex=vertices.get(key)
    if(!vertex){vertex={key,terminal,point:terminalPosition(drawing,terminal),edges:[]};vertices.set(key,vertex)}
    return vertex
  }
  for(const wire of drawing.wires){
    const path=wirePoints(drawing,wire),start=terminalVertex(wire.from),end=terminalVertex(wire.to)
    const chain=[start,...path.slice(1,-1).map((point,index)=>{
      const vertex:Vertex={key:`${wire.id}:corner:${index}`,point,wire,index:index+1,path,edges:[]}
      vertices.set(vertex.key,vertex)
      return vertex
    }),end]
    for(let i=1;i<chain.length;i++){
      const a=chain[i-1],b=chain[i]
      const axis=same(a.point,b.point)?null:a.point.y===b.point.y?'x':a.point.x===b.point.x?'y':undefined
      if(axis===undefined)continue
      const edge:Edge={a,b,axis};edges.push(edge);a.edges.push(edge);b.edges.push(edge)
    }
  }
  const graph={vertices:[...vertices.values()],edges};graphs.set(drawing,graph)
  return graph
}

/** Locate an existing corner after endpoint stretching without interpreting a
 * newly generated automatic avoidance detour as the user's original corner. */
function cornerPosition(vertex:Vertex,after:Drawing,wires:Map<string,Wire>):XY {
  const original=vertex.wire!,wire=wires.get(original.id)!,path=vertex.path!,index=vertex.index!
  const current=rawWirePoints(after,wire)
  if(current.length===path.length)return current[index]
  if(path.length===3){
    const from=terminalPosition(after,wire.from),to=terminalPosition(after,wire.to)
    return path[0].y===path[1].y?{x:to.x,y:from.y}:{x:from.x,y:to.y}
  }
  const retained=current.find(point=>same(point,vertex.point))
  if(retained)return retained
  if(index===1){
    const from=terminalPosition(after,wire.from),anchor=path[2]
    return path[0].y===path[1].y?{x:anchor.x,y:from.y}:{x:from.x,y:anchor.y}
  }
  if(index===path.length-2){
    const to=terminalPosition(after,wire.to),anchor=path[index-1]
    return path[index].y===path[index+1].y?{x:anchor.x,y:to.y}:{x:to.x,y:anchor.y}
  }
  return vertex.point
}

/** Keep degree-two anchors on their original straight run when its moving
 * corner overtakes them. IDs and all electrical references remain intact. */
export function slideStraightJunctions(before:Drawing,after:Drawing,selected:ReadonlySet<string>):Drawing {
  if(!before.junctions.length)return after
  const graph=straightGraph(before),wires=new Map(after.wires.map(wire=>[wire.id,wire]))
  const junctions=new Map(after.junctions.map(junction=>[junction.id,junction]))
  const positions=new Map<Vertex,XY>(),changes=new Map<string,XY>()
  const position=(vertex:Vertex)=>{
    let point=positions.get(vertex)
    if(!point){point=vertex.terminal?terminalPosition(after,vertex.terminal):cornerPosition(vertex,after,wires);positions.set(vertex,point)}
    return point
  }
  for(const axis of ['x','y'] as const){
    const transverse=axis==='x'?'y':'x',visited=new Set<Edge>()
    const traversable=(vertex:Vertex)=>!!vertex.terminal&&'junction'in vertex.terminal&&!selected.has(vertex.terminal.junction)&&vertex.edges.length===2&&vertex.edges.every(edge=>edge.axis===null||edge.axis===axis)
    for(const start of graph.vertices){
      if(traversable(start))continue
      for(const first of start.edges){
        if(visited.has(first)||first.axis!==null&&first.axis!==axis)continue
        const chain:Vertex[]=[start]
        let vertex=start,edge=first
        while(!visited.has(edge)){
          visited.add(edge);vertex=edge.a===vertex?edge.b:edge.a;chain.push(vertex)
          if(!traversable(vertex))break
          edge=vertex.edges.find(candidate=>candidate!==edge)!
        }
        if(chain.length<3||traversable(vertex))continue
        const a=position(start),b=position(vertex)
        // A changed perpendicular axis represents a new bend, not a straight
        // run. Leave those intentional routing anchors where the user put them.
        if(a[transverse]!==b[transverse])continue
        const direction=Math.sign(vertex.point[axis]-start.point[axis])
        if(chain.some((point,index)=>index&&direction*(point.point[axis]-chain[index-1].point[axis])<0))continue
        const min=Math.min(a[axis],b[axis]),max=Math.max(a[axis],b[axis])
        for(const interior of chain.slice(1,-1)){
          const id=(interior.terminal as {junction:string}).junction,current=junctions.get(id)!
          const coordinate=Math.max(min,Math.min(max,current[axis]))
          if(coordinate!==current[axis])changes.set(id,{...(changes.get(id)??current),[axis]:coordinate})
        }
      }
    }
  }
  if(!changes.size)return after
  const next={...after,junctions:after.junctions.map(junction=>changes.has(junction.id)?{...junction,...changes.get(junction.id)!}:junction)}
  const originals=new Map(before.wires.map(wire=>[wire.id,wire]))
  return {...next,wires:after.wires.map(wire=>[wire.from,wire.to].some(terminal=>'junction'in terminal&&changes.has(terminal.junction))?followWireEndpoints(before,next,originals.get(wire.id)!,selected):wire)}
}
