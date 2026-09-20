"""Explicit A/B join labels for training the acoustic join ranker.

Separate from reject/approve preference events (ROADMAP). Labels live in
``artifacts/join_labels.jsonl`` (append-only).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

import numpy as np

from podcast_mcp.models import EpisodeProject

VerdictLabel = Literal["pass", "fail"]


@dataclass
class JoinLabel:
    ts: str
    track_id: str
    timebase: str
    join_sec: float
    cut_start: float | None
    cut_end: float | None
    verdict: VerdictLabel
    note: str
    features: dict[str, Any]
    episode: str
    config_hash: str
    source: str = "human"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _labels_path(project: EpisodeProject) -> Path:
    return project.artifacts_dir() / "join_labels.jsonl"


def config_hash(cfg: dict[str, Any] | None) -> str:
    blob = json.dumps(cfg or {}, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()[:12]


def record_label(
    project: EpisodeProject,
    *,
    track_id: str,
    join_sec: float,
    verdict: VerdictLabel,
    timebase: str = "source",
    cut_start: float | None = None,
    cut_end: float | None = None,
    note: str = "",
    features: dict[str, Any] | None = None,
    source: str = "human",
    config: dict[str, Any] | None = None,
) -> JoinLabel:
    label = JoinLabel(
        ts=datetime.now(UTC).isoformat(),
        track_id=track_id,
        timebase=timebase,
        join_sec=float(join_sec),
        cut_start=cut_start,
        cut_end=cut_end,
        verdict=verdict,
        note=note,
        features=features or {},
        episode=project.name,
        config_hash=config_hash(config),
        source=source,
    )
    path = _labels_path(project)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(label.to_dict(), ensure_ascii=False) + "\n")
    return label


def load_labels(
    project: EpisodeProject | None = None,
    *,
    path: Path | None = None,
) -> list[JoinLabel]:
    p = path or (_labels_path(project) if project is not None else None)
    if p is None or not p.is_file():
        return []
    out: list[JoinLabel] = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        d = json.loads(line)
        out.append(
            JoinLabel(
                ts=d["ts"],
                track_id=d["track_id"],
                timebase=d.get("timebase", "source"),
                join_sec=float(d["join_sec"]),
                cut_start=d.get("cut_start"),
                cut_end=d.get("cut_end"),
                verdict=d["verdict"],
                note=d.get("note", ""),
                features=d.get("features") or {},
                episode=d.get("episode", ""),
                config_hash=d.get("config_hash", ""),
                source=d.get("source", "human"),
            )
        )
    return out


def export_training_table(
    labels: list[JoinLabel],
) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """Return X (n, d), y (n,) with y=1 for fail, feature names."""
    if not labels:
        return np.zeros((0, 1)), np.zeros(0), ["risk"]

    rows: list[list[float]] = []
    names: list[str] | None = None
    ys: list[float] = []
    for lab in labels:
        feats = lab.features or {}
        det = feats.get("detectors") or {}
        flat: dict[str, float] = {"risk": float(feats.get("risk", 0.0))}
        if isinstance(det, dict):
            for k, v in det.items():
                if isinstance(v, (int, float)):
                    flat[f"det:{k}"] = float(v)
                elif isinstance(v, dict) and "score" in v:
                    flat[f"det:{k}"] = float(v["score"])
        neural = feats.get("neural") or {}
        if isinstance(neural, dict):
            for k in ("discontinuity_delta", "mos_delta", "z"):
                if k in neural and isinstance(neural[k], (int, float)):
                    flat[f"neural:{k}"] = float(neural[k])
            nisqa = neural.get("nisqa")
            if isinstance(nisqa, dict):
                for k in ("discontinuity_delta", "mos_delta"):
                    if k in nisqa and isinstance(nisqa[k], (int, float)):
                        flat[f"neural:{k}"] = float(nisqa[k])
            wavlm = neural.get("wavlm")
            if isinstance(wavlm, dict) and isinstance(wavlm.get("z"), (int, float)):
                flat["neural:z"] = float(wavlm["z"])
        if names is None:
            names = sorted(flat.keys())
        assert names is not None
        rows.append([float(flat.get(n, 0.0)) for n in names])
        ys.append(1.0 if lab.verdict == "fail" else 0.0)
    assert names is not None
    return np.asarray(rows, dtype=np.float64), np.asarray(ys, dtype=np.float64), names
