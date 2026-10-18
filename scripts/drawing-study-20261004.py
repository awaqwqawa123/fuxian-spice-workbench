"""Read 48 selected original ASC/ASY files; preserve evidence without running SPICE."""
from pathlib import Path
import gzip, json, hashlib, math, re, sys, html
from collections import defaultdict, Counter

sys.stdout.reconfigure(encoding='utf8')
OUT=Path('docs/artifacts/drawing-study-20261004')
OUT.mkdir(parents=True,exist_ok=True)
CORPUS=Path('../../spice-workbench/docs/artifacts/local-library-complete-20261002')
if not CORPUS.exists(): CORPUS=Path('docs/artifacts/local-library-complete-20261002')
apps='AD8226 AD8475 AD8031 AD8605 LT1995 LT1996 LTC1562 LTC1068 LTC1043 LTC6240 LTC6078 LTC6252 LTC6363 LTC6268 LTC3803 LTC3891 LT8705 LT3798 LT3573 LT3752 LTC4020 LTC4359 LT1636 LT1490 LT8300 LTC3260 LTC1541 LT1970 LT6105 LTC6102 LT4321 LTC4120'.split()
edu=['1563','DCopPnt','GFT','MeasureBW','MonteCarlo','PAsystem/HandsFreePreamp','stepAC','stepmodelparam','stepnoise','steptemp','varactor2','varistor','FRA/fra_eg2_LT8609S','FRA/fra_eg3_LTC3869','FRA/fra_eg6_LT3763_probe_current','FRA/fra_eg9_LT3748_sampled']
selected=['Applications/'+x+'.asc' for x in apps]+['Educational/'+x+'.asc' for x in edu]
records={x['relative']:x for x in json.loads(gzip.decompress((CORPUS/'ltspice.json.gz').read_bytes()))}
definitions=json.loads(gzip.decompress((CORPUS/'symbol-definitions.json.gz').read_bytes()))

def source(path,encoding):
    data=Path(path).read_bytes()
    return data.decode(encoding),hashlib.sha256(data).hexdigest()

def transform(x,y,o):
    a=math.radians(int(o[1:]));c=round(math.cos(a));s=round(math.sin(a))
    xx,yy=c*x-s*y,s*x+c*y
    return (-xx if o[0]=='M' else xx),yy

def graphic(line):
    t=line.split();kind=t[0];n=8 if kind=='ARC' else 4
    if kind not in ['LINE','RECTANGLE','CIRCLE','ARC']:return ''
    q=list(map(float,t[2:2+n]));x,y,X,Y=q[:4]
    dash=' stroke-dasharray="6 4"' if 'Dash' in t[1] else ''
    if kind=='LINE':return f'<line x1="{x}" y1="{y}" x2="{X}" y2="{Y}"{dash}/>'
    if kind=='RECTANGLE':return f'<rect x="{min(x,X)}" y="{min(y,Y)}" width="{abs(X-x)}" height="{abs(Y-y)}"{dash}/>'
    if kind=='CIRCLE':return f'<ellipse cx="{(x+X)/2}" cy="{(y+Y)/2}" rx="{abs(X-x)/2}" ry="{abs(Y-y)/2}"{dash}/>'
    cx,cy=(x+X)/2,(y+Y)/2;rx,ry=abs(X-x)/2,abs(Y-y)/2
    x1,y1,x2,y2=q[4:]
    if not rx or not ry:return ''
    a=math.atan2((y1-cy)/ry,(x1-cx)/rx);b=math.atan2((y2-cy)/ry,(x2-cx)/rx)
    # ASY arcs follow the source bounding ellipse counterclockwise.
    delta=(a-b)%(2*math.pi)
    return f'<path d="M {x1} {y1} A {rx} {ry} 0 {int(delta>math.pi)} 0 {x2} {y2}"{dash}/>'

