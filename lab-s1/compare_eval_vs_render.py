"""usage: python compare_eval_vs_render.py <episode.project.json>   (run from a repo checkout, PYTHONPATH=src)

For each dialogue track of the project as saved: the reason the evidence path declines (if it does),
else evaluator vs ffmpeg render of the same tree (chains left out): length, max 100 ms and 10 ms
frame RMS difference in dB over frames above -70 dBFS, max sample difference. Read-only: works on a
copy of the project in memory; the render goes to a temp dir. Never uploads audio.
"""
import sys, tempfile
from pathlib import Path
import numpy as np
from podcast_mcp.engines import audio_audit
from podcast_mcp.engines.audio import OffSpeakerAudio, postorder
from podcast_mcp.engines.timeline_render import render_track_from_timeline, unfiltered_track_audio
from podcast_mcp.engines.ungated_audio import load_mono_full
from podcast_mcp.models import load_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.tracks import dialogue_track_ids

ws = ProjectWorkspace.open(Path(sys.argv[1]))
project = ws.project.model_copy(deep=True)
defaults = ws.effective_config()
project.processing_chains = []
for t in project.tracks:
    t.transcript_gate = False


for tid in sorted(dialogue_track_ids(project)):
    track = project.track_by_id(tid)
    plain = unfiltered_track_audio(project, track, defaults)
    if plain is None:
        print(tid, "DECLINED by unfiltered_track_audio (gate/envelope/no clips/chain)"); continue
    audio, curve = plain
    evaluated, why = audio_audit.evaluate_track_audio(plain)
    if evaluated is None:
        print(tid, "FALLBACK", why); continue
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "r.wav"
        render_track_from_timeline(project, track, out, defaults)
        rendered = load_mono_full(out)
    n = min(rendered.size, evaluated.size)
    out10 = []
    for size in (800, 80):
        k = n // size * size
        a = 10 * np.log10(np.mean(rendered[:k].astype(np.float64).reshape(-1, size) ** 2, axis=1) + 1e-12)
        b = 10 * np.log10(np.mean(evaluated[:k].astype(np.float64).reshape(-1, size) ** 2, axis=1) + 1e-12)
        live = a > -70
        out10.append(float(np.abs(a - b)[live].max()) if live.any() else 0.0)
    print(tid, "EVAL", "len render/eval", rendered.size, evaluated.size,
          "max frame dB 100ms %.3f 10ms %.3f" % tuple(out10),
          "max sample diff %.4f" % float(np.abs(rendered[:n] - evaluated[:n]).max()),
          "off-speaker:", any(isinstance(x, OffSpeakerAudio) for x in postorder(audio)))
