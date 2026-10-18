"""Fetch pinned, licensed model DATA only; never execute downloaded code.

Run from the spice-workbench directory with Python 3. No external dependencies.
The .lib conversion changes syntax/metadata, never the published electrical fit.
"""
import hashlib
import json
import re
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1] / 'public/models/open-source'
PACKAGES = [
    ('gsuberland', 'gsuberland/spice_models', '52bb96a1d1b22be83c409e40b7d7e7f05e461ba7', ['LICENSE', 'README.md', 'LEDs/CREE_XLamp_XP_E2.txt']),
    ('dvhx', 'dvhx/spice-diode-model-js', 'c225e2cc483a9e950528e9cb98ae89c4e15a487a', ['LICENSE', 'README.md', 'models.js']),
]
manifest = []
for name, repo, revision, paths in PACKAGES:
    directory = ROOT / name
    directory.mkdir(parents=True, exist_ok=True)
    for path in paths:
        url = f'https://raw.githubusercontent.com/{repo}/{revision}/{path}'
        data = urlopen(Request(url, headers={'User-Agent': 'SPICE-Workbench model data downloader'}), timeout=25).read(1_000_001)
        if len(data) > 1_000_000:
            raise ValueError('Model data exceeds size limit')
        target = directory / Path(path).name
        target.write_bytes(data)
        manifest.append({'file': f'{name}/{target.name}', 'url': url, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})

led_text = (ROOT / 'gsuberland/CREE_XLamp_XP_E2.txt').read_text(encoding='utf-8')
definitions = []
for block in re.findall(r'^\.model[^\n]*(?:\n\+[^\n]*)*', led_text, re.M | re.I):
    if 'CREE_XLAMP_XP_E2_RED_ORANGE ' not in block:
        definitions.append(block)
assert len(definitions) == 8
(ROOT / 'gsuberland/cree-xpe2.lib').write_text(
    '* CC0 1.0. Author: gsuberland. Source original and license are included.\n'
    '* Extracted 8 distinct forward I-V fits from CREE_XLamp_XP_E2.txt; electrical parameters unchanged.\n'
    '* RED_ORANGE has the same electrical model as RED and is not counted again.\n'
    '* Fits the datasheet 25 C forward curves only; not a full thermal, optical or switching model.\n\n'
    + '\n\n'.join(definitions) + '\n', encoding='utf-8', newline='\n')

js_text = (ROOT / 'dvhx/models.js').read_text(encoding='utf-8')
definitions = []
for match in re.finditer(r'"([A-Za-z0-9_-]+)": \{IS: ([\d.e-]+), N: ([\d.e-]+), RS: ([\d.e-]+)\}, // ([^\n]*)', js_text):
    name, current, ideality, resistance, fit_error = match.groups()
    # Second optimizations are not additional models. Unidentified LEDs and a
    # zener without breakdown data do not belong in the named-device catalogue.
    if name.endswith('_2') or name.startswith('LED_') or name == 'BZV86-2V0':
        continue
    definitions.append(f'* {name}: {fit_error}\n.model {name}_IVFIT D(IS={current} N={ideality} RS={resistance} type="forward-DC-fit")')
assert len(definitions) == 14
(ROOT / 'dvhx/measured-diodes.lib').write_text(
    '* GPL-3.0. Author: Dusan Halicky (dvhx). Original models.js and license are included.\n'
    '* Converted the first fit per named diode to SPICE syntax; numbers are unchanged.\n'
    '* _IVFIT is an explicit name suffix: measured sample FORWARD DC ONLY.\n'
    '* NO reverse breakdown, capacitance, reverse recovery or temperature characterization.\n'
    '* Two-terminal die I-V only: ER1002CT is not a complete three-pin dual diode package.\n\n'
    + '\n\n'.join(definitions) + '\n', encoding='utf-8', newline='\n')
for name, file in [('gsuberland', 'cree-xpe2.lib'), ('dvhx', 'measured-diodes.lib')]:
    data = (ROOT / name / file).read_bytes()
    manifest.append({'file': f'{name}/{file}', 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'conversion': 'scripts/download-open-models.py'})
(ROOT / 'manifest.json').write_text(json.dumps({'downloadedOn': '2026-09-23', 'files': manifest}, indent=2) + '\n', encoding='utf-8', newline='\n')
print('Downloaded 2 licensed packages; produced 22 distinct, explicitly bounded model definitions.')
