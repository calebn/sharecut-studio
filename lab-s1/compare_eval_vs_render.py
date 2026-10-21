"""usage: python compare_eval_vs_render.py <episode.project.json>   (run from a repo checkout, PYTHONPATH=src)

For each dialogue track of the project as saved: the reason the S1 evaluator declines (if it does),
else evaluator vs ffmpeg render of the same tree (chains left out): length, max 100 ms and 10 ms
frame RMS difference in dB over frames above -70 dBFS, max sample difference. Read-only: works on a
copy of the project in memory; the render goes to a temp dir. Never uploads audio.
"""
import sys, tempfile
from pathlib import Path
import numpy as np
from podcast_mcp.config import load_defaults
from podcast_mcp.engines import audio_eval
from podcast_mcp.engines.audio import MaskAudio, OffSpeakerAudio, SourceAudio, postorder
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


def reason(audio, curve):
    if curve != "tri":
        return f"curve {curve}"
    if any(isinstance(n, MaskAudio) for n in postorder(audio)):
        return "MaskAudio (bleed restore)"
    if not audio_eval.single_layout(audio):
        return "mixed channel layouts"
    if audio_eval._rereads_earlier_source(audio):
        return "duplicated/reordered source slice"
    return None


def frames(x, n):
    k = n // 80 * 80
    return 10 * np.log10(np.mean(x[:k].astype(np.float64).reshape(-1, 80) ** 2, axis=1) + 1e-12)


for tid in sorted(dialogue_track_ids(project)):
    track = project.track_by_id(tid)
    plain = unfiltered_track_audio(project, track, defaults)
    if plain is None:
        print(tid, "DECLINED by unfiltered_track_audio (gate/envelope/no clips/chain)"); continue
    audio, curve = plain
    r = reason(audio, curve)
    evaluated = None if r else audio_eval.evaluate_audio(audio, crossfade_curve=curve, load_source=load_mono_full)
    if evaluated is None:
        print(tid, "FALLBACK", r or "evaluator returned None (mute/crossfade overlap longer than a side, ...)"); continue
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
