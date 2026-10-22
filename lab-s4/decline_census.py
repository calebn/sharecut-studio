"""usage: python decline_census.py <clone.project.json>   (PYTHONPATH=src, venv; read-only, no ffmpeg, seconds)

How often would the in-memory evidence path decline to the render (#1958)?  Per dialogue track:
volume-envelope points and clips where the heard render adds a bleed-restore step (off_speaker_mute_regions
plus bleed_restore.regions, gate off) are the only DECLINES; saved active chains are shown but are dropped before evaluation; and across the pending edits,
how many overlap a clip's mute spans (the cuts that need the heard cache at all).
"""
import sys
from pathlib import Path
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.tracks import dialogue_track_ids

ws = ProjectWorkspace.open(Path(sys.argv[1]))
p = ws.project
rows = []
for tid in sorted(dialogue_track_ids(p)):
    clips = [c for c in p.clips if c.track_id == tid]
    env = p.volume_envelope_for(tid)
    env_pts = len(env.points) if env and env.points else 0
    restore = sum(1 for c in clips if c.off_speaker_mute_regions and c.bleed_restore and c.bleed_restore.regions)
    chains = sum(1 for ch in p.processing_chains if ch.track_id == tid and any(not fx.bypass for fx in ch.effects))
    mute_clips = sum(1 for c in clips if c.mute_regions)
    rows.append((tid, len(clips), env_pts, restore, chains, mute_clips))
    print(f"{tid}: clips={len(clips)} envelope_points={env_pts} bleed_restore_clips={restore} active_chains={chains} clips_with_mutes={mute_clips}")
# active chains do NOT decline: the evidence/heard paths drop them before evaluating (#1495, audio_audit._ungated_cache).
declined = [r[0] for r in rows if r[2] or r[3]]
print("tracks that would decline to the render:", declined or "none", f"({len(declined)} of {len(rows)})")
pending = [e for e in p.edit_decisions if not e.applied]
over = 0
for e in pending:
    for c in p.clips:
        if c.track_id != e.track_id:
            continue
        spans = c.mute_regions  # source seconds, like edit start/end
        if any(r.start_s < e.end and e.start < r.end_s for r in spans):
            over += 1
            break
print(f"pending edits={len(pending)}; overlapping a clip mute region (need heard cache): {over}")
