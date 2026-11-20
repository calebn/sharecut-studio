from __future__ import annotations

from podcast_mcp.export.daw_timeline import DawTimeline


def _track_name_lines(name: str) -> tuple[str, ...]:
    if any(ord(char) < 32 for char in name):
        raise ValueError("REAPER track names cannot contain control characters.")
    for quote in ('"', "'", "`"):
        if quote not in name:
            return (f"    NAME {quote}{name}{quote}",)
    legacy_name = name.replace("`", "'")
    return (f"    NAME `{legacy_name}`", "    <NAME", f"      |{name}", "    >")


def _gain(db: float) -> float:
    return 10 ** (db / 20)


def reaper_project(timeline: DawTimeline) -> str:
    lines = ['<REAPER_PROJECT 0.1 "7.0" 0', "  ITEMMIX 1"]
    for track in timeline.tracks:
        lines.extend(
            (
                "  <TRACK",
                *_track_name_lines(track.label),
                f"    VOLPAN {_gain(track.gain_db):.17g} 0",
                f"    MUTESOLO {int(track.muted)} 0 0",
            )
        )
        for item in track.items:
            lines.extend(
                (
                    "    <ITEM",
                    f"      POSITION {item.position_sec:.17g}",
                    f"      LENGTH {item.length_sec:.17g}",
                    f"      SOFFS {item.start_frame / item.media.sample_rate:.17g}",
                    "      LOOP 0",
                    f"      VOLPAN {_gain(item.gain_db):.17g} 0 1 -1",
                    f"      FADEIN 0 {item.fade_in_ms / 1000:.17g} 0 0 0 0 0",
                    f"      FADEOUT 0 {item.fade_out_ms / 1000:.17g} 0 0 0 0 0",
                    "      <SOURCE WAVE",
                    f'        FILE "{item.media.package_name}"',
                    "      >",
                    "    >",
                )
            )
        lines.append("  >")
    return "\n".join((*lines, ">", ""))