def render(case,asytexts):
    parts=[];points=[]
    for w in case['wires']:
        x,y,X,Y=w['p'];points.extend([(x,y),(X,Y)])
        parts.append(f'<line x1="{x}" y1="{y}" x2="{X}" y2="{Y}" stroke="#296b50"/>')
    for sym in case['symbols']:
        p=sym['p'];o=sym['orientation'];transformattr=f'translate({p[0]} {p[1]}) '+('scale(-1 1) ' if o[0]=='M' else '')+f'rotate({o[1:]})'
        lines=asytexts[sym['sourceASY']].splitlines();primitives=[];windows={}
        for line in lines:
            if line.startswith(('LINE ','RECTANGLE ','CIRCLE ','ARC ')):
                primitives.append(graphic(line))
                q=line.split();n=8 if q[0]=='ARC' else 4
                for x,y in zip(q[2:2+n:2],q[3:2+n:2]):
                    dx,dy=transform(float(x),float(y),o);points.append((p[0]+dx,p[1]+dy))
            if line.startswith('WINDOW '):windows[line.split()[1]]=line
        for window in sym.get('windows',[]):windows[window['text'].split()[1]]=window['text']
        parts.append(f'<g transform="{transformattr}" stroke="#273b35">'+''.join(primitives)+'</g>')
        for pin in sym['pins']:
            x,y=pin['p'];points.append((x,y))
            if len(sym['pins'])>3:
                parts.append(f'<text x="{x+4}" y="{y-4}" font-size="10" fill="#526b61">{html.escape(pin["name"] or "")}</text>')
        for key,attr in [('0','InstName'),('3','Value')]:
            text=sym['attributes'].get(attr)
            if not text:continue
            if key in windows:
                t=windows[key].split();dx,dy=transform(int(t[2]),int(t[3]),o);align=t[4]
                if len(t)>5 and t[5]=='0':continue
                anchor='middle' if 'Center' in align else 'end' if 'Right' in align else 'start'
            else:dx,dy=24,-14 if key=='0' else 6;anchor='start'
            x,y=p[0]+dx,p[1]+dy;points.extend([(x-20,y-16),(x+len(text)*8,y+8)])
            parts.append(f'<text x="{x}" y="{y}" text-anchor="{anchor}" font-size="13" fill="#263b34">{html.escape(text)}</text>')
    for f in case['flags']:
        x,y=f['p'];points.extend([(x-8,y-6),(x+len(f['name'])*9+12,y+24)])
        if f['name']=='0':parts.append(f'<path d="M {x-10} {y} H {x+10} M {x-7} {y+4} H {x+7} M {x-3} {y+8} H {x+3}" stroke="#296b50"/>')
        else:parts.append(f'<text x="{x+5}" y="{y-7}" font-size="13" fill="#237454">{html.escape(f["name"])}</text>')
    for q in case['geometry']['junctionCandidates']:
        x,y=q['p'];parts.append(f'<circle cx="{x}" cy="{y}" r="2.5" fill="#296b50"/>')
    left=min(x for x,y in points)-30;top=min(y for x,y in points)-30
    width=max(x for x,y in points)-left+30;height=max(y for x,y in points)-top+30
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{left} {top} {width} {height}" fill="none" stroke-width="1.5" font-family="Consolas, sans-serif"><title>{html.escape(case["relative"])} — source-derived structural view, not native LTspice</title><rect x="{left}" y="{top}" width="{width}" height="{height}" fill="white"/>'+''.join(parts)+'</svg>'

cases=[];symbols={};linecount=0
for i,relative in enumerate(selected,1):
    record=records[relative];text,sha=source(record['source'],record['encoding'])
    assert sha==record['sha256'],('Changed original',relative)
    case={**record,'studyId':f'D{i:02d}','originalLines':text.splitlines()}
    linecount+=len(case['originalLines']);asytexts={}
    for sym in case['symbols']:
        path=sym['sourceASY'];definition=definitions[path];asy,hashvalue=source(path,definition['encoding'])
        assert hashvalue==definition['sha256'],('Changed ASY',path)
        asytexts[path]=asy;symbols[path]={**definition,'originalLines':asy.splitlines()}
        for pin,original in zip(sym['pins'],definition['pins']):
            dx,dy=transform(original['x'],original['y'],sym['orientation'])
            assert pin['p']==[sym['p'][0]+dx,sym['p'][1]+dy]
            assert pin['SpiceOrder']==original.get('SpiceOrder')
    (OUT/(case['studyId']+'.svg')).write_text(render(case,asytexts),encoding='utf8')
    cases.append(case)
assert len(cases)==48 and len(set(x['layoutSignature'] for x in cases))==48
result={'date':'2026-10-04','method':'Re-read original full ASC and ASY; geometry and source review; no native GUI or simulation. Original encoding, hashes, complete lines and terminal transforms preserved. SVGs are structural reconstructions with approximate fonts/windows, not native screenshots. No source-file instruction executed.','counts':{'cases':len(cases),'distinctLayoutSignatures':48,'ASC_lines':linecount,'unique_ASY':len(symbols),'ASY_lines':sum(len(x['originalLines']) for x in symbols.values()),'wires':sum(len(x['wires']) for x in cases),'symbolInstances':sum(len(x['symbols']) for x in cases)},'cases':cases,'symbolDefinitions':symbols}
(OUT/'evidence.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
for batch in range(8):
    group=cases[batch*6:batch*6+6];sections=[]
    for x in group:
        sections.append(f'<section><h2>{x["studyId"]} {html.escape(x["relative"])}</h2><img src="{x["studyId"]}.svg"/><p>{len(x["symbols"])} symbols · {len(x["wires"])} wires · {len(x["flags"])} flags</p></section>')
    (OUT/f'sheet-{batch+1}.html').write_text('<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#edf3ef;font-family:Arial}header{padding:12px}main{display:grid;grid-template-columns:1fr 1fr}section{margin:8px;background:white;padding:12px}h2{font-size:15px;margin:0}img{width:720px;height:430px}p{font-size:12px;margin:0}</style><header>2026-10-04 · Original-source structural review · Approximate font/window placement, not native LTspice screenshots</header><main>'+''.join(sections)+'</main>',encoding='utf8')
print(json.dumps(result['counts']))
if len(sys.argv)>1:
    batch=int(sys.argv[1]);group=cases[(batch-1)*6:batch*6]
    for x in group:
        print('\n###',x['studyId'],x['relative'])
        print('WIRES:', '; '.join(f'L{w["line"]}:'+','.join(map(str,w['p'])) for w in x['wires']))
        print('FLAGS:', '; '.join(f'L{f["line"]}:{f["name"]}@{f["p"]}' for f in x['flags']))
        for s in x['symbols']:
            print('SYMBOL L'+str(s['line']),s['name'],s['p'],s['orientation'],s['attributes'],'PINS',[(p['name'],p['SpiceOrder'],p['p']) for p in s['pins']])
        print('TEXT:',x['textsAndDirectives'])
