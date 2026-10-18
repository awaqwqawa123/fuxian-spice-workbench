"""Reconcile actual live interaction evidence; repeated attempts never add cases."""
from pathlib import Path
import hashlib
import json
import sys

sys.stdout.reconfigure(encoding='utf8')
base = Path('docs/artifacts/drawing-learning-full-20261004')
sources = ['live-zoom-2/evidence.json', 'live-probes-2/evidence.json']
expected = {f'{prefix}{i:02d}' for prefix in ('P', 'R', 'Z') for i in range(1, 9)}
seen = set()
counts = {'probe': 0, 'restoration': 0, 'zoom': 0}
images = set()

def verify_images(value, folder):
    if isinstance(value, dict):
        if 'screenshot' in value:
            image = folder / value['screenshot']
            raw = image.read_bytes()
            assert raw.startswith(b'\x89PNG\r\n\x1a\n')
            assert hashlib.sha256(raw).hexdigest() == value['screenshotSha256']
            images.add(str(image))
        for child in value.values():
            verify_images(child, folder)
    elif isinstance(value, list):
        for child in value:
            verify_images(child, folder)

for relative in sources:
    path = base / relative
    evidence = json.loads(path.read_text(encoding='utf8'))
    assert evidence['pageErrors'] == []
    assert evidence['url'] == 'http://127.0.0.1:3032/'
    original = evidence['beforeProject']
    for case in evidence['results']:
        assert case['passed'] is True
        assert case['id'] in expected and case['id'] not in seen
        assert case['after']['project']['drawing'] == original['drawing']
        if case['category'] == 'zoom':
            assert case['after']['project'] == original
        seen.add(case['id'])
        counts[case['category']] += 1
    verify_images(evidence, path.parent)
assert seen == expected and set(counts.values()) == {8}
audit = {
    'completed': len(seen), 'counts': counts, 'sources': sources,
    'uniqueScenarios': sorted(seen), 'screenshotHashesVerified': len(images),
    'scope': 'Actual served default RC, one voltage probe; native mouse and keyboard, real screen matrices and isolated local storage. All server API writes blocked. Not full-source drawing, all probe kinds or large-circuit performance coverage. Live server was not a pinned build.',
    'simulationBoundary': 'Scripts did not click Run. The application may auto-run its default RC analysis; waveform correctness was not validated.',
    'supersededAttempts': [
        {'evidence': 'live-zoom-1/evidence.json', 'reason': 'Harness compared fractional requested cursor to integer Chromium wheel coordinates. Rounded input point resolves the mismatch; all eight rerun scenarios retained.'},
        {'evidence': 'live-probes-1/evidence.json', 'reason': 'Harness expected rounded cursor center after conductor projection, ignoring grab offset. Correct comparison checks W1 identity, conductor x and live tip y. All sixteen scenarios rerun and retained.'}
    ],
    'productCodeChanged': False,
}
(base / 'interaction-audit.json').write_text(json.dumps(audit, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
progress = json.loads((base / 'progress.json').read_text(encoding='utf8'))
progress.update(interactionScenariosCompleted=len(seen), interactionScenariosByCategory=counts,
                interactionEvidence=str(base / 'interaction-audit.json').replace('\\', '/'))
(base / 'progress.json').write_text(json.dumps(progress, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
print(json.dumps({'completed': len(seen), 'counts': counts, 'imagesVerified': len(images)}))
