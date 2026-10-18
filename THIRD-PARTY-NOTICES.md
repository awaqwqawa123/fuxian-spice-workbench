# Third-party licenses and public snapshot scope

The root MIT license covers original Fuxian application contributions. It does
not replace existing file notices, third-party licenses, or model-data licenses.
This is a source release with the following separately licensed components:

| Paths | License / notices |
| --- | --- |
| `public/models/qucs/` | GPL-2.0-or-later; preserve `COPYING`, upstream source, README and conversion manifests |
| `scripts/build-qucs-models.py`, `scripts/build-qucs-expansion.ts`, `src/core/qucs-model-expansion.ts` | GPL-2.0-or-later, as marked in these files; the generated registry is not relicensed MIT |
| `public/models/open-source/dvhx/` | GPL-3.0; preserve `LICENSE`, attribution and conversion explanation |
| `public/models/open-source/gsuberland/` | CC0 1.0; preserve source and README |
| `public/models/kicad/` | CC BY-SA 4.0; preserve `LICENSE.CC-BY-SA-4.0`, `UPSTREAM-LICENSE.README`, source attribution and README |
| `scripts/desktop-broker/` | Adapted MIT code from DusuWorks/codex-webui; preserve `LICENSE.dusu` and `NOTICE.md` |
| npm dependencies | Each dependency retains its own license; inspect the installed package notices, including ngspice / WebAssembly engine notices, when redistributing builds |

MIT is not a claim that every file in this repository is MIT-only. Retain the
listed GPL notices and corresponding sources when using or distributing those
components; distributing a combined build requires reviewing its applicable
component obligations, rather than labeling the entire bundle MIT-only.

The maintainer's private LTspice / PSpice / Capture / TINA vendor snapshots,
compiled private catalog, original research examples, and real-project regression
fixtures are excluded. They remain in the private development repository.
The public release includes a selected regression suite with synthetic or public
inputs. Historical tests depending on the private snapshots are not shipped.

Users may import their own models locally under the applicable model terms.
Importing a file does not grant permission to redistribute it. Model parsing or
successful simulation does not certify accuracy across all operating conditions.
