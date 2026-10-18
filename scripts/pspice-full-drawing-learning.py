"""Preserve and audit manually reviewed CSA/CSV pages; preparation never advances progress."""
from pathlib import Path
import gzip
import hashlib
import html
import json
import math
import re
import sys

sys.stdout.reconfigure(encoding='utf8')
BASE=Path('docs/artifacts/drawing-learning-full-20261004')
CORPUS=Path('docs/artifacts/local-library-complete-20261002')
if not CORPUS.exists():
    CORPUS=Path('../../spice-workbench/docs/artifacts/local-library-complete-20261002')
pages=json.loads(gzip.decompress((CORPUS/'pspice-pages.json.gz').read_bytes()))
lookup={p['id']:p for p in pages}

def write(path,value):
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf8')

def source(path,encoding='utf8',lines=None):
    path=Path(path)
    raw=path.read_bytes()
    text=raw.decode(encoding).splitlines()
    return {'source':str(path).replace('\\','/'),'sha256':hashlib.sha256(raw).hexdigest(),
            'encoding':encoding,'lines':text if lines is None else [{'line':i,'text':text[i-1]} for i in lines]}

def terminal_name(value):
    # Preserve raw source separately; the vector range decorates a terminal name.
    return re.sub(r'<[^>]*>', '', value.split('\\')[0]).strip().split(' ')[0]

def diagram(case):
    """Approximate CSA view using original CSS graphics and explicitly verified transforms."""
    a=case['originalLines']
    objects=[]
    def line(x1,y1,x2,y2,color='#34564c'):
        objects.append(f'<line x1="{x1}" y1="{-y1}" x2="{x2}" y2="{-y2}" stroke="{color}" stroke-width="3"/>')
    def text(x,y,value,size=24):
        objects.append(f'<text x="{x}" y="{-y}" font-size="{size}" fill="#284b40">{html.escape(value)}</text>')
    for l in a:
        if l.startswith('WIRE '):
            values=list(map(int,re.findall(r'-?\d+',l)))
            line(*values[-4:])
        if l.startswith('DOT '):
            values=list(map(int,re.findall(r'-?\d+',l)))
            x,y=values[-2:]
            objects.append(f'<circle cx="{x}" cy="{-y}" r="5" fill="#34564c"/>')
    for sym in case.get('symbols',[]):
        xx,xy,yx,yy=sym['matrix']
        def transform(x,y):
            return sym['origin'][0]+xx*x+xy*y,sym['origin'][1]+yx*x+yy*y
        for l in sym['lines']:
            tokens=l.split()
            if l.startswith(('L ', 'M ')):
                coords=list(map(int,tokens[1:5]))
                line(*transform(*coords[:2]),*transform(*coords[2:]))
            elif l.startswith('A '):
                x,y=transform(float(tokens[1]),float(tokens[2]))
                start,end=map(float,tokens[4:6])
                if start==0 and end>359:
                    objects.append(f'<circle cx="{x}" cy="{-y}" r="{tokens[3]}" fill="none" stroke="#34564c" stroke-width="3"/>')
                else:
                    # Approximate the original CSS arc in source coordinates before
                    # applying the instance matrix; no orientation-code guessing.
                    cx,cy,radius=map(float,tokens[1:4])
                    sweep=(end-start)%360
                    points=[]
                    for step in range(65):
                        angle=math.radians(start+sweep*step/64)
                        px,py=transform(cx+radius*math.cos(angle),cy+radius*math.sin(angle))
                        points.append(f'{px},{-py}')
                    objects.append('<polyline points="'+' '.join(points)+'" fill="none" stroke="#34564c" stroke-width="3"/>')
            elif l.startswith('T '):
                x,y=transform(float(tokens[1]),float(tokens[2]))
                # The following source line is the actual original text.
                index=sym['lines'].index(l)
                text(x,y,sym['lines'][index+1],float(tokens[5]))
    # Properties use their actual CSA coordinates; typography remains approximate.
    for i,l in enumerate(a):
        if l.startswith('FORCEPROP '):
            stop=next((j for j in range(i+1,len(a)) if a[j].startswith(('FORCEPROP ','FORCEADD ','WIRE ','FORCENOTE','QUIT'))),len(a))
            block=a[i+1:stop]
            if any('DISPLAY INVISIBLE' in item for item in block):
                continue
            m=re.match(r'FORCEPROP \d+ LAST (\S+)\s+(.*)',l)
            at=next((re.match(r'\((-?\d+) (-?\d+)\)',item) for item in block if item.startswith('(')),None)
            if m and at and not m[1].startswith('$'):
                caption=m[1]+' = '+m[2] if any('DISPLAY BOTH' in item for item in block) else m[2]
                text(int(at[1]),int(at[2]),caption)
        elif l=='FORCENOTE':
            at=re.match(r'\((-?\d+) (-?\d+)\)',a[i+2])
            text(int(at[1]),int(at[2]),a[i+1],28)
    bounds=case['viewBox']
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="'+bounds+'"><rect x="-10000" y="-10000" width="20000" height="20000" fill="white"/>'+''.join(objects)+'</svg>'

def audit_csv_geometry(case):
    """Compare preserved CSV electrical identities with original CSA geometry."""
    blocks=re.split(r'^%"', '\n'.join(case['connectivity']['lines']), flags=re.M)[1:]
    csv_pins={}
    bus_taps=[]
    for block in blocks:
        header=re.search(r'^"\d+","\((-?\d+),(-?\d+)\)","\d+","[^"]+","([^"]*)";',block,re.M)
        assert header, 'Every CSV instance needs an explicit identity.'
        pins={}
        # PS045 TAP scalar net follows BN; the quoted number selects a bit.
        for match in re.finditer(r'^"([^"\n]+)"\nBN"(\d+)"(\d+);$',block,re.M):
            pins[terminal_name(match[1])]=int(match[3])
            assert block.startswith('TAP"\n') and 'HDL_TAP"TRUE"' in block
            bus_taps.append({'instance':header[3],'terminal':terminal_name(match[1]),'bit':int(match[2]),'scalarNet':int(match[3])})
        for match in re.finditer(r'^"([^"\n]+)"(\d+);$',block,re.M):
            name=terminal_name(match[1])
            pins[name]=int(match[2])
        # This archive appends the net to the final Clock property instead of
        # the pin name. Keep FLOAT/Clock metadata separate from the net index.
        for match in re.finditer(r'^"([^"\n]+)"\n(?:FLOAT"[^"\n]*"\n)?Clock"[^"\n]*"(\d+);$',block,re.M):
            pins[terminal_name(match[1])]=int(match[2])
        # Other pages place Clock first and terminate FLOAT with the net.
        for match in re.finditer(r'^"([^"\n]+)"\nClock"[^"\n]*"\nFLOAT"[^"\n]*"(\d+);$',block,re.M):
            pins[terminal_name(match[1])]=int(match[2])
        # PS020 includes package $PN among the pin metadata, either before
        # Clock or after FLOAT/Clock. Only the trailing integer is a net;
        # the quoted $PN value remains a physical package pin number.
        for match in re.finditer(r'^"([^"\n]+)"\n(?:(?:\$PN|Clock|FLOAT)"[^"\n]*"\n)*(?:\$PN|Clock|FLOAT)"[^"\n]*"(\d+);$',block,re.M):
            pins[terminal_name(match[1])]=int(match[2])
        # PS025 retains archived current annotations inside actual pin blocks.
        # Only the integer after the final property is the electrical net.
        for match in re.finditer(r'^"([^"\n]+)"\n(?:(?:\$BIASCURRENT|FLOAT|Clock)"[^"\n]*"\n)*(?:\$BIASCURRENT|FLOAT|Clock)"[^"\n]*"(\d+);$',block,re.M):
            pins[terminal_name(match[1])]=int(match[2])
        for match in re.finditer(r'^"([^"\n]+)"\nFLOAT"[^"\n]+"0;$',block,re.M):
            pins[terminal_name(match[1])]=0
        # Original hierarchical ports carry the net on the final port property.
        for match in re.finditer(r'^"([^"\n]+)"\n(?:(?:HDL_PORT|VHDL_PORT|VHDL_MODE|VHDL_SCALAR_TYPE)"[^"\n]+"\n)*(?:HDL_PORT|VHDL_PORT|VHDL_MODE|VHDL_SCALAR_TYPE)"[^"\n]+"(\d+);$',block,re.M):
            pins[match[1]]=int(match[2])
        if not header[3]:
            assert block.startswith('DRAWING"\n') and not pins, 'Only a pinless decorative DRAWING may have no instance identity.'
            continue
        csv_pins[header[3]]=pins
    geometry=[]
    points=set()
    for line in case['originalLines']:
        if line.startswith('WIRE '):
            coordinates=list(map(int,re.findall(r'-?\d+',line)))[-4:]
            a,b=tuple(coordinates[:2]),tuple(coordinates[2:])
            geometry.append((a,b));points.update([a,b])
        elif line.startswith('DOT '):
            points.add(tuple(map(int,re.findall(r'-?\d+',line)[-2:])))
    checked=[]
    for instance,pins in case['verifiedPins'].items():
        assert set(csv_pins[instance])==set(pins), (instance, csv_pins[instance], pins)
        for name,anchor in pins.items():
            assert csv_pins[instance][name]==anchor[2]
            p=tuple(anchor[:2]);points.add(p);checked.append((p,anchor[2]))
    parent={p:p for p in points}
    def find(p):
        while parent[p]!=p:
            parent[p]=parent[parent[p]];p=parent[p]
        return p
    def join(a,b):
        parent[find(a)]=find(b)
    for a,b in geometry:
        on=[]
        for p in points:
            cross=(p[0]-a[0])*(b[1]-a[1])-(p[1]-a[1])*(b[0]-a[0])
            if cross==0 and min(a[0],b[0])<=p[0]<=max(a[0],b[0]) and min(a[1],b[1])<=p[1]<=max(a[1],b[1]):on.append(p)
        for p in on:join(a,p)
    by_component={};by_net={};unconnected=[]
    nc_net=case.get('unconnectedCsvNet')
    if nc_net is not None:
        assert f'{nc_net}"NC";' in case['connectivity']['lines'], 'NC requires explicit CSV evidence.'
    for p,net in checked:
        component=find(p)
        assert by_component.setdefault(component,net)==net, 'CSA geometry shorts distinct CSV nets.'
        if net==nc_net:
            assert component==p and component not in unconnected, 'Distinct NC pins must remain separate.'
            assert not any((p[0]-a[0])*(b[1]-a[1])==(p[1]-a[1])*(b[0]-a[0]) and min(a[0],b[0])<=p[0]<=max(a[0],b[0]) and min(a[1],b[1])<=p[1]<=max(a[1],b[1]) for a,b in geometry), 'NC pin unexpectedly touches a wire.'
            unconnected.append(component)
            continue
        assert by_net.setdefault(net,component)==component, 'CSV net is disconnected in CSA geometry.'
    return {'pinsCompared':len(checked),'netsCompared':len(by_net),'unconnectedPinsCompared':len(unconnected),'busTapMetadata':bus_taps,'scope':f'Explicit {case["id"]} CSV pin identities versus original CSA wire components; no simulator or product render; named global equivalence is retained separately.'}

