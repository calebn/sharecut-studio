"""Pin the exact wire output of off-speaker mute across every surface."""

from __future__ import annotations

import json
import wave
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.edits import off_speaker_mute as edits_module
from podcast_mcp.mcp.tools import transcript
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.project.store import save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import AnalysisService
from podcast_mcp.services.jobs import run_audio_edit
from podcast_mcp.util.coded_error import CodedError
from test_off_speaker_mute import _speechlike

pytestmark = pytest.mark.unscoped_ok

_RATE = 16000
_SECONDS = 12
_SPOKEN = [round(a + 0.4 * k, 2) for a, n in ((1.0, 7), (8.0, 5)) for k in range(n)]


def _write_wav(path: Path, samples: np.ndarray) -> None:
    pcm = np.clip(samples, -1.0, 1.0)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(_RATE)
        out.writeframes((pcm * 32767).astype("<i2").tobytes())


def _track(project: EpisodeProject, tid: str, media_sec: float) -> None:
    project.timeline.tracks.append(
        Track(
            id=tid,
            label=tid,
            role=TrackRole.DIALOGUE,
            speaker=tid.title(),
            media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=media_sec),
        )
    )
    project.timeline.clips.append(
        Clip(
            id=f"c-{tid}",
            track_id=tid,
            source_start=0.0,
            source_end=float(_SECONDS),
            timeline_start=0.0,
        )
    )


def _build(tmp_path: Path, kind: str, *, guest_media_sec: float = float(_SECONDS)):
    """A host and a guest whose mic carries a quiet copy of the host.

    ``gap``: the guest speaks (2.4-2.8) in a hole of the host's words, so the plan
    has several regions and one kept gap. ``base``: no such hole. ``quiet``: no
    copy at all. ``nocopy``: unrelated noise on the guest. ``solo``: guest only.
    """
    rng = np.random.default_rng(7)
    host = np.zeros(_RATE * _SECONDS)
    guest = np.zeros(_RATE * _SECONDS)
    for a, b in ((1.0, 4.0), (8.0, 10.0)):
        voice = _speechlike(rng, b - a, _RATE)
        lo, hi = round(a * _RATE), round(b * _RATE)
        host[lo:hi] = voice
        if kind != "quiet":
            guest[lo + 320 : hi + 320] += voice[: hi - lo] * 0.04
    guest[6 * _RATE : 7 * _RATE] = _speechlike(rng, 1.0, _RATE) * 2.0
    if kind == "nocopy":
        guest += _speechlike(rng, 12.0, _RATE)[: guest.size] * 0.1
    own_gap = kind == "gap"
    if own_gap:
        own = _speechlike(rng, 0.4, _RATE) * 2.0
        start = round(2.4 * _RATE)
        guest[start : start + own.size] = own
    room = rng.standard_normal(host.size) * 1e-4
    (tmp_path / "raw").mkdir()
    _write_wav(tmp_path / "raw" / "host.wav", host + room)
    _write_wav(tmp_path / "raw" / "guest.wav", guest + room)

    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    if kind != "solo":
        _track(project, "host", float(_SECONDS))
    _track(project, "guest", guest_media_sec)
    heard = [a for a in _SPOKEN if not (own_gap and 2.2 <= a <= 2.6)]
    guest_words = [TranscriptWord(text="mine", start=6.1, end=6.9)] + [
        TranscriptWord(text="bleed", start=a, end=a + 0.35, suppressed=True) for a in _SPOKEN[:7]
    ]
    if own_gap:
        guest_words.append(TranscriptWord(text="hey", start=2.4, end=2.8))
    project.transcripts = [
        Transcript(track_id="guest", words=guest_words),
        *(
            []
            if kind == "solo"
            else [
                Transcript(
                    track_id="host",
                    words=[TranscriptWord(text="w", start=a, end=a + 0.35) for a in heard],
                )
            ]
        ),
    ]
    return ProjectWorkspace.open(save_project(project))


