#!/usr/bin/env python3
"""Convert locally downloaded OrCAD OLB libraries to geometry and explicit pin maps.

Requires olefile and Pillow (see requirements-orcad-symbols.txt). This is a conservative reader for the
CFBF OrCAD Capture library layout documented by OpenOrCadParser, MIT licensed,
at be0a83ac119390044952cf9bed1e0fb86c448f44. Unsupported primitives reject the
part; missing PSpice templates do not acquire invented SPICE pin order.
"""
import argparse
import base64
import hashlib
import io
import json
import math
import re
import struct
from pathlib import Path

import olefile
from PIL import Image

CONVERTER = {"repo": "Werni2A/OpenOrCadParser", "revision": "be0a83ac119390044952cf9bed1e0fb86c448f44", "implementation": "spice-workbench/scripts/convert-orcad-symbols.py"}
MAGIC = bytes.fromhex('ff e4 5c 39')


def raster_outline(raw, bounds):
    """Trace the manufacturer's embedded monochrome symbol, preserving topology.

    The original raster stays in the conversion record. Vector outlines are a
    display approximation (maximum simplification error 1 source image pixel),
    never an inferred device drawing or inferred pin positions.
    """
    if raw[0xaa:0xb2] == b'CI_IMAGE':
        marker=b'CI_IMAGE~~\0'
        if raw[0xaa:0xaa+len(marker)]!=marker:raise ValueError('unknown compressed image header')
        cursor=0xaa+len(marker);digit_count=raw[cursor];cursor+=1
        if not 1<=digit_count<=10 or not raw[cursor:cursor+digit_count].isdigit():raise ValueError('compressed image length missing')
        image_size=int(raw[cursor:cursor+digit_count]);cursor+=digit_count
        if image_size!=len(raw)-cursor:raise ValueError('compressed image payload size mismatch')
        image=Image.open(io.BytesIO(raw[cursor:]))
    else:
        dib_size=struct.unpack_from('<I',raw)[0]
        depth=struct.unpack_from('<H',raw,14)[0]
        colors=struct.unpack_from('<I',raw,32)[0] or (1<<depth if depth<=8 else 0)
        offset=14+dib_size+colors*4
        image=Image.open(io.BytesIO(struct.pack('<2sIII',b'BM',len(raw)+14,0,offset)+raw))
    image=image.convert('L');w,h=image.size
    if w*h>4000000:raise ValueError('embedded raster too large')
    pixels=image.load();edges={}
    def black(x,y):return 0<=x<w and 0<=y<h and pixels[x,y]<128
    def add(a,b):edges.setdefault(a,[]).append(b)
    for y in range(h):
        for x in range(w):
            if not black(x,y):continue
            if not black(x,y-1):add((x,y),(x+1,y))
            if not black(x+1,y):add((x+1,y),(x+1,y+1))
            if not black(x,y+1):add((x+1,y+1),(x,y+1))
            if not black(x-1,y):add((x,y+1),(x,y))
    def simplify(points,tolerance=1):
        if len(points)<3:return points
        a,b=points[0],points[-1];dx,dy=b[0]-a[0],b[1]-a[1];norm=math.hypot(dx,dy)
        distances=[abs(dx*(a[1]-p[1])-(a[0]-p[0])*dy)/norm if norm else math.dist(a,p) for p in points[1:-1]]
        maximum=max(distances,default=0)
        if maximum<=tolerance:return [a,b]
        index=distances.index(maximum)+1
        return simplify(points[:index+1],tolerance)[:-1]+simplify(points[index:],tolerance)
    result=[];x1,y1,x2,y2=bounds
    def mapped(p):return [x1+p[0]/w*(x2-x1),y1+p[1]/h*(y2-y1)]
    while edges:
        start=next(iter(edges));point=start;loop=[start]
        for _ in range(w*h*4+1):
            if point not in edges:raise ValueError('broken raster contour')
            following=edges[point].pop()
            if not edges[point]:del edges[point]
            loop.append(following);point=following
            if point==start:break
        else:raise ValueError('unbounded raster contour')
        # Split a closed contour at its most distant point before simplification.
        pivot=max(range(1,len(loop)-1),key=lambda i:math.dist(start,loop[i])) if len(loop)>2 else 1
        reduced=simplify(loop[:pivot+1])[:-1]+simplify(loop[pivot:])
        for a,b in zip(reduced,reduced[1:]):
            if a!=b:result.append({'type':'line','coords':mapped(a)+mapped(b),'rasterOutline':True})
    if len(result)>240:raise ValueError(f'raster outline exceeds geometry budget ({len(result)})')
    return result


