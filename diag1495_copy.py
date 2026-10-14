"""#1495 diagnostic: per word, how the other mics' sound relates to the word by fine-spectrum match
at signed lags (+ = the other mic trails this one). Numbers only, no audio leaves the machine.

usage: .venv/bin/python diag1495_copy.py <project_dir> <out.tsv> [forced.tsv]
forced.tsv: lines "track_id<TAB>start_sec" always included (the changed words and the 6 #1527 words).
Without it: every non-audible word plus every 4th audible word.
"""
import sys
import numpy as np
from podcast_mcp.engines.audio_audit import build_reconciliation_caches, compute_word_audibility_map
from podcast_mcp.engines.copy_timbre import copy_similarity
from podcast_mcp.engines.envelope_lag import COPY_FRAME_SEC, COPY_HOP_SEC
from podcast_mcp.project_io import open_project

_, project = open_project(sys.argv[1])
caches = build_reconciliation_caches(project)
rows = compute_word_audibility_map(project, caches=caches)
forced = set()
if len(sys.argv) > 3:
    for line in open(sys.argv[3]):
        p = line.split()
        if len(p) >= 2:
            forced.add((p[0], round(float(p[1]), 1)))
LAGS = list(range(-44, 45, 2))  # hops of 10 ms: -440..+440 ms
out = open(sys.argv[2], "w")
out.write("track\tstart\tend\ttext\tstatus\tdominant\town_rms\tlevels\tother\tsim0\tbest_lag_ms\tbest_sim\tpath_lag_ms\tpath_sim\tbest_neg_ms\tbest_neg_sim\tbest_pos_ms\tbest_pos_sim\n")
n_aud = 0
for r in rows:
    key = (r["track_id"], round(r["start"], 1))
    if r["audibility_status"] == "audible" and key not in forced:
        n_aud += 1
        if n_aud % 4:
            continue
    if r["own_rms_db"] is None:
        continue
    own = caches.get(r["track_id"])
    if own is None:
        continue
    first = round((r["start"] - own.timeline_offset_sec) / COPY_HOP_SEC)
    last = round((r["end"] - own.timeline_offset_sec - COPY_FRAME_SEC) / COPY_HOP_SEC)
    frames = np.arange(first, max(first, last) + 1)
    for sid in caches.caches:
        if sid == r["track_id"]:
            continue
        sims = {}
        for lag in LAGS:
            try:
                sims[lag] = float(np.median(copy_similarity(
                    caches.path_samples(r["track_id"]), caches.path_samples(sid), frames, lag,
                    sample_rate=own.sample_rate)))
            except Exception:
                sims[lag] = float("nan")
        cp = caches.copy_path(sid, r["track_id"])
        pl = round(cp.lag_sec / COPY_HOP_SEC)
        try:
            ps = float(np.median(copy_similarity(
                caches.path_samples(r["track_id"]), caches.path_samples(sid), frames, pl,
                sample_rate=own.sample_rate)))
        except Exception:
            ps = float("nan")
        best = max(sims, key=lambda k: sims[k] if sims[k] == sims[k] else -9)
        neg = max((k for k in sims if k < 0), key=lambda k: sims[k])
        pos = max((k for k in sims if k > 0), key=lambda k: sims[k])
        lv = ";".join(f"{k}={v:.1f}" for k, v in r["track_rms_db"].items())
        out.write("\t".join(map(str, [
            r["track_id"], round(r["start"], 2), round(r["end"], 2), r["text"], r["audibility_status"],
            r.get("dominant_track"), r["own_rms_db"], lv, sid, round(sims[0], 3), best * 10,
            round(sims[best], 3), round(cp.lag_sec * 1000), round(ps, 3), neg * 10, round(sims[neg], 3),
            pos * 10, round(sims[pos], 3)])) + "\n")
out.close()
print("wrote", sys.argv[2])
