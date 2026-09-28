"""Fake pinned model snapshots whose catalog manifests are patched to the fake bytes (#728)."""

from __future__ import annotations

import dataclasses
import hashlib
from collections.abc import Iterable
from pathlib import Path

import pytest

from podcast_mcp import whisper_models, word_aligner_models
from podcast_mcp.util.model_manifest import FileManifest


def write_fake_files(root: Path, names: Iterable[str]) -> FileManifest:
    manifest = []
    for name in names:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        data = f"fake {name}".encode()
        path.write_bytes(data)
        manifest.append((name, hashlib.sha256(data).hexdigest()))
    return tuple(manifest)


def pin_word_aligner_to_fake_snapshot(root: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    model = word_aligner_models.word_aligner_model()
    manifest = write_fake_files(root, model.allow_patterns)
    monkeypatch.setattr(
        word_aligner_models,
        "WORD_ALIGNER_CATALOG",
        (dataclasses.replace(model, file_sha256=manifest),),
    )
    return root


def plant_pinned_whisper(cache: Path, model: str, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A complete HF-layout snapshot for a catalog size under ``cache``, pin patched to it."""
    pin = whisper_models.WHISPER_PINS[model]
    snap = cache / f"models--{pin.hf_repo.replace('/', '--')}" / "snapshots" / pin.revision
    manifest = write_fake_files(snap, pin.allow_patterns)
    monkeypatch.setitem(
        whisper_models.WHISPER_PINS, model, dataclasses.replace(pin, file_sha256=manifest)
    )
    return snap