mode=sys.argv[1]
batch=sys.argv[2]
out=BASE/batch
if mode=='prepare-circuit' and batch=='P042':
    assert sys.argv[3:]==['PS045'] and not out.exists(), 'Only individually checked decade counter transforms are registered.'
    p=lookup['PS045']; original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    c={'id':'PS045','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[], 'verifiedPins':{},
       'unconnectedCsvNet':0,'viewBox':'-1300 -3500 6600 5000',
       'geometryBoundary':'All 13 instances retain identity matrices individually checked from CSA/CSV/CSS. Four TAP sym_4 B contacts have no CSA LASTPIN; their original CSS contact, type17 bus WIRE and CSV B net4 provide explicit evidence. TAP S bits0/1/2/3 remain scalar nets5/1/2/3; internal plumbing never electrically joins B and S. Qbar pins are four independent NCs.',
       'modelBoundary':'Complete 7473, INV, NAN4 and their necessary timing/IO/conversion dependencies retained. Global digital supply contacts are optional model/template bindings, not drawn package pins. Historical profile/path and original STIM commands preserved. No native render, product acceptance or simulator compatibility claim.'}
    ident=[1,0,0,1]
    instances=[]
    for instance,origin,clk,q in [('I1',[50,1000],6,5),('I2',[1150,1000],5,1),('I3',[2200,1000],1,2),('I4',[3100,1000],2,3)]:
        x,y=origin
        instances.append(('7473',instance,origin,ident,{'J':[x-50,y-50,10],'CLK*':[x-32,y-150,clk],'K':[x-50,y-250,10],'|CLR|*':[x+100,y-382,9],'Q':[x+250,y-50,q],'|Q|*':[x+232,y-250,0]}))
    instances += [
        ('inv','I5',[3700,2400],ident,{'I0':[3650,2300,2],'O*':[3882,2300,7]}),
        ('inv','I6',[3750,2000],ident,{'I0':[3700,1900,5],'O*':[3932,1900,8]}),
        ('nan4','I7',[4250,2350],ident,{'I0':[4200,2350,1],'I1':[4200,2300,7],'I2':[4200,2200,3],'I3':[4200,2150,8],'O*':[4532,2250,9]}),
        ('stim1','I8',[-1000,2000],ident,{'pin1':[-750,1950,10]}),
        ('digclock','I9',[-950,1050],ident,{'1':[-700,1000,6]})]
    for instance,x,net in [('I14',650,5),('I15',1550,1),('I16',2650,2),('I17',3450,3)]:
        instances.append(('tap',instance,[x,3200],ident,{'S':[x,3150,net],'B':[x+25,3250,4]}))
    blocks=re.split(r'^FORCEADD ', '\n'.join(c['originalLines']), flags=re.M)[1:]
    for part,instance,origin,matrix,pins in instances:
        css=source(root.parent/'archive_libs/libs'/part/('sym_4/symbol.css' if part=='tap' else 'sym_1/symbol.css'))
        block=next(b for b in blocks if re.search(r'^FORCEPROP [12] LAST PATH '+instance+r'\s*$',b,re.M))
        lastpins={tuple(map(int,m)) for m in re.findall(r'LASTPIN \((-?\d+) (-?\d+)\)',block)}
        assert {tuple(a[:2]) for name,a in pins.items() if not (part=='tap' and name=='B')}==lastpins
        for line in css['lines']:
            match=re.match(r'C (-?\d+) (-?\d+) "([^"]+)"',line)
            if match:
                x,y=int(match[1]),int(match[2]);xx,xy,yx,yy=matrix
                assert pins[terminal_name(match[3])][:2]==[origin[0]+xx*x+xy*y,origin[1]+yx*x+yy*y]
        c['symbols'].append({**css,'part':part,'instance':instance,'origin':origin,'matrix':matrix})
        c['verifiedPins'][instance]=pins
    paths=['cds.lib','worklib/decade/sch_1/verilog.v','worklib/decade/sch_1/viewprps.prp',
           'worklib/decade/psp_sim_1/decade.net','worklib/decade/psp_sim_1/profiles/Tran/Tran.cir',
           'worklib/glbl/decade_cfg_analog/verilog.v']
    c['supplemental']=[source(root/path) for path in paths]
    lib=Path('E:/Cadence/SPB_25.1/tools/pspice/library')
    c['supplemental'] += [source(lib/'nom.lib','cp1252',lines=[32]),source(lib/'nom_dig.lib','cp1252'),
        source(lib/'7400.lib','cp1252',lines=list(range(1486,1537))),
        source(lib/'dig_prim.lib','cp1252',lines=list(range(338,347))+list(range(383,392))+[2175,2179]),
        source(lib/'dig_io.lib','cp1252',lines=list(range(180,189))+list(range(268,274))+list(range(286,292))+list(range(313,321))+[337]+list(range(1094,1106))+list(range(1138,1149))+list(range(1151,1162))+list(range(1183,1189))+list(range(1205,1213))+list(range(1223,1233))+list(range(1234,1238))+list(range(3804,3807))+list(range(3812,3815))+list(range(3820,3832)))]
    out.mkdir(parents=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS045.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:900px}</style><p>CSA/CSS source reconstruction; not native screenshot or product acceptance.</p><section><h2>PS045 decade counter</h2><img src="PS045.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':['PS045'],'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P043':
    assert sys.argv[3:]==['PS046'] and not out.exists(), 'Only individually checked capacitive and inductive high-pass filters transforms are registered.'
    p=lookup['PS046']; original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    c={'id':'PS046','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[], 'verifiedPins':{},
       'unconnectedCsvNet':0,'viewBox':'-3100 -2450 7200 2450',
       'geometryBoundary':'Original CSS, CSA LASTPIN and CSV individually verify R1/R3 R3 [0,-1,-1,0] and L1 R5 [0,1,-1,0]; other contacts identity. Ground local nets1/2 explicitly share global zero. Two filters retain independent source/output nodes, not bridged by visual similarity.',
       'modelBoundary':'Only primitive R/C/L/V elements with empty original IC/tolerance, no extra standard model required. AC source magnitude and full historical ac_sweep profile preserved; text explanations are design intent, not measured response. No native screenshot, simulation or product acceptance.'}
    ident=[1,0,0,1]
    instances=[
        ('vac','I1',[-2650,1400],ident,{'+':[-2600,1450,5],'-':[-2600,1250,1]}),
        ('l','I10',[1750,1550],[0,1,-1,0],{'1':[1700,1600,3],'2':[1700,1300,2]}),
        ('c','I2',[-2200,1850],ident,{'1':[-2250,1800,5],'2':[-2100,1800,4]}),
        ('r','I3',[-1750,1600],[0,-1,-1,0],{'1':[-1700,1650,4],'2':[-1700,1450,1]}),
        ('0','I4',[-2300,950],ident,{'GND':[-2250,1000,1]}),
        ('r','I5',[1950,1600],[0,-1,-1,0],{'1':[2000,1650,3],'2':[2000,1450,2]}),
        ('vac','I7',[1050,1400],ident,{'+':[1100,1450,6],'-':[1100,1250,2]}),
        ('0','I8',[1400,950],ident,{'GND':[1450,1000,2]}),
        ('r','I9',[1300,1850],ident,{'1':[1250,1800,6],'2':[1450,1800,3]})]
    blocks=re.split(r'^FORCEADD ', '\n'.join(c['originalLines']), flags=re.M)[1:]
    for part,instance,origin,matrix,pins in instances:
        css=source(root.parent/'archive_libs/libs'/part/'sym_1/symbol.css')
        block=next(b for b in blocks if re.search(r'^FORCEPROP 1 LAST PATH '+instance+r'\s*$',b,re.M))
        lastpins={tuple(map(int,m)) for m in re.findall(r'LASTPIN \((-?\d+) (-?\d+)\)',block)}
        assert {tuple(a[:2]) for a in pins.values()}==lastpins
        for line in css['lines']:
            match=re.match(r'C (-?\d+) (-?\d+) "([^"]+)"',line)
            if match:
                x,y=int(match[1]),int(match[2]);xx,xy,yx,yy=matrix
                assert pins[terminal_name(match[3])][:2]==[origin[0]+xx*x+xy*y,origin[1]+yx*x+yy*y]
        c['symbols'].append({**css,'part':part,'instance':instance,'origin':origin,'matrix':matrix})
        c['verifiedPins'][instance]=pins
    paths=['cds.lib','worklib/hpf/sch_1/verilog.v','worklib/hpf/sch_1/viewprps.prp',
           'worklib/hpf/psp_sim_1/hpf.net','worklib/hpf/psp_sim_1/profiles/ac_sweep/ac_sweep.cir',
           'worklib/glbl/hpf_cfg_analog/verilog.v']
    c['supplemental']=[source(root/path) for path in paths]
    out.mkdir(parents=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS046.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:900px}</style><p>CSA/CSS source reconstruction; not native screenshot or product acceptance.</p><section><h2>PS046 capacitive and inductive high-pass filters</h2><img src="PS046.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':['PS046'],'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P041':
    assert sys.argv[3:]==['PS044'] and not out.exists(), 'Only individually checked single-switch forward transforms are registered.'
    p=lookup['PS044']; original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    c={'id':'PS044','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[], 'verifiedPins':{},
       'unconnectedCsvNet':0,'viewBox':'-1350 -2850 4650 3100',
       'geometryBoundary':'CSS contacts checked individually against CSA LASTPIN and CSV. M1 R7 [0,1,1,0]; primary L1 R5 [0,1,-1,0]; secondary L3, C1 and R1/R2 R3 [0,-1,-1,0]; D2 R1 [0,-1,1,0]. Local ground indices 8/9 share explicit global 0\\g. K has no electrical pins.',
       'modelBoundary':'Complete necessary MUR150 and IRFZ34 declarations and current nom.lib binding retained. Single low-side gate drive returns to MOS source ground. Primary/secondary inductances and coupling are preserved; no reset winding is invented. Historical profile includes existing ss_fwd_cnvrtr.net; historical absolute model library path is preserved without claiming it runnable. No simulation or product acceptance.'}
    ident=[1,0,0,1]
    instances=[
        ('vdc','I1',[-1000,1700],ident,{'+':[-950,1700,1],'-':[-950,1500,9]}),
        ('l','I10',[1500,2200],ident,{'1':[1450,2150,5],'2':[1750,2150,2]}),
        ('c','I11',[1950,1950],[0,-1,-1,0],{'1':[2000,2000,2],'2':[2000,1850,8]}),
        ('r','I12',[2300,1950],[0,-1,-1,0],{'1':[2350,2000,2],'2':[2350,1800,8]}),
        ('0','I13',[1150,800],ident,{'GND':[1200,850,8]}),
        ('k_linear','I14',[150,2450],ident,{}),
        ('irfz34','I2',[-250,1250],[0,1,1,0],{'d':[-250,1350,3],'g':[-350,1200,6],'s':[-450,1350,9]}),
        ('r','I3',[-400,850],[0,-1,-1,0],{'1':[-350,900,6],'2':[-350,700,7]}),
        ('vpulse','I4',[-400,350],ident,{'+':[-350,400,7],'-':[-350,200,9]}),
        ('l','I5',[100,1750],[0,1,-1,0],{'1':[50,1800,1],'2':[50,1500,3]}),
        ('l','I6',[400,1750],[0,-1,-1,0],{'1':[450,1800,4],'2':[450,1500,8]}),
        ('0','I7',[-900,-100],ident,{'GND':[-850,-50,9]}),
        ('mur150','I8',[700,2200],ident,{'1':[650,2150,4],'2':[800,2150,5]}),
        ('mur150','I9',[1150,1800],[0,-1,1,0],{'1':[1200,1750,8],'2':[1200,1900,5]})]
    blocks=re.split(r'^FORCEADD ', '\n'.join(c['originalLines']), flags=re.M)[1:]
    for part,instance,origin,matrix,pins in instances:
        css=source(root.parents[2]/'archive_libs/libs'/part/'sym_1/symbol.css')
        block=next(b for b in blocks if re.search(r'^FORCEPROP 1 LAST PATH '+instance+r'\s*$',b,re.M))
        lastpins={tuple(map(int,m)) for m in re.findall(r'LASTPIN \((-?\d+) (-?\d+)\)',block)}
        assert {tuple(a[:2]) for a in pins.values()}==lastpins
        for line in css['lines']:
            match=re.match(r'C (-?\d+) (-?\d+) "([^"]+)"',line)
            if match:
                x,y=int(match[1]),int(match[2]);xx,xy,yx,yy=matrix
                assert pins[terminal_name(match[3])][:2]==[origin[0]+xx*x+xy*y,origin[1]+yx*x+yy*y]
        c['symbols'].append({**css,'part':part,'instance':instance,'origin':origin,'matrix':matrix})
        c['verifiedPins'][instance]=pins
    paths=['cds.lib','worklib/ss_fwd_cnvrtr/sch_1/verilog.v','worklib/ss_fwd_cnvrtr/sch_1/viewprps.prp',
           'worklib/ss_fwd_cnvrtr/psp_sim_1/ss_fwd_cnvrtr.net','worklib/ss_fwd_cnvrtr/psp_sim_1/profiles/tran/tran.cir',
           'worklib/glbl/ss_fwd_cnvrtr_cfg_analog/verilog.v']
    c['supplemental']=[source(root/path) for path in paths]
    c['supplemental'] += [source('E:/Cadence/SPB_25.1/tools/pspice/library/nom.lib','cp1252',lines=[39,50]),
                          source('E:/Cadence/SPB_25.1/tools/pspice/library/diode.lib','cp1252',lines=list(range(23076,23078))),
                          source('E:/Cadence/SPB_25.1/tools/pspice/library/pwrmos.lib','cp1252',lines=list(range(4583,4587)))]
    out.mkdir(parents=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS044.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:900px}</style><p>CSA/CSS source reconstruction; not native screenshot or product acceptance.</p><section><h2>PS044 single-switch forward</h2><img src="PS044.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':['PS044'],'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P040':
    assert sys.argv[3:]==['PS043'] and not out.exists(), 'Only individually checked double-switch forward transforms are registered.'
    p=lookup['PS043']; original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    c={'id':'PS043','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[], 'verifiedPins':{},
       'unconnectedCsvNet':0,'viewBox':'-1350 -2900 4650 3450',
       'geometryBoundary':'CSS contacts checked individually against CSA LASTPIN and CSV. M1 R7 [0,1,1,0], M2 R3 [0,-1,-1,0]; L2 R5 [0,1,-1,0], L3/vertical diodes R1 [0,-1,1,0]; output C/R and R2 R3 [0,-1,-1,0]. Local ground indices 10/11 share explicit global 0\\g. High-side drive returns to M2 source net 2, never ground. K has no electrical pins.',
       'modelBoundary':'Complete necessary MUR150 and IRFZ34 declarations and current nom.lib binding retained. Original two identical pulse sources retained independently; high-side floating return differs from low-side ground. Coupled inductances and K are preserved. Historical profile references absent doubleswitch_forwardconverter.net, while current ds_fwd_cnvrtr.net exists separately. No simulation, historical binding confirmation or product acceptance.'}
    ident=[1,0,0,1]
    instances=[
        ('vdc','I1',[-1050,1350],ident,{'+':[-1000,1350,7],'-':[-1000,1150,11]}),
        ('l','I10',[250,1300],[0,1,-1,0],{'1':[200,1350,2],'2':[200,1050,12]}),
        ('r','I11',[-50,2700],ident,{'1':[-100,2650,1],'2':[100,2650,8]}),
        ('vpulse','I12',[250,2400],ident,{'+':[300,2450,8],'-':[300,2250,2]}),
        ('mur150','I13',[800,1750],ident,{'1':[750,1700,6],'2':[900,1700,3]}),
        ('mur150','I14',[1100,1300],[0,-1,1,0],{'1':[1150,1250,10],'2':[1150,1400,3]}),
        ('l','I15',[1400,1750],ident,{'1':[1350,1700,3],'2':[1650,1700,9]}),
        ('c','I16',[1800,1400],[0,-1,-1,0],{'1':[1850,1450,9],'2':[1850,1300,10]}),
        ('r','I17',[2200,1450],[0,-1,-1,0],{'1':[2250,1500,9],'2':[2250,1300,10]}),
        ('0','I18',[1200,750],ident,{'GND':[1250,800,10]}),
        ('k_linear','I19',[500,2050],ident,{}),
        ('mur150','I2',[-600,1250],[0,-1,1,0],{'1':[-550,1200,11],'2':[-550,1350,2]}),
        ('irfz34','I3',[-200,750],[0,1,1,0],{'d':[-200,850,12],'g':[-300,700,4],'s':[-400,850,11]}),
        ('irfz34','I4',[-400,2100],[0,-1,-1,0],{'d':[-400,2000,7],'g':[-300,2150,1],'s':[-200,2000,2]}),
        ('r','I5',[-350,450],[0,-1,-1,0],{'1':[-300,500,4],'2':[-300,300,5]}),
        ('vpulse','I6',[-350,150],ident,{'+':[-300,200,5],'-':[-300,0,11]}),
        ('0','I7',[-550,-450],ident,{'GND':[-500,-400,11]}),
        ('mur150','I8',[-850,1550],[0,-1,1,0],{'1':[-800,1500,12],'2':[-800,1650,7]}),
        ('l','I9',[450,1100],[0,-1,1,0],{'1':[500,1050,10],'2':[500,1350,6]})]
    blocks=re.split(r'^FORCEADD ', '\n'.join(c['originalLines']), flags=re.M)[1:]
    for part,instance,origin,matrix,pins in instances:
        css=source(root.parents[2]/'archive_libs/libs'/part/'sym_1/symbol.css')
        block=next(b for b in blocks if re.search(r'^FORCEPROP 1 LAST PATH '+instance+r'\s*$',b,re.M))
        lastpins={tuple(map(int,m)) for m in re.findall(r'LASTPIN \((-?\d+) (-?\d+)\)',block)}
        assert {tuple(a[:2]) for a in pins.values()}==lastpins
        for line in css['lines']:
            match=re.match(r'C (-?\d+) (-?\d+) "([^"]+)"',line)
            if match:
                x,y=int(match[1]),int(match[2]);xx,xy,yx,yy=matrix
                assert pins[terminal_name(match[3])][:2]==[origin[0]+xx*x+xy*y,origin[1]+yx*x+yy*y]
        c['symbols'].append({**css,'part':part,'instance':instance,'origin':origin,'matrix':matrix})
        c['verifiedPins'][instance]=pins
    paths=['cds.lib','worklib/ds_fwd_cnvrtr/sch_1/verilog.v','worklib/ds_fwd_cnvrtr/sch_1/viewprps.prp',
           'worklib/ds_fwd_cnvrtr/psp_sim_1/ds_fwd_cnvrtr.net','worklib/ds_fwd_cnvrtr/psp_sim_1/profiles/tran/tran.cir',
           'worklib/glbl/ds_fwd_cnvrtr_cfg_analog/verilog.v']
    c['supplemental']=[source(root/path) for path in paths]
    c['supplemental'] += [source('E:/Cadence/SPB_25.1/tools/pspice/library/nom.lib','cp1252',lines=[39,50]),
                          source('E:/Cadence/SPB_25.1/tools/pspice/library/diode.lib','cp1252',lines=list(range(23076,23078))),
                          source('E:/Cadence/SPB_25.1/tools/pspice/library/pwrmos.lib','cp1252',lines=list(range(4583,4587)))]
    out.mkdir(parents=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS043.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:900px}</style><p>CSA/CSS source reconstruction; not native screenshot or product acceptance.</p><section><h2>PS043 double-switch forward</h2><img src="PS043.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':['PS043'],'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P039':
    assert sys.argv[3:]==['PS042'] and not out.exists(), 'Only individually checked flyback transforms are registered.'
    p=lookup['PS042']; original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    c={'id':'PS042','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[], 'verifiedPins':{},
       'unconnectedCsvNet':0,'viewBox':'-1500 -2800 7500 2900',
       'geometryBoundary':'Original CSS contacts verified against CSA LASTPIN and CSV. IRFZ34 R7 [0,1,1,0]; primary L R5 [0,1,-1,0], secondary L and gate R R1 [0,-1,1,0]; output C/R R3 [0,-1,-1,0]. Three local ground indices 1/2/3 explicitly share global 0\\g. Coupling element has no electrical pins; winding endpoints never joined.',
       'modelBoundary':'Necessary complete MUR150 and IRFZ34 models plus nom.lib binding retained. Original claims galvanic isolation despite shared global ground; source calls L2/L1=0.5 a turn ratio although values are inductances 250/500uH. Preserve these discrepancies, no excitation/ground/inductance correction, no simulation or product pass.'}
    ident=[1,0,0,1]
    instances=[
        ('vdc','I1',[-1050,1800],ident,{'+':[-1000,1800,5],'-':[-1000,1600,1]}),
        ('0','I11',[-500,200],ident,{'GND':[-450,250,3]}),
        ('0','I12',[600,200],ident,{'GND':[650,250,2]}),
        ('0','I13',[-1150,250],ident,{'GND':[-1100,300,1]}),
        ('k_linear','I14',[50,2450],ident,{}),
        ('irfz34','I15',[-350,1300],[0,1,1,0],{'d':[-350,1400,7],'g':[-450,1250,6],'s':[-550,1400,1]}),
        ('r','I3',[-500,1000],[0,-1,1,0],{'1':[-450,950,8],'2':[-450,1150,6]}),
        ('vpulse','I4',[-500,600],ident,{'+':[-450,650,8],'-':[-450,450,3]}),
        ('l','I5',[50,1800],[0,1,-1,0],{'1':[0,1850,5],'2':[0,1550,7]}),
        ('l','I6',[200,1600],[0,-1,1,0],{'1':[250,1550,2],'2':[250,1850,9]}),
        ('mur150','I7',[600,2150],ident,{'1':[550,2100,9],'2':[700,2100,4]}),
        ('c','I8',[1000,1800],[0,-1,-1,0],{'1':[1050,1850,4],'2':[1050,1700,2]}),
        ('r','I9',[1300,1800],[0,-1,-1,0],{'1':[1350,1850,4],'2':[1350,1650,2]})]
    blocks=re.split(r'^FORCEADD ', '\n'.join(c['originalLines']), flags=re.M)[1:]
    for part,instance,origin,matrix,pins in instances:
        css=source(root.parent.parent/'archive_libs/libs'/part/'sym_1/symbol.css')
        block=next(b for b in blocks if re.search(r'^FORCEPROP 1 LAST PATH '+instance+r'\s*$',b,re.M))
        lastpins={tuple(map(int,m)) for m in re.findall(r'LASTPIN \((-?\d+) (-?\d+)\)',block)}
        assert {tuple(a[:2]) for a in pins.values()}==lastpins
        for line in css['lines']:
            match=re.match(r'C (-?\d+) (-?\d+) "([^"]+)"',line)
            if match:
                x,y=int(match[1]),int(match[2]);xx,xy,yx,yy=matrix
                assert pins[terminal_name(match[3])][:2]==[origin[0]+xx*x+xy*y,origin[1]+yx*x+yy*y]
        c['symbols'].append({**css,'part':part,'instance':instance,'origin':origin,'matrix':matrix})
        c['verifiedPins'][instance]=pins
    paths=['cds.lib','worklib/flyback_cnvrtr/sch_1/verilog.v','worklib/flyback_cnvrtr/sch_1/viewprps.prp',
           'worklib/flyback_cnvrtr/psp_sim_1/flyback_cnvrtr.net','worklib/flyback_cnvrtr/psp_sim_1/profiles/tran/tran.cir',
           'worklib/glbl/flyback_cnvrtr_cfg_analog/verilog.v']
    c['supplemental']=[source(root/path) for path in paths]
    c['supplemental'] += [source('E:/Cadence/SPB_25.1/tools/pspice/library/nom.lib','cp1252',lines=[39,50]),
                          source('E:/Cadence/SPB_25.1/tools/pspice/library/diode.lib','cp1252',lines=list(range(23076,23078))),
                          source('E:/Cadence/SPB_25.1/tools/pspice/library/pwrmos.lib','cp1252',lines=list(range(4583,4587)))]
    out.mkdir(parents=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS042.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:900px}</style><p>CSA/CSS source reconstruction; not native screenshot or product acceptance.</p><section><h2>PS042 flyback</h2><img src="PS042.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':['PS042'],'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P038':
    assert sys.argv[3:]==['PS041'] and not out.exists(), 'Only explicitly reviewed buck-boost transforms are registered.'
    p=lookup['PS041']; original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    c={'id':'PS041','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[], 'verifiedPins':{},
       'unconnectedCsvNet':0,'viewBox':'-1500 -2700 7000 2900',
       'geometryBoundary':'CSS contacts individually checked against CSA LASTPIN and CSV. IRFZ34 R1 [0,-1,1,0]; L/C/R R3 [0,-1,-1,0]; MUR150 R2 [-1,0,0,1]. Ground indices 2/3 retain explicit global 0\\g equivalence. Gate-drive negative terminal returns to MOS source switching net 1, never ground.',
       'modelBoundary':'Full necessary MUR150/IRFZ34 declarations and nom.lib bindings retained. Source prose says D=0.25/33V while actual PW/PER is 25U/50U; preserve discrepancy without changing excitation. Diode anode is VOUT and cathode is switching net; do not reverse diode or output polarity to match prose. No simulation or product acceptance.'}
    ident=[1,0,0,1]
    instances=[
        ('vpulse','I1',[-250,750],ident,{'+':[-200,800,6],'-':[-200,600,1]}),
        ('0','I10',[-1150,650],ident,{'GND':[-1100,700,3]}),
        ('irfz34','I2',[-300,1650],[0,-1,1,0],{'d':[-300,1750,7],'g':[-200,1600,5],'s':[-100,1750,1]}),
        ('l','I3',[350,950],[0,-1,-1,0],{'1':[400,1000,1],'2':[400,700,2]}),
        ('r','I4',[-250,1350],[0,-1,-1,0],{'1':[-200,1400,5],'2':[-200,1200,6]}),
        ('mur150','I5',[850,1450],[-1,0,0,1],{'1':[900,1400,4],'2':[750,1400,1]}),
        ('vdc','I6',[-1150,1100],ident,{'+':[-1100,1100,7],'-':[-1100,900,3]}),
        ('c','I7',[1100,950],[0,-1,-1,0],{'1':[1150,1000,4],'2':[1150,850,2]}),
        ('r','I8',[1450,1000],[0,-1,-1,0],{'1':[1500,1050,4],'2':[1500,850,2]}),
        ('0','I9',[450,450],ident,{'GND':[500,500,2]})]
    blocks=re.split(r'^FORCEADD ', '\n'.join(c['originalLines']), flags=re.M)[1:]
    for part,instance,origin,matrix,pins in instances:
        css=source(root.parent.parent/'archive_libs/libs'/part/'sym_1/symbol.css')
        block=next(b for b in blocks if re.search(r'^FORCEPROP 1 LAST PATH '+instance+r'\s*$',b,re.M))
        lastpins={tuple(map(int,m)) for m in re.findall(r'LASTPIN \((-?\d+) (-?\d+)\)',block)}
        assert {tuple(a[:2]) for a in pins.values()}==lastpins
        for line in css['lines']:
            match=re.match(r'C (-?\d+) (-?\d+) "([^"]+)"',line)
            if match:
                x,y=int(match[1]),int(match[2]);xx,xy,yx,yy=matrix
                assert pins[terminal_name(match[3])][:2]==[origin[0]+xx*x+xy*y,origin[1]+yx*x+yy*y]
        c['symbols'].append({**css,'part':part,'instance':instance,'origin':origin,'matrix':matrix})
        c['verifiedPins'][instance]=pins
    paths=['cds.lib','worklib/buck_boost_cnvrtr/sch_1/verilog.v','worklib/buck_boost_cnvrtr/sch_1/viewprps.prp',
           'worklib/buck_boost_cnvrtr/psp_sim_1/buck_boost_cnvrtr.net','worklib/buck_boost_cnvrtr/psp_sim_1/profiles/tran/tran.cir',
           'worklib/glbl/buck_boost_cnvrtr_cfg_analog/verilog.v']
    c['supplemental']=[source(root/path) for path in paths]
    c['supplemental'] += [source('E:/Cadence/SPB_25.1/tools/pspice/library/nom.lib','cp1252',lines=[39,50]),
                          source('E:/Cadence/SPB_25.1/tools/pspice/library/diode.lib','cp1252',lines=list(range(23076,23078))),
                          source('E:/Cadence/SPB_25.1/tools/pspice/library/pwrmos.lib','cp1252',lines=list(range(4583,4587)))]
    out.mkdir(parents=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS041.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:900px}</style><p>CSA/CSS source reconstruction; not native screenshot or product acceptance.</p><section><h2>PS041 buck-boost</h2><img src="PS041.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':['PS041'],'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P037':
    assert sys.argv[3:]==['PS040'] and not out.exists(), 'Only explicitly reviewed buck transforms are registered.'
    p=lookup['PS040']; original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    c={'id':'PS040','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[], 'verifiedPins':{},
       'unconnectedCsvNet':0,'viewBox':'-1450 -2650 6800 2800',
       'geometryBoundary':'Original CSS contacts individually checked against CSA LASTPIN and CSV. IRF840 and MUR150 R1 [0,-1,1,0]; C/R R3 [0,-1,-1,0]. Separate ground geometry indices 1/2 retain explicit global 0\\g equivalence. Gate drive negative terminal belongs to MOS source switching net, not ground.',
       'modelBoundary':'Full necessary MUR150 and IRF840 declarations and nom.lib bindings retained; MOS template explicitly repeats source as bulk. Original 50V/duty0.5 notes are ideal claims, not simulation or product acceptance.'}
    ident=[1,0,0,1]
    instances=[
        ('vdc','I1',[-1050,1050],ident,{'+':[-1000,1050,6],'-':[-1000,850,2]}),
        ('0','I10',[-1050,600],ident,{'GND':[-1000,650,2]}),
        ('irf840','I2',[-550,1350],[0,-1,1,0],{'d':[-550,1450,6],'g':[-450,1300,4],'s':[-350,1450,3]}),
        ('r','I3',[-500,900],[0,-1,-1,0],{'1':[-450,950,4],'2':[-450,750,5]}),
        ('vpulse','I4',[-500,450],ident,{'+':[-450,500,5],'-':[-450,300,3]}),
        ('mur150','I5',[100,800],[0,-1,1,0],{'1':[150,750,1],'2':[150,900,3]}),
        ('l','I6',[300,1300],ident,{'1':[250,1250,3],'2':[550,1250,7]}),
        ('c','I7',[850,1100],[0,-1,-1,0],{'1':[900,1150,7],'2':[900,1000,1]}),
        ('r','I8',[1250,1050],[0,-1,-1,0],{'1':[1300,1100,7],'2':[1300,900,1]}),
        ('0','I9',[550,450],ident,{'GND':[600,500,1]})]
    blocks=re.split(r'^FORCEADD ', '\n'.join(c['originalLines']), flags=re.M)[1:]
    for part,instance,origin,matrix,pins in instances:
        css=source(root.parent.parent/'archive_libs/libs'/part/'sym_1/symbol.css')
        block=next(b for b in blocks if re.search(r'^FORCEPROP 1 LAST PATH '+instance+r'\s*$',b,re.M))
        lastpins={tuple(map(int,m)) for m in re.findall(r'LASTPIN \((-?\d+) (-?\d+)\)',block)}
        assert {tuple(a[:2]) for a in pins.values()}==lastpins
        for line in css['lines']:
            match=re.match(r'C (-?\d+) (-?\d+) "([^"]+)"',line)
            if match:
                x,y=int(match[1]),int(match[2]);xx,xy,yx,yy=matrix
                assert pins[terminal_name(match[3])][:2]==[origin[0]+xx*x+xy*y,origin[1]+yx*x+yy*y]
        c['symbols'].append({**css,'part':part,'instance':instance,'origin':origin,'matrix':matrix})
        c['verifiedPins'][instance]=pins
    paths=['cds.lib','worklib/buck_cnvrtr/sch_1/verilog.v','worklib/buck_cnvrtr/sch_1/viewprps.prp',
           'worklib/buck_cnvrtr/psp_sim_1/buck_cnvrtr.net','worklib/buck_cnvrtr/psp_sim_1/profiles/tran/tran.cir',
           'worklib/glbl/buck_cnvrtr_cfg_analog/verilog.v']
    c['supplemental']=[source(root/path) for path in paths]
    c['supplemental'] += [source('E:/Cadence/SPB_25.1/tools/pspice/library/nom.lib','cp1252',lines=[39,50]),
                          source('E:/Cadence/SPB_25.1/tools/pspice/library/diode.lib','cp1252',lines=list(range(23076,23078))),
                          source('E:/Cadence/SPB_25.1/tools/pspice/library/pwrmos.lib','cp1252',lines=list(range(1651,1655)))]
    out.mkdir(parents=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS040.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:900px}</style><p>CSA/CSS source reconstruction; not native screenshot or product acceptance.</p><section><h2>PS040 buck</h2><img src="PS040.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':['PS040'],'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P036':
    assert sys.argv[3:]==['PS039'] and not out.exists(), 'Only explicitly reviewed boost transforms are registered.'
    p=lookup['PS039']; original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    c={'id':'PS039','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[], 'verifiedPins':{},
       'unconnectedCsvNet':0,'viewBox':'-1000 -2650 6600 2850',
       'geometryBoundary':'Original CSS contacts individually checked against CSA LASTPIN and CSV. IRFZ34 R1 [0,-1,1,0]; C/R R3 [0,-1,-1,0]. Separate ground geometry indices 2/3/4 retain explicit global 0\\g equivalence.',
       'modelBoundary':'Full necessary MUR150 and IRFZ34 declarations and nom.lib bindings retained; MOS template explicitly repeats source as bulk. Original 80V/ratio2 notes are ideal claims, not simulation or product acceptance.'}
    ident=[1,0,0,1]
    instances=[
        ('vdc','I1',[-650,1550],ident,{'+':[-600,1550,8],'-':[-600,1350,2]}),
        ('0','I10',[100,150],ident,{'GND':[150,200,3]}),
        ('0','I11',[950,1100],ident,{'GND':[1000,1150,4]}),
        ('l','I2',[-300,1850],ident,{'1':[-350,1800,8],'2':[-50,1800,7]}),
        ('mur150','I3',[350,1850],ident,{'1':[300,1800,7],'2':[450,1800,1]}),
        ('irfz34','I4',[50,1050],[0,-1,1,0],{'d':[50,1150,7],'g':[150,1000,5],'s':[250,1150,4]}),
        ('c','I5',[850,1550],[0,-1,-1,0],{'1':[900,1600,1],'2':[900,1450,4]}),
        ('r','I6',[1250,1550],[0,-1,-1,0],{'1':[1300,1600,1],'2':[1300,1400,4]}),
        ('vpulse','I7',[100,500],ident,{'+':[150,550,6],'-':[150,350,3]}),
        ('r','I8',[100,850],[0,-1,-1,0],{'1':[150,900,5],'2':[150,700,6]}),
        ('0','I9',[-650,1150],ident,{'GND':[-600,1200,2]})]
    blocks=re.split(r'^FORCEADD ', '\n'.join(c['originalLines']), flags=re.M)[1:]
    for part,instance,origin,matrix,pins in instances:
        css=source(root.parent.parent/'archive_libs/libs'/part/'sym_1/symbol.css')
        block=next(b for b in blocks if re.search(r'^FORCEPROP 1 LAST PATH '+instance+r'\s*$',b,re.M))
        lastpins={tuple(map(int,m)) for m in re.findall(r'LASTPIN \((-?\d+) (-?\d+)\)',block)}
        assert {tuple(a[:2]) for a in pins.values()}==lastpins
        for line in css['lines']:
            match=re.match(r'C (-?\d+) (-?\d+) "([^"]+)"',line)
            if match:
                x,y=int(match[1]),int(match[2]);xx,xy,yx,yy=matrix
                assert pins[terminal_name(match[3])][:2]==[origin[0]+xx*x+xy*y,origin[1]+yx*x+yy*y]
        c['symbols'].append({**css,'part':part,'instance':instance,'origin':origin,'matrix':matrix})
        c['verifiedPins'][instance]=pins
    paths=['cds.lib','worklib/boost_cnvrtr/sch_1/verilog.v','worklib/boost_cnvrtr/sch_1/viewprps.prp',
           'worklib/boost_cnvrtr/cfg_analog/boost_cnvrtr.net','worklib/boost_cnvrtr/cfg_analog/boost_cnvrtr-boost_cnvrtr.net',
           'worklib/boost_cnvrtr/cfg_analog/tran.sim.cir','worklib/glbl/boost_cnvrtr_cfg_analog/verilog.v']
    c['supplemental']=[source(root/path) for path in paths]
    c['supplemental'] += [source('E:/Cadence/SPB_25.1/tools/pspice/library/nom.lib','cp1252',lines=[39,50]),
                          source('E:/Cadence/SPB_25.1/tools/pspice/library/diode.lib','cp1252',lines=list(range(23076,23078))),
                          source('E:/Cadence/SPB_25.1/tools/pspice/library/pwrmos.lib','cp1252',lines=list(range(4583,4587)))]
    out.mkdir(parents=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS039.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:900px}</style><p>CSA/CSS source reconstruction; not native screenshot or product acceptance.</p><section><h2>PS039 boost</h2><img src="PS039.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':['PS039'],'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P035':
    assert sys.argv[3:]==['PS038'] and not out.exists(), 'Only explicitly reviewed clipper transforms are registered.'
    p=lookup['PS038']; original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    c={'id':'PS038','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[], 'verifiedPins':{},
       'unconnectedCsvNet':0,'viewBox':'-1600 -2300 7400 2450',
       'geometryBoundary':'CSS contacts individually verified against CSA LASTPIN and CSV. D2/D3 R1 [0,-1,1,0] and D1 R3 [0,-1,-1,0] are instance-specific transforms. Ground indices 5/6 are separate geometry with explicit global 0\\g identity.',
       'modelBoundary':'Dbreak complete declaration and nom.lib binding read. Source prose diode identities disagree with actual port connectivity; preserve prose as source data, never change topology to match it. No simulation or product acceptance.'}
    ident=[1,0,0,1]
    instances=[
        ('vsin','I1',[-1050,1350],ident,{'+':[-1000,1400,4],'-':[-1000,1200,5]}),
        ('r','I2',[-650,1700],ident,{'1':[-700,1650,4],'2':[-500,1650,2]}),
        ('dbreak','I3',[-50,1400],[0,-1,1,0],{'1':[0,1350,5],'2':[0,1500,2]}),
        ('0','I4',[-750,950],ident,{'GND':[-700,1000,5]}),
        ('dbreak','I5',[3700,1400],[0,-1,1,0],{'1':[3750,1350,6],'2':[3750,1500,1]}),
        ('r','I6',[3100,1700],ident,{'1':[3050,1650,3],'2':[3250,1650,1]}),
        ('0','I7',[3000,950],ident,{'GND':[3050,1000,6]}),
        ('vsin','I8',[2700,1350],ident,{'+':[2750,1400,3],'-':[2750,1200,6]}),
        ('dbreak','I9',[3950,1450],[0,-1,-1,0],{'1':[4000,1500,1],'2':[4000,1350,6]})]
    blocks=re.split(r'^FORCEADD ', '\n'.join(c['originalLines']), flags=re.M)[1:]
    for part,instance,origin,matrix,pins in instances:
        css=source(root.parent/'archive_libs/libs'/part/'sym_1/symbol.css')
        block=next(b for b in blocks if re.search(r'^FORCEPROP 1 LAST PATH '+instance+r'\s*$',b,re.M))
        lastpins={tuple(map(int,m)) for m in re.findall(r'LASTPIN \((-?\d+) (-?\d+)\)',block)}
        assert {tuple(a[:2]) for a in pins.values()}==lastpins
        for line in css['lines']:
            match=re.match(r'C (-?\d+) (-?\d+) "([^"]+)"',line)
            if match:
                x,y=int(match[1]),int(match[2]);xx,xy,yx,yy=matrix
                assert pins[terminal_name(match[3])][:2]==[origin[0]+xx*x+xy*y,origin[1]+yx*x+yy*y]
        c['symbols'].append({**css,'part':part,'instance':instance,'origin':origin,'matrix':matrix})
        c['verifiedPins'][instance]=pins
    paths=['cds.lib','worklib/clipper/sch_1/verilog.v','worklib/clipper/sch_1/viewprps.prp',
           'worklib/clipper/psp_sim_1/profiles/Tran/Tran.cir','worklib/glbl/clipper_cfg_analog/verilog.v']
    c['supplemental']=[source(root/path) for path in paths]
    c['supplemental'] += [source('E:/Cadence/SPB_25.1/tools/pspice/library/nom.lib','cp1252',lines=[26]),
                          source('E:/Cadence/SPB_25.1/tools/pspice/library/breakout.lib','cp1252',lines=[17])]
    assert c['supplemental'][-1]['lines'][0]['text']=='.model Dbreak D Is=1e-14 Cjo=.1pF Rs=.1'
    c['missingGeneratedNetlist']=str(root/'worklib/clipper/psp_sim_1/clippercircuits.net').replace('\\','/')
    assert not Path(c['missingGeneratedNetlist']).exists()
    out.mkdir(parents=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS038.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:900px}</style><p>CSA/CSS source reconstruction; not native screenshot or product acceptance.</p><section><h2>PS038 clipper</h2><img src="PS038.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':['PS038'],'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P034':
    assert sys.argv[3:]==['PS037'] and not out.exists(), 'Only explicitly reviewed clamper transforms are registered.'
    p=lookup['PS037']; original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    c={'id':'PS037','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[], 'verifiedPins':{},
       'unconnectedCsvNet':0,'viewBox':'-3100 -2450 6200 2250',
       'geometryBoundary':'Original CSS contacts verified against CSA LASTPIN and CSV. D1 R3 [0,-1,-1,0] and D2 R1 [0,-1,1,0] are instance-specific transforms. Ground indices 5/6 are separate geometry with the same global 0\\g name.',
       'modelBoundary':'Dbreak complete necessary declaration and nom.lib binding retained; source clamp-voltage claims are unverified. No simulation, whole model library reading or product acceptance.'}
    ident=[1,0,0,1]
    instances=[
        ('vsin','I1',[-2600,1350],ident,{'+':[-2550,1400,4],'-':[-2550,1200,5]}),
        ('c','I2',[-2150,1750],ident,{'1':[-2200,1700,4],'2':[-2050,1700,2]}),
        ('dbreak','I3',[-1750,1400],[0,-1,-1,0],{'1':[-1700,1450,2],'2':[-1700,1300,5]}),
        ('0','I4',[-2350,900],ident,{'GND':[-2300,950,5]}),
        ('dbreak','I5',[1950,1600],[0,-1,1,0],{'1':[2000,1550,6],'2':[2000,1700,1]}),
        ('c','I6',[1550,1950],ident,{'1':[1500,1900,3],'2':[1650,1900,1]}),
        ('vsin','I7',[1100,1550],ident,{'+':[1150,1600,3],'-':[1150,1400,6]}),
        ('0','I8',[1350,1100],ident,{'GND':[1400,1150,6]})]
    blocks=re.split(r'^FORCEADD ', '\n'.join(c['originalLines']), flags=re.M)[1:]
    for part,instance,origin,matrix,pins in instances:
        css=source(root.parent/'archive_libs/libs'/part/'sym_1/symbol.css')
        block=next(b for b in blocks if re.search(r'^FORCEPROP 1 LAST PATH '+instance+r'\s*$',b,re.M))
        lastpins={tuple(map(int,m)) for m in re.findall(r'LASTPIN \((-?\d+) (-?\d+)\)',block)}
        assert {tuple(a[:2]) for a in pins.values()}==lastpins
        for line in css['lines']:
            match=re.match(r'C (-?\d+) (-?\d+) "([^"]+)"',line)
            if match:
                x,y=int(match[1]),int(match[2]);xx,xy,yx,yy=matrix
                assert pins[terminal_name(match[3])][:2]==[origin[0]+xx*x+xy*y,origin[1]+yx*x+yy*y]
        c['symbols'].append({**css,'part':part,'instance':instance,'origin':origin,'matrix':matrix})
        c['verifiedPins'][instance]=pins
    paths=['cds.lib','worklib/clamper/psp_sim_1/clamper.net','worklib/clamper/psp_sim_1/clamper_sch.prp',
           'worklib/clamper/sch_1/verilog.v','worklib/clamper/sch_1/viewprps.prp',
           'worklib/clamper/psp_sim_1/profiles/tran/tran.cir','worklib/glbl/clamper_cfg_analog/verilog.v']
    c['supplemental']=[source(root/path) for path in paths]
    c['supplemental'] += [source('E:/Cadence/SPB_25.1/tools/pspice/library/nom.lib','cp1252',lines=[26]),
                          source('E:/Cadence/SPB_25.1/tools/pspice/library/breakout.lib','cp1252',lines=[17])]
    assert c['supplemental'][-1]['lines'][0]['text']=='.model Dbreak D Is=1e-14 Cjo=.1pF Rs=.1'
    out.mkdir(parents=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS037.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:900px}</style><p>CSA/CSS source reconstruction; not native screenshot or product acceptance.</p><section><h2>PS037 clamper</h2><img src="PS037.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':['PS037'],'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P033':
    assert sys.argv[3:]==['PS036'] and not out.exists(), 'Only explicitly reviewed BJT amplifier transforms are registered.'
    p=lookup['PS036']; original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    c={'id':'PS036','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[], 'verifiedPins':{},
       'unconnectedCsvNet':0,'viewBox':'-7400 -3300 13300 3800',
       'geometryBoundary':'Original CSS contacts mapped to CSA LASTPIN and CSV identities. R3 resistor [0,-1,-1,0], R4 ground [-1,0,0,-1] and R6 VDC [1,0,0,-1] are explicitly verified only for these instances. CSV ground indices 1 through 6 retain separate geometric components and the same original global 0\\g identity.',
       'modelBoundary':'Original transistor template orders c,b,e; full necessary Q40237 declaration and nom.lib bipolar.lib binding retained. Eight supplemental texts read completely. Source gain statements are unverified source notes. No simulation, whole model library reading or product acceptance.'}
    ident=[1,0,0,1]; r3=[0,-1,-1,0]; r4=[-1,0,0,-1]; r6=[1,0,0,-1]
    instances=[
        ('40237','I1',[-6350,850],ident,{'b':[-6400,800,15],'c':[-6300,900,21],'e':[-6300,700,1]}),
        ('0','I10',[-1600,2100],r4,{'GND':[-1650,2050,6]}),
        ('vdc','I11',[-1700,1700],r6,{'+':[-1650,1700,9],'-':[-1650,1900,6]}),
        ('40237','I13',[-1700,1100],ident,{'b':[-1750,1050,11],'c':[-1650,1150,9],'e':[-1650,950,7]}),
        ('r','I14',[-2050,1100],ident,{'1':[-2100,1050,12],'2':[-1900,1050,11]}),
        ('0','I15',[-2100,200],ident,{'GND':[-2050,250,5]}),
        ('vdc','I16',[-2400,550],ident,{'+':[-2350,550,10],'-':[-2350,350,5]}),
        ('vsin','I17',[-2400,900],ident,{'+':[-2350,950,12],'-':[-2350,750,10]}),
        ('0','I18',[1700,2150],r4,{'GND':[1650,2100,4]}),
        ('vdc','I19',[1600,1750],r6,{'+':[1650,1750,13],'-':[1650,1950,4]}),
        ('r','I2',[-6700,850],ident,{'1':[-6750,800,16],'2':[-6550,800,15]}),
        ('r','I20',[1600,1550],r3,{'1':[1650,1600,13],'2':[1650,1400,22]}),
        ('40237','I21',[1600,1150],ident,{'b':[1550,1100,14],'c':[1650,1200,22],'e':[1650,1000,20]}),
        ('r','I22',[1250,1150],ident,{'1':[1200,1100,18],'2':[1400,1100,14]}),
        ('0','I23',[1200,100],ident,{'GND':[1250,150,3]}),
        ('vdc','I24',[900,600],ident,{'+':[950,600,18],'-':[950,400,3]}),
        ('r','I26',[-1700,650],r3,{'1':[-1650,700,7],'2':[-1650,500,5]}),
        ('vsin','I27',[1600,400],ident,{'+':[1650,450,19],'-':[1650,250,3]}),
        ('r','I28',[1600,800],r3,{'1':[1650,850,20],'2':[1650,650,19]}),
        ('vdc','I4',[-7050,300],ident,{'+':[-7000,300,17],'-':[-7000,100,1]}),
        ('r','I5',[-6350,1250],r3,{'1':[-6300,1300,8],'2':[-6300,1100,21]}),
        ('vdc','I6',[-6350,1450],r6,{'+':[-6300,1450,8],'-':[-6300,1650,2]}),
        ('0','I7',[-6250,1850],r4,{'GND':[-6300,1800,2]}),
        ('0','I8',[-6750,-50],ident,{'GND':[-6700,0,1]}),
        ('vsin','I9',[-7050,650],ident,{'+':[-7000,700,16],'-':[-7000,500,17]})]
    css_root=root.parent/'archive_libs/libs'
    blocks=re.split(r'^FORCEADD ', '\n'.join(c['originalLines']), flags=re.M)[1:]
    for part,instance,origin,matrix,pins in instances:
        css=source(css_root/f'{part}/sym_1/symbol.css')
        block=next(b for b in blocks if re.search(r'^FORCEPROP 1 LAST PATH '+instance+r'\s*$',b,re.M))
        lastpins={tuple(map(int,m)) for m in re.findall(r'LASTPIN \((-?\d+) (-?\d+)\)',block)}
        assert {tuple(a[:2]) for a in pins.values()}==lastpins
        for line in css['lines']:
            match=re.match(r'C (-?\d+) (-?\d+) "([^"]+)"',line)
            if match:
                x,y=int(match[1]),int(match[2]); xx,xy,yx,yy=matrix
                assert pins[terminal_name(match[3])][:2]==[origin[0]+xx*x+xy*y,origin[1]+yx*x+yy*y]
        c['symbols'].append({**css,'part':part,'instance':instance,'origin':origin,'matrix':matrix})
        c['verifiedPins'][instance]=pins
    paths=['cds.lib','worklib/bjt_amp/psp_sim_1/bjt_amp.net','worklib/bjt_amp/psp_sim_1/bjt_amp_sch.prp',
           'worklib/bjt_amp/sch_1/verilog.v','worklib/bjt_amp/sch_1/viewprps.prp',
           'worklib/bjt_amp/psp_sim_1/profiles/tran/tran.cir',
           'worklib/glbl/bjt_amplifiers_cfg_analog/verilog.v','worklib/glbl/bjt_amp_cfg_analog/verilog.v']
    c['supplemental']=[source(root/path) for path in paths]
    c['supplemental'] += [source('E:/Cadence/SPB_25.1/tools/pspice/library/nom.lib',lines=[37]),
                          source('E:/Cadence/SPB_25.1/tools/pspice/library/bipolar.lib',lines=list(range(9036,9040)))]
    assert c['supplemental'][-1]['lines'][0]['text'].startswith('.model Q40237')
    assert c['supplemental'][-1]['lines'][-1]['text'].rstrip().endswith(')')
    out.mkdir(parents=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS036.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:900px}</style><p>PS036 original CSA/CSS reconstruction; not native screenshot or product acceptance.</p><section><h2>Common emitter, common collector and common base</h2><img src="PS036.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':'PS036','CSA_lines':len(c['originalLines']),'CSV_lines':len(c['connectivity']['lines']),
        'instances':len(instances),'supplemental':len(c['supplemental']),'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch in {'P030','P031','P032'}:
    case_id={'P030':'PS033','P031':'PS034','P032':'PS035'}[batch]
    assert sys.argv[3:]==[case_id] and not out.exists(), 'Only explicitly reviewed filter transforms are registered.'
    p=lookup[case_id]; original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    c={'id':case_id,'relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[], 'verifiedPins':{},
       'unconnectedCsvNet':0,'viewBox':'-1400 -2500 4750 1800',
       'geometryBoundary':'Original CSS contacts mapped to CSA LASTPIN and CSV identities. Registered R3 instances use [0,-1,-1,0] verified from both contacts; orientation codes are not generalized. Original note coordinates and invisible SIG_NAME properties retained; reconstructed typography is approximate.',
       'modelBoundary':'Complete primitive templates, generated netlist, HDL and AC profile read. Original CSA/CSV IC=1M and generated netlist IC=1m retained independently. No external subcircuit is used; historical nom.lib listed by profile is not claimed fully read. No simulation or product acceptance.'}
    instances=[
        ('vac','I1',[-900,1150],[1,0,0,1],{'+':[-850,1200,3],'-':[-850,1000,2]}),
        ('r','I2',[-600,1450],[1,0,0,1],{'1':[-650,1400,3],'2':[-450,1400,1]}),
        ('c','I3',[-250,1200],[0,-1,-1,0],{'1':[-200,1250,1],'2':[-200,1100,2]}),
        ('c','I4',[250,1450],[1,0,0,1],{'1':[200,1400,1],'2':[350,1400,4]}),
        ('r','I5',[600,1250],[0,-1,-1,0],{'1':[650,1300,4],'2':[650,1100,2]}),
        ('0','I6',[-500,800],[1,0,0,1],{'GND':[-450,850,2]})]
    cell='bpf_cap'; historical_cell='bpf_capacitive'
    if case_id=='PS034':
        instances=[
            ('vac','I1',[-1000,950],[1,0,0,1],{'+':[-950,1000,3],'-':[-950,800,1]}),
            ('r','I2',[-600,1250],[1,0,0,1],{'1':[-650,1200,3],'2':[-450,1200,2]}),
            ('r','I3',[800,950],[0,-1,-1,0],{'1':[850,1000,4],'2':[850,800,1]}),
            ('l','I4',[-300,900],[0,-1,-1,0],{'1':[-250,950,2],'2':[-250,650,1]}),
            ('l','I5',[250,1250],[1,0,0,1],{'1':[200,1200,2],'2':[500,1200,4]}),
            ('0','I6',[-500,350],[1,0,0,1],{'GND':[-450,400,1]})]
        cell='bpf_ind'; historical_cell='bpf_inductive'
        c['viewBox']='-1500 -2500 4750 2250'
        c['modelBoundary']='Complete primitive templates, generated netlist, HDL and AC profile read. Original L2 value 100M and generated 100m retained independently; both original IC fields are empty. No external subcircuit is used; historical nom.lib is not claimed fully read. No simulation or product acceptance.'
    if case_id=='PS035':
        instances=[
            ('vac','I1',[-1100,1000],[1,0,0,1],{'+':[-1050,1050,2],'-':[-1050,850,1]}),
            ('0','I10',[-1150,450],[1,0,0,1],{'GND':[-1100,500,1]}),
            ('r','I2',[-400,1850],[1,0,0,1],{'1':[-450,1800,2],'2':[-250,1800,3]}),
            ('r','I3',[1150,1850],[1,0,0,1],{'1':[1100,1800,3],'2':[1300,1800,5]}),
            ('c','I4',[-400,1300],[1,0,0,1],{'1':[-450,1250,2],'2':[-300,1250,4]}),
            ('c','I5',[550,1550],[0,-1,-1,0],{'1':[600,1600,3],'2':[600,1450,1]}),
            ('c','I6',[1200,1300],[1,0,0,1],{'1':[1150,1250,4],'2':[1300,1250,5]}),
            ('r','I8',[1950,1100],[0,-1,-1,0],{'1':[2000,1150,5],'2':[2000,950,1]}),
            ('r','I9',[300,1050],[0,-1,-1,0],{'1':[350,1100,4],'2':[350,900,1]})]
        cell='bsf'; historical_cell='bandstopfilter'
        c['viewBox']='-1450 -2550 5400 2350'
        c['nonJunctionCrossings']=[{'point':[600,1250],'verticalCsvNet':1,'horizontalCsvNet':4,
            'scope':'C2 lower ground wire crosses C3/C1 midpoint wire; no original DOT, pin or wire endpoint at this intersection. Distinct identities verified by CSA/CSV/HDL/netlist.'}]
        c['modelBoundary']='Complete primitive templates, eight generated devices, HDL and AC profile read. Three IC properties are empty. No external subcircuit is used; historical nom.lib is not claimed fully read. No simulation or product acceptance.'
    css_root=(root.parent if case_id=='PS035' else root.parents[1])/'archive_libs/libs'
    for part,instance,origin,matrix,pins in instances:
        css=css_root/f'{part}/sym_1/symbol.css'
        c['symbols'].append({**source(css),'part':part,'instance':instance,'origin':origin,'matrix':matrix})
        c['verifiedPins'][instance]=pins
    paths=['cds.lib',f'worklib/{cell}/psp_sim_1/{cell}.net',f'worklib/{cell}/psp_sim_1/{cell}_sch.prp',
           f'worklib/{cell}/sch_1/verilog.v',f'worklib/{cell}/sch_1/viewprps.prp',
           f'worklib/{cell}/psp_sim_1/profiles/ac_sweep/ac_sweep.cir',
           f'worklib/glbl/{historical_cell}_cfg_analog/verilog.v',f'worklib/glbl/{cell}_cfg_analog/verilog.v']
    c['supplemental']=[source(root/path) for path in paths]
    out.mkdir(parents=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/(case_id+'.svg')).write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    filter_caption='band stop filter' if case_id=='PS035' else 'band pass filter'
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:900px}</style><p>'+case_id+' original CSA/CSS reconstruction; not native screenshot or product acceptance.</p><section><h2>'+case_id+' '+cell+' '+filter_caption+'</h2><img src="'+case_id+'.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':case_id,'CSA_lines':len(c['originalLines']),'CSV_lines':len(c['connectivity']['lines']),
        'instances':len(instances),'supplemental':len(c['supplemental']),'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P028':
    assert sys.argv[3:]==['PS030'] and not out.exists(), 'Only explicitly reviewed PS030 transforms are registered.'
    p=lookup['PS030']; original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    c={'id':'PS030','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[], 'verifiedPins':{},
       'unconnectedCsvNet':0,'viewBox':'-950 -2450 3100 1800',
       'geometryBoundary':'Explicit original CSS contacts, CSA LASTPIN coordinates and CSV pin identities. The three ground R2 instances use [-1,0,0,1], verified for these instances only. Six distinct 0\\g local components remain separate; wire labels annotate actual conductors.',
       'modelBoundary':'Source templates and six top-level stimuli are preserved. HDL named-port order differs from generated SPICE positional order. P027/P026 contain the separately reviewed motor and magnetic implementations and profile variants; no simulation or product acceptance.',
       'priorReading':['P027/reading-ledger.md','P026/reading-ledger.md']}
    instances=[]
    def add(part,instance,origin,matrix,pins):
        instances.append((part,instance,origin,matrix)); c['verifiedPins'][instance]=pins
    for instance,x,y,plus,minus in [('I1',0,2150,9,12),('I2',-300,2000,8,5),('I3',-600,1850,4,6)]:
        add('isrc',instance,[x,y],[1,0,0,1],{'+':[x+50,y+50,plus],'-':[x+50,y-150,minus]})
    for instance,x,y,plus,minus in [('I4',-600,1350,7,3),('I5',-300,1200,11,1),('I7',0,1050,10,2)]:
        add('vsrc',instance,[x,y],[1,0,0,1],{'+':[x+50,y+50,plus],'-':[x+50,y-150,minus]})
    for instance,x,y,net in [('I10',-300,900,1),('I11',-600,1050,3),('I9',0,800,2)]:
        add('0',instance,[x,y],[1,0,0,1],{'GND':[x+50,y+50,net]})
    for instance,x,y,net in [('I12',-600,1900,4),('I13',-300,2050,8),('I14',0,2200,9)]:
        add('0',instance,[x,y],[-1,0,0,1],{'GND':[x-50,y+50,net]})
    add('srm_main','I8',[1300,1450],[1,0,0,1],{'ID_A':[600,1850,12],'ID_B':[600,1750,5],
        'ID_C':[600,1650,6],'RA_VAL':[600,1450,7],'RB_VAL':[600,1350,11],'RC_VAL':[600,1250,10]})
    for part,instance,origin,matrix in instances:
        css=root/(f'worklib/{part}/sym_1/symbol.css' if part=='srm_main' else f'archive_libs/source/{part}/sym_1/symbol.css')
        c['symbols'].append({**source(css),'part':part,'instance':instance,'origin':origin,'matrix':matrix})
    paths=['cds.lib','worklib/top/sch_1/verilog.v','worklib/top/sch_1/viewprps.prp',
        'worklib/srm_main/entity/verilog.v','worklib/srm_main/sch_1/verilog.v',
        'archive_libs/source/isrc/entity/verilog.v','archive_libs/source/vsrc/entity/verilog.v',
        'archive_libs/source/0/entity/verilog.v','worklib/glbl/top_cfg_analog/verilog.v',
        'worklib/glbl/top_cfg_package/verilog.v','worklib/top/psp_sim_1/top.net']
    c['supplemental']=[source(root/path) for path in paths]
    c['supplemental'].append({**source(root/'worklib/top/psp_sim_1/top_sch.prp',lines=list(range(1,178))),
        'scope':'Initial device list and complete six top-level stimulus parameter blocks only; remaining hierarchical PMAP not claimed read.'})
    out.mkdir(parents=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS030.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:900px}</style><p>PS030 original CSA/CSS reconstruction; not native screenshot or product acceptance.</p><section><h2>PS030 six motor stimuli</h2><img src="PS030.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':'PS030','CSA_lines':len(c['originalLines']),'CSV_lines':len(c['connectivity']['lines']),
        'instances':len(instances),'supplemental':len(c['supplemental']),'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P027':
    assert sys.argv[3:]==['PS029'] and not out.exists(), 'Only explicitly reviewed PS029 transforms are registered.'
    p=lookup['PS029']; original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    c={'id':'PS029','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[], 'verifiedPins':{},
       'unconnectedCsvNet':0,'viewBox':'-1400 -2650 4500 2500',
       'geometryBoundary':'All 45 instances and 97 terminals use original CSS contacts, explicit CSA origins and CSV identities. Q R0 collector is y+50, emitter y-150. R5 uses [0,1,-1,0]; F R6 uses [1,0,0,-1]. Repeated named global nets remain separate local geometric components, not invented wires.',
       'modelBoundary':'Current Q2N3055 and Dbreak complete declarations and nominal includes are read; historical nominal binding unresolved. Original HDL port order and the different 2007/2018 generated SPICE interfaces are preserved independently. Magnetic implementation previously reviewed as PS028/P026. No simulation or product acceptance.'}
    instances=[]
    def add(lib,part,instance,origin,matrix,pins):
        instances.append((lib,part,instance,origin,matrix))
        c['verifiedPins'][instance]=pins
    for instance,x,y,net in [('I1',-800,1600,34),('I38',550,1600,38),('I53',1900,1600,13),
        ('I4',350,650,23),('I5',350,550,22),('I6',350,450,24)]:
        add('standard','inport',instance,[x,y],[1,0,0,1],{'A':[x+50,y,net]})
    for instance,x,y,net in [('I11',-800,1900,8),('I15',-800,1050,7),('I37',550,1900,6),
        ('I40',550,1100,5),('I48',1900,1900,4),('I52',1900,1100,3),('I55',1000,800,2),('I57',1700,350,1)]:
        add('source','0',instance,[x,y],[1,0,0,1],{'GND':[x+50,y+50,net]})
    for instance,x,y,n1,n2 in [('I12',-950,2150,25,30),('I16',-950,1300,27,32),
        ('I32',400,2150,36,40),('I41',400,1300,21,35),('I44',1750,2100,14,41),('I54',1750,1300,18,17)]:
        add('analog','r',instance,[x,y],[1,0,0,1],{'1':[x-50,y-50,n1],'2':[x+150,y-50,n2]})
    for instance,x,y,n1,n2 in [('I25',-250,1950,39,43),('I34',1100,2000,11,29),('I47',2450,1950,12,42)]:
        add('analog','r',instance,[x,y],[0,1,-1,0],{'1':[x-50,y+50,n1],'2':[x-50,y-150,n2]})
    for instance,x,y,nb,nc,ne in [('I7',-350,2300,31,9,39),('I14',-350,1350,26,33,2),
        ('I30',1000,2300,10,9,11),('I36',1000,1350,20,37,2),('I42',2350,2250,28,9,12),('I50',2350,1350,16,15,2)]:
        add('pwrbjt','q2n3055',instance,[x,y],[1,0,0,1],{'b':[x-50,y-50,nb],'c':[x+50,y+50,nc],'e':[x+50,y-150,ne]})
    for instance,x,y,n1,n2 in [('I27',-150,1750,33,9),('I28',0,1550,2,39),('I33',1200,1750,37,9),
        ('I29',1350,1550,2,11),('I45',2550,1750,15,9),('I46',2700,1550,2,12)]:
        add('breakout','dbreak',instance,[x,y],[0,-1,1,0],{'1':[x+50,y-50,n1],'2':[x+50,y+100,n2]})
    for instance,x,y,n1,n2,n3,n4 in [('I9',-650,2050,30,8,39,31),('I13',-650,1200,32,7,2,26),
        ('I31',700,2050,40,6,11,10),('I39',700,1200,35,5,2,20),('I43',2050,2050,41,4,12,28),('I51',2050,1200,17,3,2,16)]:
        add('analog','f',instance,[x,y],[1,0,0,-1],{'1':[x-50,y+50,n1],'2':[x-50,y+100,n2],
            '3':[x+150,y+50,n3],'4':[x+150,y+100,n4]})
    for instance,x,y,l1,l2,rv in [('I26',-150,1500,43,33,34),('I35',1200,1500,29,37,38),('I58',2550,1500,42,15,13)]:
        add('srmcir_lib','magnetic_ckt',instance,[x,y],[1,0,0,1],{'L1':[x-150,y+300,l1],'L2':[x-150,y-100,l2],'R_VAL':[x-250,y+100,rv]})
    add('source','vsrc','I56',[1700,650],[1,0,0,1],{'+':[1750,700,19],'-':[1750,500,1]})
    for lib,part,instance,origin,matrix in instances:
        css=root/('worklib/magnetic_ckt/sym_1/symbol.css' if lib=='srmcir_lib' else f'archive_libs/{lib}/{part}/sym_1/symbol.css')
        c['symbols'].append({**source(css),'part':part,'instance':instance,'origin':origin,'matrix':matrix})
    paths=['cds.lib','worklib/srm_main/sch_1/verilog.v','worklib/srm_main/entity/verilog.v',
        'archive_libs/pwrbjt/q2n3055/chips/chips.prt','archive_libs/analog/r/chips/chips.prt','archive_libs/analog/r/awb_model/device.prp',
        'worklib/top/psp_sim_1/top.net','worklib/top/psp_sim_1/top_subckt.lib',
        'worklib/top/psp_sim_1/profiles/TOP/TOP.cir','worklib/top/psp_sim_1/profiles/TOP/SLPS_SRM_main__SLPS__SLPS.cir',
        'worklib/top/psp_sim_1/profiles/TOP_slps_/TOP_slps_.cir','worklib/top/psp_sim_1/profiles/TOP_slps_/TOP_slps__SLPS.cir']
    paths += [f'archive_libs/{lib}/{part}/entity/verilog.v' for lib,part in sorted({(x[0],x[1]) for x in instances if x[0] not in {'standard','srmcir_lib'}})]
    c['supplemental']=[source(root/path) for path in paths]
    c['supplemental'].append({**source(root/'worklib/srm_main/sch_1/viewprps.prp',lines=list(range(1,195))),
        'scope':'Only complete initial QA1, FA1, RAB1, F2, QA2, RAB2 and RA blocks; not full 767-line property file.'})
    current=Path('E:/Cadence/SPB_25.1/tools/pspice/library')
    c['supplemental'] += [{**source(current/'pwrbjt.lib',lines=list(range(109,116))),'scope':'Complete current Q2N3055 declaration and comments; not historical binding.'},
        {**source(current/'breakout.lib',lines=[17]),'scope':'Complete current Dbreak declaration; not power_Dbreak.'},
        {**source(current/'nom.lib',lines=[26,49]),'scope':'Current breakout and pwrbjt includes; not full nominal library.'}]
    c['missingOptionalSources']=[str(root/path).replace('\\','/') for path in ['archive_libs/standard/inport/entity/verilog.v',
        'archive_libs/pwrbjt/q2n3055/awb_model/device.prp','archive_libs/breakout/dbreak/chips/chips.prt']]
    assert all(not Path(path).exists() for path in c['missingOptionalSources'])
    out.mkdir(parents=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS029.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:800px}</style><p>PS029 original CSA/CSS reconstruction; not native screenshot or product acceptance.</p><section><h2>PS029 three-phase motor main circuit</h2><img src="PS029.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':'PS029','CSA_lines':len(c['originalLines']),'CSV_lines':len(c['connectivity']['lines']),
        'instances':len(instances),'supplemental':len(c['supplemental']),'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P026':
    assert sys.argv[3:]==['PS028'] and not out.exists(), 'Only explicitly reviewed PS028 transforms are registered.'
    p=lookup['PS028']; original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    c={'id':'PS028','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[],
       'verifiedPins':{'I1':{'A':[2350,1900,6]},'I2':{'A':[2350,1450,14]},'I3':{'A':[500,1900,13]},
           'I10':{'1':[1700,1900,6],'2':[1700,1850,8],'3':[1500,1900,7],'4':[1500,1850,10]},
           'I11':{'1':[1500,1600,10],'2':[1500,1550,5],'3':[1700,1600,9],'4':[1700,1550,4]},
           'I12':{'1':[1850,1300,4],'2':[1850,1600,9]},
           'I13':{'1':[2050,1500,9],'2':[2050,1450,4],'3':[2250,1500,8],'4':[2250,1450,14]},
           'I14':{'GND':[1350,1450,5]},'I15':{'GND':[1850,1150,4]},
           'I4':{'1':[650,1900,13],'2':[650,1800,2],'3':[850,1700,11],'4':[1050,1900,12],'5':[1050,1800,1]},
           'I5':{'1':[850,1450,3],'2':[850,1650,11]},'I6':{'GND':[850,1400,3]},
           'I7':{'GND':[550,1450,2]},'I8':{'GND':[1100,1450,1]},
           'I9':{'1':[1150,1900,12],'2':[1350,1900,7]}},
       'unconnectedCsvNet':0,'viewBox':'250 -2250 2700 1300',
       'geometryBoundary':'31 explicit terminals and 14 continuous local CSV nets retained; five separate local ground indices share the original global name 0\\g. Their global equivalence is not a wire. H and left IOPORT transforms come from original CSS/CSA terminal pairs, not a guessed meaning of R 2. Hierarchical L1/L2/R_VAL ports remain distinct from the local L1 inductor.',
       'modelBoundary':'Complete original R/L/F/H/E/ZX templates, entities and generated magnetic_ckt netlists read. Generated SPICE port order r_val,l1,l2 differs from HDL l1,l2,r_val and is retained explicitly. Necessary PMAP scope is only one complete magnetic instance, lines 993-1185; other PMAP instances are not claimed read. Current 25.1 ZX complete declaration and nom.lib include are recorded separately and do not establish historical archive binding. Four analysis files differ; no simulation run.'}
    instances=[('standard','ioport','I1',[2400,1900],[1,0,0,1]),
        ('standard','ioport','I2',[2400,1450],[1,0,0,1]),
        ('standard','ioport','I3',[450,1900],[-1,0,0,1]),
        ('analog','h','I10',[1650,1950],[-1,0,0,1]),
        ('analog','f','I11',[1550,1650],[1,0,0,1]),
        ('analog','l','I12',[1800,1350],[0,-1,1,0]),
        ('analog','e','I13',[2100,1550],[1,0,0,1]),
        ('anl_misc','zx','I4',[700,1950],[1,0,0,1]),
        ('analog','r','I5',[800,1500],[0,-1,1,0]),
        ('analog','r','I9',[1200,1950],[1,0,0,1]),
        ('source','0','I14',[1300,1400],[1,0,0,1]),
        ('source','0','I15',[1800,1100],[1,0,0,1]),
        ('source','0','I6',[800,1350],[1,0,0,1]),
        ('source','0','I7',[500,1400],[1,0,0,1]),
        ('source','0','I8',[1050,1400],[1,0,0,1])]
    for lib,part,instance,origin,matrix in instances:
        c['symbols'].append({**source(root/'archive_libs'/lib/part/'sym_1/symbol.css'),
                             'part':part,'instance':instance,'origin':origin,'matrix':matrix})
    paths=['cds.lib','worklib/magnetic_ckt/sch_1/verilog.v','worklib/magnetic_ckt/entity/verilog.v',
        'worklib/magnetic_ckt/sym_1/symbol.css','worklib/magnetic_ckt/sch_1/viewprps.prp',
        'worklib/top/psp_sim_1/top.net','worklib/top/psp_sim_1/top_subckt.lib',
        'worklib/top/psp_sim_1/profiles/TOP/TOP.cir',
        'worklib/top/psp_sim_1/profiles/TOP/SLPS_SRM_main__SLPS__SLPS.cir',
        'worklib/top/psp_sim_1/profiles/TOP_slps_/TOP_slps_.cir',
        'worklib/top/psp_sim_1/profiles/TOP_slps_/TOP_slps__SLPS.cir']
    for lib,part in sorted({(x[0],x[1]) for x in instances}):
        paths.append(f'archive_libs/{lib}/{part}/entity/verilog.v')
    for part in ['r','l']:
        paths += [f'archive_libs/analog/{part}/{suffix}' for suffix in ['awb_model/device.prp','chips/chips.prt']]
    c['supplemental']=[source(root/path) for path in paths]
    c['supplemental'].append({**source(root/'worklib/top/psp_sim_1/top_sch.prp',lines=list(range(993,1186))),
                              'scope':'Only one complete magnetic_ckt instance PMAP, not the full top-level PMAP.'})
    current=Path('E:/Cadence/SPB_25.1/tools/pspice/library')
    c['supplemental'].append({**source(current/'anl_misc.lib',lines=list(range(40,54))),
                              'scope':'Current ZX comments and complete subcircuit; not historical archive binding.'})
    c['supplemental'].append({**source(current/'nom.lib',lines=[36]),
                              'scope':'Current nominal library includes anl_misc.lib; historical nominal library unresolved.'})
    out.mkdir(parents=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS028.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:800px}</style><p>PS028 original CSA/CSS reconstruction; not native screenshot or product acceptance.</p><section><h2>PS028 magnetic circuit</h2><img src="PS028.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':'PS028','CSA_lines':len(c['originalLines']),'CSV_lines':len(c['connectivity']['lines']),'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P025':
    assert sys.argv[3:]==['PS027'] and not out.exists(), 'Only explicitly reviewed PS027 transforms are registered.'
    p=lookup['PS027']; original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    c={'id':'PS027','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[],
       'verifiedPins':{'I1':{'1':[850,2350,1],'2':[1050,2350,3]},
           'I2':{'1':[1200,2100,2],'2':[1200,2250,3]},
           'I3':{'+':[700,2300,1],'-':[700,2100,2]},
           'I4':{'GND':[700,1950,2]}},
       'unconnectedCsvNet':0,'viewBox':'200 -2600 1450 900',
       'geometryBoundary':'Original CSA/CSS pin positions preserved. Three CSV nets form three continuous local components; no inferred wire or module port. CSV/CSA call input net 1, while generated Verilog/netlist call it one: identity is established by matched device terminals, not by a universal name replacement.',
       'modelBoundary':'Primitive R/C/V templates, R/C port-order and package maps read. C value is 0.5 with no suffix; neither CSS default 1n nor analysis duration changes it. Historical PMAP has VARIABLES_DEF absent from this CSA/CSV. Standalone and two SLPS analyses differ and SLPS replaces VIN with zero; no simulation run.'}
    for lib,part,instance,origin,matrix in [
        ('analog','r','I1',[900,2400],[1,0,0,1]),
        ('analog','c','I2',[1150,2150],[0,-1,1,0]),
        ('source','vsrc','I3',[650,2250],[1,0,0,1]),
        ('source','0','I4',[650,1900],[1,0,0,1])]:
        c['symbols'].append({**source(root/'archive_libs'/lib/part/'sym_1/symbol.css'),
                             'part':part,'instance':instance,'origin':origin,'matrix':matrix})
    paths=['cds.lib','worklib/rccir/sch_1/verilog.v','worklib/rccir/sch_1/viewprps.prp',
        'worklib/rccir/psp_sim_1/rccir.net','worklib/rccir/psp_sim_1/rccir_sch.prp',
        'worklib/glbl/rccir_cfg_analog/verilog.v','worklib/glbl/rccir_cfg_package/verilog.v',
        'worklib/rccir/psp_sim_1/profiles/tran/tran.cir',
        'worklib/rccir/psp_sim_1/profiles/tran/SLPS_SLPS.cir',
        'worklib/rccir/psp_sim_1/profiles/tran_slps_/tran_slps_.cir',
        'worklib/rccir/psp_sim_1/profiles/tran_slps_/tran_slps__SLPS.cir']
    for lib,part in [('analog','r'),('analog','c'),('source','vsrc'),('source','0')]:
        paths.append(f'archive_libs/{lib}/{part}/entity/verilog.v')
    for part in ['r','c']:
        paths += [f'archive_libs/analog/{part}/{suffix}' for suffix in ['awb_model/device.prp','chips/chips.prt']]
    c['supplemental']=[source(root/path) for path in paths]
    out.mkdir(parents=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS027.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:900px}</style><p>PS027 original CSA/CSS reconstruction; not native screenshot or product acceptance.</p><section><h2>PS027 RC co-simulation</h2><img src="PS027.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':'PS027','CSA_lines':len(c['originalLines']),'CSV_lines':len(c['connectivity']['lines']),'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P024':
    assert sys.argv[3:]==['PS026'] and not out.exists(), 'Only explicitly reviewed PS026 transforms are registered.'
    p=lookup['PS026']; original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    identity=[1,0,0,1]; vertical=[0,-1,1,0]
    reflected_x=[-1,0,0,1]; reflected_vertical=[0,-1,-1,0]
    c={'id':'PS026','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[],
       'verifiedPins':{
        'I1':{'+':[-100,2550,23],'-':[-100,2350,22]},
        'I10':{'1':[800,700,12],'2':[800,900,5]},
        'I11':{'1':[1550,550,7],'2':[1750,550,13]},
        'I12':{'1':[2450,250,15],'2':[2450,450,13]},
        'I13':{'+':[1950,1850,2],'-':[1950,1650,4],'V+':[2150,1900,8],
               'V-':[2150,1600,9],'OUT':[2350,1750,3]},
        'I14':{'+':[950,1750,6],'-':[950,1550,5],'V+':[1150,1800,10],
               'V-':[1150,1500,11],'OUT':[1350,1650,4]},
        'I15':{'b':[900,550,7],'c':[800,650,12],'e':[800,450,18]},
        'I16':{'1':[1250,300,17],'2':[1250,450,7]},
        'I17':{'1':[2700,1200,3],'2':[2700,1050,13]},
        'I18':{'GND':[-100,2200,22]},'I19':{'GND':[450,2200,21]},
        'I2':{'+':[450,2550,1],'-':[450,2350,21]},
        'I20':{'GND':[-250,1000,20]},'I21':{'GND':[550,150,19]},
        'I22':{'GND':[800,150,18]},'I23':{'GND':[1250,100,17]},
        'I24':{'GND':[1700,950,16]},
        'I25':{'1':[1050,950,5],'2':[1200,950,4]},
        'I26':{'1':[2450,1000,13],'2':[2450,1200,3]},'I27':{'GND':[2450,150,15]},
        'I3':{'+':[-250,1400,14],'-':[-250,1200,20]},
        'I4':{'1':[200,1750,14],'2':[400,1750,6]},
        'I5':{'1':[200,1550,14],'2':[400,1550,5]},
        'I6':{'1':[2000,2250,2],'2':[2200,2250,3]},
        'I7':{'1':[1050,1200,5],'2':[1250,1200,4]},
        'I8':{'1':[1700,1300,16],'2':[1700,1500,2]},
        'I9':{'1':[550,700,19],'2':[550,900,6]}},
       'unconnectedCsvNet':0,'viewBox':'-750 -2850 3800 3000',
       'namedNetEquivalence':{'0':{'csvLocalNets':list(range(15,23))},
           'VCC':{'csvLocalNets':[8,10,23]},'VEE':{'csvLocalNets':[1,9,11]}},
       'geometryBoundary':'Original CSA/CSS positions, matrices and pin identities retained. Local CSV components differ from global same-name equivalence. NC=0 is unused; no inferred ports or wire completion.',
       'modelBoundary':'Explicit TL082 +,-,V+,V-,OUT and Q2SC1815 c,b,e templates and package maps read. Complete current model declarations retained; absent archived model bodies cannot establish historical nom.lib binding. Standalone and two SLPS profiles differ in analysis and VIN; no simulation run.'}
    specs=[('source','vsrc','I1',[-150,2500],identity),
       ('analog','r','I10',[750,750],vertical),('analog','r','I11',[1600,600],identity),
       ('analog','r','I12',[2400,300],vertical),('opamp','tl082','I13',[2000,1900],identity),
       ('opamp','tl082','I14',[1000,1800],identity),('jbipolar','q2sc1815','I15',[850,600],reflected_x),
       ('jdiode','d1s1588','I16',[1200,350],vertical),('jdiode','d1s1588','I17',[2650,1150],reflected_vertical),
       ('source','0','I18',[-150,2150],identity),('source','0','I19',[400,2150],identity),
       ('source','vsrc','I2',[400,2500],identity),('source','0','I20',[-300,950],identity),
       ('source','0','I21',[500,100],identity),('source','0','I22',[750,100],identity),
       ('source','0','I23',[1200,50],identity),('source','0','I24',[1650,900],identity),
       ('analog','c','I25',[1100,1000],identity),('analog','r','I26',[2400,1050],vertical),
       ('source','0','I27',[2400,100],identity),('source','vsrc','I3',[-300,1350],identity),
       ('analog','r','I4',[250,1800],identity),('analog','r','I5',[250,1600],identity),
       ('analog','r','I6',[2050,2300],identity),('analog','r','I7',[1100,1250],identity),
       ('analog','r','I8',[1650,1350],vertical),('analog','r','I9',[500,750],vertical)]
    for lib,part,instance,origin,matrix in specs:
        c['symbols'].append({**source(root/'archive_libs'/lib/part/'sym_1/symbol.css'),
                             'part':part,'instance':instance,'origin':origin,'matrix':matrix})
    paths=['cds.lib','worklib/vco/sch_1/verilog.v','worklib/vco/sch_1/viewprps.prp',
        'worklib/vco/psp_sim_1/vco.net','worklib/glbl/vco_cfg_analog/verilog.v',
        'worklib/glbl/vco_cfg_package/verilog.v',
        'worklib/vco/psp_sim_1/profiles/tran/tran.cir',
        'worklib/vco/psp_sim_1/profiles/tran/SLPS_SLPS.cir',
        'worklib/vco/psp_sim_1/profiles/tran_slps_/tran_slps_.cir',
        'worklib/vco/psp_sim_1/profiles/tran_slps_/tran_slps__SLPS.cir']
    for lib,part in [('source','vsrc'),('analog','r'),('opamp','tl082'),('jbipolar','q2sc1815'),('jdiode','d1s1588'),('source','0'),('analog','c')]:
        paths.append(f'archive_libs/{lib}/{part}/entity/verilog.v')
    for lib,part in [('analog','r'),('analog','c'),('opamp','tl082'),('jbipolar','q2sc1815'),('jdiode','d1s1588')]:
        paths.append(f'archive_libs/{lib}/{part}/chips/chips.prt')
    for part in ['r','c']:
        paths.append(f'archive_libs/analog/{part}/awb_model/device.prp')
    c['supplemental']=[source(root/path) for path in paths]
    for library,start,end in [('opamp.lib',3973,4014),('jdiode.lib',740,741),('jbipolar.lib',1068,1072)]:
        c['supplemental'].append(source(Path('E:/Cadence/SPB_25.1/tools/pspice/Library')/library,
                                        encoding='latin1',lines=range(start,end+1)))
    out.mkdir(parents=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS026.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:1080px}</style><p>PS026 original CSA/CSS reconstruction; not native screenshot or product acceptance.</p><section><h2>PS026 VCO</h2><img src="PS026.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':'PS026','CSA_lines':len(c['originalLines']),'CSV_lines':len(c['connectivity']['lines']),'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P023':
    assert sys.argv[3:]==['PS025'] and (not out.exists() or not any(out.iterdir())), 'Resume empty PS025 preparation; never reset preserved evidence.'
    p=lookup['PS025']; original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    identity=[1,0,0,1]; vertical=[0,-1,1,0]
    c={'id':'PS025','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[],
       'verifiedPins':{
        'I1':{'+':[-50,1800,12],'-':[-50,1600,2]},
        'I10':{'+':[1950,2000,19],'-':[1950,1800,20]},
        'I11':{'1':[2150,2050,19],'2':[2150,1950,6],'3':[2350,1850,16],
               '4':[2550,2050,10],'5':[2550,1950,11]},
        'I12':{'1':[2350,1600,7],'2':[2350,1800,16]},
        'I13':{'1':[2800,1600,8],'2':[2800,1800,11]},
        'I14':{'GND':[-50,1400,2]},'I15':{'GND':[550,1400,3]},
        'I16':{'GND':[950,1400,4]},'I17':{'GND':[1950,1500,5]},
        'I18':{'GND':[2100,1500,6]},'I19':{'GND':[2350,1500,7]},
        'I2':{'+':[50,2450,18],'-':[50,2250,9]},
        'I20':{'GND':[2800,1500,8]},'I21':{'GND':[50,2200,9]},
        'I22':{'+':[1950,1800,20],'-':[1950,1600,5]},
        'I3':{'1':[200,1950,12],'2':[350,1950,1]},
        'I4':{'1':[550,2100,1],'2':[550,2300,15]},
        'I5':{'1':[550,1550,3],'2':[550,1750,1]},
        'I6':{'1':[950,2100,14],'2':[950,2300,15]},
        'I7':{'1':[950,1550,4],'2':[950,1750,13]},
        'I8':{'1':[1150,2050,14],'2':[1300,2050,17]},
        'I9':{'b':[850,1950,1],'c':[950,2050,14],'e':[950,1850,13]}},
       'unconnectedCsvNet':0,'viewBox':'-500 -2850 3900 1750',
       'namedNetEquivalence':{'0':{'csvLocalNets':[2,3,4,5,6,7,8,9]},
           'NODE1':{'csvLocalNets':[10,17]},'VDD':{'csvLocalNets':[15,18]}},
       'geometryBoundary':'Actual PS025 CSA/CSS positions retained; CSV NC=0 is unused. NODE1 is a remote same-name wire, not an inferred module port. Local wire components and global named equivalence remain distinct.',
       'modelBoundary':'Original ZX five-port template and Q2SC1815 c,b,e template, entity and available package map read. Current complete ZX and Q2SC1815 declarations retained; missing archived model.sp/device.prp for these modeled parts prevents proof of historical binding. Historical bias annotations and differing TRAN/SLPS profiles are preserved, not new simulation results.'}
    specs=[('source','vsrc','I1',[-100,1750],identity),
       ('source','vsrc','I10',[1900,1950],identity),('anl_misc','zx','I11',[2200,2100],identity),
       ('analog','r','I12',[2300,1650],vertical),('analog','r','I13',[2750,1650],vertical),
       ('source','0','I14',[-100,1350],identity),('source','0','I15',[500,1350],identity),
       ('source','0','I16',[900,1350],identity),('source','0','I17',[1900,1450],identity),
       ('source','0','I18',[2050,1450],identity),('source','0','I19',[2300,1450],identity),
       ('source','vdc','I2',[0,2450],identity),('source','0','I20',[2750,1450],identity),
       ('source','0','I21',[0,2150],identity),('source','vdc','I22',[1900,1800],identity),
       ('analog','c','I3',[250,2000],identity),('analog','r','I4',[500,2150],vertical),
       ('analog','r','I5',[500,1600],vertical),('analog','r','I6',[900,2150],vertical),
       ('analog','r','I7',[900,1600],vertical),('analog','c','I8',[1200,2100],identity),
       ('jbipolar','q2sc1815','I9',[900,2000],identity)]
    for lib,part,instance,origin,matrix in specs:
        c['symbols'].append({**source(root/'archive_libs'/lib/part/'sym_1/symbol.css'),
                             'part':part,'instance':instance,'origin':origin,'matrix':matrix})
    paths=['cds.lib','worklib/nlload/sch_1/verilog.v','worklib/nlload/sch_1/viewprps.prp',
        'worklib/nlload/psp_sim_1/nlload.net','worklib/nlload/psp_sim_1/nlload_sch.prp',
        'worklib/glbl/nlload_cfg_analog/verilog.v','worklib/glbl/nlload_cfg_package/verilog.v',
        'worklib/nlload/psp_sim_1/profiles/tran/tran.cir',
        'worklib/nlload/psp_sim_1/profiles/tran/SLPS_SLPS.cir',
        'worklib/nlload/psp_sim_1/profiles/tran_slps_/tran_slps_.cir',
        'worklib/nlload/psp_sim_1/profiles/tran_slps_/tran_slps__SLPS.cir']
    for lib,part in [('analog','c'),('analog','r'),('anl_misc','zx'),('jbipolar','q2sc1815'),('source','0'),('source','vdc'),('source','vsrc')]:
        paths.append(f'archive_libs/{lib}/{part}/entity/verilog.v')
    for part in ['r','c']:
        paths += [f'archive_libs/analog/{part}/{suffix}' for suffix in ['awb_model/device.prp','chips/chips.prt']]
    paths.append('archive_libs/jbipolar/q2sc1815/chips/chips.prt')
    c['supplemental']=[source(root/path) for path in paths]
    c['supplemental'] += [source('E:/Cadence/SPB_25.1/tools/pspice/Library/anl_misc.lib',encoding='latin1',lines=range(40,51)),
                          source('E:/Cadence/SPB_25.1/tools/pspice/Library/jbipolar.lib',encoding='latin1',lines=range(1068,1073))]
    out.mkdir(parents=True,exist_ok=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS025.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:1000px}</style><p>PS025 original CSA/CSS reconstruction; not native screenshot or product acceptance.</p><section><h2>PS025 nonlinear load</h2><img src="PS025.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':'PS025','CSA_lines':len(c['originalLines']),'CSV_lines':len(c['connectivity']['lines']),'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P022':
    assert sys.argv[3:]==['PS024'] and not out.exists(), 'Only explicitly reviewed PS024 transforms are registered.'
    p=lookup['PS024']; original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    identity=[1,0,0,1]; vertical=[0,-1,1,0]; reflected_y=[1,0,0,-1]
    c={'id':'PS024','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[],
       'verifiedPins':{
        'I1':{'1':[700,1850,19],'2':[900,1850,15]},
        'I10':{'+':[1800,1350,18],'-':[1800,1150,1]},
        'I11':{'+':[2150,1350,9],'-':[2150,1150,4]},
        'I12':{'GND':[1800,950,1]},'I13':{'GND':[2150,950,4]},
        'I14':{'1':[1050,1450,3],'2':[1050,1650,8]},
        'I19':{'1':[2200,1750,7],'2':[2400,1750,13]},
        'I20':{'1':[2600,1250,2],'2':[2600,1450,14]},
        'I21':{'GND':[2600,1150,2]},
        'I22':{'1':[2800,2100,13],'2':[3000,2100,16]},
        'I23':{'+':[1250,1650,8],'-':[1250,1850,15],'V+':[1450,1600,6],
               'V-':[1450,1900,17],'OUT':[1650,1750,7],'OS1':[1650,1850,0],'OS2':[1650,1650,0]},
        'I24':{'+':[2850,1550,14],'-':[2850,1750,13],'V+':[3050,1500,12],
               'V-':[3050,1800,11],'OUT':[3250,1650,16],'OS1':[3250,1750,0],'OS2':[3250,1550,0]},
        'I3':{'1':[1550,2150,10],'2':[1700,2150,7]},
        'I4':{'1':[1200,2150,15],'2':[1400,2150,10]},
        'I6':{'GND':[1050,1300,3]},'I7':{'+':[500,1700,19],'-':[500,1500,5]},
        'I8':{'GND':[500,1300,5]}},
       'unconnectedCsvNet':0,'viewBox':'100 -2700 3800 2050',
       'namedNetEquivalence':{'0':{'csvLocalNets':[1,2,3,4,5]},
         'VCC':{'csvLocalNets':[6,12,18]},'VEE':{'csvLocalNets':[9,11,17]},
         'PIC_OUT':{'csvLocalNets':[16],'boundary':'Internal named wire in portless picont_sch(); no inferred link to external VGATE.'}},
       'geometryBoundary':'Actual PS024 CSA anchors and original CSS reflection retained. Working diagram differs from archived PS023; no borrowed instance map or inferred decorative ports.'}
    specs=[('analog','r','I1',[750,1900],identity),
      ('source','vsrc','I10',[1750,1300],identity),('source','vsrc','I11',[2100,1300],identity),
      ('source','0','I12',[1750,900],identity),('source','0','I13',[2100,900],identity),
      ('analog','r','I14',[1000,1500],vertical),('analog','r','I19',[2250,1800],identity),
      ('analog','r','I20',[2550,1300],vertical),('source','0','I21',[2550,1100],identity),
      ('analog','r','I22',[2850,2150],identity),
      ('opamp','ua741','I23',[1300,1600],reflected_y),('opamp','ua741','I24',[2900,1500],reflected_y),
      ('analog','c','I3',[1600,2200],identity),('analog','r','I4',[1250,2200],identity),
      ('source','0','I6',[1000,1250],identity),('source','vsrc','I7',[450,1650],identity),
      ('source','0','I8',[450,1250],identity)]
    for lib,part,instance,origin,matrix in specs:
        c['symbols'].append({**source(root/'archive_libs'/lib/part/'sym_1/symbol.css'),
                             'part':part,'instance':instance,'origin':origin,'matrix':matrix})
    paths=['cds.lib','worklib/picont_sch/sch_1/verilog.v',
           'worklib/picont_sch/psp_sim_1/picont_sch.net',
           'worklib/picont_sch/psp_sim_1/profiles/tran/tran.cir',
           'archive_libs/opamp/ua741/chips/chips.prt']
    for lib,part in [('analog','r'),('analog','c'),('source','vsrc'),('source','0'),('opamp','ua741')]:
        paths.append(f'archive_libs/{lib}/{part}/entity/verilog.v')
    for part in ['r','c']:
        paths += [f'archive_libs/analog/{part}/{suffix}' for suffix in ['awb_model/device.prp','chips/chips.prt']]
    c['supplemental']=[source(root/path) for path in paths]
    c['supplemental'].append(source('E:/Cadence/SPB_25.1/tools/pspice/Library/opamp.lib',encoding='latin1',lines=range(4161,4203)))
    out.mkdir(parents=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS024.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:1000px}</style><p>PS024 working CSA/CSS reconstruction; not native screenshot or product acceptance.</p><section><h2>PS024 working cascaded controller</h2><img src="PS024.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':'PS024','CSA_lines':len(c['originalLines']),'CSV_lines':len(c['connectivity']['lines']),'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P020':
    assert sys.argv[3:]==['PS022'] and (not out.exists() or not any(out.iterdir())), 'Resume preserved PS022 evidence; never reset.'
    p=lookup['PS022']; original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    identity=[1,0,0,1]; vertical=[0,-1,1,0]; reflected_y=[1,0,0,-1]
    c={'id':'PS022','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[],
       'verifiedPins':{
        'I1':{'GND':[-50,1450,15]},
        'I10':{'1':[1000,2300,7],'2':[1150,2300,5]},
        'I11':{'GND':[1600,1100,16]},
        'I12':{'+':[1600,1500,8],'-':[1600,1300,16]},
        'I13':{'GND':[2050,1300,17]},
        'I14':{'1':[2050,1400,17],'2':[2050,1600,10]},
        'I15':{'1':[1650,1900,5],'2':[1850,1900,13]},
        'I16':{'+':[2300,1700,10],'-':[2300,1900,13],
               'V+':[2500,1650,9],'V-':[2500,1950,11],'OUT':[2700,1800,12],
               'OS1':[2700,1900,0],'OS2':[2700,1700,0]},
        'I17':{'1':[2250,2250,13],'2':[2450,2250,12]},
        'I2':{'+':[-50,1850,14],'-':[-50,1650,15]},
        'I3':{'1':[500,1600,18],'2':[500,1800,2]},
        'I4':{'GND':[500,1450,18]},
        'I5':{'1':[150,2000,14],'2':[350,2000,6]},
        'I6':{'GND':[1250,1100,19]},
        'I7':{'+':[700,1800,2],'-':[700,2000,6],
              'V+':[900,1750,1],'V-':[900,2050,3],'OUT':[1100,1900,5],
              'OS1':[1100,2000,0],'OS2':[1100,1800,0]},
        'I8':{'+':[1250,1500,4],'-':[1250,1300,19]},
        'I9':{'1':[650,2300,6],'2':[850,2300,7]}},
       'unconnectedCsvNet':0,'viewBox':'-450 -2600 3900 1850',
       'geometryBoundary':'All 17 original CSS instances, origins and independently checked matrices retained. The four OS1/OS2 contacts explicitly use CSV NC=0 and remain separate; NC is not SPICE ground. VCC/VEE and ground named equivalence is confirmed separately by archived netlist/Verilog.',
       'namedNetEquivalence':{'VCC':{'csvLocalNets':[1,4,9]},'VEE':{'csvLocalNets':[3,8,11]},
          '0':{'csvLocalNets':[15,16,17,18,19]},
          'evidence':'driver_sch.net and sch_1/verilog.v; PIC_OUT is a local wire, not a module port and has no connection to the page3 VGATE source.'},
       'modelBoundary':'The seven-contact original uA741 graphic retains OS1/OS2 as Unmodeled/NC; PSpiceTemplate exports only +,-,V+,V-,OUT. Package numbers 3,2,7,4,6,1,5 do not redefine five-port order. CPI=4U IC=-3, VCONT DC1 AC1Vac SIN(0 0.01 1K), VCC DC15 AC1Vac and VEE DC-15 AC1Vac retained separately. Complete current uA741 model read, without proof of historical library binding or simulation.'}
    specs=[('source','0','I1',[-100,1400],identity),('analog','c','I10',[1050,2350],identity),
       ('source','0','I11',[1550,1050],identity),('source','vsrc','I12',[1550,1450],identity),
       ('source','0','I13',[2000,1250],identity),('analog','r','I14',[2000,1450],vertical),
       ('analog','r','I15',[1700,1950],identity),('opamp','ua741','I16',[2350,1650],reflected_y),
       ('analog','r','I17',[2300,2300],identity),('source','vsrc','I2',[-100,1800],identity),
       ('analog','r','I3',[450,1650],vertical),('source','0','I4',[450,1400],identity),
       ('analog','r','I5',[200,2050],identity),('source','0','I6',[1200,1050],identity),
       ('opamp','ua741','I7',[750,1750],reflected_y),('source','vsrc','I8',[1200,1450],identity),
       ('analog','r','I9',[700,2350],identity)]
    for lib,part,instance,origin,matrix in specs:
        c['symbols'].append({**source(root/'archive_libs'/lib/part/'sym_1/symbol.css'),
          'part':part,'instance':instance,'origin':origin,'matrix':matrix})
    paths=['cds.lib','worklib/driver_sch/sch_1/verilog.v','worklib/driver_sch/psp_sim_1/driver_sch.net',
       'archive_libs/opamp/ua741/entity/verilog.v','archive_libs/opamp/ua741/chips/chips.prt',
       'archive_libs/analog/c/entity/verilog.v','archive_libs/analog/c/chips/chips.prt']
    c['supplemental']=[source(root/path) for path in paths]
    c['supplemental'].append(source(Path('E:/Cadence/SPB_25.1/tools/pspice/Library/opamp.lib'),
                                 encoding='latin1',lines=range(4167,4203)))
    out.mkdir(parents=True,exist_ok=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'PS022.svg').write_text(diagram(c),encoding='utf8')
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><h1>P020 / PS022 original-coordinate reconstruction, not native screenshot</h1><img style="width:1500px;height:950px" src="PS022.svg">',encoding='utf8')
    print(json.dumps({'prepared':'PS022','CSA_lines':len(c['originalLines']),'CSV_lines':len(c['connectivity']['lines']),'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P019':
    assert sys.argv[3:]==['PS021'] and (not out.exists() or not any(out.iterdir())), 'Resume preserved PS021 evidence; never reset.'
    p=lookup['PS021']; original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    identity=[1,0,0,1]; vertical=[0,-1,1,0]; reflected_x=[-1,0,0,1]
    c={'id':'PS021','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[],
       'verifiedPins':{
        'I10':{'1':[4300,1750,21],'2':[4300,1900,1]},
        'I11':{'A':[2400,800,5],'Y*':[2632,800,2]},
        'I12':{'1':[5150,2250,12],'2':[5450,2250,13]},
        'I13':{'GND':[5700,1750,15]},'I14':{'GND':[1400,1150,4]},
        'I15':{'GND':[2400,1050,18]},'I16':{'GND':[2700,1550,23]},
        'I17':{'GND':[2200,2100,16]},
        'I18':{'1':[4750,2250,11],'2':[4950,2250,12]},
        'I19':{'+':[5700,2050,13],'-':[5700,1850,15]},
        'I2':{'1':[2600,2350,8],'2':[2800,2350,1]},
        'I20':{'1':[3450,1550,21],'2':[3450,1750,3]},
        'I21':{'GND':[1800,700,24]},'I22':{'GND':[3150,1800,17]},
        'I23':{'1':[2400,1100,18],'2':[2400,1300,7]},
        'I25':{'GND':[4000,600,14]},
        'I26':{'IN':[1800,1800,9],'OUT':[2050,1800,5]},
        'I3':{'+':[2200,2350,8],'-':[2200,2150,16]},
        'I37':{'g':[3850,1800,3],'s':[4000,1700,21],'d':[4000,1900,1]},
        'I38':{'g':[3850,800,2],'d':[4000,900,21],'s':[4000,700,14]},
        'I4':{'+':[1800,900,19],'-':[1800,700,24]},
        'I40':{'1':[2600,1350,7],'2':[2800,1350,6]},
        'I41':{'VCC_BAR':[1800,1000,19]},
        'I5':{'+':[1400,1550,22],'-':[1400,1350,4]},
        'I6':{'1':[2200,1800,5],'2':[2400,1800,10]},
        'I7':{'IN':[1450,1800,22],'OUT':[1750,1800,9]},
        'I8':{'A':[3200,2100,6],'K':[3200,2000,17],'E':[3450,1900,3],'C':[3550,2100,1]},
        'I9':{'+':[2500,1800,10],'-':[2500,1600,7],'V+':[2700,1850,20],
              'V-':[2700,1550,23],'OUT':[2900,1700,6]},
        'V15':{'VCC_BAR':[2700,2100,20]}},
       'decorativePins':{'I34':{'A':[4250,2550,11]},'I35':{'A':[4550,1400,21]}},
       'viewBox':'450 -2850 5850 2500',
       'geometryBoundary':'All 31 original instances retain CSS, CSA origins and independently checked matrices. Two COMMENT_BODY TRUE OFFPAGE icons are absent from CSV and remain decorative. ROTOR_IN equivalence is positively proved in CSV, Verilog and generated SPICE; no inferred cross-module PIC_OUT connection. Named global equivalence is retained separately from physical wire components.',
       'namedNetEquivalence':{'0':{'csvLocalNets':[4,14,15,16,17,18,23,24]},
         'V15V':{'csvLocalNets':[19,20]},'ROTOR_IN':{'csvLocalNets':[11,21]},
         'evidence':'driver_sch() has no external ports; archived Verilog and driver_sch.net explicitly map both rotor_in regions. The separate page2 pic_out wire is not a page3 input.'},
       'modelBoundary':'Original M2SK2741 emits primitive M d,g,s,s; M2SK3405 emits X d,g,s. PS2561 emits A,K,C,E despite Verilog A,C,E,K and package 1,2,4,3. LM324 emits +,-,V+,V-,OUT. 7404 has two graphic contacts A/Y* and hidden global digital supplies, not invented graphic power pins. Current necessary model bodies and D_04/IO_STD declarations retained; current installed libraries are not proof of historical 2010/2018 binding. Raw R3=10M and generated 10m both mean milli in PSpice. No simulation or product pass.'}
    specs=[('breakout','dbreak','I10',[4250,1800],vertical),
      ('7400','7404','I11',[2450,900],identity),('analog','l','I12',[5200,2300],identity),
      ('source','0','I13',[5650,1700],identity),('source','0','I14',[1350,1100],identity),
      ('source','0','I15',[2350,1000],identity),('source','0','I16',[2650,1500],identity),
      ('source','0','I17',[2150,2050],identity),('analog','r','I18',[4800,2300],identity),
      ('source','vsrc','I19',[5650,2000],identity),('analog','r','I2',[2650,2400],identity),
      ('analog','r','I20',[3400,1600],vertical),('source','0','I21',[1750,650],identity),
      ('source','0','I22',[3100,1750],identity),('analog','r','I23',[2350,1150],vertical),
      ('source','0','I25',[3950,550],identity),('abm','gain','I26',[1850,1900],identity),
      ('source','vsrc','I3',[2150,2300],identity),
      ('standard','offpage','I34',[4200,2550],identity),
      ('standard','offpage','I35',[4600,1400],reflected_x),
      ('jpwrmos','m2sk2741','I37',[3900,1900],identity),
      ('nec_mos','m2sk3405#2fnec','I38',[3900,900],identity),
      ('source','vsrc','I4',[1750,850],identity),('analog','r','I40',[2650,1400],identity),
      ('standard','vcc_bar','I41',[1750,1050],identity),
      ('source','vsrc','I5',[1350,1500],identity),('analog','r','I6',[2250,1850],identity),
      ('function','slew_limit','I7',[1600,1800],identity),
      ('opto','ps2561#2d1','I8',[3250,2150],identity),
      ('opamp','lm324','I9',[2550,1850],identity),
      ('standard','vcc_bar','V15',[2650,2150],identity)]
    for lib,part,instance,origin,matrix in specs:
        libroot=Path('E:/Cadence/SPB_25.1/share/library/standard') if lib=='standard' else root/'archive_libs'/lib
        c['symbols'].append({**source(libroot/part/'sym_1/symbol.css'),
                             'part':part,'instance':instance,'origin':origin,'matrix':matrix})
    paths=['cds.lib','worklib/driver_sch/sch_1/verilog.v',
           'worklib/driver_sch/psp_sim_1/driver_sch.net',
           'worklib/driver_sch/psp_sim_1/profiles/tran/tran.cir',
           'worklib/driver_sch/psp_sim_1/profiles/tran/SLPS_Driver_and_Rotor.cir',
           'worklib/driver_sch/psp_sim_1/profiles/tran_slps_/tran_slps_.cir',
           'worklib/driver_sch/psp_sim_1/profiles/tran_slps_/tran_slps__SLPS.cir']
    for lib,part in dict.fromkeys((s[0],s[1]) for s in specs if s[0]!='standard'):
        paths.append(f'archive_libs/{lib}/{part}/entity/verilog.v')
        for suffix in ['chips/chips.prt','awb_model/device.prp','awb_model/model.sp']:
            path=f'archive_libs/{lib}/{part}/{suffix}'
            if (root/path).exists():paths.append(path)
    c['supplemental']=[source(root/path) for path in paths]
    for lib,start,stop in [('breakout.lib',17,17),('7400.lib',94,105),
      ('dig_io.lib',1094,1105),('function.lib',198,218),('jpwrmos.lib',2450,2466),
      ('nec_mos.lib',4613,4666),('opto.lib',1378,1401),('opamp.lib',2236,2287)]:
        c['supplemental'].append(source(Path('E:/Cadence/SPB_25.1/tools/pspice/Library')/lib,encoding='latin1',lines=range(start,stop+1)))
    out.mkdir(parents=True,exist_ok=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS021.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:900px}</style><p>PS021 CSA/CSS reconstruction; not native screenshot or product acceptance.</p><section><h2>PS021 PWM driver and rotor loop</h2><img src="PS021.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':'PS021','CSA_lines':len(c['originalLines']),'CSV_lines':len(c['connectivity']['lines']),'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch in {'P018','P021'}:
    case_id = 'PS020' if batch == 'P018' else 'PS023'
    assert sys.argv[3:]==[case_id] and (not out.exists() or not any(out.iterdir())), 'Resume preserved evidence; never reset.'
    p=lookup[case_id]; original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[4]
    identity=[1,0,0,1]; vertical=[0,-1,1,0]; reflected_y=[1,0,0,-1]; reflected_x=[-1,0,0,1]
    c={'id':case_id,'relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[],
       'verifiedPins':{
        'I10':{'1':[1600,1800,19],'2':[1800,1800,18]},
        'I11':{'1':[2250,1300,3],'2':[2250,1500,13]},
        'I12':{'1':[450,1350,2],'2':[450,1550,16]},
        'I13':{'1':[450,2450,17],'2':[650,2450,14]},
        'I14':{'1':[0,1800,15],'2':[200,1800,17]},
        'I15':{'+':[1200,700,8],'-':[1200,500,7]},
        'I16':{'+':[1550,750,9],'-':[1550,550,4]},
        'I17':{'+':[-300,1700,15],'-':[-300,1500,5]},
        'I18':{'VCC_CIRCLE':[1200,800,8]},'I19':{'VCC_CIRCLE':[1550,800,9]},
        'I2':{'+':[750,1600,16],'-':[750,1800,17],'V+':[950,1550,11],
              'V-':[950,1850,1],'OUT':[1150,1700,19],'OS1':[1150,1800,0],'OS2':[1150,1600,0]},
        'I20':{'VCC_CIRCLE':[950,2050,1]},'I21':{'VCC_CIRCLE':[2550,1950,10]},
        'I22':{'+':[2350,1600,13],'-':[2350,1800,18],'V+':[2550,1550,6],
               'V-':[2550,1850,10],'OUT':[2750,1700,12],'OS1':[2750,1800,0],'OS2':[2750,1600,0]},
        'I23':{'VCC_CIRCLE':[1050,1300,11]},'I24':{'VCC_CIRCLE':[2800,1300,6]},
        'I3':{'GND':[2250,1250,3]},'I4':{'GND':[450,1250,2]},
        'I5':{'GND':[1200,400,7]},'I6':{'GND':[1550,400,4]},'I7':{'GND':[-300,1250,5]},
        'I8':{'1':[950,2450,14],'2':[1100,2450,19]},
        'I9':{'1':[2500,2450,18],'2':[2700,2450,12]}},
       'decorativePins':{'I25':{'A':[3300,1700,12]}},'unconnectedCsvNet':0,
       'viewBox':'-900 -2800 4800 2650',
       'geometryBoundary':'All CSA instances retain original CSS and independently checked matrices/contact anchors. OFFPAGE I25 is COMMENT_BODY TRUE and absent from CSV, so remains a decorative anchor rather than an invented electrical instance. Four CSV NC pins remain independently unconnected. Global equivalence is verified in archived Verilog and generated SPICE netlist; no simulation or product pass.',
       'namedNetEquivalence':{'0':{'csvLocalNets':[2,3,4,5,7]},'VCC':{'csvLocalNets':[6,8,11]},
         'VEE':{'csvLocalNets':[1,9,10]},'PIC_OUT':{'csvLocalNets':[12],'boundary':'Local internal wire in module picont_sch(), which has no external port; OFFPAGE artwork alone does not prove connection to PS017 or another module.'}},
       'modelBoundary':'Original template emits +,-,V+,V-,OUT only. OS1/OS2 are unmodeled, separately NC; package pin8 is also NC in chips.prt but absent from graphic. Archived X_X1/X_X2 map all five modeled terminals. Current installed opamp.lib uA741 body is readable and retained separately from the 2010 historical library binding.'}
    specs=[('analog','r','I10',[1650,1850],identity),('analog','r','I11',[2200,1350],vertical),
      ('analog','r','I12',[400,1400],vertical),('analog','r','I13',[500,2500],identity),
      ('analog','r','I14',[50,1850],identity),('source','vsrc','I15',[1150,650],identity),
      ('source','vsrc','I16',[1500,700],identity),('source','vsrc','I17',[-350,1650],identity),
      ('standard','vcc_circle','I18',[1150,850],identity),('standard','vcc_circle','I19',[1500,850],identity),
      ('opamp','ua741','I2',[800,1550],reflected_y),('standard','vcc_circle','I20',[900,2100],identity),
      ('standard','vcc_circle','I21',[2500,2000],identity),('opamp','ua741','I22',[2400,1550],reflected_y),
      ('standard','vcc_circle','I23',[1100,1350],reflected_x),('standard','vcc_circle','I24',[2850,1350],reflected_x),
      ('standard','offpage','I25',[3350,1700],reflected_x),('source','0','I3',[2200,1200],identity),
      ('source','0','I4',[400,1200],identity),('source','0','I5',[1150,350],identity),
      ('source','0','I6',[1500,350],identity),('source','0','I7',[-350,1200],identity),
      ('analog','c','I8',[1000,2500],identity),('analog','r','I9',[2550,2500],identity)]
    for lib,part,instance,origin,matrix in specs:
        libroot=Path('E:/Cadence/SPB_25.1/share/library/standard') if lib=='standard' else root/'archive_libs'/lib
        c['symbols'].append({**source(libroot/part/'sym_1/symbol.css'),
                             'part':part,'instance':instance,'origin':origin,'matrix':matrix})
    paths=['cds.lib','archive_libs/analog/picont_sch/sch_1/verilog.v',
           'archive_libs/analog/glbl/picont_sch_cfg_analog/verilog.v',
           'archive_libs/analog/picont_sch/psp_sim_1/picont_sch.net',
           'archive_libs/analog/picont_sch/psp_sim_1/profiles/tran/tran.cir',
           'archive_libs/opamp/ua741/chips/chips.prt']
    for lib,part in [('analog','r'),('analog','c'),('source','vsrc'),('source','0'),('opamp','ua741')]:
        paths.append(f'archive_libs/{lib}/{part}/entity/verilog.v')
    for part in ['r','c']:
        paths += [f'archive_libs/analog/{part}/{suffix}' for suffix in ['awb_model/device.prp','chips/chips.prt']]
    c['supplemental']=[source(root/path) for path in paths]
    c['supplemental'].append(source('E:/Cadence/SPB_25.1/tools/pspice/Library/opamp.lib',encoding='latin1',lines=range(4161,4203)))
    out.mkdir(parents=True,exist_ok=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/f'{case_id}.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text(f'<!doctype html><meta charset="utf-8"><style>body{{background:#edf3ef;font-family:Arial}}section{{background:white;padding:12px}}img{{width:1440px;height:1000px}}</style><p>{case_id} CSA/CSS reconstruction; not native screenshot or product acceptance.</p><section><h2>{case_id} uA741 cascaded controller</h2><img src="{case_id}.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':case_id,'CSA_lines':len(c['originalLines']),'CSV_lines':len(c['connectivity']['lines']),'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P017':
    assert sys.argv[3:]==['PS018','PS019'] and (not out.exists() or not any(out.iterdir())), 'Resume existing motor page evidence; never reset.'
    cases=[]
    identity=[1,0,0,1]
    for identifier in ['PS018','PS019']:
        p=lookup[identifier]; original=source(p['source'],p['encoding'])
        assert original['sha256']==p['sha256']
        root=Path(p['source']).parents[3]
        c={'id':identifier,'relative':p['relative'],**original,'originalLines':original['lines'],
           'connectivity':source(p['connectivitySource']),'symbols':[],
           'geometryBoundary':'Identity matrices independently checked against original CSA LASTPIN and all archived CSS contact identities. Global zero remains separate local geometry, explicitly equivalent in device_fb Verilog.'}
        if identifier=='PS018':
            c['verifiedPins']={'I1':{'GND':[800,1650,5]},'I2':{'+':[1850,1950,1],'-':[1850,1750,6]},
                'I3':{'GND':[1850,1700,6]},'I4':{'1':[1250,2050,2],'2':[1550,2050,1]},
                'I5':{'1':[850,2050,3],'2':[1050,2050,2]},
                'I6':{'1':[500,1900,4],'2':[500,1850,7],'3':[700,1900,3],'4':[700,1850,5]},
                'I7':{'GND':[350,1650,7]}}
            c['viewBox']='-100 -2400 2450 1100'
            specs=[('source','0','I1',[750,1600]),('source','vsrc','I2',[1800,1900]),
                ('source','0','I3',[1800,1650]),('analog','l','I4',[1300,2100]),
                ('analog','r','I5',[900,2100]),('analog','e','I6',[550,1950]),('source','0','I7',[300,1600])]
            c['namedNetEquivalence']={'0':{'csvLocalNets':[5,6,7]},'PIC_OUT':{'otherPage':'PS017 net13'},'evidence':'Original device_fb Verilog page2_i6 control1 is pic_out and output3 is vr; local grounds map to glbl.\\0.'}
            c['modelBoundary']='E original template emits %3 %4 as output and %1 %2 as control, despite graphical left/right and numeric terminal order. GAIN=-20, PIC_OUT is control1, VR output3. All sources retain DC1/AC1Vac and empty TRAN. E is a primitive requiring no external subcircuit; archived E device.prp/chips.prt and generated SPICE netlist absent, so no simulation or historical binding claim.'
        else:
            c['verifiedPins']={'I1':{'1':[700,2300,2],'2':[900,2300,1]},'I2':{'GND':[1600,1950,3]},
                'I3':{'1':[1100,2300,1],'2':[1400,2300,3]},
                'I4':{'+':[500,2150,2],'-':[500,1950,4]},'I5':{'GND':[500,1900,4]}}
            c['viewBox']='100 -2700 1850 1100'
            specs=[('analog','r','I1',[750,2350]),('source','0','I2',[1550,1900]),
                ('analog','l','I3',[1150,2350]),('source','vsrc','I4',[450,2100]),('source','0','I5',[450,1850])]
            c['namedNetEquivalence']={'0':{'csvLocalNets':[3,4]},'evidence':'Original CSV zero names plus device_fb Verilog page3_i3/page3_i4 explicitly map to glbl.\\0; no PIC_OUT/VR or coupling declaration on page3.'}
            c['modelBoundary']='Independent stator R/L loop, no drawn PIC_OUT/VR connection or magnetic coupling to page2. Preserve RS500, LS10, VSTATOR DC1/AC1Vac/emptyTRAN and empty IC/tolerance. Device titles do not authorize inventing motor co-simulation couplings. No simulation or product pass.'
        for lib,part,instance,origin in specs:
            c['symbols'].append({**source(root/'archive_libs'/lib/part/'sym_1/symbol.css'),
                                 'part':part,'instance':instance,'origin':origin,'matrix':identity})
        c['supplemental']=[source(root/'cds.lib'),source(root/'worklib/device_fb/sch_1/verilog.v')]
        for lib,part in dict.fromkeys((s[0],s[1]) for s in specs):
            c['supplemental'].append(source(root/'archive_libs'/lib/part/'entity/verilog.v'))
            if lib=='analog' and part in {'r','l'}:
                for rel in ['awb_model/device.prp','chips/chips.prt']:
                    c['supplemental'].append(source(root/'archive_libs'/lib/part/rel))
        cases.append(c)
    out.mkdir(parents=True,exist_ok=True)
    for c in cases:
        write(out/(c['id']+'-pin-audit.json'),audit_csv_geometry(c))
        (out/(c['id']+'.svg')).write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':cases},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:700px}</style><p>CSA/CSS source-coordinate reconstruction; no native screenshot or product acceptance.</p>'+''.join('<section><h2>'+c['id']+' motor loop page</h2><img src="'+c['id']+'.svg"></section>' for c in cases),encoding='utf8')
    print(json.dumps({'prepared':[{'id':c['id'],'CSA_lines':len(c['originalLines']),'CSV_lines':len(c['connectivity']['lines'])} for c in cases],'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P016':
    assert sys.argv[3:]==['PS017'] and (not out.exists() or not any(out.iterdir())), 'Resume existing PS017 evidence; never reset.'
    p=lookup['PS017']; original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    identity=[1,0,0,1];vertical=[0,-1,1,0]
    c={'id':'PS017','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[],
       'verifiedPins':{
        'I1':{'GND':[1350,1150,1]},'I10':{'+':[50,1750,9],'-':[50,1550,2]},
        'I11':{'GND':[50,1500,2]},'I12':{'1':[900,2200,6],'2':[1100,2200,13]},
        'I13':{'1':[600,1500,4],'2':[600,1700,5]},
        'I14':{'+':[800,1700,5],'-':[800,1900,6],'V+':[1000,1650,7],
               'V-':[1000,1950,8],'OUT':[1200,1800,13]},
        'I2':{'+':[1700,1400,12],'-':[1700,1200,3]},'I3':{'GND':[1700,1150,3]},
        'I4':{'1':[1100,2400,10],'2':[1250,2400,13]},
        'I5':{'1':[750,2400,6],'2':[950,2400,10]},
        'I6':{'+':[1350,1400,11],'-':[1350,1200,1]},
        'I8':{'1':[250,1900,9],'2':[450,1900,6]},'I9':{'GND':[600,1500,4]}},
       'viewBox':'-400 -2700 2550 1800',
       'geometryBoundary':'LM139 R6 is vertical reflection [1,0,0,-1], proved against all five CSS contacts and CSA LASTPIN; its V+ lies below and V- above. R3 R1 is counterclockwise rotation. Named VCC/VEE components and four local zero components remain geometrically distinct; explicit archived Verilog proves their electrical equivalence.'}
    specs=[('source','0','I1',[1300,1100],identity),('source','vsrc','I10',[0,1700],identity),
        ('source','0','I11',[0,1450],identity),('analog','r','I12',[950,2250],identity),
        ('analog','r','I13',[550,1550],vertical),('opamp','lm139','I14',[850,1650],[1,0,0,-1]),
        ('source','vsrc','I2',[1650,1350],identity),('source','0','I3',[1650,1100],identity),
        ('analog','c','I4',[1150,2450],identity),('analog','r','I5',[800,2450],identity),
        ('source','vsrc','I6',[1300,1350],identity),('analog','r','I8',[300,1950],identity),
        ('source','0','I9',[550,1450],identity)]
    for lib,part,instance,origin,matrix in specs:
        c['symbols'].append({**source(root/'archive_libs'/lib/part/'sym_1/symbol.css'),
                             'part':part,'instance':instance,'origin':origin,'matrix':matrix})
    c['supplemental']=[source(root/'cds.lib'),source(root/'worklib/device_fb/sch_1/verilog.v')]
    for lib,part in dict.fromkeys((s[0],s[1]) for s in specs):
        c['supplemental'].append(source(root/'archive_libs'/lib/part/'entity/verilog.v'))
    for part in ['r','c']:
        for rel in ['awb_model/device.prp','chips/chips.prt']:
            c['supplemental'].append(source(root/'archive_libs/analog'/part/rel))
    c['supplemental'].append(source(root/'archive_libs/opamp/lm139/chips/chips.prt'))
    c['supplemental'].append(source(Path('E:/Cadence/SPB_25.1/tools/pspice/Library/opamp.lib'),encoding='latin1',lines=range(4539,4567)))
    c['namedNetEquivalence']={'0':{'csvLocalNets':[1,2,3,4]},'VCC':{'csvLocalNets':[7,11]},'VEE':{'csvLocalNets':[8,12]},'evidence':'CSV repeated names and archived device_fb Verilog explicitly map all page1 terminals to vcc, vee and glbl.\\0.'}
    c['modelBoundary']='Original LM139 CSS/template, chips.prt and entity read. Template +,-,V+,V-,OUT matches the complete current LM139 subcircuit; Verilog declaration order and physical package numbers are not SPICE order. Current model has open collector output; the page contains no VCC pull-up, so do not add one during drawing restoration. Archived model.sp/device.prp and generated SPICE netlist are absent for LM139; no proof of historic co-simulation binding, simulation or product pass.'
    out.mkdir(parents=True,exist_ok=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS017.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:1000px}</style><p>CSA/CSS source-coordinate reconstruction; no native screenshot or product acceptance.</p><section><h2>PS017 motor control feedback page</h2><img src="PS017.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':'PS017','CSA_lines':len(c['originalLines']),'CSV_lines':len(c['connectivity']['lines']),'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P015':
    assert sys.argv[3:]==['PS016'] and (not out.exists() or not any(out.iterdir())), 'Resume existing PS016 evidence; never reset.'
    p=lookup['PS016']; original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    identity=[1,0,0,1];vertical=[0,-1,1,0]
    c={'id':'PS016','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[],
       'verifiedPins':{
        'I1':{'+':[-150,2300,18],'-':[-150,2100,10]},
        'I2':{'+':[-150,1600,6],'-':[-150,1400,11]},
        'I3':{'+':[2900,2300,8],'-':[2900,2100,16]},
        'I4':{'1':[600,2450,18],'2':[600,2150,1],'3':[800,2450,9],'4':[800,2150,3]},
        'I5':{'b':[100,1750,6],'c':[250,1850,1],'e':[250,1650,12]},
        'I6':{'1':[450,1900,7],'2':[450,2050,1]},
        'I7':{'1':[450,1450,13],'2':[450,1650,7]},
        'I8':{'1':[700,1650,7],'2':[700,1500,14]},
        'I9':{'1':[900,2450,9],'2':[1050,2450,4]},
        'I10':{'1':[1150,2200,3],'2':[1150,2350,4]},
        'I11':{'1':[1400,2300,19],'2':[1400,2450,4]},
        'I12':{'1':[1400,2100,3],'2':[1400,2300,19]},
        'I13':{'1':[1400,1650,2],'2':[1400,1850,3]},
        'I14':{'1':[2400,1950,15],'2':[2400,2150,20]},
        'I15':{'1':[1600,2450,4],'2':[1900,2450,5]},
        'I16':{'1':[1950,2200,3],'2':[1950,2350,5]},
        'I17':{'1':[2600,2350,8],'2':[2600,2250,17],'3':[2400,2150,20],
               '4':[2200,2350,5],'5':[2200,2250,3]},
        'I18':{'GND':[-150,2000,10]},'I19':{'GND':[-150,1200,11]},
        'I20':{'GND':[250,1250,12]},'I21':{'GND':[450,1250,13]},
        'I22':{'GND':[700,1300,14]},'I23':{'GND':[1400,1600,2]},
        'I24':{'GND':[2400,1850,15]},'I25':{'GND':[2900,1950,16]},
        'I26':{'GND':[2700,1950,17]}},
       'viewBox':'-750 -2875 4150 1900',
       'geometryBoundary':'All PS016 matrices derived from this archive CSS, CSA LASTPIN and CSV identity. ZX R2 is horizontal reflection [-1,0,0,1], not 180-degree rotation. D3 R3 uses [0,-1,-1,0]. Nine local ground components are geometrically separate and explicitly global in archived Verilog.'}
    specs=[('source','vsrc','I1',[-200,2250],identity),
        ('source','vsrc','I2',[-200,1550],identity),('source','vsrc','I3',[2850,2250],identity),
        ('analog','xfrm_linear','I4',[650,2450],identity),
        ('pwrbjt','2n6547#2fto','I5',[150,1800],identity),
        ('analog','c','I6',[400,1950],vertical),('analog','r','I7',[400,1500],vertical),
        ('diode','d1n4933','I8',[650,1600],[0,-1,-1,0]),
        ('diode','d1n4933','I9',[950,2500],identity),
        ('diode','d1n4933','I10',[1100,2250],vertical),
        ('analog','c','I11',[1350,2350],vertical),('analog','r','I12',[1350,2150],vertical),
        ('analog','r','I13',[1350,1700],vertical),('analog','r','I14',[2350,2000],vertical),
        ('analog','l','I15',[1650,2500],identity),('analog','c','I16',[1900,2250],vertical),
        ('anl_misc','zx','I17',[2550,2400],[-1,0,0,1])]
    for instance,origin in [('I18',[-200,1950]),('I19',[-200,1150]),('I20',[200,1200]),
        ('I21',[400,1200]),('I22',[650,1250]),('I23',[1350,1550]),
        ('I24',[2350,1800]),('I25',[2850,1900]),('I26',[2650,1900])]:
        specs.append(('source','0',instance,origin,identity))
    for lib,part,instance,origin,matrix in specs:
        c['symbols'].append({**source(root/'archive_libs'/lib/part/'sym_1/symbol.css'),
                             'part':part,'instance':instance,'origin':origin,'matrix':matrix})
    c['supplemental']=[source(root/path) for path in ['cds.lib',
        'worklib/for_conv/sch_1/verilog.v','worklib/glbl/for_conv_cfg_analog/verilog.v']]
    for lib,part in dict.fromkeys((s[0],s[1]) for s in specs):
        c['supplemental'].append(source(root/'archive_libs'/lib/part/'entity/verilog.v'))
    for part in ['r','c','l']:
        c['supplemental'].append(source(root/'archive_libs/analog'/part/'awb_model/device.prp'))
    for part in ['diode/d1n4933','pwrbjt/2n6547#2fto']:
        c['supplemental'].append(source(root/'archive_libs'/part/'chips/chips.prt'))
    for library,lines in [('anl_misc.lib',range(40,51)),('diode.lib',range(4035,4037)),('pwrbjt.lib',range(7549,7574))]:
        c['supplemental'].append(source(Path('E:/Cadence/SPB_25.1/tools/pspice/Library')/library,encoding='latin1',lines=lines))
    c['namedNetEquivalence']={'0':{'csvLocalNets':[2,10,11,12,13,14,15,16,17],
        'evidence':'CSV declares nine 0\\g components; archived for_conv Verilog L27-40 and L44-102 explicitly map their terminals to glbl.\\0.'}}
    c['modelBoundary']='Original ZX, Q2N6547 and D1N4933 templates and complete necessary current library declarations read. Archived diode and transistor chips.prt are present and preserved; their package numbers do not define SPICE port order. Archived model.sp/device.prp for these three modeled parts, ZX chips.prt and generated SPICE netlist are absent; current library is not proof of historical co-simulation binding. XFRM_LINEAR expands K plus two inductors, not a wire. No simulation or product pass.'
    out.mkdir(parents=True,exist_ok=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS016.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:1000px}</style><p>CSA/CSS source-coordinate reconstruction; no native screenshot or product acceptance.</p><section><h2>PS016 forward converter with variable load</h2><img src="PS016.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':'PS016','CSA_lines':len(c['originalLines']),'CSV_lines':len(c['connectivity']['lines']),'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P014':
    assert sys.argv[3:]==['PS015'] and (not out.exists() or not any(out.iterdir())), 'Resume existing PS015 evidence; never reset.'
    p=lookup['PS015']; original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    identity=[1,0,0,1];vertical=[0,-1,1,0]
    c={'id':'PS015','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[],
       'verifiedPins':{
        'I1':{'A':[1450,2300,6]},'I2':{'A':[1450,1500,5]},
        'I10':{'+':[600,1850,9],'-':[600,1650,1]},
        'I3':{'1':[800,2050,7],'2':[800,1950,2],'3':[1000,1850,8],
              '4':[1200,2050,6],'5':[1200,1950,4]},
        'I4':{'1':[1300,1650,5],'2':[1300,1850,4]},
        'I5':{'1':[1000,1600,3],'2':[1000,1800,8]},
        'I6':{'GND':[1000,1450,3]},'I7':{'GND':[800,1450,2]},'I8':{'GND':[600,1450,1]},
        'I9':{'+':[600,2050,7],'-':[600,1850,9]}},
       'viewBox':'-50 -2525 1950 1450',
       'geometryBoundary':'PS015 matrices verified from archived CSS contacts, CSA LASTPIN and CSV identities. R1 resistors rotate counterclockwise; other instances retain identity. Three local ground components remain geometrically separate, with global zero equivalence proved by archived Verilog and generated netlist.'}
    for lib,part,instance,origin,matrix in [
        ('standard','ioport','I1',[1500,2300],identity),('standard','ioport','I2',[1500,1500],identity),
        ('source','vdc','I10',[550,1850],identity),('anl_misc','zx','I3',[850,2100],identity),
        ('analog','r','I4',[1250,1700],vertical),('analog','r','I5',[950,1650],vertical),
        ('source','0','I6',[950,1400],identity),('source','0','I7',[750,1400],identity),
        ('source','0','I8',[550,1400],identity),('source','vsrc','I9',[550,2000],identity)]:
        c['symbols'].append({**source(root/'archive_libs'/lib/part/'sym_1/symbol.css'),
                             'part':part,'instance':instance,'origin':origin,'matrix':matrix})
    c['supplemental']=[source(root/path) for path in [
        'cds.lib','worklib/r_val/entity/verilog.v','worklib/r_val/sch_1/verilog.v',
        'worklib/bjt_amp/psp_sim_1/bjt_amp.net','archive_libs/anl_misc/zx/entity/verilog.v',
        'archive_libs/analog/r/entity/verilog.v','archive_libs/source/vdc/entity/verilog.v',
        'archive_libs/source/vsrc/entity/verilog.v','archive_libs/source/0/entity/verilog.v']]
    c['supplemental'].append(source('E:/Cadence/SPB_25.1/tools/pspice/Library/anl_misc.lib',lines=range(40,51)))
    c['namedNetEquivalence']={'0':{'csvLocalNets':[1,2,3],
        'evidence':'Archived r_val Verilog maps all ground symbols to global zero; original generated r_val netlist uses SPICE 0.'}}
    c['modelBoundary']='ZX explicit template orders ports 1..5. Current complete necessary ZX declaration retained; missing archived awb_model/device.prp, awb_model/model.sp and chips/chips.prt prevent confirmation of historical library binding. Original 1-ohm reference, 1P series offset, DC100K AC1Vac control and 1N offset source retained. No simulation.'
    out.mkdir(parents=True,exist_ok=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS015.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:1100px}</style><p>CSA/CSS source-coordinate reconstruction; no native screenshot or product acceptance.</p><section><h2>PS015 hierarchical variable impedance implementation</h2><img src="PS015.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':'PS015','CSA_lines':len(c['originalLines']),'CSV_lines':len(c['connectivity']['lines']),'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P013':
    assert sys.argv[3:]==['PS014'] and not out.exists(), 'Resume existing PS014 evidence; never reset.'
    p=lookup['PS014']
    original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    identity=[1,0,0,1];vertical=[0,-1,1,0]
    c={'id':'PS014','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[],
       'verifiedPins':{
        'I1':{'b':[1300,1700,10],'c':[1400,1800,9],'e':[1400,1600,8]},
        'I10':{'1':[600,1700,6],'2':[750,1700,10]},
        'I11':{'1':[1600,1900,9],'2':[1750,1900,7]},
        'I12':{'1':[2050,1450,5],'2':[2050,1650,7]},
        'I13':{'GND':[2050,1100,5]},
        'I14':{'+':[300,1650,6],'-':[300,1450,1]},
        'I16':{'GND':[500,2050,4]},
        'I17':{'P1':[900,1650,10],'P2':[900,1300,2]},
        'I2':{'1':[1400,2000,9],'2':[1400,2200,11]},
        'I3':{'1':[1400,1300,3],'2':[1400,1500,8]},
        'I4':{'1':[900,1900,10],'2':[900,2100,11]},
        'I5':{'+':[500,2450,11],'-':[500,2250,4]},
        'I7':{'GND':[1400,1100,3]},'I8':{'GND':[900,1050,2]},
        'I9':{'GND':[300,1000,1]}},
       'viewBox':'-350 -2800 2800 2050',
       'geometryBoundary':'PS014 matrices verified from CSS contacts, CSA LASTPIN and CSV identities. R1 resistors rotate counterclockwise, Q and two capacitors retain identity geometry. Five local ground components remain separate in geometry; preserved Verilog and SPICE netlist explicitly bind them to zero.'}
    for lib,part,instance,origin,matrix in [
        ('jbipolar','q2sc1815','I1',[1350,1750],identity),
        ('analog','c','I10',[650,1750],identity),('analog','c','I11',[1650,1950],identity),
        ('analog','r','I12',[2000,1500],vertical),('source','0','I13',[2000,1050],identity),
        ('source','vsrc','I14',[250,1600],identity),('source','0','I16',[450,2000],identity),
        ('analog','r','I2',[1350,2050],vertical),('analog','r','I3',[1350,1350],vertical),
        ('analog','r','I4',[850,1950],vertical),('source','vdc','I5',[450,2450],identity),
        ('source','0','I7',[1350,1050],identity),('source','0','I8',[850,1000],identity),
        ('source','0','I9',[250,950],identity)]:
        c['symbols'].append({**source(root/'archive_libs'/lib/part/'sym_1/symbol.css'),
                            'part':part,'instance':instance,'origin':origin,'matrix':matrix})
    c['symbols'].append({**source(root/'worklib/r_val/sym_1/symbol.css'),
                         'part':'r_val','instance':'I17','origin':[900,1400],'matrix':identity})
    c['supplemental']=[source(root/path) for path in [
        'cds.lib','worklib/bjt_amp/sch_1/verilog.v','worklib/r_val/entity/verilog.v',
        'worklib/r_val/sch_1/verilog.v','worklib/bjt_amp/cfg_analog/expand.cfg',
        'worklib/bjt_amp/psp_sim_1/bjt_amp.net','worklib/bjt_amp/psp_sim_1/profiles/tran/tran.cir',
        'worklib/bjt_amp/psp_sim_1/profiles/tran_slps_/tran_slps_.cir']]
    for lib,part in [('jbipolar','q2sc1815'),('analog','r'),('analog','c'),
                     ('source','vsrc'),('source','vdc'),('source','0'),('anl_misc','zx')]:
        c['supplemental'].append(source(root/'archive_libs'/lib/part/'entity/verilog.v'))
    c['supplemental'] += [source(root/'archive_libs/anl_misc/zx/sym_1/symbol.css'),
        source('E:/Cadence/SPB_25.1/tools/pspice/Library/jbipolar.lib',lines=range(1068,1073)),
        source('E:/Cadence/SPB_25.1/tools/pspice/Library/anl_misc.lib',lines=range(40,51))]
    c['namedNetEquivalence']={'0':{'csvLocalNets':[1,2,3,4,5],
        'evidence':'Original bjt_amp Verilog binds all five ground symbols to global zero; archived bjt_amp.net explicitly uses SPICE 0.'}}
    c['modelBoundary']='Q PSPICETEMPLATE explicitly orders c,b,e, while Verilog entity declares b,c,e. R_VAL is a two-port hierarchical variable impedance, not a plain resistor: archived netlist retains ZX five-port model, 1-ohm reference, 1P offset resistor, DC100K control and 1N offset source. Necessary current Q2SC1815 and ZX declarations read; historical nom.lib binding and co-simulation behavior remain unverified.'
    c['generatedNetlist']=str(root/'worklib/bjt_amp/psp_sim_1/bjt_amp.net').replace('\\','/')
    out.mkdir(parents=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS014.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:1100px}</style><p>CSA/CSS source-coordinate reconstruction; no native screenshot or product acceptance.</p><section><h2>PS014 BJT amplifier with hierarchical variable impedance</h2><img src="PS014.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':'PS014','CSA_lines':len(c['originalLines']),'CSV_lines':len(c['connectivity']['lines']),'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P012':
    assert sys.argv[3:]==['PS013'] and not out.exists(), 'Resume existing PS013 evidence; never reset.'
    p=lookup['PS013']
    original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    identity=[1,0,0,1];vertical=[0,-1,1,0];flip_y=[1,0,0,-1]
    mirror_x=[-1,0,0,1];clockwise=[0,1,-1,0]
    c={'id':'PS013','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[],
       'unconnectedCsvNet':0,
       'verifiedPins':{
        'I11':{'1':[-200,1150,12],'2':[0,1150,13]},
        'I12':{'1':[200,850,16],'2':[200,1000,13]},
        'I14':{'1':[1450,-450,8],'2':[1450,-250,11]},
        'I15':{'1':[1850,-400,8],'2':[1850,-250,11]},
        'I16':{'1':[950,-750,17],'2':[950,-550,7],'t':[1050,-650,8]},
        'I17':{'1':[2700,50,11],'2':[2850,50,12]},
        'I18':{'1':[550,-600,7],'2':[550,-750,17]},
        'I19':{'1':[1450,-950,17],'2':[1450,-800,8]},
        'I2':{'+':[1150,950,15],'-':[1150,1150,10],'V+':[1350,900,3],
              'V-':[1350,1200,2],'OUT':[1550,1050,12],'OS1':[1550,1150,0],'OS2':[1550,950,0]},
        'I20':{'1':[100,-450,6],'2':[300,-450,7]},
        'I22':{'+':[-800,-750,4],'-':[-800,-950,17]},
        'I23':{'+':[-1300,-750,5],'-':[-1300,-950,17]},
        'I24':{'+':[2200,1900,11]},'I25':{'+':[2300,-300,8]},'I26':{'+':[200,1500,13]},
        'I29':{'GND':[1950,1575,14]},'I30':{'GND':[1000,825,15]},
        'I31':{'GND':[200,725,16]},'I32':{'GND':[950,-1225,17]},
        'I4':{'d':[1950,1850,1],'s':[1950,1650,14],'g':[2100,1750,11]},
        'I6':{'1':[400,1150,13],'2':[600,1150,10]},
        'I7':{'1':[2500,2200,9],'2':[2650,2200,12]},
        'I8':{'1':[950,2200,10],'2':[1100,2200,9]},
        'I9':{'1':[1650,2000,9],'2':[1850,2000,1]}},
       'decorativePins':{'I33':{'A':[3450,1050]}},
       'viewBox':'-1650 -2500 5400 4050',
       'geometryBoundary':'Matrices verified from original CSS anchors, CSA LASTPIN and CSV: UA741 R6 flips y, TIS74 R2 mirrors x, D1N753 R5 rotates clockwise. NC zero is not a shared electrical net. Undotted crossings remain distinct.'}
    for lib,part,instance,origin,matrix in [
        ('analog','r','I11',[-150,1200],identity),('analog','c','I12',[150,900],vertical),
        ('analog','r','I14',[1400,-400],vertical),('analog','c','I15',[1800,-350],vertical),
        ('breakout','pot','I16',[900,-700],vertical),('diode','d1n914','I17',[2750,100],identity),
        ('diode','d1n753','I18',[600,-650],clockwise),('analog','c','I19',[1400,-900],vertical),
        ('opamp','ua741','I2',[1200,900],flip_y),('analog','r','I20',[150,-400],identity),
        ('source','vsrc','I22',[-850,-800],identity),('source','vsrc','I23',[-1350,-800],identity),
        ('special','ic1','I24',[2150,2000],identity),('special','ic1','I25',[2250,-200],identity),
        ('special','ic1','I26',[150,1600],identity),('source','0','I29',[1900,1550],identity),
        ('source','0','I30',[950,800],identity),('source','0','I31',[150,700],identity),
        ('source','0','I32',[900,-1250],identity),('jfet','tis74','I4',[2050,1850],mirror_x),
        ('analog','r','I6',[450,1200],identity),('analog','c','I7',[2550,2250],identity),
        ('analog','c','I8',[1000,2250],identity),('analog','r','I9',[1700,2050],identity)]:
        c['symbols'].append({**source(root/'archive_libs'/lib/part/'sym_1/symbol.css'),
                            'part':part,'instance':instance,'origin':origin,'matrix':matrix})
    c['symbols'].append({**source('E:/Cadence/SPB_25.1/share/library/standard/offpage/sym_2/symbol.css'),
                         'part':'offpage','instance':'I33','origin':[3500,1050],'matrix':identity})
    c['supplemental']=[source(root/path) for path in [
        'cds.lib','worklib/stabosc9/sch_1/verilog.v','worklib/stabosc9/cfg_analog/expand.cfg',
        'worklib/stabosc9/psp_sim_1/profiles/TRAN/TRAN.cir',
        'worklib/stabosc9/psp_sim_1/stabosc9.map','worklib/stabosc9/psp_sim_1/stabosc9.smap',
        'worklib/stabosc9/psp_sim_1/stabosc9.ver']]
    for lib,part in [('opamp','ua741'),('jfet','tis74'),('diode','d1n753'),('diode','d1n914'),
                     ('breakout','pot'),('special','ic1'),('analog','r'),('analog','c'),('source','vsrc'),('source','0')]:
        c['supplemental'].append(source(root/'archive_libs'/lib/part/'entity/verilog.v'))
    library=Path('E:/Cadence/SPB_25.1/tools/pspice/Library')
    c['supplemental'] += [source(library/'diode.lib',lines=[21499,21500,25907,25908,25909]),
                         source(library/'jfet.lib',lines=range(2598,2602)),
                         source(library/'opamp.lib',encoding='latin1',lines=range(4161,4203))]
    c['namedNetEquivalence']={'VP12':{'csvLocalNets':[3,5]},'VN12':{'csvLocalNets':[2,4,6]},
                             '0':{'csvLocalNets':[14,15,16,17]},
                             'evidence':'Preserved generated Verilog binds the separate local source, power and ground groups explicitly.'}
    c['modelBoundary']='UA741 has seven visible pins but PSPICETEMPLATE orders only +,-,V+,V-,OUT; OS1/OS2 are unmodeled NC. POT instance overrides CSS with two RT/RB resistors and +.001. IC1 emits .IC, not a subcircuit. Complete necessary current-library declarations are preserved; historical nom.lib binding is unverified.'
    c['missingGeneratedNetlist']=str(root/'worklib/stabosc9/psp_sim_1/stabosc9.net').replace('\\','/')
    assert not Path(c['missingGeneratedNetlist']).exists()
    out.mkdir(parents=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS013.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:1100px}</style><p>CSA/CSS source-coordinate reconstruction; no native screenshot or product acceptance.</p><section><h2>PS013 STABOSC9 oscillator and amplitude control</h2><img src="PS013.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':'PS013','CSA_lines':len(c['originalLines']),'CSV_lines':len(c['connectivity']['lines']),'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P011':
    assert sys.argv[3:]==['PS012'] and not out.exists(), 'Resume existing PS012 evidence; never reset.'
    p=lookup['PS012']
    original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    identity=[1,0,0,1]
    vertical=[0,-1,1,0]
    flip_y=[1,0,0,-1]
    c={'id':'PS012','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[],
       'verifiedPins':{
        'I1':{'+':[1250,1600,8],'-':[1250,1800,4],'V+':[1450,1550,6],
              'V-':[1450,1850,1],'OUT':[1650,1700,5]},
        'I11':{},'I12':{'GND':[1150,275,8]},
        'I2':{'1':[1250,2450,4],'2':[1450,2450,5]},
        'I3':{'1':[550,1800,3],'2':[700,1800,4]},
        'I4':{'1':[250,1300,8],'2':[250,1500,3]},
        'I5':{'1':[-250,1800,2],'2':[-50,1800,3]},
        'I6':{'1':[1250,2950,3],'2':[1400,2950,5]},
        'I7':{'+':[1450,1200,6],'-':[1450,1000,8]},
        'I8':{'+':[2050,1200,7],'-':[2050,1000,8]}},
       'viewBox':'-1050 -3400 4500 3600',
       'geometryBoundary':'PS012 R6 is a vertical mirror derived from original CSS anchors plus CSA/CSV connectivity: positive input is (1250,1600), negative input is (1250,1800). VN15 local components 1 and 7 remain geometrically separate; the generated Verilog explicitly binds both to vn15.'}
    for lib,part,instance,origin,matrix in [
        ('lin_tech','lt1013#2flt','I1',[1300,1550],flip_y),
        ('analog','r','I2',[1300,2500],identity),
        ('analog','c','I3',[600,1850],identity),
        ('analog','r','I4',[200,1350],vertical),
        ('analog','r','I5',[-200,1850],identity),
        ('analog','c','I6',[1300,3000],identity),
        ('source','vdc','I7',[1400,1200],identity),
        ('source','vdc','I8',[2000,1200],identity),
        ('source','0','I12',[1100,250],identity)]:
        c['symbols'].append({**source(root/'archive_libs'/lib/part/'sym_1/symbol.css'),
                            'part':part,'instance':instance,'origin':origin,'matrix':matrix})
    c['symbols'].append({**source('E:/Cadence/SPB_25.1/share/library/standard/vhdl_decs/sym_1/symbol.css'),
                         'part':'vhdl_decs','instance':'I11','origin':[2900,400],'matrix':identity})
    c['supplemental']=[source(root/path) for path in [
        'cds.lib','worklib/onestage/sch_1/verilog.v','worklib/onestage/entity/verilog.v',
        'archive_libs/lin_tech/lt1013#2flt/entity/verilog.v',
        'archive_libs/analog/r/entity/verilog.v','archive_libs/analog/c/entity/verilog.v',
        'archive_libs/source/vdc/entity/verilog.v','worklib/onestage/cfg_analog/expand.cfg',
        'worklib/onestage/psp_sim_1/onestage.map','worklib/onestage/psp_sim_1/onestage.dmap',
        'worklib/histo/sch_1/verilog.v','worklib/histo/psp_sim_1/profiles/AC/AC.cir']]
    # Alias and complete required dependency; no historical library binding claim.
    c['supplemental'].append(source('E:/Cadence/SPB_25.1/tools/pspice/Library/lin_tech.lib',
                                  lines=[3042,3043,3044,*range(10088,10129)]))
    c['namedNetEquivalence']={'VN15':{'csvLocalNets':[1,7],
        'evidence':'worklib/onestage/sch_1/verilog.v: page1_i1 V- and page1_i8 + both bind vn15'}}
    c['modelBoundary']='PSPICETEMPLATE explicitly orders +,-,V+,V-,OUT. Current installed LT1013/LT alias passes 1..5 to LT1413/LT; its complete local model is retained. Historical generated histo.net is missing, so current library lookup is not proof of the original simulation binding.'
    c['missingGeneratedNetlist']=str(root/'worklib/histo/psp_sim_1/histo.net').replace('\\','/')
    assert not Path(c['missingGeneratedNetlist']).exists()
    out.mkdir(parents=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS012.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:1000px}</style><p>CSA/CSS source-coordinate reconstruction; no native screenshot or product acceptance.</p><section><h2>PS012 ONESTAGE internal circuit</h2><img src="PS012.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':'PS012','CSA_lines':len(c['originalLines']),'CSV_lines':len(c['connectivity']['lines']),'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P010':
    assert sys.argv[3:]==['PS011'] and not out.exists(), 'Resume existing PS011 evidence; never reset.'
    p=lookup['PS011']
    original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    identity=[1,0,0,1]
    c={'id':'PS011','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[],
       'verifiedPins':{
        'I5':{'IN':[-100,1500,2],'OUT':[950,1500,3]},
        'I6':{'IN':[1750,1500,3],'OUT':[2800,1500,1]},
        'I8':{'+':[-550,1250,2],'-':[-550,1050,4]},
        'I9':{'GND':[-550,775,4]}},
       'decorativePins':{'I10':{'A':[3400,1500]}},
       'viewBox':'-1050 -1900 4900 1450',
       'geometryBoundary':'Identity transforms verified from CSS/CSA/CSV. OFFPAGE I10 has an anchor but is absent from the electrical CSV; preserve its OUT label without inventing an electrical instance.'}
    instances=[
        (root/'worklib/onestage/sym_1/symbol.css','onestage','I5',[450,1450]),
        (root/'worklib/onestage/sym_1/symbol.css','onestage','I6',[2300,1450]),
        (root/'archive_libs/source/vsrc/sym_1/symbol.css','vsrc','I8',[-600,1200]),
        (root/'archive_libs/source/0/sym_1/symbol.css','0','I9',[-600,750]),
        (Path('E:/Cadence/SPB_25.1/share/library/standard/offpage/sym_2/symbol.css'),'offpage','I10',[3450,1500])]
    for path,part,instance,origin in instances:
        c['symbols'].append({**source(path),'part':part,'instance':instance,'origin':origin,'matrix':identity})
    c['supplemental']=[source(root/path) for path in [
        'cds.lib','worklib/histo/sch_1/verilog.v','worklib/onestage/entity/verilog.v',
        'worklib/histo/cfg_analog/expand.cfg','worklib/onestage/cfg_analog/expand.cfg',
        'worklib/histo/psp_sim_1/profiles/AC/AC.cir']]
    c['modelBoundary']='Parent page preserves distinct X1/X2 RIN/RFEEDBACK overrides; child PS012 is separately pending. AC profile includes histo.net, which is unavailable; no simulation or historical binding is claimed.'
    c['missingGeneratedNetlist']=str(root/'worklib/histo/psp_sim_1/histo.net').replace('\\','/')
    assert not Path(c['missingGeneratedNetlist']).exists()
    out.mkdir(parents=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS011.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:850px}</style><p>CSA/CSS source-coordinate reconstruction; no native screenshot or product acceptance.</p><section><h2>PS011 two-stage amplifier</h2><img src="PS011.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':'PS011','CSA_lines':len(c['originalLines']),'CSV_lines':len(c['connectivity']['lines']),'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P009':
    assert sys.argv[3:]==['PS010'] and not out.exists(), 'Resume existing PS010 evidence; never reset.'
    p=lookup['PS010']
    original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    identity=[1,0,0,1]
    mirror=[-1,0,0,1]
    vertical=[0,-1,1,0]
    c={'id':'PS010','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[],
       'verifiedPins':{
        'I1':{'b':[750,1050,1],'c':[850,1150,7],'e':[850,950,2]},
        'I2':{'b':[-200,1050,1],'c':[-300,1150,1],'e':[-300,950,2]},
        'I3':{'b':[750,1900,6],'c':[850,2000,9],'e':[850,1800,7]},
        'I4':{'b':[1850,1900,8],'c':[1750,2000,10],'e':[1750,1800,7]},
        'I7':{'1':[-300,2350,1],'2':[-300,2550,11]},
        'I8':{'1':[400,1900,4],'2':[600,1900,6]},
        'I9':{'1':[2050,1900,8],'2':[2250,1900,14]},
        'I10':{'1':[1200,2250,9],'2':[1350,2250,10]},
        'I11':{'+':[300,1750,4],'-':[300,1550,13]},
        'I14':{'+':[1900,850,5],'-':[1900,650,12]},
        'I15':{'+':[2350,850,3],'-':[2350,650,12]},
        'I19':{'GND':[2100,425,12]},
        'I20':{'1':[850,2350,9],'2':[850,2550,11]},
        'I21':{'1':[1750,2350,10],'2':[1750,2550,11]},
        'I22':{'GND':[300,1375,13]},
        'I23':{'GND':[2550,1375,14]}},
       'viewBox':'-850 -3150 3750 2900',
       'geometryBoundary':'PS010 instance transforms checked from original CSS, CSA LASTPIN and CSV identities. R2 transistor instances are horizontal mirrors in this archive, not an assumed LTspice rotation. CSV same-name VP12, VN12 and ground components stay separate; Verilog provides named equivalence.'}
    for lib,part,instance,origin,matrix in [
        ('bipolar','q2n2222','I1',[800,1100],identity),
        ('bipolar','q2n2222','I2',[-250,1100],mirror),
        ('bipolar','q2n2222','I3',[800,1950],identity),
        ('bipolar','q2n2222','I4',[1800,1950],mirror),
        ('analog','r','I7',[-350,2400],vertical),
        ('analog','r','I8',[450,1950],identity),
        ('analog','r','I9',[2100,1950],identity),
        ('analog','c','I10',[1250,2300],identity),
        ('source','vsin','I11',[250,1700],identity),
        ('source','vdc','I14',[1850,850],identity),
        ('source','vdc','I15',[2300,850],identity),
        ('source','0','I19',[2050,400],identity),
        ('analog','r','I20',[800,2400],vertical),
        ('analog','r','I21',[1700,2400],vertical),
        ('source','0','I22',[250,1350],identity),
        ('source','0','I23',[2500,1350],identity)]:
        c['symbols'].append({**source(root/'archive_libs'/lib/part/'sym_1/symbol.css'),
                             'part':part,'instance':instance,'origin':origin,'matrix':matrix})
    paths=['cds.lib','worklib/example/sch_1/verilog.v',
           'worklib/example/psp_sim_1/profiles/AC-Sweep/AC-Sweep.cir',
           'worklib/example/psp_sim_1/profiles/TRAN/TRAN.cir',
           'archive_libs/bipolar/q2n2222/chips/chips.prt',
           'archive_libs/bipolar/q2n2222/entity/verilog.v',
           'archive_libs/bipolar/q2n2222/entity/vhdl.vhd',
           'archive_libs/analog/c/chips/chips.prt','archive_libs/analog/r/chips/chips.prt',
           'archive_libs/analog/r/awb_model/device.prp']
    c['supplemental']=[source(root/path) for path in paths]
    c['supplemental'] += [source('E:/Cadence/SPB_25.1/tools/pspice/library/nom.lib','cp1252',lines=[37]),
                          source('E:/Cadence/SPB_25.1/tools/pspice/library/bipolar.lib','cp1252',lines=list(range(291,295)))]
    c['modelBoundary']='Archive has no q2n2222 model.sp; installed nom.lib L37 and complete bipolar.lib Q2N2222 declaration L291-294 read as current accessible evidence. Historical referenced simulation paths differ; missing generated netlist prevents confirmation of exact historical model binding.'
    c['missingGeneratedNetlist']=str(root/'worklib/example/psp_sim_1/example.net').replace('\\','/')
    assert not Path(c['missingGeneratedNetlist']).exists()
    out.mkdir(parents=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS010.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:1080px}</style><p>CSA/CSS source-coordinate reconstruction; no native screenshot or product acceptance.</p><section><h2>PS010 differential amplifier</h2><img src="PS010.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':'PS010','CSA_lines':len(c['originalLines']),'CSV_lines':len(c['connectivity']['lines']),
                      'CSS_instances':len(c['symbols']),'supplemental_files':len(c['supplemental']),
                      'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P008':
    assert sys.argv[3:]==['PS009'] and not out.exists(), 'Resume existing PS009 evidence; never reset.'
    p=lookup['PS009']
    original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    identity=[1,0,0,1]
    vertical=[0,-1,1,0]
    reverse=[-1,0,0,-1]
    downward=[0,1,-1,0]
    c={'id':'PS009','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[],
       'verifiedPins':{
        'I1':{'C':[1600,1550,6],'B':[1500,1450,7],'E':[1600,1350,14]},
        'I2':{'C':[700,1950,8],'B':[600,2050,9],'E':[700,2150,4]},
        'I3':{'A':[1250,1500,7],'B':[1250,1700,13]},
        'I5':{'A':[1600,2000,6],'B':[1600,2200,4]},
        'I6':{'A':[1600,2350,4],'B':[1600,2550,3]},
        'I7':{'A':[300,2100,9],'B':[300,2300,11]},
        'I8':{'A':[1600,1000,1],'B':[1600,1200,14]},
        'I9':{'A':[300,1000,1],'B':[300,1200,9]},
        'I10':{'A':[2150,1150,1],'B':[2150,1350,5]},
        'I11':{'A':[-150,1450,12],'B':[-350,1450,10]},
        'I12':{'A':[150,1450,7],'B':[-50,1450,12]},
        'I13':{'A':[1300,1800,13],'B':[1500,1800,6]},
        'I14':{'A':[2000,2050,2],'B':[2000,2250,4]},
        'I15':{'A':[700,1200,8],'B':[700,1000,1]},
        'I16':{'AN':[300,2700,3],'CAT':[300,2500,11]},
        'I17':{'VOUT':[900,3100,3]},
        'I18':{'A':[1950,1700,5],'B':[1750,1700,6]},
        'I19':{'G':[2000,1950,2]},
        'I20':{'G':[2150,750,1]},
        'I21':{'A':[950,1500,7],'B':[950,1700,8]},
        'I22':{'PVS':[-500,1200,10],'NVS':[-500,1000,1]}},
       'viewBox':'-1100 -3300 3650 2800',
       'geometryBoundary':'Per-instance transforms verified from original CSS contact identities, CSA LASTPIN/wire anchors and CSV terminals. CSV ground nets 1/2 remain geometrically separate; original Verilog establishes global ground equivalence.'}
    for lib,part,instance,origin,matrix in [
        ('bjn','2n5179','I1',[1550,1450],identity),
        ('bjp','2n3905','I2',[650,2050],identity),
        ('pspice_elem','resistor','I3',[1250,1600],vertical),
        ('pspice_elem','resistor','I5',[1600,2100],vertical),
        ('pspice_elem','resistor','I6',[1600,2450],vertical),
        ('pspice_elem','resistor','I7',[300,2200],vertical),
        ('pspice_elem','resistor','I8',[1600,1100],vertical),
        ('pspice_elem','resistor','I9',[300,1100],vertical),
        ('pspice_elem','resistor','I10',[2150,1250],vertical),
        ('pspice_elem','resistor','I11',[-250,1450],reverse),
        ('pspice_elem','capacitor','I12',[50,1450],identity),
        ('pspice_elem','capacitor','I13',[1400,1800],reverse),
        ('pspice_elem','capacitor','I14',[2000,2150],downward),
        ('pspice_elem','capacitor','I15',[700,1100],vertical),
        ('di','1n4148','I16',[300,2600],downward),
        ('pspice_elem','voltage_bus','I17',[900,3150],downward),
        ('pspice_elem','capacitor','I18',[1850,1700],identity),
        ('pspice_elem','ground','I19',[2000,1900],identity),
        ('pspice_elem','ground','I20',[2150,700],identity),
        ('pspice_elem','resistor','I21',[950,1600],vertical),
        ('pspice_elem','v_sinusoidal','I22',[-500,1100],identity),
        ('pspice_elem','variables','I23',[-1000,1950],identity)]:
        c['symbols'].append({**source(root/'archive_libs'/lib/part/'sym_1/symbol.css'),
                             'part':part,'instance':instance,'origin':origin,'matrix':matrix})
    paths=['cds.lib','worklib/rf_amplifier/sch_1/verilog.v',
           'worklib/rf_amplifier/psp_sim_1/profiles/AC/AC.cir',
           'worklib/rf_amplifier/psp_sim_1/profiles/TRANS/TRANS.cir']
    paths += [f'archive_libs/{part}/{tail}' for part in ['bjn/2n5179','bjp/2n3905','di/1n4148']
              for tail in ['awb_model/device.prp','awb_model/model.sp','chips/chips.prt']]
    paths += [f'archive_libs/pspice_elem/{part}/awb_model/device.prp'
              for part in ['resistor','capacitor','ground','voltage_bus','v_sinusoidal']]
    c['supplemental']=[source(root/path) for path in paths]
    c['missingGeneratedNetlist']=str(root/'worklib/rf_amplifier/psp_sim_1/rf_amplifier.net').replace('\\','/')
    assert not Path(c['missingGeneratedNetlist']).exists()
    out.mkdir(parents=True)
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS009.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:1080px}</style><p>CSA/CSS source-coordinate reconstruction; no native screenshot or product acceptance.</p><section><h2>PS009 RF amplifier</h2><img src="PS009.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':'PS009','CSA_lines':len(c['originalLines']),'CSV_lines':len(c['connectivity']['lines']),
                      'CSS_instances':len(c['symbols']),'supplemental_files':len(c['supplemental']),
                      'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P007':
    assert sys.argv[3:]==['PS008'] and not out.exists(), 'Resume existing PS008 evidence; never reset.'
    p=lookup['PS008']
    original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    identity=[1,0,0,1]
    vertical=[0,-1,1,0]
    mirror_x=[-1,0,0,1]
    diagonal=[0,1,1,0]
    c={'id':'PS008','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[],
       'verifiedPins':{
        'I1':{'C':[850,2250,8],'B':[750,2150,6],'E':[650,2250,7]},
        'I2':{'A':[1850,2250,8],'B':[2050,2250,2]},
        'I3':{'C':[850,1450,6],'B':[750,1350,5],'E':[850,1250,10]},
        'I4':{'C':[1350,1450,9],'B':[1450,1350,3],'E':[1350,1250,10]},
        'I5':{'AN':[-50,900,1],'CAT':[-50,1100,4],'REF':[-150,1000,0]},
        'I6':{'A':[250,1350,4],'B':[450,1350,5]},
        'I7':{'A':[300,1950,7],'B':[500,1950,6]},
        'I8':{'A':[1550,1800,9],'B':[1750,1800,3]},
        'I9':{'A':[1950,1350,3],'B':[2150,1350,2]},
        'I10':{'A':[1100,800,1],'B':[1100,1000,10]},
        'I11':{'A':[1800,800,1],'B':[1800,1000,3]},
        'I12':{'A':[1250,1950,5],'B':[1250,2150,8]},
        'I13':{'A':[3050,1550,1],'B':[3050,1750,2]},
        'I14':{'A':[-50,1500,4],'B':[-50,1700,7]},
        'I15':{'PVS':[-1000,1650,7],'NVS':[-1000,1450,1]},
        'I16':{'A':[-550,1550,7],'B':[-550,1350,1]},
        'I17':{'A':[2150,1800,2],'B':[1950,1800,3]},
        'I18':{'A':[2700,1500,2],'B':[2700,1300,1]},
        'I20':{},'I21':{'G':[1800,500,1]}},
       'decorativePins':{'I22':{'A':[3500,2250,2]}},
       'viewBox':'-1300 -2500 6200 2350',
       'geometryBoundary':'Every instance matrix is explicitly checked against original CSS contacts, CSA LASTPIN and wire endpoints, and preserved CSV electrical identity. LM136 REF is explicitly FLOAT and unconnected. OFFPAGE I22 has COMMENT_BODY TRUE and is absent from CSV; retained as an original graphic annotation with a checked anchor, not invented as an electrical instance. No universal rotation-code conversion or simulation claim.',
       'missingGeneratedNetlist':str(root/'worklib/linear_reg/psp_sim_1/linear_reg.net').replace('\\','/')}
    assert not Path(c['missingGeneratedNetlist']).exists()
    instances=[
        ('bjpd','2n6034','I1',[750,2200],diagonal,'sym_1'),
        ('pspice_elem','inductor','I2',[1950,2250],identity,'sym_1'),
        ('bjn','mrf580','I3',[800,1350],identity,'sym_1'),
        ('bjn','mrf580','I4',[1400,1350],mirror_x,'sym_1'),
        ('vr','lm136','I5',[-50,1000],vertical,'sym_1'),
        ('pspice_elem','resistor','I6',[350,1350],identity,'sym_1'),
        ('pspice_elem','resistor','I7',[400,1950],identity,'sym_1'),
        ('pspice_elem','resistor','I8',[1650,1800],identity,'sym_1'),
        ('pspice_elem','resistor','I9',[2050,1350],identity,'sym_1'),
        ('pspice_elem','resistor','I10',[1100,900],vertical,'sym_1'),
        ('pspice_elem','resistor','I11',[1800,900],vertical,'sym_1'),
        ('pspice_elem','resistor','I12',[1250,2050],vertical,'sym_1'),
        ('pspice_elem','resistor','I13',[3050,1650],vertical,'sym_1'),
        ('pspice_elem','resistor','I14',[-50,1600],vertical,'sym_1'),
        ('pspice_elem','voltage_source','I15',[-1000,1550],identity,'sym_1'),
        ('pspice_elem','capacitor','I16',[-550,1450],vertical,'sym_1'),
        ('pspice_elem','capacitor','I17',[2050,1800],identity,'sym_1'),
        ('pspice_elem','capacitor','I18',[2700,1400],vertical,'sym_1'),
        ('pspice_elem','variables','I20',[3700,500],identity,'sym_1'),
        ('pspice_elem','ground','I21',[1800,450],identity,'sym_1'),
        ('standard','offpage','I22',[3550,2250],identity,'sym_2')]
    for lib,part,instance,origin,matrix,view in instances:
        libroot=Path('E:/Cadence/SPB_25.1/share/library/standard') if lib=='standard' else root/'archive_libs'/lib
        c['symbols'].append({**source(libroot/part/view/'symbol.css'),
                            'part':part,'instance':instance,'origin':origin,'matrix':matrix})
    paths=['cds.lib','worklib/linear_reg/sch_1/verilog.v','worklib/linear_reg/psp_sim_1/profiles/Trans/Trans.cir']
    for lib,part in [('bjpd','2n6034'),('bjn','mrf580'),('vr','lm136')]:
        paths += [f'archive_libs/{lib}/{part}/{suffix}' for suffix in ['awb_model/device.prp','awb_model/model.sp','chips/chips.prt']]
    paths += [f'archive_libs/pspice_elem/{part}/awb_model/device.prp' for part in ['voltage_source','ground','resistor','capacitor','inductor']]
    c['supplemental']=[source(root/path) for path in paths]
    out.mkdir()
    write(out/'pin-audit.json',audit_csv_geometry(c))
    (out/'PS008.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:900px}</style><p>PS008 CSA/CSS source reconstruction; typography approximate; not native screenshot or product acceptance.</p><section><h2>PS008 linear regulator</h2><img src="PS008.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':['PS008'],'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P006':
    assert sys.argv[3:]==['PS001'] and (not out.exists() or not any(out.iterdir())), 'Resume preserved PS001 evidence; never reset.'
    p=lookup['PS001']
    original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    identity=[1,0,0,1]
    reverse=[-1,0,0,-1]
    upward=[0,-1,1,0]
    c={'id':'PS001','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[],
       'verifiedPins':{
        'I10':{'A':[1450,1900,3],'B':[1250,1900,13]},
        'I11':{'A':[1600,1250,10],'B':[1800,1250,5]},
        'I12':{'PVS':[900,2050,2],'NVS':[900,1850,13]},
        'I13':{'PVS':[900,950,4],'NVS':[900,750,12]},
        'I14':{'A':[3050,2450,7],'B':[3250,2450,8]},
        'I15':{'PVS':[3550,1900,8],'NVS':[3550,1700,12]},
        'I16':{'A':[3300,850,6],'B':[3300,650,12]},
        'I17':{'AN':[1650,1650,13],'CAT':[1650,1850,3]},
        'I20':{'C':[2700,1350,9],'B':[2600,1250,5],'E':[2700,1150,1]},
        'I21':{'C':[2700,2000,11],'B':[2600,1900,3],'E':[2700,1800,9]},
        'I22':{'G':[900,1500,13]},'I23':{'G':[900,300,12]},'I24':{},
        'I3':{'A':[3050,1000,1],'B':[3250,1000,6]},
        'I4':{'A':[1100,1250,4],'B':[1300,1250,10]},
        'I5':{'A':[1250,2250,2],'B':[1450,2250,3]},
        'I6':{'A':[2700,2100,11],'B':[2700,2300,7]},
        'I7':{'A':[2700,700,12],'B':[2700,900,1]},
        'I8':{'A':[2150,1500,5],'B':[2150,1700,3]},
        'I9':{'A':[2150,750,12],'B':[2150,950,5]}},
       'viewBox':'500 -2750 4800 2850',
       'geometryBoundary':'Per-instance CSS contacts explicitly checked against CSA LASTPIN, wire endpoints and CSV identities. Two geometric ground components retain CSV nets 12/13; Verilog declares their global equivalence. CSS/CSA sinusoidal amplitude expressions differ and remain preserved. No universal orientation-code mapping or simulation claim.',
       'missingGeneratedNetlist':str(root/'worklib/cascode/psp_sim_1/cascode.net').replace('\\','/')}
    assert not Path(c['missingGeneratedNetlist']).exists()
    instances=[
        ('pspice_elem','capacitor','I10',[1350,1900],identity,'sym_1'),
        ('pspice_elem','capacitor','I11',[1700,1250],reverse,'sym_1'),
        ('pspice_elem','voltage_source','I12',[900,1950],identity,'sym_1'),
        ('pspice_elem','v_sinusoidal','I13',[900,850],identity,'sym_1'),
        ('pspice_elem','inductor','I14',[3150,2450],identity,'sym_1'),
        ('pspice_elem','voltage_source','I15',[3550,1800],identity,'sym_1'),
        ('pspice_elem','capacitor','I16',[3300,750],upward,'sym_1'),
        ('diz','1n755','I17',[1650,1750],upward,'sym_1'),
        ('bjn','2n1613','I20',[2650,1250],identity,'sym_1'),
        ('bjn','2n1613','I21',[2650,1900],identity,'sym_1'),
        ('pspice_elem','ground','I22',[900,1450],identity,'sym_11'),
        ('pspice_elem','ground','I23',[900,250],identity,'sym_11'),
        ('pspice_elem','variables','I24',[4100,2050],identity,'sym_1'),
        ('pspice_elem','resistor','I3',[3150,1000],identity,'sym_1'),
        ('pspice_elem','resistor','I4',[1200,1250],identity,'sym_1'),
        ('pspice_elem','resistor','I5',[1350,2250],identity,'sym_1'),
        ('pspice_elem','resistor','I6',[2700,2200],upward,'sym_1'),
        ('pspice_elem','resistor','I7',[2700,800],upward,'sym_1'),
        ('pspice_elem','resistor','I8',[2150,1600],upward,'sym_1'),
        ('pspice_elem','resistor','I9',[2150,850],upward,'sym_1')]
    for lib,part,instance,origin,matrix,view in instances:
        c['symbols'].append({**source(root/'archive_libs'/lib/part/view/'symbol.css'),
                             'part':part,'instance':instance,'origin':origin,'matrix':matrix})
    c['supplemental']=[source(root/'cds.lib'),source(root/'worklib/cascode/sch_1/verilog.v'),
        source(root/'worklib/cascode/psp_sim_1/profiles/Tran/Tran.cir'),
        source(root/'archive_libs/diz/1n755/awb_model/device.prp'),
        source(root/'archive_libs/diz/1n755/awb_model/model.sp'),
        source(root/'archive_libs/diz/1n755/chips/chips.prt'),
        source(root/'archive_libs/bjn/2n1613/awb_model/device.prp'),
        source(root/'archive_libs/bjn/2n1613/awb_model/model.sp'),
        source(root/'archive_libs/bjn/2n1613/chips/chips.prt'),
        source(root/'archive_libs/pspice_elem/ground/awb_model/device.prp'),
        source(root/'archive_libs/pspice_elem/v_sinusoidal/awb_model/device.prp'),
        source(root/'archive_libs/templates/434/awb_model/model.sp',lines=list(range(1,35))+[105,106])]
    pin_audit=audit_csv_geometry(c)
    out.mkdir(exist_ok=True)
    write(out/'pin-audit.json',pin_audit)
    (out/'PS001.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:900px}</style><p>CSA/CSS source reconstruction; typography approximate; not native screenshot or product acceptance.</p><section><h2>PS001 cascode</h2><img src="PS001.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':['PS001'],'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P005':
    assert sys.argv[3:]==['PS003'] and not out.exists(), 'Only explicitly reviewed PS003 transforms are registered here.'
    p=lookup['PS003']
    original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    identity=[1,0,0,1]
    upward=[0,-1,1,0]
    downward=[0,1,-1,0]
    c={'id':'PS003','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[],
       'verifiedPins':{
        '10P':{'A':[2250,1950,8],'B':[2250,1750,16]},
        '11P':{'A':[1500,1050,11],'B':[1700,1050,10]},
        '12P':{'A':[1900,1050,10],'B':[2100,1050,9]},
        '13P':{'A':[1050,2050,6],'B':[1250,2050,5]},
        '14P':{'A':[1500,2050,5],'B':[1700,2050,7]},
        '15P':{'A':[1900,2050,7],'B':[2100,2050,8]},
        '16P':{'G':[1350,1700,13]},'17P':{'G':[900,1700,14]},
        '18P':{'PVS':[900,1950,6],'NVS':[900,1750,14]},
        '19P':{'VOUT':[2850,1150,3]},'20P':{'VOUT':[2850,850,4]},
        '21P':{'VOUT':[2850,1850,1]},'22P':{'VOUT':[2850,2150,2]},
        '3P':{'G':[2250,700,15]},'5P':{'G':[2250,1700,16]},
        '6P':{'A':[2250,950,9],'B':[2250,750,15]},
        '7P':{'A':[1800,950,10],'B':[1800,750,12]},
        '8P':{'A':[1350,1950,5],'B':[1350,1750,13]},
        '9P':{'A':[1800,1950,7],'B':[1800,1750,11]},
        'I25':{'PIN':[2700,2050,8],'NIN':[2700,1950,11],'OUT':[2900,2000,11],'PVSS':[2850,2100,2],'NVSS':[2850,1900,1]},
        'I26':{'PIN':[2700,1050,9],'NIN':[2700,950,12],'OUT':[2900,1000,12],'PVSS':[2850,1100,3],'NVSS':[2850,900,4]}},
       'viewBox':'600 -2450 2800 2600',
       'geometryBoundary':'Explicit CSS contacts mapped per instance and checked against CSV and CSA components. Local ground components remain separate in geometry; Verilog explicitly gives global equivalence. Decorative frame omitted and typography approximate; no universal orientation-code rule.',
       'missingGeneratedNetlist':str(root/'worklib/lowpass/psp_sim_1/lowpass.net').replace('\\','/')}
    assert not Path(c['missingGeneratedNetlist']).exists()
    instances=[('capacitor','10P',[2250,1850],upward),
        ('resistor','11P',[1600,1050],identity),('resistor','12P',[2000,1050],identity),
        ('resistor','13P',[1150,2050],identity),('resistor','14P',[1600,2050],identity),('resistor','15P',[2000,2050],identity),
        ('ground','16P',[1350,1650],identity),('ground','17P',[900,1650],identity),('v_pulse','18P',[900,1850],identity),
        ('voltage_bus','19P',[2850,1200],downward),('voltage_bus','20P',[2850,800],upward),
        ('voltage_bus','21P',[2850,1800],upward),('voltage_bus','22P',[2850,2200],downward),
        ('variables','24P',[700,500],identity),('ground','3P',[2250,650],identity),('ground','5P',[2250,1650],identity),
        ('capacitor','6P',[2250,850],upward),('capacitor','7P',[1800,850],upward),
        ('capacitor','8P',[1350,1850],upward),('capacitor','9P',[1800,1850],upward),
        ('ca1458','I25',[2800,2000],identity),('ca1458','I26',[2800,1000],identity)]
    for part,instance,origin,matrix in instances:
        lib='opa' if part=='ca1458' else 'pspice_elem'
        c['symbols'].append({**source(root/'archive_libs'/lib/part/'sym_1/symbol.css'),'part':part,'instance':instance,'origin':origin,'matrix':matrix})
    c['supplemental']=[source(root/'worklib/lowpass/sch_1/verilog.v'),
        source(root/'archive_libs/opa/ca1458/awb_model/device.prp'),
        source(root/'archive_libs/opa/ca1458/awb_model/model.sp'),
        source(root/'archive_libs/opa/ca1458/chips/chips.prt'),
        source(root/'archive_libs/pspice_elem/voltage_bus/awb_model/device.prp'),
        source(root/'archive_libs/templates/639/awb_model/model.sp',lines=list(range(315,376))),
        source(root/'worklib/lowpass/psp_sim_1/profiles/trans/trans.cir'),
        source(root/'worklib/lowpass/psp_sim_1/profiles/ac/ac.cir')]
    out.mkdir()
    (out/'PS003.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:1100px}</style><p>CSA/CSS source reconstruction; not native screenshot or product acceptance.</p><section><h2>PS003 lowpass</h2><img src="PS003.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':['PS003'],'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit' and batch=='P004':
    assert sys.argv[3:]==['PS005'] and not out.exists(), 'Only explicitly reviewed PS005 transforms are registered here.'
    p=lookup['PS005']
    original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    identity=[1,0,0,1]
    vertical=[0,-1,1,0]
    c={'id':'PS005','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[],
       'verifiedPins':{
        'I10':{'VOUT':[650,650,7]},'I11':{'VOUT':[650,500,4]},
        'I12':{'in':[200,1500,2],'out':[950,1500,1]},
        'I2':{'in':[1450,1500,1],'out':[2200,1500,5]},
        'I13':{'in':[2450,1500,5],'out':[3200,1500,8]},
        'I14':{'A':[900,650,7],'B':[1100,650,3]},
        'I15':{'A':[900,500,4],'B':[1100,500,6]},
        'I19':{'G':[-400,900,9]},'I20':{'G':[3500,1000,10]},
        'I4':{'A':[3450,1200,10],'B':[3450,1400,8]},
        'I5':{'A':[3600,1400,8],'B':[3600,1200,10]},
        'I9':{'PVS':[-400,1350,2],'NVS':[-400,1150,9]}},
       'viewBox':'-900 -2650 5300 2900',
       'geometryBoundary':'Explicit instance transforms verified against original CSS contacts, CSA LASTPIN and CSV identities. Decorative frame M commands omitted from circuit view, preserved in source; typography approximate. No universal CSA orientation conversion.',
       'priorReading':['P003/reading-ledger.md'],
       'missingGeneratedNetlist':str(root/'worklib/low_pass_3/psp_sim_1/low_pass_3.net').replace('\\','/')}
    assert not Path(c['missingGeneratedNetlist']).exists()
    instances=[
        ('pspice_elem','voltage_bus','I10',[600,650],identity),
        ('pspice_elem','voltage_bus','I11',[600,500],identity),
        ('worklib','one_pole','I12',[600,1450],identity),
        ('worklib','one_pole','I2',[1850,1450],identity),
        ('worklib','one_pole','I13',[2850,1450],identity),
        ('pspice_elem','resistor','I14',[1000,650],identity),
        ('pspice_elem','resistor','I15',[1000,500],identity),
        ('pspice_elem','ground','I19',[-400,850],identity),
        ('pspice_elem','ground','I20',[3500,950],identity),
        ('pspice_elem','variables','I21',[2150,250],identity),
        ('pspice_elem','resistor','I4',[3450,1300],vertical),
        ('pspice_elem','capacitor','I5',[3600,1300],vertical),
        ('pspice_elem','v_pulse','I9',[-400,1250],identity)]
    for lib,part,instance,origin,matrix in instances:
        libroot=root/'worklib' if lib=='worklib' else root/'archive_libs'/lib
        c['symbols'].append({**source(libroot/part/'sym_1/symbol.css'),'part':part,'instance':instance,'origin':origin,'matrix':matrix})
    c['supplemental']=[source(root/'worklib/low_pass_3/sch_1/verilog.v'),
        source(root/'worklib/one_pole/entity/verilog.v'),
        source(root/'archive_libs/pspice_elem/voltage_bus/awb_model/device.prp'),
        source('E:/Cadence/SPB_25.1/share/library/standard/cadence#20b#20size#20page/sym_1/symbol.css')]
    out.mkdir()
    (out/'PS005.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:900px}</style><p>CSA/CSS source reconstruction; decorative frame omitted; not native screenshot or product acceptance.</p><section><h2>PS005 low_pass_3</h2><img src="PS005.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':['PS005'],'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-circuit':
    assert batch=='P003' and sys.argv[3:]==['PS006'] and not out.exists(), 'Only the explicitly reviewed PS006 transforms are registered; resume existing evidence.'
    p=lookup['PS006']
    original=source(p['source'],p['encoding'])
    assert original['sha256']==p['sha256']
    root=Path(p['source']).parents[3]
    c={'id':'PS006','relative':p['relative'],**original,'originalLines':original['lines'],
       'connectivity':source(p['connectivitySource']),'symbols':[],
       'verifiedPins':{
        'I12':{'PIN':[1350,1350,4],'NIN':[1350,1250,3],'OUT':[1550,1300,5],'PVSS':[1500,1400,1],'NVSS':[1500,1200,6]},
        'I15':{'G':[1000,1000,8]},'I17':{'A':[200,1350,7]},'I18':{'A':[1800,1300,5]},
        'I2':{'A':[1150,1000,5],'B':[1150,1200,3]},
        'I3':{'A':[700,1350,2],'B':[900,1350,4]},
        'I5':{'A':[1000,1250,4],'B':[1000,1050,8]},
        'I6':{'A':[650,1250,2],'B':[650,1050,5]},
        'I7':{'A':[400,1350,7],'B':[600,1350,2]}},
       'viewBox':'-600 -1800 3400 1900',
       'geometryBoundary':'Each instance matrix is explicitly verified from CSS contacts, CSA LASTPIN and wire endpoints, and CSV identities; not a universal CSA rotation-code conversion.',
       'missingGeneratedNetlist':str(root/'worklib/low_pass_3/psp_sim_1/low_pass_3.net').replace('\\','/')}
    assert not Path(c['missingGeneratedNetlist']).exists()
    identity=[1,0,0,1]
    vertical=[0,-1,1,0]
    for lib,part,instance,origin,matrix in [
        ('opa','ca1458','I12',[1450,1300],identity),
        ('pspice_elem','ground','I15',[1000,950],identity),
        ('standard','vhdl_decs','I16',[2300,700],identity),
        ('standard','inport','I17',[150,1350],identity),
        ('standard','outport','I18',[1850,1300],identity),
        ('pspice_elem','variables','I19',[-400,250],identity),
        ('pspice_elem','resistor','I2',[1150,1100],vertical),
        ('pspice_elem','resistor','I3',[800,1350],identity),
        ('pspice_elem','capacitor','I5',[1000,1150],vertical),
        ('pspice_elem','capacitor','I6',[650,1150],vertical),
        ('pspice_elem','resistor','I7',[500,1350],identity)]:
        libroot=Path('E:/Cadence/SPB_25.1/share/library/standard') if lib=='standard' else root/'archive_libs'/lib
        c['symbols'].append({**source(libroot/part/'sym_1/symbol.css'),'part':part,'instance':instance,'origin':origin,'matrix':matrix})
    c['supplemental']=[source(root/'cds.lib'),source(root/'worklib/one_pole/sch_1/verilog.v'),
        source(root/'archive_libs/opa/ca1458/awb_model/device.prp'),
        source(root/'archive_libs/opa/ca1458/awb_model/model.sp'),
        source(root/'archive_libs/opa/ca1458/chips/chips.prt'),
        source(root/'archive_libs/templates/639/awb_model/model.sp',lines=list(range(315,376))),
        source(root/'worklib/low_pass_3/psp_sim_1/profiles/trans/trans.cir')]
    out.mkdir()
    (out/'PS006.svg').write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':[c]},ensure_ascii=False).encode(),mtime=0))
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:900px}</style><p>CSA/CSS source reconstruction; not native screenshot or product acceptance.</p><section><h2>PS006 one_pole</h2><img src="PS006.svg"></section>',encoding='utf8')
    print(json.dumps({'prepared':['PS006'],'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare-notes':
    assert not out.exists(), 'Resume existing evidence; do not reset.'
    identities=sys.argv[3:]
    assert identities and len(set(identities))==len(identities)
    cases=[]
    for identity in identities:
        p=lookup[identity]
        original=source(p['source'],p['encoding'])
        assert original['sha256']==p['sha256']
        # Only notes pages with no circuit geometry qualify for this path.
        assert not any(line.startswith(('WIRE ','DOT ','LASTPIN ')) for line in original['lines'])
        assert all('CADENCE' in line and 'SIZE PAGE' in line for line in original['lines'] if line.startswith('FORCEADD '))
        connectivity=source(p['connectivitySource'])
        assert len(connectivity['lines'])==5 and connectivity['lines'][3]=='0"NC";'
        cases.append({'id':identity,'relative':p['relative'],**original,
            'originalLines':original['lines'],'connectivity':connectivity,'symbols':[],'supplemental':[],
            'viewBox':'-2100 -4100 9400 3200',
            'geometryBoundary':'Verified notes-only CSA/CSV page. No circuit topology or associated model reading is claimed.'})
    out.mkdir()
    for c in cases:
        (out/(c['id']+'.svg')).write_text(diagram(c),encoding='utf8')
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':cases},ensure_ascii=False).encode(),mtime=0))
    sections=''.join('<section><h2>'+c['id']+' '+html.escape(c['relative'])+'</h2><img src="'+c['id']+'.svg"></section>' for c in cases)
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:800px}</style><p>Notes-only CSA source reconstruction; text and typography are approximate, not native screenshot.</p>'+sections,encoding='utf8')
    print(json.dumps({'prepared':identities,'status':'pending_manual_notes_and_image_review'}))
elif mode=='prepare':
    assert batch=='P001' and not out.exists(), 'Resume existing evidence; do not reset.'
    out.mkdir()
    cases=[]
    for identity in ['PS002','PS007']:
        p=lookup[identity]
        raw=Path(p['source']).read_bytes()
        assert hashlib.sha256(raw).hexdigest()==p['sha256']
        c={'id':identity,'relative':p['relative'],**source(p['source'],p['encoding']),
           'originalLines':raw.decode(p['encoding']).splitlines(),'connectivity':source(p['connectivitySource']),
           'symbols':[],'supplemental':[]}
        if identity=='PS002':
            root=Path(p['source']).parents[3]
            for lib,part,origin,matrix in [
                ('pspice_elem','voltage_source',[150,1700],[1,0,0,1]),
                ('pspice_elem','resistor',[500,2050],[1,0,0,1]),
                ('pspice_elem','ground',[700,1350],[1,0,0,1]),
                ('pspice_elem','variables',[1550,1100],[1,0,0,1]),
                ('diode','d1n914',[1200,1800],[0,-1,-1,0])]:
                c['symbols'].append({**source(root/'archive_libs'/lib/part/'sym_1/symbol.css'),
                                     'part':part,'origin':origin,'matrix':matrix})
            c['supplemental']=[source(root/'cds.lib'),source(root/'worklib/diodex/sch_1/verilog.v'),
                source(root/'worklib/diodex/psp_sim_1/profiles/dc/dc.cir'),
                source('E:/Cadence/SPB_25.1/tools/pspice/library/diode.lib',lines=[21499,21500])]
            c['verifiedPins']={
                'V1':{'PVS':[150,1800,2],'NVS':[150,1600,3]},
                'R1':{'A':[400,2050,2],'B':[600,2050,1]},
                'D1':{'1':[1250,1850,1],'2':[1250,1700,3]},
                'GROUND':{'G':[700,1400,3]}}
            c['geometryBoundary']='R3 diode transform derived for this instance from CSS contacts, CSA LASTPIN coordinates and CSV pin identities; no universal orientation-code conversion asserted.'
            c['missingGeneratedNetlist']=str(root/'worklib/diodex/psp_sim_1/diodex.net').replace('\\','/')
            assert not Path(c['missingGeneratedNetlist']).exists()
            c['viewBox']='-20 -2420 3000 1900'
        else:
            c['viewBox']='-880 -2500 4000 1920'
            c['geometryBoundary']='Notes-only page; no circuit symbols, wires or terminals in CSA/CSV. Associated circuit on page2 is separately pending.'
        (out/(identity+'.svg')).write_text(diagram(c),encoding='utf8')
        cases.append(c)
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps({'batch':batch,'cases':cases},ensure_ascii=False).encode(),mtime=0))
    sections=''.join('<section><h2>'+c['id']+' '+html.escape(c['relative'])+'</h2><img src="'+c['id']+'.svg"></section>' for c in cases)
    (out/'sheet-1.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#edf3ef;font-family:Arial}section{background:white;padding:12px}img{width:1440px;height:800px}</style><p>CSA/CSS source-coordinate reconstruction; no native screenshot or product acceptance.</p>'+sections,encoding='utf8')
    print(json.dumps({'prepared':[c['id'] for c in cases],'status':'pending_manual_notes_and_image_review'}))
elif mode=='render':
    d=json.loads(gzip.decompress((out/'evidence.json.gz').read_bytes()))
    for c in d['cases']:
        (out/(c['id']+'.svg')).write_text(diagram(c),encoding='utf8')
    print('Rendered existing preserved evidence; review status unchanged.')
elif mode=='audit':
    d=json.loads(gzip.decompress((out/'evidence.json.gz').read_bytes()))
    notes=json.loads((out/'notes.json').read_text(encoding='utf8'))
    for path in sorted(out.glob('standard-*-evidence.json')):
        model=json.loads(path.read_text(encoding='utf8'))
        raw=Path(model['source']).read_bytes()
        assert hashlib.sha256(raw).hexdigest()==model['sha256']
        lines=raw.decode(model['encoding']).splitlines()
        for declaration in model['declarations']:
            start,end=declaration['startLine'],declaration['endLine']
            assert '\n'.join(lines[start-1:end])==declaration['text']
            assert end==len(lines) or not lines[end].lstrip().startswith('+'), 'Retain complete model continuation lines.'
        excerpt=(out/model['evidence']).read_bytes()
        assert hashlib.sha256(excerpt).hexdigest()==model['evidenceSha256']
        assert excerpt.decode('utf8')=='\n\n'.join(x['text'] for x in model['declarations'])+'\n'
    assert [n['id'] for n in notes]==[c['id'] for c in d['cases']]
    assert len({n['id'] for n in notes})==len(notes)
    assert all('??' not in n[key] and '\ufffd' not in n[key] for n in notes for key in ('lesson','boundary')), 'Reject damaged note encoding.'
    assert (out/'sheet-1.png').read_bytes().startswith(b'\x89PNG\r\n\x1a\n')
    parts=['# '+batch+'：PSpice逐页复核','','原坐标结构重建，不是原生截图；未运行仿真。','']
    electrical=[]
    for c,n in zip(d['cases'],notes):
        assert n['imageInspected'] is True and n['sourceReadComplete'] is True and n['lesson'] and n['boundary']
        for s in [c,c['connectivity'],*c['symbols'],*c['supplemental']]:
            raw=Path(s['source']).read_bytes()
            assert hashlib.sha256(raw).hexdigest()==s['sha256']
            if s['lines'] and isinstance(s['lines'][0],dict):
                a=raw.decode(s['encoding']).splitlines()
                assert all(a[l['line']-1]==l['text'] for l in s['lines'])
            else:
                assert raw.decode(s['encoding']).splitlines()==s['lines']
        identities={'voltage_source':'V1','resistor':'R1','ground':'GROUND','d1n914':'D1'}
        for s in c['symbols']:
            for l in s['lines']:
                match=re.match(r'C (-?\d+) (-?\d+) "([^"]+)"',l)
                if match:
                    x,y=int(match[1]),int(match[2])
                    xx,xy,yx,yy=s['matrix']
                    p=[s['origin'][0]+xx*x+xy*y,s['origin'][1]+yx*x+yy*y]
                    name=terminal_name(match[3])
                    instance=s.get('instance') or identities[s['part']]
                    pin_map=c.get('decorativePins',{}) if instance in c.get('decorativePins',{}) else c['verifiedPins']
                    assert pin_map[instance][name][:2]==p
        if c['id'] in {'PS001','PS003','PS005','PS006','PS008','PS009','PS010','PS011','PS012','PS013','PS014','PS015','PS016','PS017','PS018','PS019','PS020','PS021','PS022','PS023','PS024','PS025','PS026','PS027','PS028','PS029','PS030','PS033','PS034','PS035','PS036','PS037','PS038','PS039','PS040','PS041','PS042','PS043','PS044','PS045','PS046'}:
            electrical.append({'id':c['id'],**audit_csv_geometry(c)})
        parts+=['## '+c['id']+' '+c['relative'],'',n['lesson'],'','边界与反例：'+n['boundary'],'','[原文]('+c['source']+') · [结构图]('+c['id']+'.svg)','','```text']
        for i in n['lines']:
            assert 1<=i<=len(c['originalLines'])
            parts.append(f'CSA L{i}: {c["originalLines"][i-1]}')
        for i in n['csvLines']:
            assert 1<=i<=len(c['connectivity']['lines'])
            parts.append(f'CSV L{i}: {c["connectivity"]["lines"][i-1]}')
        parts+=['```','']
    (out/'reading-ledger.md').write_text('\n'.join(parts),encoding='utf8')
    manifest=json.loads((BASE/'manifest.json').read_text(encoding='utf8'))
    for c in manifest['pspice']:
        if c['id'] in {n['id'] for n in notes}:
            c.update(status='deep_review_complete',evidence=str(out/'reading-ledger.md').replace('\\','/'),batch=batch)
    write(BASE/'manifest.json',manifest)
    progress=json.loads((BASE/'progress.json').read_text(encoding='utf8'))
    progress['pspicePagesReviewed']=sum(c['status']=='deep_review_complete' for c in manifest['pspice'])
    progress['pspiceBatches']=[b for b in progress.get('pspiceBatches',[]) if b['batch']!=batch]+[{'batch':batch,'completed':len(notes),'evidence':str(out/'reading-ledger.md').replace('\\','/')}]
    write(BASE/'progress.json',progress)
    write(out/'audit.json',{'caseNotesVerified':len(notes),
        'originalSourceHashesVerified':sum(2+len(c['symbols'])+len(c['supplemental']) for c in d['cases']),
        'PNGSheetsPresent':1,'electricalCrossChecks':electrical,'scope':'Source integrity and manually recorded reading/image inspection; not native render or product pass.'})
    print(json.dumps({'batch':batch,'reviewed':len(notes),'pspiceTotal':progress['pspicePagesReviewed']}))
else:
    raise ValueError('Expected prepare-notes, prepare, render or audit.')
