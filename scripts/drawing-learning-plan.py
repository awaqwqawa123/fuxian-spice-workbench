"""Prepare a finite reading queue and preserve evidence for a selected phase."""
from pathlib import Path
import ast
import gzip
import hashlib
import html
import json
import math
import sys

sys.stdout.reconfigure(encoding="utf8")
BASE = Path("docs/artifacts/drawing-learning-20261004")
PLAN = Path("docs/research/drawing-learning-plan.json")
corpus = Path("docs/artifacts/local-library-complete-20261002")
if not corpus.exists():
    corpus = Path("../../spice-workbench/docs/artifacts/local-library-complete-20261002")
records = {c["relative"]: c for c in json.loads(gzip.decompress((corpus / "ltspice.json.gz").read_bytes()))}
definitions = json.loads(gzip.decompress((corpus / "symbol-definitions.json.gz").read_bytes()))
plan = json.loads(PLAN.read_text(encoding="utf8"))
previous = json.loads(Path("docs/artifacts/drawing-study-20261004/evidence.json").read_text(encoding="utf8"))
prior = {c["relative"] for c in previous["cases"]}
queue = []
for phase in plan["phases"]:
    assert len(phase["cases"]) == (16 if phase["id"] < "S09" else 24 if phase["id"] == "S09" else 0)
    for path in phase["cases"]:
        assert path in records, (phase["id"], "missing", path)
        assert path not in prior, (phase["id"], "prior batch", path)
        c = records[path]
        queue.append({"phase": phase["id"], "relative": path, "source": c["source"], "sha256": c["sha256"], "layoutSignature": c["layoutSignature"], "symbols": len(c["symbols"]), "wires": len(c["wires"]), "status": phase["status"] if phase["status"] != "planned" else "queued"})