def _dump(value: dict[str, Any]) -> str:
    return json.dumps(value, indent=2)


def _cli_text(result) -> str:
    assert result.exit_code == 0, result.output
    assert result.output.endswith("\n")
    return result.output[:-1]


def _cli_args(ws: ProjectWorkspace, track: str, *flags: str) -> list[str]:
    return ["edit", "mute-off-speaker", "--project", str(ws.path), "--track", track, *flags]


def _preview_surface(surface: str, ws: ProjectWorkspace, track: str) -> str:
    if surface == "service":
        return _dump(AnalysisService(ws).preview_off_speaker_mute(track_id=track))
    if surface == "service_apply_false":
        return _dump(AnalysisService(ws).mute_off_speaker(track_id=track, apply=False))
    if surface == "cli":
        return _cli_text(CliRunner().invoke(app, _cli_args(ws, track, "--dry-run")))
    if surface == "mcp_apply_false":
        return transcript.mute_off_speaker_tool(str(ws.path), track_id=track, apply=False)
    return transcript.mute_off_speaker_tool(str(ws.path), track_id=track, dry_run=True)


def _apply_surface(surface: str, ws: ProjectWorkspace, track: str) -> str:
    if surface == "service":
        return _dump(AnalysisService(ws).mute_off_speaker(track_id=track))
    if surface == "job":
        return _dump(run_audio_edit(ws, "mute_off_speaker", {"track_id": track}, lock_timeout=5.0))
    if surface == "cli":
        return _cli_text(CliRunner().invoke(app, _cli_args(ws, track)))
    return transcript.mute_off_speaker_tool(str(ws.path), track_id=track)


_PREVIEW_SURFACES = ["service", "service_apply_false", "cli", "mcp_apply_false", "mcp_dry_run"]
_APPLY_SURFACES = ["service", "cli", "mcp", "job"]


def _regions(ws: ProjectWorkspace) -> list[tuple[float, float]]:
    return [
        (r.start_s, r.end_s)
        for c in ProjectWorkspace.open(ws.path).project.clips
        if c.track_id == "guest"
        for r in c.off_speaker_mute_regions
    ]


_PREVIEW_GAP = """
{
  "dry_run": true,
  "track_id": "guest",
  "region_count": 3,
  "muted_sec": 4.68,
  "audible_muted_sec": 4.36,
  "quiet_muted_sec": 0.32,
  "own_word_overlap_sec": 0.0,
  "kept_uncorrelated_sec": 0.0,
  "leak_ratio_db": -28.2,
  "kept_own_word_sec": 0.64,
  "kept_own_energy_sec": 0.0,
  "already_quiet_sec": 0.0,
  "refusal": null,
  "still_audible_sec": 0.0,
  "still_audible_copy_sec": 0.0,
  "judged_words": [
    {
      "start": 2.4,
      "end": 2.8,
      "verdict": "own",
      "correlation": 0.4,
      "level_over_peer_db": 3.9,
      "over_copy_db": 32.1,
      "text": "hey",
      "source": [
        2.4,
        2.8
      ]
    }
  ],
  "kept_gaps": [
    {
      "start": 2.28,
      "end": 2.92,
      "reason": "own_word",
      "words": [
        {
          "text": "hey",
          "source": [
            2.4,
            2.8
          ],
          "timeline": [
            2.4,
            2.8
          ]
        }
      ]
    }
  ],
  "regions": [
    {
      "start": 0.92,
      "end": 2.28,
      "duration": 1.36,
      "peer_tracks": [
        "host"
      ],
      "audible_sec": 1.26,
      "peak_db": -41.3
    },
    {
      "start": 2.92,
      "end": 4.08,
      "duration": 1.16,
      "peer_tracks": [
        "host"
      ],
      "audible_sec": 1.1,
      "peak_db": -41.6
    },
    {
      "start": 7.92,
      "end": 10.08,
      "duration": 2.16,
      "peer_tracks": [
        "host"
      ],
      "audible_sec": 2.0,
      "peak_db": -41.5
    }
  ]
}
"""