class Reader:
    def __init__(self, data): self.data, self.pos = data, 0
    def take(self, size):
        if size < 0 or self.pos + size > len(self.data): raise ValueError(f'truncated stream at {self.pos}')
        result = self.data[self.pos:self.pos + size]; self.pos += size; return result
    def u8(self): return self.take(1)[0]
    def u16(self): return struct.unpack('<H', self.take(2))[0]
    def u32(self): return struct.unpack('<I', self.take(4))[0]
    def i16(self): return struct.unpack('<h', self.take(2))[0]
    def i32(self): return struct.unpack('<i', self.take(4))[0]
    def string(self):
        length = self.u16()
        if length > 32767: raise ValueError('invalid string length')
        value = self.take(length)
        if self.u8() != 0 or b'\0' in value: raise ValueError('invalid terminated string')
        return value.decode('cp1252')
    def preamble(self):
        if self.data[self.pos:self.pos + 4] == MAGIC:
            self.take(4); self.take(self.u32())
    def prefix(self, kind):
        start = self.pos
        for count in range(10, 0, -1):
            self.pos = start; stops = []
            try:
                for _ in range(count - 1):
                    if self.u8() != kind: raise ValueError('prefix type')
                    stop = self.pos + 8 + self.u32(); self.take(4)
                    if stop > len(self.data): raise ValueError('prefix bounds')
                    stops.append(stop)
                if self.u8() != kind: raise ValueError('short prefix type')
                n = self.i16()
                if n < -1 or n > 4096: raise ValueError('property count')
                properties = [tuple(struct.unpack('<II', self.take(8))) for _ in range(max(0, n))]
                if self.data[self.pos:self.pos + 4] != MAGIC: raise ValueError('structure preamble missing')
                self.preamble()
                if not stops or max(stops) < self.pos: raise ValueError('missing structure boundary')
                return max(stops), sorted(set(stops)), properties
            except (ValueError, struct.error): pass
        self.pos = start; raise ValueError(f'unsupported structure {kind} at {start}')
    def skip_structure(self, kind):
        end, _, _ = self.prefix(kind); self.pos = end


def string_table(data):
    r = Reader(data)
    if not r.take(32).startswith(b'OrCAD Windows Library'): raise ValueError('not an OrCAD library')
    r.take(16)
    fonts = r.u16()
    if not 1 <= fonts <= 256: raise ValueError('invalid font count')
    r.take((fonts - 1) * 60)
    if r.u16() != 24: raise ValueError('unknown library field table')
    r.take(48 + 8)
    for _ in range(8): r.string()
    r.take(156)
    start = r.pos
    for counter in ('u32', 'u16'):
        r.pos = start
        try:
            n = getattr(r, counter)()
            if n > 200000: raise ValueError('string count')
            strings = [r.string() for _ in range(n)]
            aliases = r.u16()
            for _ in range(aliases): r.string(); r.string()
            if r.pos == len(data): return strings
        except (ValueError, struct.error): pass
    raise ValueError('unsupported library string table')


def font_table(data):
    """LOGFONTA records are source metadata, not guessed CSS font settings."""
    r=Reader(data);r.take(48);count=r.u16();fonts=[]
    if not 1<=count<=256:raise ValueError('invalid font count')
    for _ in range(count-1):
        raw=r.take(60);height,width,escapement,orientation,weight=struct.unpack_from('<5i',raw)
        fonts.append({'height':height,'width':width,'escapement':escapement,'orientation':orientation,'weight':weight,'italic':bool(raw[20]),'family':raw[28:60].split(b'\0',1)[0].decode('cp1252')})
    return fonts


def display_property(r, strings):
    """Decode explicit coordinates/font/rotation; keep unknown display modes raw."""
    end,_,pairs=r.prefix(39)
    name=r.u32();x,y=r.i16(),r.i16();font_rotation=r.u16();color=r.u8();mode=list(r.take(2));reserved=r.u8()
    if name>=len(strings) or reserved!=0 or r.pos!=end:raise ValueError('display property boundary mismatch')
    return {'property':strings[name],'x':x,'y':y,'fontIndex':font_rotation&0x3fff,'rotation':(font_rotation>>14)*90,'color':color,'displayModeBytes':mode,'properties':resolve_props(pairs,strings)}