assert len(queue) == 152
assert len({c["relative"] for c in queue}) == 152
assert len({c["layoutSignature"] for c in queue}) == 152
BASE.mkdir(parents=True, exist_ok=True)
(BASE / "queue.json").write_text(json.dumps({"planId": plan["planId"], "review": 128, "heldOut": 24, "meaning": "Scheduled topic review, not completed reading or new corpus files; held-out cases excluded from this round's rule extraction.", "cases": queue}, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
mode = sys.argv[1] if len(sys.argv) > 1 else "queue"
if mode == "queue":
    print("Queue validated: 128 review candidates + 24 held-out candidates; distinct source paths and signatures; excluded previous 48-case batch.")
    sys.exit(0)
phase_id = sys.argv[2]
out = BASE / phase_id
if mode == "prepare":
    phase = next(p for p in plan["phases"] if p["id"] == phase_id)
    # Reuse only pure SVG helpers; do not execute the old generator's file writes.
    tree = ast.parse(Path("scripts/drawing-study-20261004.py").read_text(encoding="utf8"))
    helper_names = {"transform", "graphic", "render"}
    module = ast.Module(body=[n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in helper_names], type_ignores=[])
    namespace = {"math": math, "html": html}
    exec(compile(module, "drawing-study-render-helpers", "exec"), namespace)
    cases, symbols = [], {}
    out.mkdir(parents=True, exist_ok=True)
    for i, path in enumerate(phase["cases"], 1):
        c = {**records[path], "studyId": f"{phase_id}-{i:02d}"}
        raw = Path(c["source"]).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == c["sha256"]
        c["originalLines"] = raw.decode(c["encoding"]).splitlines()
        originals = {}
        for s in c["symbols"]:
            d = definitions[s["sourceASY"]]
            raw = Path(d["source"]).read_bytes()
            assert hashlib.sha256(raw).hexdigest() == d["sha256"]
            text = raw.decode(d["encoding"])
            originals[d["source"]] = text
            symbols[d["source"]] = {**d, "originalLines": text.splitlines()}
            assert len(s["pins"]) == len(d["pins"])
            for p, original in zip(s["pins"], d["pins"]):
                x, y = namespace["transform"](original["x"], original["y"], s["orientation"])
                assert p["p"] == [s["p"][0] + x, s["p"][1] + y]
                assert p["name"] == original.get("PinName") and p["SpiceOrder"] == original.get("SpiceOrder")
        (out / (c["studyId"] + ".svg")).write_text(namespace["render"](c, originals), encoding="utf8")
        cases.append(c)
    counts = {"cases": len(cases), "ASC_lines": sum(len(c["originalLines"]) for c in cases), "unique_ASY": len(symbols), "ASY_lines": sum(len(d["originalLines"]) for d in symbols.values()), "wires": sum(len(c["wires"]) for c in cases), "symbolInstances": sum(len(c["symbols"]) for c in cases)}
    (out / "evidence.json.gz").write_bytes(gzip.compress(json.dumps({"phase": phase_id, "method": "Original source and pin verification; approximate structural SVG, no native GUI or simulation. Preparation does not mark reading complete.", "counts": counts, "cases": cases, "symbolDefinitions": symbols}, ensure_ascii=False, indent=2).encode("utf8"), mtime=0))
    for batch in range(math.ceil(len(cases) / 4)):
        sections = "".join(f'<section><h2>{c["studyId"]} {html.escape(c["relative"])}</h2><img src="{c["studyId"]}.svg"></section>' for c in cases[batch*4:batch*4+4])
        (out / f"sheet-{batch+1}.html").write_text('<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#edf3ef;font-family:Arial}header{padding:12px}main{display:grid;grid-template-columns:1fr 1fr}section{margin:8px;background:white;padding:12px}h2{font-size:15px;margin:0}img{width:720px;height:520px}</style><header>Learning plan · '+phase_id+' · Source-derived structural views; approximate text, not native LTspice screenshots</header><main>'+sections+'</main>', encoding="utf8")
    print(json.dumps(counts))
elif mode == "read":
    data = json.loads(gzip.decompress((out / "evidence.json.gz").read_bytes()))
    start, end = map(int, sys.argv[3:5])
    for c in data["cases"][start-1:end]:
        print("\n###", c["studyId"], c["relative"])
        print("WIRES:", "; ".join(f'L{w["line"]}:{w["p"]}' for w in c["wires"]))
        print("FLAGS:", "; ".join(f'L{f["line"]}:{f["name"]}@{f["p"]}' for f in c["flags"]))
        for s in c["symbols"]:
            print(f'L{s["line"]}', s["name"], s["orientation"], s["attributes"], "PINS", [(p["name"], p["SpiceOrder"], p["p"]) for p in s["pins"]])
        print("TEXT:", c["textsAndDirectives"])
elif mode == "summary":
    data = json.loads(gzip.decompress((out / "evidence.json.gz").read_bytes()))
    notes = json.loads((out / "notes.json").read_text(encoding="utf8"))
    assert [n["id"] for n in notes] == [c["studyId"] for c in data["cases"]]
    for original in [*data["cases"], *data["symbolDefinitions"].values()]:
        raw = Path(original["source"]).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == original["sha256"]
        assert raw.decode(original["encoding"]).splitlines() == original["originalLines"]
    parts = [f"# {phase_id}：{len(notes)} 例逐例阅读定位", "", "所有图均为原坐标结构重建，不是原生 LTspice 截图；本阶段未仿真。每例引用 ASC 一基行号，完整原文与 ASY 在同目录 evidence.json.gz。", ""]
    for c, n in zip(data["cases"], notes):
        parts += [f"## {c['studyId']} · {c['relative']}", "", n["lesson"], "", "适用边界：" + n["boundary"], "", f"[原文]({c['source']}) · [结构图]({c['studyId']}.svg)", "", "```text"]
        for line in n["lines"]:
            assert 1 <= line <= len(c["originalLines"])
            parts.append(f"L{line}: {c['originalLines'][line-1]}")
        parts += ["```", ""]
    sheets = math.ceil(len(data["cases"]) / 4)
    for i in range(1, sheets + 1):
        assert (out / f"sheet-{i}.png").read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
    (out / "reading-ledger.md").write_text("\n".join(parts), encoding="utf8")
    (out / "audit.json").write_text(json.dumps({"counts": data["counts"], "sourceFilesVerified": len(data["cases"]) + len(data["symbolDefinitions"]), "notesVerified": len(notes), "sheetsPresent": sheets, "scope": "Source hashes/text, note line ranges and artifact presence; not native rendering, simulation or all product layouts."}, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(f"{len(notes)} notes and source references verified; {len(data['cases']) + len(data['symbolDefinitions'])} original sources unchanged; {sheets} PNG sheets present.")
else:
    raise ValueError("Expected queue, prepare or read")
