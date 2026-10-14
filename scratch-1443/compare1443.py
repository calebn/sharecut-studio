"""usage: compare1443.py A B [--rows]  -- A and B are out/ stems like after-g0-aligned.

Prints, for proposals (mute, ripple), word verdicts and bleed-gate spans, how B differs from A.
Proposals and gate spans match within 10 ms."""

import json
import sys
from pathlib import Path

OUT = Path.home() / "projects/ShareCut_Podcast_Test/runs/2026-10-13-issue1443/out"
TOL = float(__import__("os").environ.get("TOL", "0.011"))


def props(stem, mode):
    data = json.loads((OUT / f"{stem}-{mode}.json").read_text() or "{}")
    return sorted(
        (e["track_id"], e["reason"], round(e["start"], 3), round(e["end"], 3), bool(e["review_required"]))
        for e in data.get("edits", [])
    )


def match(a, b, same):
    rest, only_a = list(b), []
    for r in a:
        hit = next((x for x in rest if same(r, x)), None)
        if hit is None:
            only_a.append(r)
        else:
            rest.remove(hit)
    return only_a, rest


def same_prop(r, x):
    return r[:2] == x[:2] and r[4] == x[4] and abs(r[2] - x[2]) <= TOL and abs(r[3] - x[3]) <= TOL


def gate(stem):
    data = json.loads((OUT / f"{stem}-gate.json").read_text() or "{}")
    out = {}
    for c in data.get("candidates", []):
        out[c["track_id"]] = (
            [tuple(s) for s in c.get("attenuation_spans", [])],
            c.get("bleed_reduction"),
        )
    return out


def seconds(spans):
    return sum(b - a for a, b in spans)


def words(stem):
    return json.loads((OUT / f"{stem}-words.json").read_text())


a, b = sys.argv[1], sys.argv[2]
show = "--rows" in sys.argv
for mode in ("mute", "ripple"):
    pa, pb = props(a, mode), props(b, mode)
    oa, ob = match(pa, pb, same_prop)
    print(f"{mode}: {len(pa)} vs {len(pb)}; only first {len(oa)}, only second {len(ob)}")
    if show:
        for r in oa:
            print("   first ", r)
        for r in ob:
            print("   second", r)
wa, wb = words(a), words(b)
for tid in wa:
    fields = ("suppressed", "status", "dominant", "suspect")
    diffs = {f: 0 for f in fields}
    rows = []
    for x, y in zip(wa[tid], wb[tid]):
        for i, f in enumerate(fields, start=3):
            if x[i] != y[i]:
                diffs[f] += 1
                rows.append((x[0], x[1], f, x[i], y[i]))
    print(f"words {tid}: {len(wa[tid])}; differ {diffs}")
    if show:
        for r in rows[:40]:
            print("   ", r)
ga, gb = gate(a), gate(b)
for tid in sorted(set(ga) | set(gb)):
    sa, ra = ga.get(tid, ([], None))
    sb, rb = gb.get(tid, ([], None))
    oa, ob = match(sa, sb, lambda r, x: abs(r[0] - x[0]) <= TOL and abs(r[1] - x[1]) <= TOL)
    print(
        f"gate {tid}: {len(sa)} spans {seconds(sa):.1f}s {ra} vs {len(sb)} spans {seconds(sb):.1f}s {rb};"
        f" unmatched {len(oa)}/{len(ob)}"
    )
