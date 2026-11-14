"""The guest's proxy key moves with every project leaf that moves a proxy artifact.

``test_guest_audio_freshness`` states the rule per document command. This states it on the
project's state, without the command registry: every leaf of the project model is perturbed in
place, one at a time (scalars changed by a fixed step, booleans flipped, enums set to each other
member, lists shortened by their last element), and wherever the artifacts a fresh manifest would
hold change, the manifest key (render hashes plus clip rows) must change too. All gaps are
reported at once, as field paths.
"""

from __future__ import annotations

import shutil
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel

from podcast_mcp.models.episode import ClipMuteRegion
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.batch_scope import batch_scope
from test_guest_audio_freshness import (
    Rig,
    _bleed_target,
    _hash_each_file_revision_once,  # noqa: F401  (autouse fixture)
    _observe,
    _template,
)

Path_ = tuple[str | int, ...]


def _get(root: Any, path: Path_) -> Any:
    for step in path:
        root = getattr(root, step) if isinstance(root, BaseModel) else root[step]
    return root


def _set(root: Any, path: Path_, value: Any) -> None:
    parent = _get(root, path[:-1])
    if isinstance(parent, BaseModel):
        object.__setattr__(parent, str(path[-1]), value)
    else:
        parent[path[-1]] = value


def _leaves(value: Any, path: Path_ = ()) -> Iterator[tuple[Path_, Any]]:
    if isinstance(value, BaseModel):
        for name in type(value).model_fields:
            yield from _leaves(getattr(value, name), (*path, name))
    elif isinstance(value, list):
        yield path, value
        for index, item in enumerate(value):
            yield from _leaves(item, (*path, index))
    elif isinstance(value, dict):
        for key, item in value.items():
            yield from _leaves(item, (*path, key))
    elif value is not None:
        yield path, value


def _variants(value: Any) -> list[Any]:
    if isinstance(value, bool):
        return [not value]
    if isinstance(value, Enum):
        return [member for member in type(value) if member is not value]
    if isinstance(value, int):
        return [value + 1]
    if isinstance(value, float):
        return [value * 1.5 + 0.25]
    if isinstance(value, str):
        return [value + "x"]
    return []


def _name(path: Path_) -> str:
    return ".".join(str(step) for step in path)


@dataclass
class Sweep:
    tried: int = 0
    rejected: int = 0
    both: list[str] = field(default_factory=list)
    key_only: int = 0
    gaps: list[str] = field(default_factory=list)


def _sweep(ws: ProjectWorkspace, extra: dict[str, Callable[[Any], Callable[[], None]]]) -> Sweep:
    """Perturb each leaf and each ``extra`` state in turn; the project is put back each time."""
    project = ws.project
    base_artifacts, base_key = _observe(ws)
    result = Sweep()

    def check(label: str, undo: Callable[[], None]) -> None:
        result.tried += 1
        try:
            artifacts, key = _observe(ws)
        except Exception:  # the model or a file rejects this value; it is not a project state
            result.rejected += 1
            return
        finally:
            undo()
        if artifacts != base_artifacts and key == base_key:
            result.gaps.append(label)
        elif artifacts != base_artifacts:
            result.both.append(label)
        elif key != base_key:
            result.key_only += 1

    for path, value in list(_leaves(project)):
        if isinstance(value, list):
            if not value:
                continue
            last = value.pop()
            check(f"{_name(path)} (last item removed)", lambda v=value, x=last: v.append(x))
            continue
        for new in _variants(value):
            _set(project, path, new)
            check(f"{_name(path)} = {new!r}", lambda p=path, o=value: _set(project, p, o))
    for label, apply in extra.items():
        check(label, apply(project))
    return result


def _guest_media_replaced(project: Any) -> Callable[[], None]:
    # The guest's clips play a recorded source, so only its own media identity changes.
    guest = project.track_by_id("guest")
    before = guest.media
    object.__setattr__(guest, "media", before.model_copy(update={"path": "raw/replacement.wav"}))
    return lambda: object.__setattr__(guest, "media", before)


def _lane_mute(project: Any) -> Callable[[], None]:
    clip = next(c for c in project.clips if c.id == "g1")
    before = clip.mute_regions
    object.__setattr__(clip, "mute_regions", [ClipMuteRegion(start_s=3.0, end_s=3.5)])
    return lambda: object.__setattr__(clip, "mute_regions", before)


def _open(template: Path, tmp_path: Path, name: str) -> Rig:
    root = tmp_path / name
    shutil.copytree(template.parent, root)
    return Rig(ProjectWorkspace.open(root / template.name), root)


def _restored(template: Path, tmp_path: Path, *, ungated: bool) -> ProjectWorkspace:
    rig = _open(template, tmp_path, "restored")
    rig.host("RestoreClipBleed", {"target": _bleed_target(rig)})
    if ungated:
        # The restore stays on the clip; no gate on the host reads the lane's own edits.
        object.__setattr__(rig.ws.project.track_by_id("host"), "transcript_gate", False)
    return rig.ws


@pytest.fixture(scope="module")
def gated_template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return _template(tmp_path_factory.mktemp("gated"))


@pytest.fixture(scope="module")
def ungated_template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return _template(tmp_path_factory.mktemp("ungated"), gated=False)


CONFIGURATIONS = ("restored", "ungated", "restored-ungated")
GUEST_MEDIA = "guest media replaced by different content"
LANE_MUTE = "a mute region on the restored clip's lane"


@pytest.mark.timeout(240)
def test_the_guest_key_moves_with_every_project_leaf_that_moves_a_proxy_artifact(
    gated_template: Path, ungated_template: Path, tmp_path: Path
) -> None:
    runs: dict[str, tuple[ProjectWorkspace, dict[str, Any]]] = {
        "restored": (_restored(gated_template, tmp_path, ungated=False), {LANE_MUTE: _lane_mute}),
        "ungated": (
            _open(ungated_template, tmp_path, "ungated").ws,
            {GUEST_MEDIA: _guest_media_replaced},
        ),
        "restored-ungated": (
            _restored(gated_template, tmp_path / "b", ungated=True),
            {LANE_MUTE: _lane_mute},
        ),
    }
    results: dict[str, Sweep] = {}
    started = time.monotonic()
    with batch_scope():
        for name in CONFIGURATIONS:
            ws, extra = runs[name]
            results[name] = _sweep(ws, extra)
    for name, sweep in results.items():
        print(
            f"sweep {name}: tried {sweep.tried}, rejected {sweep.rejected}, "
            f"moved both {len(sweep.both)}, key only {sweep.key_only}, gaps {len(sweep.gaps)}"
        )
    print(f"sweep seconds: {time.monotonic() - started:.1f}")

    gaps = [f"{name}: {label}" for name, sweep in results.items() for label in sweep.gaps]
    assert not gaps, "the proxy artifacts changed but the guest's key did not:\n" + "\n".join(gaps)
    for name, sweep in results.items():
        assert sweep.both, f"{name}: no leaf moved both the artifacts and the key"
    assert GUEST_MEDIA in results["ungated"].both
    assert LANE_MUTE in results["restored-ungated"].both
    assert LANE_MUTE in results["restored"].both
    # A role flip is in the sweep (enums are perturbed), and without a gate only the key's
    # reading of the selection can see it.
    assert any(".role = " in label for label in results["ungated"].both)