_APPLY_GAP = """
{
  "dry_run": false,
  "track_id": "guest",
  "region_count": 3,
  "muted_sec": 4.68,
  "audible_muted_sec": 4.36,
  "quiet_muted_sec": 0.32,
  "own_word_overlap_sec": 0.0,
  "kept_uncorrelated_sec": 0.0,
  "leak_ratio_db": -28.2,
  "kept_own_word_sec": 0.64,
  "kept_own_energy_sec": 0.0,
  "already_quiet_sec": 0.0,
  "refusal": null,
  "still_audible_sec": 0.0,
  "still_audible_copy_sec": 0.0,
  "judged_words": [
    {
      "start": 2.4,
      "end": 2.8,
      "verdict": "own",
      "correlation": 0.4,
      "level_over_peer_db": 3.9,
      "over_copy_db": 32.1,
      "text": "hey",
      "source": [
        2.4,
        2.8
      ]
    }
  ],
  "kept_gaps": [
    {
      "start": 2.28,
      "end": 2.92,
      "reason": "own_word",
      "words": [
        {
          "text": "hey",
          "source": [
            2.4,
            2.8
          ],
          "timeline": [
            2.4,
            2.8
          ]
        }
      ]
    }
  ],
  "regions": [
    {
      "start": 0.92,
      "end": 2.28,
      "duration": 1.36,
      "peer_tracks": [
        "host"
      ],
      "audible_sec": 1.26,
      "peak_db": -41.3
    },
    {
      "start": 2.92,
      "end": 4.08,
      "duration": 1.16,
      "peer_tracks": [
        "host"
      ],
      "audible_sec": 1.1,
      "peak_db": -41.6
    },
    {
      "start": 7.92,
      "end": 10.08,
      "duration": 2.16,
      "peer_tracks": [
        "host"
      ],
      "audible_sec": 2.0,
      "peak_db": -41.5
    }
  ],
  "applied_count": 3,
  "applied_sec": 4.68,
  "held_count": 0,
  "held_sec": 0,
  "held": []
}
"""

_REAPPLY_GAP = """
{
  "dry_run": false,
  "track_id": "guest",
  "region_count": 0,
  "muted_sec": 0,
  "audible_muted_sec": 0,
  "quiet_muted_sec": 0,
  "own_word_overlap_sec": 0,
  "kept_uncorrelated_sec": 0.0,
  "leak_ratio_db": -28.2,
  "kept_own_word_sec": 0.64,
  "kept_own_energy_sec": 0.0,
  "already_quiet_sec": 0.0,
  "refusal": null,
  "still_audible_sec": 0.0,
  "still_audible_copy_sec": 0.0,
  "judged_words": [
    {
      "start": 2.4,
      "end": 2.8,
      "verdict": "own",
      "correlation": 0.4,
      "level_over_peer_db": 3.9,
      "over_copy_db": 32.1,
      "text": "hey",
      "source": [
        2.4,
        2.8
      ]
    }
  ],
  "kept_gaps": [
    {
      "start": 2.28,
      "end": 2.92,
      "reason": "own_word",
      "words": [
        {
          "text": "hey",
          "source": [
            2.4,
            2.8
          ],
          "timeline": [
            2.4,
            2.8
          ]
        }
      ]
    }
  ],
  "regions": []
}
"""

_PREVIEW_BASE = """
{
  "dry_run": true,
  "track_id": "guest",
  "region_count": 2,
  "muted_sec": 5.32,
  "audible_muted_sec": 5.0,
  "quiet_muted_sec": 0.32,
  "own_word_overlap_sec": 0.0,
  "kept_uncorrelated_sec": 0.0,
  "leak_ratio_db": -28.2,
  "kept_own_word_sec": 0.0,
  "kept_own_energy_sec": 0.0,
  "already_quiet_sec": 0.0,
  "refusal": null,
  "still_audible_sec": 0.0,
  "still_audible_copy_sec": 0.0,
  "judged_words": [],
  "kept_gaps": [],
  "regions": [
    {
      "start": 0.92,
      "end": 4.08,
      "duration": 3.16,
      "peer_tracks": [
        "host"
      ],
      "audible_sec": 3.0,
      "peak_db": -41.1
    },
    {
      "start": 7.92,
      "end": 10.08,
      "duration": 2.16,
      "peer_tracks": [
        "host"
      ],
      "audible_sec": 2.0,
      "peak_db": -41.5
    }
  ]
}
"""

