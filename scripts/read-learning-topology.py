"""Read the full preserved circuit as devices joined by original wire components."""
from pathlib import Path
import gzip,json,sys
sys.stdout.reconfigure(encoding='utf8')
phase=sys.argv[1]
data=json.loads(gzip.decompress((Path('docs/artifacts/drawing-learning-20261004')/phase/'evidence.json.gz').read_bytes()))
start,end=map(int,sys.argv[2:4])
for c in data['cases'][start-1:end]:
    print('\n###',c['studyId'],c['relative'],'geometry',c['geometry']['bounds'],c['geometry']['axes'])
    def label(p):
        return '/'.join(p.get('labels',[])) or str(p.get('wireComponent',p['p']))
    for s in c['symbols']:
        attrs = {key: value if len(value) < 160 else value[:160]+' [remaining model parameters preserved in evidence]' for key, value in s['attributes'].items()}
        print('L'+str(s['line']),s['name'],s['orientation'],attrs, '; '.join(str(p['name'])+':'+str(p['SpiceOrder'])+'@'+str(p['p'])+'='+label(p) for p in s['pins']))
    print('FLAGS',[(f['line'],f['name'],f['p']) for f in c['flags'] if f['name']!='0'])
    print('TEXT',c['textsAndDirectives'])
