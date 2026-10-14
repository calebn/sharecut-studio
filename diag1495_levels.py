"""#1495 diagnostic 2: per word, each track's chain-free level with NO offset, plus profiles, echo pairs and
whether the other tracks' transcripts have a word over the same seconds. Numbers only (no text, no audio).

Run it on the fix/1495-raw-levels tree (e2285d7), which reads the chain-free evidence:
  .venv/bin/python diag1495_levels.py <project_dir> out_levels.tsv out_profiles.json
Rows: every transcript word the audibility map visits (join with the earlier main TSV on track+start).
"""
import json, sys
import numpy as np
import podcast_mcp.engines.audio_audit as aa
from podcast_mcp.project_io import open_project

_, project = open_project(sys.argv[1])
caches = aa.build_reconciliation_caches(project)

calls = []
orig = aa._track_levels
def wrapped(project, track_ids, t0, t1, lags, caches_, offsets):
    raw = orig(project, track_ids, t0, t1, lags, caches_, {})
    calls.append((t0, t1, raw, dict(lags)))
    return orig(project, track_ids, t0, t1, lags, caches_, offsets)
aa._track_levels = wrapped
rows = aa.compute_word_audibility_map(project, caches=caches)
aa._track_levels = orig

skip = {"zero_duration_word", "sandwiched_zero_duration_word", aa.ANOMALOUS_WORD_DURATION_REASON}
lanes = {lane.track_id: lane.transcript.words for lane in aa.lanes_transcripts(project, aa.dialogue_track_ids(project))}
tids = list(caches.caches)
out = open(sys.argv[2], "w")
out.write("track\tstart\tend\thead_status\thead_dominant\t" + "\t".join(f"raw_{t}" for t in tids)
          + "\t" + "\t".join(f"cover_{t}" for t in tids) + "\n")
k = 0
for r in rows:
    if r.get("reason") in skip or r["own_rms_db"] is None and not r["track_rms_db"]:
        continue
    if k >= len(calls):
        break
    t0, t1, raw, lags = calls[k]
    k += 1
    cover = []
    for t in tids:
        if t == r["track_id"]:
            cover.append("")
            continue
        over = sum(max(0.0, min(w.end, r["end"]) - max(w.start, r["start"])) for w in lanes.get(t, []))
        cover.append(f"{over / max(1e-6, r['end'] - r['start']):.2f}")
    out.write("\t".join([r["track_id"], f"{r['start']:.2f}", f"{r['end']:.2f}", r["audibility_status"],
                         str(r.get("dominant_track"))] + [f"{raw.get(t, float('nan')):.2f}" for t in tids] + cover) + "\n")
out.close()
prof = {"tracks": {}, "echo_pairs": [], "calls": len(calls), "rows": len(rows)}
for tid, c in caches.caches.items():
    p = c.profile
    prof["tracks"][tid] = {"room_db": p.room_db, "speech_db": p.speech_db, "loud_db": p.loud_db,
        "voice_db": p.voice_db, "path_reference_db": p.path_reference_db,
        "audibility_floor_db": p.audibility_floor_db, "voice_gain": p.voice_gain}
for e in caches.echo_pairs():
    prof["echo_pairs"].append({kk: getattr(e, kk) for kk in (
        "source_track_id", "bleed_track_id", "dominated_frames", "copy_frames",
        "consistent_frames", "lag_ms", "level_db", "null_copy_rate", "null_consistent_rate")})
json.dump(prof, open(sys.argv[3], "w"), indent=1, default=str)
print("wrote", sys.argv[2], sys.argv[3], "calls", len(calls), "rows", len(rows))