_APPLY_HELD = """
{
  "dry_run": false,
  "track_id": "guest",
  "region_count": 2,
  "muted_sec": 5.32,
  "audible_muted_sec": 5.0,
  "quiet_muted_sec": 0.32,
  "own_word_overlap_sec": 0.0,
  "kept_uncorrelated_sec": 0.0,
  "leak_ratio_db": -28.2,
  "kept_own_word_sec": 0.0,
  "kept_own_energy_sec": 0.0,
  "already_quiet_sec": 0.0,
  "refusal": null,
  "still_audible_sec": 0.0,
  "still_audible_copy_sec": 0.0,
  "judged_words": [],
  "kept_gaps": [],
  "regions": [
    {
      "start": 0.92,
      "end": 4.08,
      "duration": 3.16,
      "peer_tracks": [
        "host"
      ],
      "audible_sec": 3.0,
      "peak_db": -41.1
    },
    {
      "start": 7.92,
      "end": 10.08,
      "duration": 2.16,
      "peer_tracks": [
        "host"
      ],
      "audible_sec": 2.0,
      "peak_db": -41.5
    }
  ],
  "applied_count": 0,
  "applied_sec": 0,
  "held_count": 2,
  "held_sec": 5.32,
  "held": [
    {
      "start": 0.92,
      "end": 4.08,
      "reason": "source_geometry",
      "detail": "recording_extent"
    },
    {
      "start": 7.92,
      "end": 10.08,
      "reason": "source_geometry",
      "detail": "recording_extent"
    }
  ]
}
"""

_PREVIEW_QUIET = """
{
  "dry_run": true,
  "track_id": "guest",
  "region_count": 0,
  "muted_sec": 0,
  "audible_muted_sec": 0,
  "quiet_muted_sec": 0,
  "own_word_overlap_sec": 0,
  "kept_uncorrelated_sec": 0.0,
  "leak_ratio_db": null,
  "kept_own_word_sec": 0.0,
  "kept_own_energy_sec": 0.0,
  "already_quiet_sec": 5.32,
  "refusal": null,
  "still_audible_sec": 0.0,
  "still_audible_copy_sec": 0.0,
  "judged_words": [],
  "kept_gaps": [],
  "regions": []
}
"""

_APPLY_QUIET = """
{
  "dry_run": false,
  "track_id": "guest",
  "region_count": 0,
  "muted_sec": 0,
  "audible_muted_sec": 0,
  "quiet_muted_sec": 0,
  "own_word_overlap_sec": 0,
  "kept_uncorrelated_sec": 0.0,
  "leak_ratio_db": null,
  "kept_own_word_sec": 0.0,
  "kept_own_energy_sec": 0.0,
  "already_quiet_sec": 5.32,
  "refusal": null,
  "still_audible_sec": 0.0,
  "still_audible_copy_sec": 0.0,
  "judged_words": [],
  "kept_gaps": [],
  "regions": []
}
"""

_PREVIEW_NOCOPY = """
{
  "dry_run": true,
  "track_id": "guest",
  "region_count": 0,
  "muted_sec": 0,
  "audible_muted_sec": 0,
  "quiet_muted_sec": 0,
  "own_word_overlap_sec": 0,
  "kept_uncorrelated_sec": 3.32,
  "leak_ratio_db": null,
  "kept_own_word_sec": 0.0,
  "kept_own_energy_sec": 0.0,
  "already_quiet_sec": 0.0,
  "refusal": "no_copy_evidence",
  "still_audible_sec": 0.0,
  "still_audible_copy_sec": 0.0,
  "judged_words": [],
  "kept_gaps": [],
  "regions": []
}
"""

