"""Reproduce the shipped ngspice model data from pinned Qucs-S source files.

GPL-2.0-or-later for this conversion and its generated model data.
The Qucs community reference models are NOT claimed to be manufacturer originals.
Run from spice-workbench; no network and no arbitrary source execution.
"""
from pathlib import Path
import re, json, hashlib
ROOT = Path(__file__).resolve().parent.parent / "public/models/qucs"


def properties(file):
    text = (ROOT / "upstream" / file).read_text(encoding="utf-8")
    return re.findall(r'Props.append\(new Property\("([^"\n]+)",\s*"([^"\n]+)"', text)


def numeric(value):
    # Qucs permits explicit capacitance units such as 1424.39pF.
    value = re.sub(r"(?<=[0-9pnum])F$", "", value)
    # The selected upstream records contain constants only; never evaluate text.
    if not re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?", value, re.I):
        raise ValueError("Not a SPICE constant: " + value)
    return value


def convert(filename, cpp, tag, kind, ignored, rename):
    source = (ROOT / "upstream" / filename).read_text(encoding="utf-8")
    props = properties(cpp)
    output = ["* Qucs-S community reference models; converted 2026-09-24.",
              "* GPL-2.0-or-later; see COPYING, README.md and upstream/.",
              "* Single transistor / diode model, not a complete multi-die package.",
              "* Original electrical constants retained; _QUCS distinguishes this source."]
    rows, skipped = [], []
    for name, block in re.findall(r"<Component ([^>]+)>(.*?)</Component>", source, re.S):
        if not re.fullmatch(r"[a-z0-9_][a-z0-9_.-]{0,33}", name, re.I):
            continue
        nodes = re.findall(r"<" + re.escape(tag) + r"\s[^>]*>", block)
        if len(nodes) != 1:
            skipped.append({"id": name, "reason": "not one primitive"}); continue
        manufacturer = re.search(r"Manufacturer:\s*([^\r\n<]+)", block)
        # This file is explicitly the International Rectifier reference package.
        mfg = "International Rectifier / Infineon" if kind == "VDMOS" else manufacturer.group(1).strip() if manufacturer else ""
        if not mfg:
            skipped.append({"id": name, "reason": "manufacturer not stated"}); continue
        values = re.findall(r'"([^"\n]*)"\s+[01]', nodes[0])
        if len(values) > len(props):
            raise ValueError("Unexpected property count: " + name)
        # Original Qucs diode libraries use Temp at position 11; IKF was inserted
        # later. The legacy field order is documented by component.cpp loading.
        legacy = kind == "D" and len(values) in (17, 27)
        stored_props = props[:11] + [props[17]] + props[12:17] + props[18:] if legacy else props
        assigned = {key: default for key, default in props}
        assigned.update({key: value for (key, default), value in zip(stored_props, values)})
        # Missing trailing properties use the documented Qucs-S constructor defaults.
        reason = None
        for key, allowed in ignored.items():
            if key in assigned and assigned[key] not in allowed:
                reason = "unsupported non-default property " + key + "=" + assigned[key]; break
        if reason:
            skipped.append({"id": name, "reason": reason}); continue
        electrical = []
        for key, value in assigned.items():
            if key in ignored:
                continue
            if kind == "D" and key == "Ikf" and value in {"0", "0.0"}:
                # Qucs 0 means no high-injection limit. Match its SPICE export:
                # omit IKF rather than send explicit zero (ngspice issue #37).
                continue
            param = rename.get(key, key.upper())
            electrical.append(param + "=" + numeric(value))
        model_type = assigned["Type"].upper() if kind == "Q" else kind
        flag = assigned["Type"] + " " if kind == "VDMOS" else ""
        output += ["", "* " + name + " / " + mfg,
                   ".model " + name + "_QUCS " + model_type + "(" + flag + " ".join(electrical) + ' mfg="' + mfg + '" type="Qucs 单管芯参考")']
        rows.append({"id": name + "_QUCS", "part": name, "manufacturer": mfg, "type": assigned["Type"].upper() if kind == "Q" else "PMOS" if kind == "VDMOS" and assigned["Type"] == "pchan" else "NMOS" if kind == "VDMOS" else "D"})
    return "\n".join(output) + "\n", rows, skipped

common = {"Temp": {"26.85"}, "Area": {"1", "1.0"}, "UseGlobTemp": {"yes"}, "LibName": {"Generic"}, "CompName": {"Generic"}}
bjt = {**common, "Type": {"npn", "pnp"}, "Ffe": {"1", "1.0"}, "Kb": {"0", "0.0"}, "Ab": {"1", "1.0"}, "Fb": {"1", "1.0"}}
diode = {**common, "Ffe": {"1", "1.0"}, "Cp": {"0", "0.0", "0.0 fF"}, "Ttt1": {"0", "0.0"}, "Ttt2": {"0", "0.0"}, "Tm1": {"0", "0.0"}, "Tm2": {"0", "0.0"}, "Symbol": {"normal"}}
vdmos = {"Type": {"pchan", "nchan"}, "Mul": {"1"}, "Thermal": {"off"}, "UseGlobTemp": {"yes"}, "Temp": {"26.85"}, "Rthjc": {"1.0"}, "Cthj": {"10e-6"}, "Rthca": {"1000"}}
manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
manifest["converted"] = []
for src, cpp, tag, kind, ignored, rename, out in [
    ("Transistors.lib", "bjtsub.cpp", "_BJT", "Q", bjt, {}, "transistors.lib"),
    ("Diodes.lib", "diode.cpp", "Diode", "D", diode, {"Cj0": "CJO", "Tbv": "TBV1", "Trs": "TRS1"}, "diodes.lib"),
    ("VDMOS_IR.lib", "vdmos.cpp", "VDMOS", "VDMOS", vdmos, {"VtO": "VTO", "CjO": "CJO"}, "power-mos.lib"),
]:
    text, rows, skipped = convert(src, cpp, tag, kind, ignored, rename)
    data = text.encode("utf-8")
    (ROOT / out).write_bytes(data)
    manifest["converted"].append({"file": out, "upstream": src, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "models": rows, "skipped": skipped})
    print(out, len(rows), "models", len(skipped), "skipped")
(ROOT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
