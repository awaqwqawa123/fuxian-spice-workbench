"""Extract selected declarations after reading them; do not count source cases."""
from pathlib import Path
import hashlib
import json
import re
import sys

BASE = Path('docs/artifacts/drawing-learning-full-20261004')
ROOT = Path('C:/Users/23983/AppData/Local/LTspice/lib/cmp')
sys.stdout.reconfigure(encoding='utf8')


def extract(batch, filename, names):
    source = ROOT / filename
    raw = source.read_bytes()
    # Installed MOS/BJT tables have UTF-16LE text without a BOM.
    encoding = 'utf-16-le' if raw[:4:2] == b'* ' and raw[1:4:2] == b'\x00\x00' else 'latin1'
    lines = raw.decode(encoding).splitlines()
    declarations = []
    for name in names:
        hits = [i for i, line in enumerate(lines)
                if re.match(r'\s*\.model\s+' + re.escape(name) + r'\s', line, re.I)]
        assert len(hits) == 1, (filename, name, hits)
        start = hits[0]
        end = start + 1
        while end < len(lines) and lines[end].lstrip().startswith('+'):
            end += 1
        declarations.append({'name': name, 'startLine': start + 1, 'endLine': end,
                             'text': '\n'.join(lines[start:end])})
    stem = filename.split('.')[1]
    excerpt = f'standard-{stem}-required.txt'
    content = '\n\n'.join(d['text'] for d in declarations) + '\n'
    (BASE / batch / excerpt).write_bytes(content.encode('utf8'))
    evidence = {'source': str(source), 'sha256': hashlib.sha256(raw).hexdigest(),
                'encoding': encoding, 'status': 'necessary_declarations_read_complete',
                'declarations': declarations, 'evidence': excerpt,
                'evidenceSha256': hashlib.sha256(content.encode('utf8')).hexdigest(),
                'scope': 'Only the selected necessary complete declarations have been read; no simulation.'}
    (BASE / batch / f'standard-{stem}-evidence.json').write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print(batch, filename, encoding, ', '.join(names))


if __name__ == '__main__':
    extract(sys.argv[1], sys.argv[2], sys.argv[3:])