_APPLY_NOCOPY = """
{
  "dry_run": false,
  "track_id": "guest",
  "region_count": 0,
  "muted_sec": 0,
  "audible_muted_sec": 0,
  "quiet_muted_sec": 0,
  "own_word_overlap_sec": 0,
  "kept_uncorrelated_sec": 3.32,
  "leak_ratio_db": null,
  "kept_own_word_sec": 0.0,
  "kept_own_energy_sec": 0.0,
  "already_quiet_sec": 0.0,
  "refusal": "no_copy_evidence",
  "still_audible_sec": 0.0,
  "still_audible_copy_sec": 0.0,
  "judged_words": [],
  "kept_gaps": [],
  "regions": []
}
"""

_PREVIEW_SOLO = """
{
  "dry_run": true,
  "track_id": "guest",
  "region_count": 0,
  "muted_sec": 0,
  "audible_muted_sec": 0,
  "quiet_muted_sec": 0,
  "own_word_overlap_sec": 0.0,
  "kept_uncorrelated_sec": 0.0,
  "leak_ratio_db": null,
  "kept_own_word_sec": 0.0,
  "kept_own_energy_sec": 0.0,
  "already_quiet_sec": 0.0,
  "refusal": "no_other_dialogue_track",
  "still_audible_sec": 0.0,
  "still_audible_copy_sec": 0.0,
  "judged_words": [],
  "kept_gaps": [],
  "regions": []
}
"""

_APPLY_SOLO = """
{
  "dry_run": false,
  "track_id": "guest",
  "region_count": 0,
  "muted_sec": 0,
  "audible_muted_sec": 0,
  "quiet_muted_sec": 0,
  "own_word_overlap_sec": 0.0,
  "kept_uncorrelated_sec": 0.0,
  "leak_ratio_db": null,
  "kept_own_word_sec": 0.0,
  "kept_own_energy_sec": 0.0,
  "already_quiet_sec": 0.0,
  "refusal": "no_other_dialogue_track",
  "still_audible_sec": 0.0,
  "still_audible_copy_sec": 0.0,
  "judged_words": [],
  "kept_gaps": [],
  "regions": []
}
"""

_APPLY_EQUIVALENT = """
{
  "dry_run": false,
  "track_id": "guest",
  "region_count": 3,
  "muted_sec": 4.68,
  "audible_muted_sec": 4.36,
  "quiet_muted_sec": 0.32,
  "own_word_overlap_sec": 0.0,
  "kept_uncorrelated_sec": 0.0,
  "leak_ratio_db": -28.2,
  "kept_own_word_sec": 0.64,
  "kept_own_energy_sec": 0.0,
  "already_quiet_sec": 0.0,
  "refusal": null,
  "still_audible_sec": 0.0,
  "still_audible_copy_sec": 0.0,
  "judged_words": [
    {
      "start": 2.4,
      "end": 2.8,
      "verdict": "own",
      "correlation": 0.4,
      "level_over_peer_db": 3.9,
      "over_copy_db": 32.1,
      "text": "hey",
      "source": [
        2.4,
        2.8
      ]
    }
  ],
  "kept_gaps": [
    {
      "start": 2.28,
      "end": 2.92,
      "reason": "own_word",
      "words": [
        {
          "text": "hey",
          "source": [
            2.4,
            2.8
          ],
          "timeline": [
            2.4,
            2.8
          ]
        }
      ]
    }
  ],
  "regions": [
    {
      "start": 0.92,
      "end": 2.28,
      "duration": 1.36,
      "peer_tracks": [
        "host"
      ],
      "audible_sec": 1.26,
      "peak_db": -41.3
    },
    {
      "start": 2.92,
      "end": 4.08,
      "duration": 1.16,
      "peer_tracks": [
        "host"
      ],
      "audible_sec": 1.1,
      "peak_db": -41.6
    },
    {
      "start": 7.92,
      "end": 10.08,
      "duration": 2.16,
      "peer_tracks": [
        "host"
      ],
      "audible_sec": 2.0,
      "peak_db": -41.5
    }
  ],
  "applied_count": 0,
  "applied_sec": 0,
  "held_count": 0,
  "held_sec": 0,
  "held": []
}
"""


