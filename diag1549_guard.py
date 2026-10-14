"""#1549 diagnostic: what the peer guard saw on every span it called "peer speaks". Numbers only.

usage (any tree): .venv/bin/python diag1549_guard.py <project_dir> out.json
Runs propose_tighten on the project (use the Daniela clone; it does not touch audio) and records, for each
_peer_speaks_near_span call that returned True, the owner/peer ids, the span, the track gains, and the frames
the guard read (level per 50 ms frame in dB as the guard sees them, and its 'peer owns this frame' mask).
"""
import json, sys
import numpy as np
import podcast_mcp.edits.speech_energy_guard as g
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService

ws = ProjectWorkspace.open(sys.argv[1])
project = ws.project if hasattr(ws, "project") else ws.get_project()
gains = {t.id: t.gain_db for t in project.tracks}
state = {"frames": None}
kept = []
orig_frames, orig_near = g._owned_peer_frames, g._peer_speaks_near_span

def frames(project_, peer, start, end, **kw):
    res = orig_frames(project_, peer, start, end, **kw)
    if state["frames"] is not None and res is not None:
        owners = {}
        for tid in kw.get("owner_track_ids", ()):
            lv = g.timeline_frame_levels_db(project_, tid, start, end, frame_sec=g.LEVEL_FRAME_SEC,
                                            hop_sec=g.LEVEL_FRAME_SEC, caches=kw.get("caches"))
            owners[tid] = None if lv is None else [round(float(x), 1) for x in lv]
        state["frames"].append({"start": start, "end": end, "peer_levels": [round(float(x), 1) for x in res.levels],
                                "peer_own": [int(x) for x in res.own], "owner_levels": owners})
    return res

def near(project_, peer, span, **kw):
    state["frames"] = []
    out = orig_near(project_, peer, span, **kw)
    if out is True:
        kept.append({"peer": peer, "owners": sorted(kw.get("owner_track_ids", ())), "span": [round(span[0], 3), round(span[1], 3)],
                     "dominance_db": kw.get("dominance_db"), "frames": state["frames"]})
    state["frames"] = None
    return out

g._owned_peer_frames, g._peer_speaks_near_span = frames, near
proposal = EditService(ws).propose_tighten()
payload = proposal.to_payload()
asks = [{"track": e.get("track_id"), "start": e.get("start"), "end": e.get("end"), "reason": (e.get("reason") or "").split(":other_speaking")[0][:40],
         "peers": (e.get("reason") or "").split(":other_speaking:")[1] if ":other_speaking:" in (e.get("reason") or "") else None}
        for e in payload.get("edits", [])]
json.dump({"gains": gains, "asks": asks, "kept": kept}, open(sys.argv[2], "w"))
print("asks", len(asks), "with other_speaking", sum(1 for a in asks if a["peers"]), "guard-true spans", len(kept))
