"""Audit preserved sources and note references, then assemble the reading ledger."""
from pathlib import Path
from collections import Counter
import hashlib
import json
import math
import sys

sys.stdout.reconfigure(encoding="utf8")
root = Path("docs/artifacts/drawing-study-20261004")
data = json.loads((root / "evidence.json").read_text(encoding="utf8"))
notes = json.loads((root / "notes.json").read_text(encoding="utf8"))
assert len(notes) == 48
assert [n["studyId"] for n in notes] == [c["studyId"] for c in data["cases"]]
references = []
for source in [*data["cases"], *data["symbolDefinitions"].values()]:
    raw = Path(source["source"]).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == source["sha256"], source["source"]
    assert raw.decode(source["encoding"]).splitlines() == source["originalLines"]
    assert len(source["originalLines"]) == source["lines"]

parts = ["# 2026-10-04 LTspice 48 例逐例阅读记录", "",
         "本批 32 份 Applications、16 份 Educational；全部已计入 10 月 2 日的全库结构读取，今天补充深入复核，不增加全库独立案例总数。每例记录独立阅读判断、需要保留的电气关系及原文定位。", "",
         "原始 ASC/ASY 全文与校验和见 [evidence.json](../artifacts/drawing-study-20261004/evidence.json)，人工笔记见 [notes.json](../artifacts/drawing-study-20261004/notes.json)。下方 L 为对应 ASC 一基行号；引脚表的 ASY:L 为原符号引脚定义行号，坐标为原实例旋转/镜像后的世界坐标。", "",
         "已查看八张结构重建图覆盖全部 48 例；这些图保留原导线坐标、ASY 图元与实例变换，但字体、窗口、引脚标题与接点显示不等同于原生 LTspice。它们用于核对分区和路线，不证明原生文字无碰撞。未运行仿真，未执行案例说明中的操作。", ""]
for case, note in zip(data["cases"], notes):
    sid = case["studyId"]
    lines = case["originalLines"]
    counts = Counter(line.split()[0] for line in lines if line.strip())
    for key in ["WIRE", "FLAG", "SYMBOL"]:
        assert counts[key] == case["commandCounts"].get(key, 0), (sid, key)
    for key, collection in [("WIRE", "wires"), ("FLAG", "flags"), ("SYMBOL", "symbols")]:
        assert counts[key] == len(case[collection])
        for item in case[collection]:
            assert lines[item["line"] - 1] == item["text"], (sid, collection)
    for sym in case["symbols"]:
        definition = data["symbolDefinitions"][sym["sourceASY"]]
        assert len(sym["pins"]) == len(definition["pins"])
        angle = math.radians(int(sym["orientation"][1:]))
        co, si = round(math.cos(angle)), round(math.sin(angle))
        for pin, original in zip(sym["pins"], definition["pins"]):
            x = co * original["x"] - si * original["y"]
            y = si * original["x"] + co * original["y"]
            if sym["orientation"][0] == "M":
                x = -x
            assert pin["p"] == [sym["p"][0] + x, sym["p"][1] + y]
            assert pin["name"] == original.get("PinName")
            assert pin["SpiceOrder"] == original.get("SpiceOrder")
            assert definition["originalLines"][original["sourceLine"] - 1].startswith("PIN ")
    parts.extend([f"## {sid} · {case['relative']}", "",
                  f"类别：{note['group']}。原图 {len(case['symbols'])} 个符号、{len(case['wires'])} 段 WIRE。", "",
                  f"**观察与经验：**{note['lesson']}", "", f"**适用边界：**{note['caution']}", "",
                  f"[原始 ASC]({case['source']}) · [结构重建 SVG](../artifacts/drawing-study-20261004/{sid}.svg) · [分组图](../artifacts/drawing-study-20261004/sheet-{(int(sid[1:])-1)//6+1}.png)", "",
                  "关键原文与端口定位：", "",
                  "| 实例 / 原符号 | ASC 定位 | 真实端口：SpiceOrder @ 世界坐标；ASY 行 |",
                  "| --- | --- | --- |"])
    case_refs = []
    for device in note["devices"]:
        matches = [s for s in case["symbols"] if s["attributes"].get("InstName") == device]
        assert len(matches) == 1, (sid, device)
        sym = matches[0]
        inst_line = lines.index("SYMATTR InstName " + device) + 1
        case_refs.extend([sym["line"], inst_line])
        pins = "; ".join(f"{p['name']}:{p['SpiceOrder']} @ ({p['p'][0]},{p['p'][1]}); ASY:L{p['definitionLine']}" for p in sym["pins"])
        parts.append(f"| {device} / {sym['name']} | L{sym['line']} `{sym['text']}`；L{inst_line} 位号 | {pins} |")
    extra = note.get("sourceLines", [])
    for line in extra:
        assert 1 <= line <= len(lines)
        case_refs.append(line)
    nonzero = [f for f in case["flags"] if f["name"] != "0"]
    if nonzero:
        parts.extend(["", "原网标（不含地）：" + "；".join(f"L{f['line']} `{f['name']}` @ ({f['p'][0]},{f['p'][1]})" for f in nonzero) + "。"])
        case_refs.extend(f["line"] for f in nonzero)
    if extra:
        parts.extend(["", "补充原文：", "", "```text", *[f"L{line}: {lines[line-1]}" for line in extra], "```"])
    parts.append("")
    references.append({"studyId": sid, "ASC_lines": sorted(set(case_refs))})

counts = {
    "cases": len(data["cases"]),
    "distinctLayoutSignatures": len(set(c["layoutSignature"] for c in data["cases"])),
    "ASC_lines": sum(len(c["originalLines"]) for c in data["cases"]),
    "unique_ASY": len(data["symbolDefinitions"]),
    "ASY_lines": sum(len(d["originalLines"]) for d in data["symbolDefinitions"].values()),
    "wires": sum(len(c["wires"]) for c in data["cases"]),
    "symbolInstances": sum(len(c["symbols"]) for c in data["cases"]),
}
assert counts == data["counts"]
for case in data["cases"]:
    assert (root / (case["studyId"] + ".svg")).is_file()
for batch in range(1, 9):
    assert (root / f"sheet-{batch}.png").read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
    assert (root / f"sheet-{batch}.html").is_file()
audit = {"counts": counts, "verified": "116 source files match preserved bytes/hashes/lines; all instance pin transforms and identities match ASY; 48 note device references and explicit ASC line references resolve; 48 SVG and 8 HTML/PNG sheets present. This checks evidence integrity, not electrical simulation or native rendering fidelity.", "references": references}
(root / "audit.json").write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
research = Path("docs/research/2026-10-04-ltspice-case-notes.md")
research.parent.mkdir(parents=True, exist_ok=True)
research.write_text("\n".join(parts), encoding="utf8")
print(json.dumps(counts))
print("Source integrity, pin transforms, reading references and artifacts verified.")
