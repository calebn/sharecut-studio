"""Pin the exact wire output of EditService.render_status for projects with a premix."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

import edit_wire_render as rr
from edit_wire_helpers import build_workspace, normalize
from podcast_mcp.services.app import ProjectWorkspace

pytestmark = pytest.mark.unscoped_ok

_SCENARIOS: dict[str, Callable[[Path], ProjectWorkspace]] = {
    "fresh": rr.fresh,
    "clip-shortened-after-render": lambda root: rr.edit(rr.fresh(root), rr.shorten_host_clip),
    "premix-older-than-stems": lambda root: rr.premix(
        rr.hashed(rr.stems(build_workspace(root)), "host", "guest"), mtime=rr.OLD - 1000
    ),
    "fader-moved-after-premix": lambda root: rr.edit(rr.fresh(root), rr.fader),
    "track-muted-after-premix": lambda root: rr.edit(rr.fresh(root), rr.muted),
    "balance-basis": lambda root: rr.edit(rr.fresh(root), rr.balance),
    "reconciliation-flagged": lambda root: rr.edit(rr.fresh(root), rr.flagged),
}

_EXPECTED: dict[str, dict[str, Any]] = {
    "fresh": {
        "invalidations": [],
        "needs_rerender": False,
        "premix": {
            "exists": True,
            "is_stale": False,
            "mtime_sec": 1700000100.0,
            "path": "<ws>/artifacts/premix.wav",
            "size_bytes": 192044,
            "stale_vs_mix": False,
            "stale_vs_stems": False,
        },
        "reconciliation": {
            "fingerprint": "<hash:0>",
            "last_reconciliation_hash": "<hash:0>",
            "reconciliation_stale_flag": False,
            "stale": False,
        },
        "tracks": {
            "guest": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": False,
                "expected_duration_sec": 6.0,
                "render_hash": "<hash:1>",
                "stem_duration_sec": 6.0,
                "stem_exists": True,
                "stem_is_fresh": True,
                "stem_path": "<ws>/artifacts/tracks/guest.wav",
                "stored_hash": "<hash:1>",
            },
            "host": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": False,
                "expected_duration_sec": 6.0,
                "render_hash": "<hash:2>",
                "stem_duration_sec": 6.0,
                "stem_exists": True,
                "stem_is_fresh": True,
                "stem_path": "<ws>/artifacts/tracks/host.wav",
                "stored_hash": "<hash:2>",
            },
        },
    },
    "clip-shortened-after-render": {
        "invalidations": [],
        "needs_rerender": True,
        "premix": {
            "exists": True,
            "is_stale": True,
            "mtime_sec": 1700000100.0,
            "path": "<ws>/artifacts/premix.wav",
            "size_bytes": 192044,
            "stale_vs_mix": False,
            "stale_vs_stems": False,
        },
        "reconciliation": {
            "fingerprint": "<hash:0>",
            "last_reconciliation_hash": "<hash:1>",
            "reconciliation_stale_flag": False,
            "stale": True,
        },
        "tracks": {
            "guest": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": False,
                "expected_duration_sec": 6.0,
                "render_hash": "<hash:2>",
                "stem_duration_sec": 6.0,
                "stem_exists": True,
                "stem_is_fresh": True,
                "stem_path": "<ws>/artifacts/tracks/guest.wav",
                "stored_hash": "<hash:2>",
            },
            "host": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": True,
                "expected_duration_sec": 5.0,
                "render_hash": "<hash:3>",
                "stem_duration_sec": 6.0,
                "stem_exists": True,
                "stem_is_fresh": False,
                "stem_path": "<ws>/artifacts/tracks/host.wav",
                "stored_hash": "<hash:4>",
            },
        },
    },
    "premix-older-than-stems": {
        "invalidations": [],
        "needs_rerender": True,
        "premix": {
            "exists": True,
            "is_stale": True,
            "mtime_sec": 1699999000.0,
            "path": "<ws>/artifacts/premix.wav",
            "size_bytes": 192044,
            "stale_vs_mix": False,
            "stale_vs_stems": True,
        },
        "reconciliation": {
            "fingerprint": "<hash:0>",
            "last_reconciliation_hash": None,
            "reconciliation_stale_flag": False,
            "stale": True,
        },
        "tracks": {
            "guest": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": False,
                "expected_duration_sec": 6.0,
                "render_hash": "<hash:1>",
                "stem_duration_sec": 6.0,
                "stem_exists": True,
                "stem_is_fresh": True,
                "stem_path": "<ws>/artifacts/tracks/guest.wav",
                "stored_hash": "<hash:1>",
            },
            "host": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": False,
                "expected_duration_sec": 6.0,
                "render_hash": "<hash:2>",
                "stem_duration_sec": 6.0,
                "stem_exists": True,
                "stem_is_fresh": True,
                "stem_path": "<ws>/artifacts/tracks/host.wav",
                "stored_hash": "<hash:2>",
            },
        },
    },
    "fader-moved-after-premix": {
        "invalidations": [],
        "needs_rerender": True,
        "premix": {
            "exists": True,
            "is_stale": True,
            "mtime_sec": 1700000100.0,
            "path": "<ws>/artifacts/premix.wav",
            "size_bytes": 192044,
            "stale_vs_mix": True,
            "stale_vs_stems": False,
        },
        "reconciliation": {
            "fingerprint": "<hash:0>",
            "last_reconciliation_hash": "<hash:0>",
            "reconciliation_stale_flag": False,
            "stale": False,
        },
        "tracks": {
            "guest": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": False,
                "expected_duration_sec": 6.0,
                "render_hash": "<hash:1>",
                "stem_duration_sec": 6.0,
                "stem_exists": True,
                "stem_is_fresh": True,
                "stem_path": "<ws>/artifacts/tracks/guest.wav",
                "stored_hash": "<hash:1>",
            },
            "host": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": False,
                "expected_duration_sec": 6.0,
                "render_hash": "<hash:2>",
                "stem_duration_sec": 6.0,
                "stem_exists": True,
                "stem_is_fresh": True,
                "stem_path": "<ws>/artifacts/tracks/host.wav",
                "stored_hash": "<hash:2>",
            },
        },
    },
    "track-muted-after-premix": {
        "invalidations": [],
        "needs_rerender": True,
        "premix": {
            "exists": True,
            "is_stale": True,
            "mtime_sec": 1700000100.0,
            "path": "<ws>/artifacts/premix.wav",
            "size_bytes": 192044,
            "stale_vs_mix": True,
            "stale_vs_stems": False,
        },
        "reconciliation": {
            "fingerprint": "<hash:0>",
            "last_reconciliation_hash": "<hash:0>",
            "reconciliation_stale_flag": False,
            "stale": False,
        },
        "tracks": {
            "guest": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": False,
                "expected_duration_sec": 6.0,
                "render_hash": "<hash:1>",
                "stem_duration_sec": 6.0,
                "stem_exists": True,
                "stem_is_fresh": True,
                "stem_path": "<ws>/artifacts/tracks/guest.wav",
                "stored_hash": "<hash:1>",
            },
            "host": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": False,
                "expected_duration_sec": 6.0,
                "render_hash": "<hash:2>",
                "stem_duration_sec": 6.0,
                "stem_exists": True,
                "stem_is_fresh": True,
                "stem_path": "<ws>/artifacts/tracks/host.wav",
                "stored_hash": "<hash:2>",
            },
        },
    },
    "balance-basis": {
        "invalidations": [],
        "needs_rerender": False,
        "premix": {
            "exists": True,
            "is_stale": False,
            "mtime_sec": 1700000100.0,
            "path": "<ws>/artifacts/premix.wav",
            "size_bytes": 192044,
            "stale_vs_mix": False,
            "stale_vs_stems": False,
        },
        "reconciliation": {
            "fingerprint": "<hash:0>",
            "last_reconciliation_hash": "<hash:0>",
            "reconciliation_stale_flag": False,
            "stale": False,
        },
        "tracks": {
            "guest": {
                "balance_measured_lufs": -20.0,
                "balance_stale": False,
                "balance_ungated": True,
                "duration_mismatch": False,
                "expected_duration_sec": 6.0,
                "render_hash": "<hash:1>",
                "stem_duration_sec": 6.0,
                "stem_exists": True,
                "stem_is_fresh": True,
                "stem_path": "<ws>/artifacts/tracks/guest.wav",
                "stored_hash": "<hash:1>",
            },
            "host": {
                "balance_measured_lufs": -19.5,
                "balance_stale": True,
                "balance_ungated": False,
                "duration_mismatch": False,
                "expected_duration_sec": 6.0,
                "render_hash": "<hash:2>",
                "stem_duration_sec": 6.0,
                "stem_exists": True,
                "stem_is_fresh": True,
                "stem_path": "<ws>/artifacts/tracks/host.wav",
                "stored_hash": "<hash:2>",
            },
        },
    },
    "reconciliation-flagged": {
        "invalidations": [],
        "needs_rerender": False,
        "premix": {
            "exists": True,
            "is_stale": False,
            "mtime_sec": 1700000100.0,
            "path": "<ws>/artifacts/premix.wav",
            "size_bytes": 192044,
            "stale_vs_mix": False,
            "stale_vs_stems": False,
        },
        "reconciliation": {
            "fingerprint": "<hash:0>",
            "last_reconciliation_hash": "<hash:1>",
            "reconciliation_stale_flag": True,
            "stale": True,
        },
        "tracks": {
            "guest": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": False,
                "expected_duration_sec": 6.0,
                "render_hash": "<hash:2>",
                "stem_duration_sec": 6.0,
                "stem_exists": True,
                "stem_is_fresh": True,
                "stem_path": "<ws>/artifacts/tracks/guest.wav",
                "stored_hash": "<hash:2>",
            },
            "host": {
                "balance_measured_lufs": None,
                "balance_stale": None,
                "balance_ungated": None,
                "duration_mismatch": False,
                "expected_duration_sec": 6.0,
                "render_hash": "<hash:3>",
                "stem_duration_sec": 6.0,
                "stem_exists": True,
                "stem_is_fresh": True,
                "stem_path": "<ws>/artifacts/tracks/host.wav",
                "stored_hash": "<hash:3>",
            },
        },
    },
}


@pytest.mark.parametrize("surface", list(rr.STATUS_SURFACES))
@pytest.mark.parametrize("name", list(_SCENARIOS))
def test_render_status_wire(tmp_path, name, surface):
    ws = _SCENARIOS[name](tmp_path)
    assert normalize(rr.STATUS_SURFACES[surface](ws), ws) == _EXPECTED[name]


def test_gui_view_of_a_fresh_project_adds_only_proxy_hashes(tmp_path):
    ws = rr.fresh(tmp_path)
    status = rr.web_view(ws)["render_status"]
    proxy = status.pop("proxy_hashes")
    assert normalize(status, ws) == _EXPECTED["fresh"]
    assert sorted(proxy) == ["guest", "host"]
    assert all(len(value) == 16 for value in proxy.values())
