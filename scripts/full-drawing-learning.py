"""Evidence and cursor for actual full-library reading; preparation never marks read."""
from pathlib import Path
import ast
import gzip
import hashlib
import html
import json
import math
import sys

sys.stdout.reconfigure(encoding='utf8')
BASE = Path('docs/artifacts/drawing-learning-full-20261004')
CORPUS = Path('docs/artifacts/local-library-complete-20261002')
if not CORPUS.exists():
    CORPUS = Path('../../spice-workbench/docs/artifacts/local-library-complete-20261002')
records = json.loads(gzip.decompress((CORPUS/'ltspice.json.gz').read_bytes()))
definitions = json.loads(gzip.decompress((CORPUS/'symbol-definitions.json.gz').read_bytes()))
lookup = {r['id']:r for r in records}

def write(path, value):
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf8')

def helpers():
    tree=ast.parse(Path('scripts/drawing-study-20261004.py').read_text(encoding='utf8'))
    module=ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in {'transform','graphic','render'}],type_ignores=[])
    ns={'math':math,'html':html}
    exec(compile(module,'existing-structural-renderer','exec'),ns)
    return ns

mode=sys.argv[1]
BASE.mkdir(parents=True,exist_ok=True)
if mode=='init':
    assert not (BASE/'manifest.json').exists(), 'Do not reset an existing full-study cursor.'
    previous=json.loads(Path('docs/artifacts/drawing-study-20261004/evidence.json').read_text(encoding='utf8'))
    prior_notes=json.loads(Path('docs/artifacts/drawing-study-20261004/notes.json').read_text(encoding='utf8'))
    assert len(previous['cases'])==len(prior_notes)==48
    reviewed={c['relative']:'docs/artifacts/drawing-study-20261004/notes.json' for c in previous['cases']}
    for i in range(1,9):
        folder=Path('docs/artifacts/drawing-learning-20261004')/f'S{i:02d}'
        ev=json.loads(gzip.decompress((folder/'evidence.json.gz').read_bytes()))
        notes=json.loads((folder/'notes.json').read_text(encoding='utf8'))
        assert len(notes)==len(ev['cases'])==16
        for c,n in zip(ev['cases'],notes):
            assert c['studyId']==n['id']
            reviewed[c['relative']]=str(folder/'reading-ledger.md').replace('\\','/')
    assert len(reviewed)==176
    cases=[{k:r[k] for k in ('id','relative','source','sha256','layoutSignature')}|{
        'status':'prior_deep_review_complete' if r['relative'] in reviewed else 'pending',
        'priorEvidence':reviewed.get(r['relative']),
        'priorMigrationOnly':r['relative'] in json.loads(Path('docs/research/drawing-learning-plan.json').read_text(encoding='utf8'))['phases'][8]['cases']}
        for r in records]
    ps=json.loads(gzip.decompress((CORPUS/'pspice-pages.json.gz').read_bytes()))
    write(BASE/'manifest.json',{'scope':'4334 LTspice source diagrams and 85 accessible PSpice CSA/CSV pages; associated symbols and netlists. Native DSN rendering tracked separately.',
         'goal':'Read every source case with specific lesson, boundary, citations and inspected structural image; then representative product validation.',
         'cases':cases,'pspice':[{'id':p['id'],'source':p['source'],'relative':p['relative'],'sha256':p['sha256'],'status':'pending'} for p in ps]})
    write(BASE/'progress.json',{'ltspiceTarget':4334,'ltspiceDeepCompleted':176,'ltspiceRemaining':4158,
          'pspicePageTarget':85,'pspicePagesReviewed':0,'productComparisonsTarget':48,'productComparisonsCompleted':0,
          'interactionScenariosTarget':24,'interactionScenariosCompleted':0,'batches':[],'status':'active',
          'scopeCaveat':'Prior 24 source-migration judgments are reread in this full-study cursor; not promoted automatically. Text structure is not native screenshot, simulation or product acceptance.'})
    print('Full-study manifest initialized: 176 confirmed prior deep reviews; 4158 LT diagrams and 85 PSpice pages pending.')
    sys.exit(0)
