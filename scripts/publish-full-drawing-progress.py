"""Publish finite-study scope and verified progress without overwriting history."""
from pathlib import Path
import gzip
import hashlib
import json
import sys

sys.stdout.reconfigure(encoding='utf8')
BASE=Path('docs/artifacts/drawing-learning-full-20261004')

def read(path):
    return json.loads(Path(path).read_text(encoding='utf8'))

def write(path,value):
    Path(path).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf8')

if len(sys.argv)>1 and sys.argv[1]=='models':
    batch=sys.argv[2]
    ev=json.loads(gzip.decompress((BASE/batch/'evidence.json.gz').read_bytes()))
    rows=[]
    for sym in ev['symbolDefinitions'].values():
        attributes=dict(line.split(' ',2)[1:] for line in sym['originalLines'] if line.startswith('SYMATTR '))
        model=attributes.get('ModelFile')
        if not model and attributes.get('SpiceModel','').lower().endswith(('.sub','.lib','.cir')):
            model=attributes['SpiceModel']
        if not model:
            continue
        path=Path('C:/Users/23983/AppData/Local/LTspice/lib/sub')/model
        if not path.exists():
            raise FileNotFoundError(path)
        raw=path.read_bytes()
        encrypted=b'<Binary File>' in raw[:100] or b'$CDNENCSTART' in raw[:200]
        rows.append({'symbol':sym['source'],'source':str(path).replace('\\','/'),
          'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw),
          'status':'encrypted_body_unreadable' if encrypted else 'pending_text_read',
          'header':'<Binary File>' if b'<Binary File>' in raw[:100] else ('$CDNENCSTART' if encrypted else 'text_source'),
          'scope':'Original ASY/ASC explicit identities retained; no inference of hidden subcircuit interface.'})
    write(BASE/batch/'model-interface-evidence.json',{'batch':batch,'models':rows})
    print(json.dumps({'batch':batch,'models':len(rows),'encrypted':sum(r['status']=='encrypted_body_unreadable' for r in rows),'pendingText':[r['source'] for r in rows if r['status']=='pending_text_read']}))
    sys.exit(0)

p=read('docs/research/drawing-learning-plan.json')
pr=read('docs/research/drawing-learning-progress.json')
full=read(BASE/'progress.json')
if p.get('revision')!=4:
    p['previousRevision3Targets']={k:p.get(k) for k in ['plannedReviewCases','heldOutCases','dailyReviewTarget','dailyHeldOutTarget','dailyPracticeMinimum','dailyTargets','nextRun','activeQueue']}
    for k in ['dailyReviewTarget','dailyHeldOutTarget','dailyPracticeMinimum','dailyTargets']:
        p.pop(k,None)
p.update(revision=4,revisedDate='2026-10-04',cadence='finite_full_library_completion',
         plannedReviewCases=4334,heldOutCases=0,priorDeepReviewCases=176,
         caseCountMeaning='全部4334份ASC逐份有阅读证据；原176份已证实深读保留，24份迁移仅判断的案例重新深读。phases仅是历史实绩。',
         activeQueue=str(BASE/'manifest.json').replace('\\','/'))
p['completionTargets']={'ltspiceSourceDiagrams':4334,'pspiceReadableCSACSVPages':85,
    'associatedSymbols':'Read every original symbol used by a source, retain its hash and port identity; shared definitions can reuse cited prior reading.',
    'necessaryModels':'Read accessible model interfaces where needed; encrypted or unavailable bodies are explicit gaps, never guessed.',
    'sourceRuleSummaries':'Every case has a specific lesson, boundary/counterexample and citations, grouped into eight topics.',
    'productDrawingComparisons':48,'interactionScenarios':24,
    'nativeDSNSeparate':{'total':33,'priorNativeReviewed':1,'remainingNativeUnreviewed':32,'includedInThisTextSourceCompletion':False}}
p['completionCriteria']=[
    'Every accessible source has specific manually authored notes and inspected diagram evidence; preparations and scans do not advance the cursor.',
    'All 85 PSpice CSA pages are reread with CSV connectivity, used symbol information and necessary associated netlist evidence.',
    'All 48 product comparisons retain originals and electrical identity; unsupported cases remain explicit in the denominator.',
    '24 live interaction scenarios (probe 8, zoom 8, restoration 8) have actual production evidence.',
    'Representative failures are repaired at the shared cause and verified; conclusions cite source evidence and remaining inaccessible/native gaps.',
    'A final coverage report reconciles every source status. Do not equate this scope with all literature or with native DSN completion.']
p['nextRun']={'date':'2026-10-05','time':'09:00','timezone':'Asia/Hong_Kong','status':'resume_finite_cursor',
    'progress':str(BASE/'progress.json').replace('\\','/'),'manifest':p['activeQueue'],
    'sequence':'Resume reserved unfinished batch first; then pending LTspice and PSpice sources; source synthesis and actual product acceptance interleave.',
    'batchSize':16,'stopAtDailyQuota':False,'stopAtCompletion':True}
p['finiteScopeStatus']={'status':'active',**full}
pr['planRevision']=4
pr['schedule']['promptRevision']='finite_full_library_completion'
pr.setdefault('previousRevision3DailyIntensity',pr.pop('dailyIntensity',None))
pr.setdefault('previousRevision3Cycle',pr.get('activeCycle'))
pr['activeCycle']={'revision':4,'status':'in_progress','fullStudyProgress':str(BASE/'progress.json').replace('\\','/'),
    'ltspiceDeepCompleted':full['ltspiceDeepCompleted'],'ltspiceRemaining':full['ltspiceRemaining'],
    'pspicePagesReviewed':full['pspicePagesReviewed'],'productDrawingComparisonsCompleted':full['productComparisonsCompleted'],
    'interactionScenarioChecksCompleted':full['interactionScenariosCompleted'],
    'historicalCountsMeaning':'Original counts/runs remain historical. No automatically scanned or reserved case is promoted to read.'}
change={'date':'2026-10-04','revision':4,'reason':'用户要求全部学完；改为有清晰终点的现有案例库全量审读，取消为每日配额无限扩源。',
    'report':'docs/research/2026-10-04-full-library-learning.md','manifest':p['activeQueue']}
pr['planChanges']=[x for x in pr.get('planChanges',[]) if x.get('revision')!=4]+[change]
write('docs/research/drawing-learning-plan.json',p)
write('docs/research/drawing-learning-progress.json',pr)
print(json.dumps({'revision':4,'deep':full['ltspiceDeepCompleted'],'remaining':full['ltspiceRemaining'],'historyPreserved':len(pr['runs'])}))