def _t(text: str) -> str:
    return text.strip("\n")


_NO_REGIONS: list[tuple[float, float]] = []
_GAP_REGIONS = [(0.92, 2.28), (2.92, 4.08), (7.92, 10.08)]

_PREVIEW_CASES = [
    pytest.param("gap", float(_SECONDS), _PREVIEW_GAP, id="regions-and-kept-gap"),
    pytest.param("base", float(_SECONDS), _PREVIEW_BASE, id="regions-only"),
    pytest.param("quiet", float(_SECONDS), _PREVIEW_QUIET, id="empty-plan"),
    pytest.param("nocopy", float(_SECONDS), _PREVIEW_NOCOPY, id="refusal-no-copy-evidence"),
    pytest.param("solo", float(_SECONDS), _PREVIEW_SOLO, id="refusal-no-other-track"),
]

_APPLY_CASES = [
    pytest.param("gap", float(_SECONDS), _APPLY_GAP, _GAP_REGIONS, id="regions-and-kept-gap"),
    pytest.param("quiet", float(_SECONDS), _APPLY_QUIET, _NO_REGIONS, id="empty-plan"),
    pytest.param("nocopy", float(_SECONDS), _APPLY_NOCOPY, _NO_REGIONS, id="refusal-no-copy"),
    pytest.param("solo", float(_SECONDS), _APPLY_SOLO, _NO_REGIONS, id="refusal-no-other-track"),
    pytest.param("base", 8.0, _APPLY_HELD, _NO_REGIONS, id="held-regions"),
]


@pytest.mark.parametrize("surface", _PREVIEW_SURFACES)
@pytest.mark.parametrize(("kind", "media_sec", "expected"), _PREVIEW_CASES)
def test_preview_wire_text(tmp_path, surface, kind, media_sec, expected):
    ws = _build(tmp_path, kind, guest_media_sec=media_sec)
    assert _preview_surface(surface, ws, "guest") == _t(expected)


@pytest.mark.parametrize("surface", _PREVIEW_SURFACES)
def test_preview_does_not_touch_the_project(tmp_path, surface):
    ws = _build(tmp_path, "gap")
    before = ws.path.read_bytes()
    _preview_surface(surface, ws, "guest")
    assert ws.path.read_bytes() == before
    assert _regions(ws) == _NO_REGIONS


@pytest.mark.parametrize("surface", _APPLY_SURFACES)
@pytest.mark.parametrize(("kind", "media_sec", "expected", "saved"), _APPLY_CASES)
def test_apply_wire_text(tmp_path, surface, kind, media_sec, expected, saved):
    ws = _build(tmp_path, kind, guest_media_sec=media_sec)
    assert _apply_surface(surface, ws, "guest") == _t(expected)
    assert _regions(ws) == saved


@pytest.mark.parametrize("surface", _APPLY_SURFACES)
def test_reapply_finds_nothing_more(tmp_path, surface):
    ws = _build(tmp_path, "gap")
    assert _apply_surface(surface, ws, "guest") == _t(_APPLY_GAP)
    assert _apply_surface(surface, ws, "guest") == _t(_REAPPLY_GAP)
    assert _regions(ws) == _GAP_REGIONS