manifest=json.loads((BASE/'manifest.json').read_text(encoding='utf8'))
if mode=='prepare':
    batch=sys.argv[2]
    count=int(sys.argv[3])
    out=BASE/batch
    assert not out.exists(), 'Batch already exists; resume it instead.'
    reserved={c['id'] for p in BASE.glob('B*/evidence.json.gz') for c in json.loads(gzip.decompress(p.read_bytes()))['cases']}
    selected=[lookup[c['id']] for c in manifest['cases'] if c['status']=='pending' and c['id'] not in reserved][:count]
    assert selected
    out.mkdir()
    ns=helpers()
    cases=[]
    symbols={}
    for r in selected:
        raw=Path(r['source']).read_bytes()
        assert hashlib.sha256(raw).hexdigest()==r['sha256']
        c={**r,'studyId':r['id'],'originalLines':raw.decode(r['encoding']).splitlines()}
        texts={}
        for s in c['symbols']:
            d=definitions[s['sourceASY']]
            raw=Path(d['source']).read_bytes()
            assert hashlib.sha256(raw).hexdigest()==d['sha256']
            texts[d['source']]=raw.decode(d['encoding'])
            symbols[d['source']]={**d,'originalLines':texts[d['source']].splitlines()}
            assert len(s['pins'])==len(d['pins']), 'Every original pin must survive the transformation.'
            for p,orig in zip(s['pins'],d['pins']):
                x,y=ns['transform'](orig['x'],orig['y'],s['orientation'])
                assert p['p']==[s['p'][0]+x,s['p'][1]+y]
                assert p['SpiceOrder']==orig.get('SpiceOrder')
        if c['wires'] or c['symbols'] or c['flags']:
            svg=ns['render'](c,texts)
        else:
            svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 540"><text x="20" y="40">No circuit geometry; inspect preserved TEXT source.</text></svg>'
        (out/(c['id']+'.svg')).write_text(svg,encoding='utf8')
        cases.append(c)
    write_data={'batch':batch,'cases':cases,'symbolDefinitions':symbols,'method':'Preserved original sources and approximate source-coordinate structural views; preparation only.'}
    (out/'evidence.json.gz').write_bytes(gzip.compress(json.dumps(write_data,ensure_ascii=False).encode(),mtime=0))
    for i in range(math.ceil(len(cases)/4)):
        sections=''.join('<section><h2>'+c['id']+' '+html.escape(c['relative'])+'</h2><img src="'+c['id']+'.svg"></section>' for c in cases[i*4:i*4+4])
        (out/f'sheet-{i+1}.html').write_text('<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#edf3ef;font-family:Arial}main{display:grid;grid-template-columns:1fr 1fr}section{padding:12px;margin:8px;background:white}h2{font-size:15px;margin:0}img{width:720px;height:540px}</style><header>Full-library study '+batch+'; source-coordinate reconstruction, not native screenshot</header><main>'+sections+'</main>',encoding='utf8')
    print(json.dumps({'batch':batch,'prepared':len(cases),'ASC_lines':sum(len(c['originalLines']) for c in cases),'unique_ASY':len(symbols),'ids':[c['id'] for c in cases]}))
elif mode=='read':
    batch=sys.argv[2]
    start,end=map(int,sys.argv[3:5])
    d=json.loads(gzip.decompress((BASE/batch/'evidence.json.gz').read_bytes()))
    for c in d['cases'][start-1:end]:
        print('\n###',c['id'],c['relative'])
        for i,line in enumerate(c['originalLines'],1):
            print(f'L{i}: {line}')
        print('VERIFIED WORLD PINS')
        for s in c['symbols']:
            print('L'+str(s['line']),s['name'],s['orientation'],s['attributes'],'; '.join(str(p['name'])+':'+str(p['SpiceOrder'])+'@'+str(p['p'])+'='+('/'.join(p.get('labels',[])) or str(p.get('wireComponent',p['p']))) for p in s['pins']))
    if '--asy' in sys.argv:
        used={s['sourceASY'] for c in d['cases'][start-1:end] for s in c['symbols']}
        print('\nORIGINAL SYMBOL DEFINITIONS')
        for path in sorted(used):
            print('\nASY',path)
            print('\n'.join(f'L{i}: {line}' for i,line in enumerate(d['symbolDefinitions'][path]['originalLines'],1)))
