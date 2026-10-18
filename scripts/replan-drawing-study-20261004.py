"""Prepare the expanded plan and unopened source queue; does not count reading."""
from collections import defaultdict, deque
from datetime import date, timedelta
from pathlib import Path
import gzip
import hashlib
import json
import math
import sys

sys.stdout.reconfigure(encoding='utf8')
RESEARCH = Path('docs/research')
ARTIFACTS = Path('docs/artifacts')
CORPUS = ARTIFACTS / 'local-library-complete-20261002'
if not CORPUS.exists():
    CORPUS = Path('../../spice-workbench/docs/artifacts/local-library-complete-20261002')
OUT = ARTIFACTS / 'drawing-learning-expanded-20261004'
OUT.mkdir(parents=True, exist_ok=True)

def write(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n', encoding='utf8')

records = json.loads(gzip.decompress((CORPUS / 'ltspice.json.gz').read_bytes()))
old_plan = json.loads((RESEARCH / 'drawing-learning-plan.json').read_text(encoding='utf8'))
previous = json.loads((ARTIFACTS / 'drawing-study-20261004/evidence.json').read_text(encoding='utf8'))
known = {c['relative'] for c in previous['cases']}
known.update(c for p in old_plan['phases'] for c in p['cases'])
assert len(records) == 4334 and len(known) == 200
assert known <= {r['relative'] for r in records}

# Balance source sizes and directories, not inferred circuit functions.
buckets = defaultdict(list)
for r in records:
    if r['relative'] in known:
        continue
    n = len(r['symbols'])
    complexity = 'small' if n < 10 else 'medium' if n < 25 else 'large'
    buckets[(r['relative'].split('/')[0], complexity)].append(r)
for key in buckets:
    buckets[key] = deque(sorted(buckets[key], key=lambda r: hashlib.sha256(r['relative'].encode()).hexdigest()))
ordered = []
while any(buckets.values()):
    for key in sorted(buckets):
        if buckets[key]:
            ordered.append(buckets[key].popleft())
assert len(ordered) == 4134

full = []
days = []
offset = 0
for day_index in range(math.ceil(len(ordered)/760)):
    chunk = ordered[offset:offset+760]
    held_count = min(120, len(chunk))
    review_count = len(chunk)-held_count
    run_date = (date(2026,10,5)+timedelta(days=day_index)).isoformat()
    day_cases = []
    for index, r in enumerate(chunk):
        role = 'review' if index < review_count else 'held_out'
        row = {k:r[k] for k in ('relative','source','sha256','layoutSignature')}
        row.update(id=f'D{day_index+1:02d}-{index+1:04d}', date=run_date, role=role,
                   status='queued_unread', symbols=len(r['symbols']), wires=len(r['wires']),
                   sourceBucket='small' if len(r['symbols'])<10 else 'medium' if len(r['symbols'])<25 else 'large')
        day_cases.append(row)
    full.extend(day_cases)
    days.append({'date':run_date,'reviewCandidates':review_count,'heldOutCandidates':held_count,
                 'dailyReviewTarget':640,'dailyHeldOutTarget':120,
                 'remainingReviewSlotsForTarget':640-review_count,
                 'remainingSlotsPolicy':'Select new external sources or explicitly counted rereviews; never relabel a repeat as new.',
                 'topicAssignment':'Pending actual reading; source-size balancing is not topology classification.',
                 'cases':day_cases})
    offset += len(chunk)
assert len(full) == 4134 and len({r['relative'] for r in full}) == 4134
assert not (known & {r['relative'] for r in full})
assert sum(d['reviewCandidates'] for d in days)==3414
assert sum(d['heldOutCandidates'] for d in days)==720
manifest = {'planRevision':3,'sourceCorpusFiles':4334,'sourceCorpusLayouts':4328,
            'knownInspectedInLatestTwoBatches':200,'queuedFiles':4134,
            'meaning':'Unopened source candidates for expanded cycle. Earlier scattered reviews are not exhaustively indexed; not a never-before-read claim. Layout variants are separately marked by signature.',
            'duplicateLayoutsPolicy':'One layout signature can have multiple source variants; count files, unique layouts and independent topology separately.',
            'sourceBuckets':'Round-robin by directory and symbol count with stable path-hash ordering; not semantic topic assignment.',
            'days':days}
write(OUT/'source-queue.json',manifest)
write(OUT/'next-run.json',{'planRevision':3,**days[0]})
prior_verified = 0
for r in days[0]['cases']:
    assert Path(r['source']).is_file(), r['source']
    assert hashlib.sha256(Path(r['source']).read_bytes()).hexdigest() == r['sha256'], r['source']
    prior_verified += 1
write(OUT/'queue-audit.json',{'queuedFiles':len(full),'knownExcluded':len(known),
      'nextRunSourcesExistAndHashesVerified':prior_verified,'nextRunReviewCandidates':640,
      'nextRunHeldOutCandidates':120,'readingCompletedByThisScript':0,
      'productLayoutsVerifiedByThisScript':0,'scope':'Source paths, deduplication, counts and next-run hashes only.'})

targets = {'review':640,'heldOutJudgments':120,'practiceMinimum':80,'topicsPerDay':8,
           'productDrawingComparisons':48,'interactionScenarioChecks':24,
           'externalReferenceReadings':12,'ruleCounterexampleChecks':40}
old_plan.update(revision=3, revisedDate='2026-10-04',cadence='daily_full_cycle_expanded',
                plannedReviewCases=640, heldOutCases=120,
                dailyReviewTarget=640,dailyHeldOutTarget=120,dailyPracticeMinimum=80,
                dailyTargets=targets,
                caseCountMeaning='活动计划每日640深读＋120独立迁移；phases保存10月4日首轮128＋24实绩清单，不表示新计划已完成。',
                historicalCycle={'reviewTarget':128,'heldOutTarget':24,'readingComplete':True,'productAcceptancePending':True},
                activeQueue='docs/artifacts/drawing-learning-expanded-20261004/source-queue.json',
                nextRun={'date':'2026-10-05','time':'09:00','timezone':'Asia/Hong_Kong',
                         'focus':'Local physical connections, unexplained detours and foreign-net overlap',
                         'allEightTopicsRequired':True,'candidateManifest':'docs/artifacts/drawing-learning-expanded-20261004/next-run.json',
                         'reviewCandidates':640,'heldOutCandidates':120,'status':'queued_unread'})
write(RESEARCH/'drawing-learning-plan.json',old_plan)
progress = json.loads((RESEARCH/'drawing-learning-progress.json').read_text(encoding='utf8'))
progress['planRevision'] = 3
progress['dailyIntensity'] = targets
progress['schedule']['promptRevision'] = 'expanded_daily_640_plus_120'
progress['activeCycle'] = {'revision':3,'status':'planned_not_started','newReviewCompleted':0,
                         'heldOutJudgmentsCompleted':0,'practiceCompleted':0,'productDrawingComparisonsCompleted':0,
                         'interactionScenarioChecksCompleted':0,'externalReferencesRead':0,
                         'queuedSourceFiles':4134,'sourceAudit':str(OUT/'queue-audit.json').replace('\\','/'),
                         'historicalCountsMeaning':'counts and runs above describe completed prior batches; do not increment for queued sources.'}
progress['planChanges'] = [*progress.get('planChanges',[]),{'date':'2026-10-04','revision':3,
                         'reason':'User requested substantially more work and a new plan.',
                         'before':{'review':128,'heldOutJudgments':24,'practiceMinimum':16},'after':targets,
                         'report':'docs/research/2026-10-04-expanded-drawing-learning-plan.md'}]
write(RESEARCH/'drawing-learning-progress.json',progress)
print(json.dumps({'queued':len(full),'nextRunHashVerified':prior_verified,'dailyTargets':targets,'completedNewReading':0},ensure_ascii=False))
