from pathlib import Path
import json,sys
sys.stdout.reconfigure(encoding='utf8')
data=json.loads(Path('docs/artifacts/drawing-study-20261004/evidence.json').read_text(encoding='utf8'))
start,end=map(int,sys.argv[1:3])
for x in data['cases'][start-1:end]:
    print('\n###',x['studyId'],x['relative'])
    print('WIRES:', '; '.join(f'L{w["line"]}:'+','.join(map(str,w['p'])) for w in x['wires']))
    print('FLAGS:', '; '.join(f'L{f["line"]}:{f["name"]}@{f["p"]}' for f in x['flags']))
    for s in x['symbols']:
        print('L'+str(s['line']),s['name'],s['orientation'],s['attributes'],'PINS',[(p['name'],p['SpiceOrder'],p['p']) for p in s['pins']] if len(s['pins'])>2 else [p['p'] for p in s['pins']])
    print('TEXT:',x['textsAndDirectives'])