elif mode=='audit':
    batch=sys.argv[2]
    out=BASE/batch
    d=json.loads(gzip.decompress((out/'evidence.json.gz').read_bytes()))
    notes=json.loads((out/'notes.json').read_text(encoding='utf8'))
    assert [n['id'] for n in notes]==[c['id'] for c in d['cases']]
    assert len({n['id'] for n in notes})==len(notes)
    assert all(n['lesson'] and n['boundary'] and n['lines'] and n['imageInspected'] is True for n in notes)
    assert all('??' not in n[key] and '\ufffd' not in n[key] for n in notes for key in ('lesson','boundary')), 'Reject damaged note encoding.'
    parts=['# '+batch+'：逐例学习记录','','图为原坐标结构重建，不是原生截图；本批未运行仿真或全部产品排图。','']
    for c,n in zip(d['cases'],notes):
        raw=Path(c['source']).read_bytes()
        assert hashlib.sha256(raw).hexdigest()==c['sha256']
        assert raw.decode(c['encoding']).splitlines()==c['originalLines']
        parts += ['## '+c['id']+' '+c['relative'],'',n['lesson'],'','边界与反例：'+n['boundary'],'','[原文]('+c['source']+') · [结构图]('+c['id']+'.svg)','','```text']
        for i in n['lines']:
            assert 1<=i<=len(c['originalLines'])
            parts.append(f'L{i}: {c["originalLines"][i-1]}')
        parts += ['```','']
    for orig in d['symbolDefinitions'].values():
        raw=Path(orig['source']).read_bytes()
        assert hashlib.sha256(raw).hexdigest()==orig['sha256']
    if (out/'model-interface-evidence.json').exists():
        models=json.loads((out/'model-interface-evidence.json').read_text(encoding='utf8'))
        for model in models['models']:
            assert hashlib.sha256(Path(model['source']).read_bytes()).hexdigest()==model['sha256']
            assert model['status'] in {'encrypted_body_unreadable','necessary_interface_read_complete'}, 'Readable necessary model interfaces must actually be read.'
            if model['status']=='necessary_interface_read_complete':
                assert hashlib.sha256((out/model['evidence']).read_bytes()).hexdigest()==model['evidenceSha256']
        parts += ['## 模型接口核对边界','','[模型来源与核对记录](model-interface-evidence.json)：加密正文明确记为无法审读，不推测内部接口，不以外观排序改写原始 SpiceOrder。','']
    for path in sorted(out.glob('standard-*-evidence.json')):
        model_evidence=json.loads(path.read_text(encoding='utf8'))
        raw=Path(model_evidence['source']).read_bytes()
        assert hashlib.sha256(raw).hexdigest()==model_evidence['sha256']
        lines=raw.decode(model_evidence['encoding']).splitlines()
        declarations=model_evidence['declarations']
        for declaration in declarations:
            start,end=declaration['startLine'],declaration['endLine']
            assert '\n'.join(lines[start-1:end])==declaration['text']
            assert end==len(lines) or not lines[end].lstrip().startswith('+'), 'Retain complete continuation lines.'
        excerpt=(out/model_evidence['evidence']).read_bytes()
        assert hashlib.sha256(excerpt).hexdigest()==model_evidence['evidenceSha256']
        assert excerpt.decode('utf8')=='\n\n'.join(d['text'] for d in declarations)+'\n'
        parts += ['## 必要标准模型声明','','['+path.name+']('+path.name+')：仅核对本批所需完整声明，保留编码、来源哈希及续行；不是全模型库深读或仿真通过。','']
    if (out/'mos-lookup-gap.json').exists():
        correction=json.loads((out/'mos-lookup-gap.json').read_text(encoding='utf8'))
        if correction.get('status')=='corrected_model_found_after_utf16le_decode':
            assert (out/correction['correctedEvidence']).exists()
            parts += ['## 检索纠正','','原始无匹配检索未解码无BOM UTF-16LE，旧结论无效；[纠正记录](mos-lookup-gap.json)保留旧证据及正确声明出处。','']
    for i in range(math.ceil(len(notes)/4)):
        assert (out/f'sheet-{i+1}.png').read_bytes().startswith(b'\x89PNG\r\n\x1a\n')
    (out/'reading-ledger.md').write_text('\n'.join(parts),encoding='utf8')
    reviewed={n['id'] for n in notes}
    for c in manifest['cases']:
        if c['id'] in reviewed:
            c.update(status='deep_review_complete',batch=batch,evidence=str(out/'reading-ledger.md').replace('\\','/'))
    write(BASE/'manifest.json',manifest)
    progress=json.loads((BASE/'progress.json').read_text(encoding='utf8'))
    progress['ltspiceDeepCompleted']=sum(c['status'] in ('prior_deep_review_complete','deep_review_complete') for c in manifest['cases'])
    progress['ltspiceRemaining']=4334-progress['ltspiceDeepCompleted']
    progress['batches']=[x for x in progress['batches'] if x['batch']!=batch]+[{'batch':batch,'completed':len(notes),'ASC_lines':sum(len(c['originalLines']) for c in d['cases']),'evidence':str(out/'reading-ledger.md').replace('\\','/')}]
    write(BASE/'progress.json',progress)
    write(out/'audit.json',{'caseNotesVerified':len(notes),'originalSourceHashesVerified':len(notes)+len(d['symbolDefinitions']),'PNGSheetsPresent':math.ceil(len(notes)/4),'scope':'Evidence integrity, references and manually recorded image inspection; not native render or product pass.'})
    print(json.dumps({'batch':batch,'completed':len(notes),'totalDeep':progress['ltspiceDeepCompleted'],'remaining':progress['ltspiceRemaining']}))
else:
    raise ValueError(mode)