def primitive(r):
    kind = r.u8()
    if r.u8() != kind: raise ValueError('primitive prefix differs')
    start = r.pos; size = r.u32()
    if r.u32() != 0: raise ValueError('primitive reserved bytes')
    if kind in (40, 41, 42, 43):
        expected = (40, 48) if kind == 42 else (24, 32, 40)
        if size not in expected: raise ValueError(f'unsupported primitive length {kind}:{size}')
        coords = [r.i32() for _ in range(8 if kind == 42 else 4)]
        style = width = 0
        if size >= (48 if kind == 42 else 32): style, width = r.u32(), r.u32()
        fill = 0
        if kind != 42 and size == 40: fill = r.u32(); r.i32()
        if r.pos != start + size: raise ValueError('primitive size mismatch')
        result = {"type": {40:'rectangle', 41:'line', 42:'arc', 43:'ellipse'}[kind], 'coords': coords, 'lineStyle': style, 'lineWidth': width}
        if kind!=42 and size==40:result['fillStyle']=fill
    elif kind in (44, 45, 87):
        variants = []
        body = r.pos
        for meta in (16, 8, 0):
            r.pos = body
            try:
                values = [r.u32() for _ in range(meta // 4)]
                n = r.u16()
                if n < 2 or n > 4096 or 10 + meta + 4 * n != size: continue
                points = []
                for _ in range(n):
                    y, x = r.i16(), r.i16(); points.extend([x, y])
                variants.append({'type': {44:'polygon',45:'polyline',87:'bezier'}[kind], 'coords': points, 'lineStyle': values[0] if values else 0, 'lineWidth': values[1] if values else 0, 'fillStyle': values[2] if len(values) >= 3 else 0})
            except ValueError: pass
        if len(variants) != 1: raise ValueError('ambiguous polygon layout')
        r.pos = start + size; result = variants[0]
    elif kind == 46:
        x,y = r.i32(),r.i32(); bounds=[r.i32() for _ in range(4)]; font = r.u16();r.take(2); text=r.string()
        # Capture text byteLength differs across versions (upstream explicitly
        # documents this). String termination and enclosing checkpoints still
        # bound the actual record; preserve the discrepancy as source metadata.
        result = {'type':'text','coords':[x,y],'bounds':bounds,'text':text,'fontIndex':font, 'declaredBytes':size, 'actualBytes':r.pos-start}
    elif kind == 47:
        location=[r.i32() for _ in range(6)];dimensions=[r.u32(),r.u32()];raw=r.take(r.u32())
        if r.pos!=start+size:raise ValueError('bitmap boundary mismatch')
        bounds=[location[4],location[5],location[2],location[3]]
        result={'type':'bitmap','coords':bounds,'pixelSize':dimensions,'rawBase64':base64.b64encode(raw).decode('ascii'),'vectorization':{'method':'threshold-128-boundary-outline','maximumErrorSourcePixels':1},'outline':raster_outline(raw,bounds)}
    else: raise ValueError(f'unsupported graphic primitive {kind}')
    r.preamble(); return result


def resolve_props(pairs, strings):
    result = {}
    for a,b in pairs:
        if a >= len(strings) or b >= len(strings): raise ValueError('property string index out of range')
        result[strings[a]] = strings[b]
    return result


def library_part(r, strings):
    end, stops, prop_pairs = r.prefix(24)
    name, _ = r.string(), r.string(); r.take(4)
    geometry = [primitive(r) for _ in range(r.u16())]
    rasters=[g for g in geometry if g['type']=='bitmap']
    geometry=[primitive for item in geometry for primitive in (item['outline'] if item['type']=='bitmap' else [item])]
    # The primitive section has an explicit boundary, not a searched byte pattern.
    next_stops = [s for s in stops if s >= r.pos]
    if not next_stops: raise ValueError('missing graphic checkpoint')
    r.pos = min(next_stops)
    pins = []
    for _ in range(r.u16()):
        if r.data[r.pos] == 0:
            r.take(1);pins.append(None);continue
        pin_end, _, pin_props = r.prefix(26)
        pin_name = r.string(); coords = [r.i32() for _ in range(4)]
        shape = r.u16();r.take(2);port_type=r.u32();r.take(4)
        displays=[display_property(r,strings) for _ in range(r.u16())]
        if r.pos > pin_end: raise ValueError('pin exceeds declared boundary')
        r.pos = pin_end
        pins.append({'name':pin_name,'x':coords[2],'y':coords[3], 'bodyX':coords[0],'bodyY':coords[1], 'shape':shape,'portType':port_type,'properties':resolve_props(pin_props,strings),'displayProperties':displays})
    displays=[display_property(r,strings) for _ in range(r.u16())]
    props = resolve_props(prop_pairs, strings)
    if r.pos > end: raise ValueError('library part exceeds boundary')
    general={}
    if r.pos < end:
        r.preamble()
        general={key:r.string() for key in ('implementationPath','implementation','referencePrefix','partValue')}
        general['visibilityFlags']=r.u8()
        if r.u8()!=0 or r.pos!=end:raise ValueError('general properties boundary mismatch')
    result={'id':name,'pins':pins,'geometry':geometry,'properties':props,'generalProperties':general,'displayProperties':displays}
    if rasters:result['originalRasterGraphics']=rasters
    return result


def physical_pin_number(pin):
    number=pin.get('number')
    return number.strip() if isinstance(number,str) and number.strip() else None


def apply_package_pin_map(pins, pin_map):
    """Keep source numbers untouched; an empty number proves no equivalence."""
    if len(pins)!=len(pin_map):raise ValueError('incomplete device pinMap')
    visible_numbers={physical_pin_number(mapping) for pin,mapping in zip(pins,pin_map) if pin is not None and mapping is not None and physical_pin_number(mapping) is not None}
    for pin,mapping in zip(pins,pin_map):
        if pin is None and mapping is not None:
            if physical_pin_number(mapping) is None or physical_pin_number(mapping) not in visible_numbers:raise ValueError('omitted symbol pin has unmatched device mapping')
        if pin is not None and mapping is None:raise ValueError('visible symbol pin has no physical mapping')
        if pin is not None:pin.update(mapping)
    return [pin for pin in pins if pin is not None]


def apply_template_pin_order(pins, tokens):
    """Resolve explicit template tokens against unique logical terminals.

    The source array position identifies a terminal; a missing package number
    never identifies multiple terminals as one. Nonempty duplicate package
    numbers remain ambiguous and are not accepted through a name shortcut.
    """
    assigned=set();ordered=[]
    for pin in pins:pin.pop('spiceOrder',None)
    for token in tokens:
        matches=[index for index,pin in enumerate(pins) if pin.get('name')==token]
        if not matches:matches=[index for index,pin in enumerate(pins) if physical_pin_number(pin) is not None and physical_pin_number(pin)==token]
        if len(matches)!=1 or matches[0] in assigned:return False
        index=matches[0];number=physical_pin_number(pins[index])
        if number is not None and sum(physical_pin_number(pin)==number for pin in pins)!=1:return False
        assigned.add(index);ordered.append(index)
    for order,index in enumerate(ordered,1):pins[index]['spiceOrder']=order
    return bool(ordered)


def read_package(data, strings):
    r = Reader(data); parts = []
    for _ in range(r.u16()):
        r.skip_structure(6)
        for _ in range(r.u16()): parts.append(library_part(r, strings))
    end, _, pairs = r.prefix(31)
    name = r.string(); r.string();ref = r.string();r.string();footprint=r.string()
    maps=[]
    for _ in range(r.u16()):
        device_end, _, device_pairs=r.prefix(32);unit=r.string();r.string();pin_map=[]
        for _ in range(r.u16()):
            if r.data[r.pos:r.pos+2] == b'\xff\xff':r.take(2);pin_map.append(None)
            else: pin_map.append({'number':r.string(),'flags':r.u8()})
        if r.pos != device_end: raise ValueError('device pinMap boundary mismatch')
        maps.append({'unit':unit,'pinMap':pin_map,'properties':resolve_props(device_pairs,strings)})
    if r.pos != end or end != len(data): raise ValueError('package boundary mismatch')
    props=resolve_props(pairs,strings)
    if len(maps)!=1:
        # Preserve decoded drawings and every original unit map, but never turn
        # gate zero or an arbitrary unit into a complete electrical instance.
        for part in parts:
            part['name']=name;part['packageId']=name
            part['physicalUnitMaps']=maps;part['properties'].update(props)
            part['referencePrefix']=ref;part['footprint']=footprint
            part['issues']=['Multi-unit package requires explicit verified unit selection']
            part['unsupportedElectricalMapping']=True
            yield part
        return
    device=maps[0]
    for part in parts:
        if not part['id'].endswith('.Normal'): continue
        part['pins']=apply_package_pin_map(part['pins'],device['pinMap'])
        part['name']=name;part['id']=name;part['properties'].update(props);part['properties'].update(device['properties']);part['referencePrefix']=ref;part['footprint']=footprint
        template=next((v for k,v in part['properties'].items() if k.upper()=='PSPICETEMPLATE'),None)
        part['issues']=[]
        if template:
            part['pspiceTemplate']=template
            fields=[field for field in template.replace('\\n',' ').replace('\n',' ').split() if field!='+']
            model_markers=[i for i,t in enumerate(fields) if t.upper() in ('@MODEL','@VALUE')]
            placeholders=[]
            if model_markers: placeholders=[re.fullmatch(r'%(?:\{([^}]+)\}|([^\s%{}]+))',t) for t in fields[1:model_markers[0]]]
            if placeholders and all(placeholders):
                tokens=[m.group(1) or m.group(2) for m in placeholders]
                # Package terminals absent from the explicit model template
                # (e.g. op-amp offset adjustment pins) remain physical graphics,
                # never guessed into additional simulation ports.
                if not apply_template_pin_order(part['pins'],tokens):
                    part['issues'].append('PSpice template pin references do not resolve uniquely')
            else:part['issues'].append('PSpice template uses unsupported pin syntax')
        else:part['issues'].append('No explicit PSpice template; physical pin order is not simulation port order')
        marker_key=fields[model_markers[0]][1:].upper() if template and model_markers else 'MODEL'
        for key in (marker_key,):
            value=next((v for k,v in part['properties'].items() if k.upper()==key),None)
            if value:part['modelId']=value;break
        if 'modelId' not in part and marker_key=='MODEL' and part['generalProperties'].get('implementation'):part['modelId']=part['generalProperties']['implementation']
        implementation_path=part['generalProperties'].get('implementationPath','')
        if implementation_path and not Path(implementation_path).is_absolute() and ':' not in implementation_path:
            part['modelFile']=implementation_path.replace('\\','/')
        yield part


def convert(path):
    with olefile.OleFileIO(path) as ole:
        library=ole.openstream('Library').read();strings=string_table(library);fonts=font_table(library);parts=[];issues=[]
        for stream in ole.listdir():
            if len(stream)!=2 or stream[0]!='Packages':continue
            try:parts.extend(read_package(ole.openstream(stream).read(),strings))
            except (ValueError,OSError,struct.error,IndexError) as error:issues.append({'stream':'/'.join(stream),'reason':str(error)})
    return {'version':1,'originalSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'converter':CONVERTER,'coordinateSystem':{'unit':'orcad-capture','yDirection':'down','normalized':False},'fonts':fonts,'parts':parts,'issues':issues}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('source',type=Path);parser.add_argument('output',type=Path);args=parser.parse_args()
    summary={'files':0,'convertedFiles':0,'parts':0,'mappedParts':0,'unresolvedUnitParts':0,'rejectedStreams':0,'filesWithIssues':[]}
    for path in sorted(args.source.rglob('*')):
        if path.suffix.lower() not in ('.olb','.obk'):continue
        summary['files']+=1
        relative=path.relative_to(args.source)
        try:record=convert(path)
        except (ValueError,OSError,struct.error,IndexError) as error:record={'version':1,'originalSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'converter':CONVERTER,'parts':[],'issues':[{'reason':str(error)}]}
        record['sourcePath']=relative.as_posix();target=args.output/Path(str(relative)+'.json');target.parent.mkdir(parents=True,exist_ok=True);target.write_text(json.dumps(record,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
        summary['convertedFiles']+=bool(record['parts']);summary['parts']+=len(record['parts']);summary['mappedParts']+=sum(any(pin and 'spiceOrder' in pin for pin in p['pins']) for p in record['parts']);summary['unresolvedUnitParts']+=sum(bool(p.get('unsupportedElectricalMapping')) for p in record['parts']);summary['rejectedStreams']+=len(record['issues'])
        if record['issues']:summary['filesWithIssues'].append({'path':relative.as_posix(),'issues':record['issues'][:5]})
    args.output.mkdir(parents=True,exist_ok=True);(args.output/'conversion-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps({k:v for k,v in summary.items() if k!='filesWithIssues'}))


if __name__=='__main__':main()