@pytest.mark.parametrize("surface", _APPLY_SURFACES)
def test_equivalent_reapply_counts_zero_applied(tmp_path, monkeypatch, surface):
    ws = _build(tmp_path, "gap")
    real = edits_module.plan_off_speaker_mutes
    plan = real(ws.project, "guest", defaults=ws.effective_config())
    assert _apply_surface(surface, ws, "guest") == _t(_APPLY_GAP)
    monkeypatch.setattr(edits_module, "plan_off_speaker_mutes", lambda *a, **k: plan)
    assert _apply_surface(surface, ws, "guest") == _t(_APPLY_EQUIVALENT)
    assert _regions(ws) == _GAP_REGIONS


def test_cli_without_dry_run_applies_and_with_dry_run_only_previews(tmp_path):
    ws = _build(tmp_path, "gap")
    dry = json.loads(_preview_surface("cli", ws, "guest"))
    assert dry["dry_run"] is True
    assert _regions(ws) == _NO_REGIONS
    applied = json.loads(_apply_surface("cli", ws, "guest"))
    assert applied["dry_run"] is False
    assert applied["applied_count"] == 3


def test_mcp_apply_false_and_dry_run_win_over_the_default_apply(tmp_path):
    ws = _build(tmp_path, "gap")
    for flags in ({"apply": False}, {"dry_run": True}, {"apply": False, "dry_run": True}):
        text = transcript.mute_off_speaker_tool(str(ws.path), track_id="guest", **flags)
        assert text == _t(_PREVIEW_GAP)
    assert _regions(ws) == _NO_REGIONS


def test_row_key_order_is_pinned(tmp_path):
    ws = _build(tmp_path, "gap")
    result = json.loads(_apply_surface("service", ws, "guest"))
    assert list(result) == [
        "dry_run",
        "track_id",
        "region_count",
        "muted_sec",
        "audible_muted_sec",
        "quiet_muted_sec",
        "own_word_overlap_sec",
        "kept_uncorrelated_sec",
        "leak_ratio_db",
        "kept_own_word_sec",
        "kept_own_energy_sec",
        "already_quiet_sec",
        "refusal",
        "still_audible_sec",
        "still_audible_copy_sec",
        "judged_words",
        "kept_gaps",
        "regions",
        "applied_count",
        "applied_sec",
        "held_count",
        "held_sec",
        "held",
    ]
    assert list(result["regions"][0]) == [
        "start",
        "end",
        "duration",
        "peer_tracks",
        "audible_sec",
        "peak_db",
    ]
    assert list(result["kept_gaps"][0]) == ["start", "end", "reason", "words"]
    assert list(result["kept_gaps"][0]["words"][0]) == ["text", "source", "timeline"]
    assert list(result["judged_words"][0]) == [
        "start",
        "end",
        "verdict",
        "correlation",
        "level_over_peer_db",
        "over_copy_db",
        "text",
        "source",
    ]


def test_held_rows_key_order_and_detail(tmp_path):
    ws = _build(tmp_path, "base", guest_media_sec=8.0)
    result = json.loads(_apply_surface("service", ws, "guest"))
    assert [list(row) for row in result["held"]] == [["start", "end", "reason", "detail"]] * 2
    assert list(result)[-5:] == [
        "applied_count",
        "applied_sec",
        "held_count",
        "held_sec",
        "held",
    ]


def _kinds(value: dict[str, Any], *names: str) -> dict[str, str]:
    return {name: type(value[name]).__name__ for name in names}


def test_value_types_with_regions_and_a_leak_ratio(tmp_path):
    ws = _build(tmp_path, "gap")
    result = json.loads(_apply_surface("service", ws, "guest"))
    assert _kinds(
        result,
        "dry_run",
        "track_id",
        "region_count",
        "muted_sec",
        "leak_ratio_db",
        "refusal",
        "kept_uncorrelated_sec",
        "applied_count",
        "applied_sec",
        "held_count",
        "held_sec",
        "held",
    ) == {
        "dry_run": "bool",
        "track_id": "str",
        "region_count": "int",
        "muted_sec": "float",
        "leak_ratio_db": "float",
        "refusal": "NoneType",
        "kept_uncorrelated_sec": "float",
        "applied_count": "int",
        "applied_sec": "float",
        "held_count": "int",
        "held_sec": "int",
        "held": "list",
    }
    assert result["kept_uncorrelated_sec"] == 0.0
    # Integral seconds stay floats; only the sums over nothing are ints.
    assert _kinds(result["regions"][2], "audible_sec", "duration", "start") == {
        "audible_sec": "float",
        "duration": "float",
        "start": "float",
    }
    assert result["regions"][2]["audible_sec"] == 2.0


