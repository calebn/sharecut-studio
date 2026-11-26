"""Build ``.sharecutkit`` files for the kit import tests, including ones a library could not export."""

from __future__ import annotations

import hashlib
import itertools
import zipfile
from collections.abc import Sequence
from pathlib import Path

from podcast_mcp.segments.kit import KitEntry, KitFile, kit_id_for, kit_json
from podcast_mcp.segments.model import SEGMENT_JSON, parse_segment, segment_json
from segment_helpers import make_segment_dir

_COUNTER = itertools.count(1)

Member = tuple[str, bytes, int]
DEFAULT_MEMBERS: tuple[Member, ...] = (
    ("Warm Intro", b"fLaC-one", 1),
    ("Sign Off", b"fLaC-two", 1),
)


def hand_made_kit(
    root: Path,
    *,
    kit_name: str = "Show Kit",
    members: Sequence[Member] = DEFAULT_MEMBERS,
) -> Path:
    """A kit file with one member per ``(name, audio, version)``; every entry pins its member."""
    files: dict[str, bytes] = {}
    entries: list[KitEntry] = []
    for index, (name, audio, version) in enumerate(members, start=1):
        folder = make_segment_dir(root / f"member-{index}", name=name, audio=audio)
        segment = parse_segment((folder / SEGMENT_JSON).read_bytes()).model_copy(
            update={"version": version}
        )
        files[f"seg{index:02d}__{SEGMENT_JSON}"] = segment_json(segment).encode()
        files[f"seg{index:02d}__clip-01.flac"] = audio
        entries.append(
            KitEntry(segment_id=segment.id, version=version, at="start" if index % 2 else "end")
        )
    kit = KitFile(id=kit_id_for(kit_name), name=kit_name, entries=entries)
    files["kit.json"] = kit_json(kit).encode()
    manifest = "".join(
        f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in files.items()
    )
    out = root / f"kit-{next(_COUNTER):03d}.sharecutkit"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            archive.writestr(name, data)
        archive.writestr("MANIFEST.sha256", manifest)
    return out