def test_value_types_of_an_empty_plan(tmp_path):
    ws = _build(tmp_path, "quiet")
    result = json.loads(_apply_surface("service", ws, "guest"))
    assert _kinds(
        result,
        "region_count",
        "muted_sec",
        "audible_muted_sec",
        "quiet_muted_sec",
        "own_word_overlap_sec",
        "kept_uncorrelated_sec",
        "leak_ratio_db",
        "already_quiet_sec",
        "refusal",
    ) == {
        "region_count": "int",
        "muted_sec": "int",
        "audible_muted_sec": "int",
        "quiet_muted_sec": "int",
        "own_word_overlap_sec": "int",
        "kept_uncorrelated_sec": "float",
        "leak_ratio_db": "NoneType",
        "already_quiet_sec": "float",
        "refusal": "NoneType",
    }
    assert "applied_count" not in result


def test_value_types_of_a_refusal(tmp_path):
    ws = _build(tmp_path, "nocopy")
    result = json.loads(_apply_surface("service", ws, "guest"))
    assert _kinds(result, "refusal", "leak_ratio_db", "muted_sec") == {
        "refusal": "str",
        "leak_ratio_db": "NoneType",
        "muted_sec": "int",
    }
    assert result["refusal"] == "no_copy_evidence"


def test_value_types_of_a_hold(tmp_path):
    ws = _build(tmp_path, "base", guest_media_sec=8.0)
    result = json.loads(_apply_surface("service", ws, "guest"))
    assert _kinds(result, "applied_count", "applied_sec", "held_count", "held_sec") == {
        "applied_count": "int",
        "applied_sec": "int",
        "held_count": "int",
        "held_sec": "float",
    }
    assert result["held"][0]["detail"] == "recording_extent"


def _raise_surface(surface: str, ws: ProjectWorkspace) -> None:
    if surface == "service_preview":
        AnalysisService(ws).preview_off_speaker_mute(track_id="nobody")
    elif surface == "service_apply":
        AnalysisService(ws).mute_off_speaker(track_id="nobody")
    elif surface == "job":
        run_audio_edit(ws, "mute_off_speaker", {"track_id": "nobody"}, lock_timeout=5.0)
    elif surface == "mcp_apply":
        transcript.mute_off_speaker_tool(str(ws.path), track_id="nobody")
    else:
        transcript.mute_off_speaker_tool(str(ws.path), track_id="nobody", dry_run=True)


@pytest.mark.parametrize(
    "surface", ["service_preview", "service_apply", "job", "mcp_apply", "mcp_dry_run"]
)
def test_unknown_track_is_coded_and_changes_nothing(tmp_path, surface):
    ws = _build(tmp_path, "gap")
    before = ws.path.read_bytes()
    with pytest.raises(CodedError) as caught:
        _raise_surface(surface, ws)
    assert caught.value.code == "track_not_found"
    assert str(caught.value) == "unknown track_id: 'nobody'"
    assert ws.path.read_bytes() == before


@pytest.mark.parametrize("flags", [[], ["--dry-run"]])
def test_cli_unknown_track_error_text(tmp_path, flags):
    ws = _build(tmp_path, "gap")
    result = CliRunner().invoke(app, _cli_args(ws, "nobody", *flags))
    assert result.exit_code == 1
    assert result.output == (
        "Error: unknown track_id: 'nobody' (code track_not_found) "
        "(set PODCAST_DEBUG=1 for the traceback)\n"
    )
    assert _regions(ws) == _NO_REGIONS
