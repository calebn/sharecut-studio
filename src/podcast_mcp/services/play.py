from __future__ import annotations

import hashlib
import os
import platform
import re
import shutil
import wave
from dataclasses import dataclass
from pathlib import Path

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.pending_preview import (
    DEFAULT_AB_GAP_SEC,
    PendingPreviewWindow,
    resolve_pending_preview,
)
from podcast_mcp.edits.track_ids import SAFE_TRACK_ID
from podcast_mcp.edits.transcript_cuts import search_transcript
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.play_audit import (
    stem_is_fresh,
    stem_path,
    track_render_hash,
    write_stem_hash,
)
from podcast_mcp.engines.timeline_render import render_track_segment
from podcast_mcp.engines.timemap import TimelineMapError, timeline_range_to_source
from podcast_mcp.engines.transcript_gated_play import (
    dialogue_tracks_for_play,
    render_gated_mix,
    render_gated_track,
    transcript_gate_fingerprint,
    word_intervals,
)
from podcast_mcp.models import TrackRole
from podcast_mcp.render import rerender_preview
from podcast_mcp.services.session_state import publish_agent_play
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.util.process import run
from podcast_mcp.util.tracks import track_audio_path

# Full-stem rebuild on --rerender is only worth it for long windows. Short
# auditions use segment render (faster, and avoids silent stem-slice races).
_FULL_STEM_RERENDER_MIN_SEC = 60.0
WAVEFORM_WINDOW_MAX_SEC = 8.0


def _wav_peak_abs(path: Path) -> float | None:
    """Peak absolute sample in [0, 1], or None if unreadable."""
    try:
        import wave

        with wave.open(str(path), "rb") as w:
            n = w.getnframes()
            if n <= 0 or w.getsampwidth() != 2:
                return None
            raw = w.readframes(n)
        import struct

        samples = struct.unpack(f"<{len(raw) // 2}h", raw)
        if not samples:
            return None
        return max(abs(s) for s in samples) / 32768.0
    except Exception:
        return None


@dataclass
class PlayRequest:
    source: str
    start_sec: float
    end_sec: float
    query: str | None = None
    match_index: int = 0
    padding_sec: float = 1.0
    raw: bool = False
    rerender: bool = False
    compare: bool = False
    follow_transcript: bool = False


@dataclass
class PlayResult:
    wav_path: Path
    player_cmd: list[str] | None
    source_label: str
    start_sec: float
    end_sec: float
    tier: str
    compare_segments: list[dict] | None = None


@dataclass(frozen=True)
class TransportPath:
    """Full on-disk WAV for continuous transport (GUI Range streaming).

    Distinct from :meth:`PlayService.play`, which always extracts a segment into
    ``play_cache/``. CLI/MCP segment audition and the DAW transport share the
    same path resolution helpers (``_ensure_premix``, ``ensure_stem``,
    ``track_audio_path``).
    """

    path: Path
    source: str
    tier: str
    stem_is_fresh: bool | None = None


class PlayService:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.ws = workspace
        self.project = workspace.project
        self._defaults = load_defaults()

    def resolve_transport_path(
        self,
        kind: str,
        *,
        track_id: str | None = None,
        rerender: bool = False,
        build_stem: bool = False,
    ) -> TransportPath:
        """Resolve a full WAV for browser/DAW transport (no segment extract).

        ``kind`` mirrors GUI audition modes and CLI ``--source`` families:

        - ``premix`` - ``artifacts/premix.wav`` (same as ``podcast play --source premix``)
        - ``review`` / ``review:<id>`` - frozen review mix under ``artifacts/review/``
        - ``stem`` / ``processed`` - processed stem for ``track_id``
          (``podcast play --source processed:<id>`` artifact)
        - ``raw`` / ``track`` - source media (``podcast play --source track:<id>``)
        """
        normalized = kind.strip().lower()
        if normalized == "premix":
            # Transport streaming must not rebuild on every GET; use rerender=True
            # (CLI --rerender / ?rerender=1) when a rebuild is intentional.
            if rerender:
                path = self._ensure_premix(rerender=True)
            else:
                path = self.project.artifacts_dir() / "premix.wav"
                if not path.is_file():
                    raise FileNotFoundError(
                        "premix.wav not found; run render-preview or pipeline first"
                    )
            return TransportPath(
                path=path.resolve(),
                source="premix",
                tier="premix",
            )

        if normalized == "review" or normalized.startswith("review:"):
            from podcast_mcp.edits.review_versions import version_audio_path

            if normalized.startswith("review:"):
                version_id = normalized.split(":", 1)[1].strip()
            else:
                version_id = (track_id or "").strip() or (
                    self.project.review.active_version_id or ""
                )
            if not version_id:
                raise ValueError(
                    "review version id required (kind=review:<id>, track_id=, "
                    "or set review.active_version_id)"
                )
            path = version_audio_path(self.project, version_id)
            return TransportPath(
                path=path,
                source=f"review:{version_id}",
                tier="review",
            )

        if normalized in ("stem", "processed", "fx"):
            if not track_id:
                raise ValueError("track_id required for stem/processed transport")
            if self.project.track_by_id(track_id) is None:
                raise KeyError(f"unknown track {track_id!r}")
            if rerender or build_stem:
                path = self.ensure_stem(track_id)
            else:
                path = stem_path(self.project, track_id)
                if not path.is_file():
                    raise FileNotFoundError(
                        f"processed stem missing for {track_id!r}; "
                        "run assemble_timeline or pass build_stem=True"
                    )
            return TransportPath(
                path=path.resolve(),
                source=f"processed:{track_id}",
                tier="stem",
                stem_is_fresh=stem_is_fresh(self.project, track_id),
            )

        if normalized in ("raw", "track"):
            if not track_id:
                raise ValueError("track_id required for raw/track transport")
            path = track_audio_path(self.project, track_id)
            if not path.is_file():
                raise FileNotFoundError(f"raw media not found: {path}")
            return TransportPath(
                path=path.resolve(),
                source=f"track:{track_id}",
                tier="raw",
            )

        raise ValueError(
            f"unknown transport kind {kind!r}; "
            "use premix, review[:id], stem/processed, or raw/track"
        )

    def extract_waveform_window(
        self,
        *,
        kind: str,
        track_id: str,
        start_sec: float,
        end_sec: float,
    ) -> Path:
        """Short PCM WAV for client waveform tiles (source or stem clock).

        Caps the window so a client cannot extract an hour. Uses the existing
        ``play_cache/`` extract path with FFmpeg ``-threads 1``.
        """
        if not SAFE_TRACK_ID.fullmatch(track_id):
            raise ValueError(f"invalid track_id: {track_id!r}")
        if self.project.track_by_id(track_id) is None:
            raise ValueError(f"unknown track: {track_id}")
        lo = max(0.0, float(start_sec))
        hi = float(end_sec)
        if hi <= lo:
            raise ValueError("end must be after start")
        hi = min(hi, lo + WAVEFORM_WINDOW_MAX_SEC)
        normalized = kind.strip().lower()
        if normalized in ("stem", "processed", "fx"):
            src = stem_path(self.project, track_id)
            tracks_dir = (self.project.artifacts_dir() / "tracks").resolve()
            if not src.resolve().is_relative_to(tracks_dir):
                raise ValueError(f"stem path escaped artifacts/tracks for {track_id!r}")
            if not src.is_file():
                raise FileNotFoundError(f"processed stem missing for {track_id!r}")
            label = f"wf_stem_{track_id}"
        else:
            src = track_audio_path(self.project, track_id)
            if not src.is_file():
                raise FileNotFoundError(f"raw media not found: {src}")
            label = f"wf_raw_{track_id}"
        out = self._cache_path(label, lo, hi, src)
        if not out.is_file():
            tmp = out.with_name(f".{out.stem}.{os.getpid()}.{os.urandom(4).hex()}{out.suffix}")
            try:
                FFmpegEngine().extract_segment(src, tmp, lo, hi)
                tmp.replace(out)
            except Exception:
                tmp.unlink(missing_ok=True)
                raise
        return out

    def play(
        self,
        req: PlayRequest,
        *,
        dry_run: bool = False,
        player: str | None = None,
        publish_audition: bool = True,
    ) -> PlayResult:
        if req.follow_transcript:
            return self._play_follow_transcript(
                req,
                dry_run=dry_run,
                player=player,
                publish_audition=publish_audition,
            )
        if req.compare:
            return self._play_compare(
                req,
                dry_run=dry_run,
                player=player,
                publish_audition=publish_audition,
            )
        source, start, end = self._resolve_source_and_times(req)
        if req.raw and source.startswith("processed:"):
            source = "track:" + source.split(":", 1)[1]

        wav_path, tier, ext_start, ext_end = self._resolve_audio(
            source, start, end, rerender=req.rerender
        )

        cmd = None if dry_run else self._player_command(player, wav_path)
        if cmd:
            run(cmd, check=True)
        result = PlayResult(
            wav_path=wav_path,
            player_cmd=cmd,
            source_label=source,
            start_sec=ext_start,
            end_sec=ext_end,
            tier=tier,
        )
        if publish_audition:
            # Prefer timeline bounds from the request resolution (start/end),
            # not extract offsets (raw track:* returns source-media seconds).
            timeline_start, timeline_end = start, end
            if source.startswith("track:"):
                timeline_start, timeline_end = start, end
            self._publish_audition(
                req,
                result,
                dry_run=dry_run,
                timeline_start=timeline_start,
                timeline_end=timeline_end,
            )
        return result

    def _publish_audition(
        self,
        req: PlayRequest,
        result: PlayResult,
        *,
        dry_run: bool,
        timeline_start: float,
        timeline_end: float,
    ) -> None:
        publish_agent_play(
            self.project,
            timeline_start_sec=timeline_start,
            timeline_end_sec=timeline_end,
            source=result.source_label,
            tier=result.tier,
            dry_run=dry_run,
            query=req.query,
            match_index=req.match_index if req.query is not None else None,
            wav=result.wav_path,
            compare_segments=result.compare_segments,
        )

    def _resolve_source_and_times(self, req: PlayRequest) -> tuple[str, float, float]:
        if req.query:
            matches = search_transcript(self.project, req.query)
            if not matches:
                raise ValueError(f"no transcript match for {req.query!r}")
            if req.match_index < 0 or req.match_index >= len(matches):
                raise ValueError(
                    f"match index {req.match_index} out of range (0..{len(matches) - 1})"
                )
            m = matches[req.match_index]
            if m.timeline_start is None or m.timeline_end is None:
                raise ValueError(
                    f"transcript match for {req.query!r} falls in removed timeline material"
                )
            start = max(0.0, m.timeline_start - req.padding_sec)
            end = m.timeline_end + req.padding_sec
            if req.source in ("premix", "export"):
                return req.source, start, end
            if req.raw or req.source.startswith("track:"):
                return f"track:{m.track_id}", start, end
            return f"processed:{m.track_id}", start, end

        if req.end_sec <= req.start_sec:
            raise ValueError("end must be after start")
        return req.source, req.start_sec, req.end_sec

    def _resolve_audio(
        self,
        source: str,
        timeline_start: float,
        timeline_end: float,
        *,
        rerender: bool,
    ) -> tuple[Path, str, float, float]:
        if source.startswith("processed:"):
            tid = source.split(":", 1)[1]
            return self._processed_audio(tid, timeline_start, timeline_end, rerender=rerender)
        if source.startswith("track:"):
            tid = source.split(":", 1)[1]
            try:
                media, ext_start, ext_end = timeline_range_to_source(
                    self.project, tid, timeline_start, timeline_end
                )
            except TimelineMapError as exc:
                raise ValueError(str(exc)) from exc
            out = self._cache_path(f"raw_{tid}", timeline_start, timeline_end, media)
            if not out.is_file():
                FFmpegEngine().extract_segment(media, out, ext_start, ext_end)
            return out, "raw", ext_start, ext_end
        if source == "premix":
            path = self._ensure_premix(rerender=rerender)
            out = self._cache_path("premix", timeline_start, timeline_end, path)
            if not out.is_file():
                FFmpegEngine().extract_segment(path, out, timeline_start, timeline_end)
            return out, "premix", timeline_start, timeline_end
        if source == "export":
            path = self._latest_export_wav()
            out = self._cache_path("export", timeline_start, timeline_end, path)
            if not out.is_file():
                FFmpegEngine().extract_segment(path, out, timeline_start, timeline_end)
            return out, "export", timeline_start, timeline_end
        raise ValueError(
            f"unknown source {source!r}; use processed:<id>, track:<id>, premix, or export"
        )

    def _processed_audio(
        self,
        track_id: str,
        timeline_start: float,
        timeline_end: float,
        *,
        rerender: bool,
    ) -> tuple[Path, str, float, float]:
        edit_hash = track_render_hash(self.project, track_id)
        stem = stem_path(self.project, track_id)
        window = max(0.0, timeline_end - timeline_start)

        if rerender:
            self._invalidate_processed_cache(track_id)
            # Short windows: invalidate and segment-render only. Rebuilding a
            # multi-hour stem for a 3s audition is slow and has produced
            # all-zero extracts when the stem slice raced the rewrite.
            if window > _FULL_STEM_RERENDER_MIN_SEC:
                self.ensure_stem(track_id)

        # Freshness includes timeline-duration match; mismatched stems fall through
        # to segment render so timeline seconds are never treated as source offsets.
        if stem_is_fresh(self.project, track_id):
            out = self._cache_path(
                f"stem_{track_id}_{edit_hash}",
                timeline_start,
                timeline_end,
                stem,
            )
            if not out.is_file() or rerender:
                FFmpegEngine().extract_segment(stem, out, timeline_start, timeline_end)
            peak = _wav_peak_abs(out)
            if peak is not None and peak > 1e-5:
                return out, "stem", timeline_start, timeline_end
            out.unlink(missing_ok=True)

        cache = self._segment_cache_path(track_id, timeline_start, timeline_end, edit_hash)
        if cache.is_file() and not rerender:
            return cache, "segment_cache", timeline_start, timeline_end

        render_track_segment(
            self.project,
            track_id,
            timeline_start,
            timeline_end,
            cache,
            self._defaults,
        )
        return cache, "segment_render", timeline_start, timeline_end

    def _ensure_premix(self, *, rerender: bool) -> Path:
        premix = self.project.artifacts_dir() / "premix.wav"
        if rerender or not premix.is_file():
            rerender_preview(self.project)
            self.ws.save()
        if not premix.is_file():
            raise FileNotFoundError("premix.wav not found; run render-preview or pipeline first")
        return premix

    def _invalidate_processed_cache(self, track_id: str) -> None:
        import shutil

        stem = stem_path(self.project, track_id)
        stem.unlink(missing_ok=True)
        hash_path = stem.parent / f"{track_id}.hash"
        hash_path.unlink(missing_ok=True)
        cache_dir = self.project.artifacts_dir() / "play_cache"
        if not cache_dir.is_dir():
            return
        seen: set[Path] = set()
        for pattern in (f"*_{track_id}_*", f"*{track_id}*"):
            for p in cache_dir.glob(pattern):
                if p in seen:
                    continue
                seen.add(p)
                if p.name.startswith("compose_"):
                    continue
                if p.is_dir():
                    shutil.rmtree(p, ignore_errors=True)
                else:
                    p.unlink(missing_ok=True)

    def ensure_stem(self, track_id: str) -> Path:
        """Render full processed stem (assemble_timeline for one track)."""
        from podcast_mcp.engines.ffmpeg import FFmpegEngine

        track = self.project.track_by_id(track_id)
        if not track:
            raise ValueError(f"unknown track {track_id!r}")
        out = stem_path(self.project, track_id)
        out.parent.mkdir(parents=True, exist_ok=True)
        FFmpegEngine().render_dialogue_track(self.project, track, out, self._defaults)
        write_stem_hash(self.project, track_id)
        return out

    def _segment_cache_path(
        self,
        track_id: str,
        start: float,
        end: float,
        edit_hash: str,
    ) -> Path:
        out_dir = self.project.artifacts_dir() / "play_cache"
        out_dir.mkdir(parents=True, exist_ok=True)
        return out_dir / f"processed_{track_id}_{start:.2f}_{end:.2f}_{edit_hash}.wav"

    def _latest_export_wav(self) -> Path:
        export = self.project.export_dir()
        wavs = sorted(export.glob("*.wav"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not wavs:
            raise FileNotFoundError(f"no WAV files in {export}")
        return wavs[0]

    def _cache_path(self, label: str, start: float, end: float, src: Path, extra: str = "") -> Path:
        # Include mtime so re-rendered stems invalidate prior extracts even when
        # the path and edit hash are unchanged.
        mtime = src.stat().st_mtime_ns if src.is_file() else 0
        key = f"{src}:{mtime}:{label}:{start:.3f}:{end:.3f}:{extra}"
        digest = hashlib.sha256(key.encode()).hexdigest()[:16]
        safe = re.sub(r"[^a-z0-9_-]+", "_", label.lower())[:40]
        out_dir = self.project.artifacts_dir() / "play_cache"
        out_dir.mkdir(parents=True, exist_ok=True)
        return out_dir / f"{safe}_{digest}.wav"

    def _source_mtime_ns(self, source: str) -> int:
        path: Path | None = None
        if source == "premix":
            path = self.project.artifacts_dir() / "premix.wav"
        elif source == "export":
            try:
                path = self._latest_export_wav()
            except FileNotFoundError:
                return 0
        elif source.startswith("processed:"):
            path = stem_path(self.project, source.split(":", 1)[1])
        elif source.startswith("track:"):
            track = self.project.track_by_id(source.split(":", 1)[1])
            if track is None or track.media is None:
                return 0
            media = Path(track.media.path)
            path = media if media.is_absolute() else Path(self.project.workspace_dir) / media
        if path is None or not path.is_file():
            return 0
        return path.stat().st_mtime_ns

    def _publish_atomic(self, tmp: Path, dest: Path) -> Path:
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.replace(tmp, dest)
        except OSError:
            tmp.unlink(missing_ok=True)
            raise
        return dest

    def _temp_beside(self, dest: Path) -> Path:
        return dest.with_name(f"{dest.stem}.{os.getpid()}.partial{dest.suffix}")

    def _join_parts_atomic(self, parts: list[Path], dest: Path) -> Path:
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._temp_beside(dest)
        published = False
        try:
            FFmpegEngine().join_audio_parts(parts, tmp)
            self._publish_atomic(tmp, dest)
            published = True
            return dest
        finally:
            if not published:
                tmp.unlink(missing_ok=True)

    def _play_follow_transcript(
        self,
        req: PlayRequest,
        *,
        dry_run: bool = False,
        player: str | None = None,
        publish_audition: bool = True,
    ) -> PlayResult:
        source, start, end = self._resolve_source_and_times(req)
        if end <= start:
            raise ValueError("end must be after start")

        single_tid: str | None = None
        if source.startswith("processed:") or source.startswith("track:"):
            single_tid = source.split(":", 1)[1]

        if req.compare:
            result = self._play_follow_transcript_compare(
                req, start, end, dry_run=dry_run, player=player
            )
        elif single_tid and source not in ("premix", "export"):
            result = self._play_follow_transcript_track(
                single_tid, start, end, req.rerender, dry_run=dry_run, player=player
            )
        else:
            result = self._play_follow_transcript_mix(
                start, end, req.rerender, dry_run=dry_run, player=player
            )
        if publish_audition:
            self._publish_audition(
                req,
                result,
                dry_run=dry_run,
                timeline_start=start,
                timeline_end=end,
            )
        return result

    def _play_follow_transcript_track(
        self,
        track_id: str,
        start: float,
        end: float,
        rerender: bool,
        *,
        dry_run: bool,
        player: str | None,
    ) -> PlayResult:
        segment, _tier, _, _ = self._processed_audio(track_id, start, end, rerender=rerender)
        intervals = word_intervals(self.project, track_id, start, end)
        rel_intervals = [(s - start, e - start) for s, e in intervals]
        fp = transcript_gate_fingerprint(self.project, [track_id], start, end)
        out = self._cache_path(f"follow_{track_id}_{fp}", start, end, segment)
        if not out.is_file():
            render_gated_track(
                segment,
                rel_intervals,
                out,
                timeline_start=0.0,
                timeline_end=end - start,
            )
        cmd = None if dry_run else self._player_command(player, out)
        if cmd:
            run(cmd, check=True)
        return PlayResult(
            wav_path=out,
            player_cmd=cmd,
            source_label=f"follow-transcript:processed:{track_id}",
            start_sec=start,
            end_sec=end,
            tier="transcript_gated",
            compare_segments=[
                {
                    "source": f"follow-transcript:processed:{track_id}",
                    "wav": str(out),
                    "tier": "transcript_gated",
                    "intervals": [{"start": s, "end": e} for s, e in intervals],
                }
            ],
        )

    def _play_follow_transcript_mix(
        self,
        start: float,
        end: float,
        rerender: bool,
        *,
        dry_run: bool,
        player: str | None,
    ) -> PlayResult:
        track_ids = dialogue_tracks_for_play(self.project)
        if not track_ids:
            raise ValueError("follow-transcript mix requires dialogue tracks")

        segments: list[tuple[str, Path]] = []
        for tid in track_ids:
            seg, _, _, _ = self._processed_audio(tid, start, end, rerender=rerender)
            segments.append((tid, seg))

        intervals_by_track = {
            tid: [(s - start, e - start) for s, e in word_intervals(self.project, tid, start, end)]
            for tid in track_ids
        }
        fp = transcript_gate_fingerprint(self.project, track_ids, start, end)
        label = f"follow_mix_{fp}"
        out = self._cache_path(label, start, end, segments[0][1])
        if not out.is_file():
            render_gated_mix(
                segments,
                intervals_by_track,
                out,
                timeline_start=0.0,
                timeline_end=end - start,
            )
        cmd = None if dry_run else self._player_command(player, out)
        if cmd:
            run(cmd, check=True)
        return PlayResult(
            wav_path=out,
            player_cmd=cmd,
            source_label="follow-transcript:mix",
            start_sec=start,
            end_sec=end,
            tier="transcript_gated_mix",
            compare_segments=[
                {
                    "source": "follow-transcript:mix",
                    "wav": str(out),
                    "tier": "transcript_gated_mix",
                    "tracks": track_ids,
                    "intervals_by_track": {
                        tid: [{"start": s + start, "end": e + start} for s, e in iv]
                        for tid, iv in intervals_by_track.items()
                    },
                }
            ],
        )

    def _play_follow_transcript_compare(
        self,
        req: PlayRequest,
        start: float,
        end: float,
        *,
        dry_run: bool = False,
        player: str | None = None,
    ) -> PlayResult:
        track_ids = dialogue_tracks_for_play(self.project)
        if not track_ids:
            raise ValueError("follow-transcript compare requires dialogue tracks")

        segments: list[dict] = []
        last_wav: Path | None = None
        last_cmd: list[str] | None = None

        for tid in track_ids:
            result = self._play_follow_transcript_track(
                tid, start, end, req.rerender, dry_run=dry_run, player=player
            )
            seg = result.compare_segments[0] if result.compare_segments else {}
            segments.append(
                {
                    "source": result.source_label,
                    "wav": str(result.wav_path),
                    "tier": result.tier,
                    "intervals": seg.get("intervals", []),
                }
            )
            last_wav = result.wav_path
            last_cmd = result.player_cmd

        mix_result = self._play_follow_transcript_mix(
            start, end, req.rerender, dry_run=dry_run, player=player
        )
        segments.append(
            {
                "source": mix_result.source_label,
                "wav": str(mix_result.wav_path),
                "tier": mix_result.tier,
                "intervals_by_track": (
                    mix_result.compare_segments[0].get("intervals_by_track", {})
                    if mix_result.compare_segments
                    else {}
                ),
            }
        )
        last_wav = mix_result.wav_path
        last_cmd = mix_result.player_cmd

        return PlayResult(
            wav_path=last_wav or Path("."),
            player_cmd=last_cmd,
            source_label="follow-transcript:compare",
            start_sec=start,
            end_sec=end,
            tier="transcript_gated_compare",
            compare_segments=segments,
        )

    def _play_compare(
        self,
        req: PlayRequest,
        *,
        dry_run: bool = False,
        player: str | None = None,
        publish_audition: bool = True,
    ) -> PlayResult:
        if req.end_sec <= req.start_sec:
            raise ValueError("end must be after start")
        dialogue = [
            t
            for t in self.project.tracks
            if t.role == TrackRole.DIALOGUE and t.media and not t.muted
        ]
        if not dialogue:
            raise ValueError("compare requires dialogue tracks")

        segments: list[dict] = []
        last_wav: Path | None = None
        last_cmd: list[str] | None = None
        order: list[tuple[str, str]] = [
            *(("track", t.id) for t in dialogue),
            ("premix", "premix"),
        ]
        for kind, label in order:
            sub = PlayRequest(
                source=f"track:{label}" if kind == "track" else "premix",
                start_sec=req.start_sec,
                end_sec=req.end_sec,
                rerender=req.rerender,
            )
            result = self.play(sub, dry_run=dry_run, player=player, publish_audition=False)
            segments.append(
                {
                    "source": result.source_label,
                    "wav": str(result.wav_path),
                    "tier": result.tier,
                }
            )
            last_wav = result.wav_path
            last_cmd = result.player_cmd

        result = PlayResult(
            wav_path=last_wav or Path("."),
            player_cmd=last_cmd,
            source_label="compare",
            start_sec=req.start_sec,
            end_sec=req.end_sec,
            tier="compare",
            compare_segments=segments,
        )
        if publish_audition:
            self._publish_audition(
                req,
                result,
                dry_run=dry_run,
                timeline_start=req.start_sec,
                timeline_end=req.end_sec,
            )
        return result

    def audition_context(
        self,
        timeline_start: float,
        timeline_end: float,
        *,
        skew_warn_sec: float | None = None,
        detail: str = "summary",
        include_dsp: bool = True,
    ) -> dict:
        """Caption + skew + freshness report for a timeline window."""
        from podcast_mcp.edits.audition_context import (
            DEFAULT_SKEW_WARN_SEC,
            build_audition_context,
        )

        return build_audition_context(
            self.project,
            timeline_start,
            timeline_end,
            skew_warn_sec=(DEFAULT_SKEW_WARN_SEC if skew_warn_sec is None else skew_warn_sec),
            detail=detail,  # type: ignore[arg-type]
            include_dsp=include_dsp,
        )

    def play_compose(
        self,
        track_ids: list[str],
        start_sec: float,
        end_sec: float,
        *,
        tier: str = "processed",
        rerender: bool = False,
        dry_run: bool = False,
        player: str | None = None,
        publish_audition: bool = True,
    ) -> PlayResult:
        """Mix selected tracks for a timeline window into play_cache (no project mutation)."""
        if end_sec <= start_sec:
            raise ValueError("end must be after start")
        kind = (tier or "processed").strip().lower()
        if kind not in {"processed", "raw"}:
            raise ValueError("tier must be processed or raw")
        ids = [tid.strip() for tid in track_ids if tid and str(tid).strip()]
        if not ids:
            raise ValueError("track_ids must not be empty")
        known = {t.id for t in self.project.tracks}
        unknown = [tid for tid in ids if tid not in known]
        if unknown:
            raise ValueError(f"unknown track_ids: {sorted(unknown)}")

        segments: list[tuple[Path, float]] = []
        for tid in ids:
            source = f"track:{tid}" if kind == "raw" else f"processed:{tid}"
            wav, _tier, _, _ = self._resolve_audio(source, start_sec, end_sec, rerender=rerender)
            track = self.project.track_by_id(tid)
            gain = 0.0
            if kind == "raw" and track is not None:
                gain = float(track.gain_db)
            segments.append((wav, gain))

        extra = ":".join(
            f"{path}:{path.stat().st_mtime_ns if path.is_file() else 0}:{gain}"
            for path, gain in segments
        )
        out = self._cache_path(
            f"compose_{kind}_{'-'.join(ids)}",
            start_sec,
            end_sec,
            segments[0][0],
            extra=extra,
        )
        if not out.is_file() or rerender:
            tmp = self._temp_beside(out)
            published = False
            try:
                FFmpegEngine().mix_tracks(segments, tmp)
                self._publish_atomic(tmp, out)
                published = True
            finally:
                if not published:
                    tmp.unlink(missing_ok=True)

        cmd = None if dry_run else self._player_command(player, out)
        if cmd:
            run(cmd, check=True)
        result = PlayResult(
            wav_path=out,
            player_cmd=cmd,
            source_label=f"compose:{kind}:{','.join(ids)}",
            start_sec=start_sec,
            end_sec=end_sec,
            tier="compose",
        )
        if publish_audition:
            self._publish_audition(
                PlayRequest(
                    source=result.source_label,
                    start_sec=start_sec,
                    end_sec=end_sec,
                ),
                result,
                dry_run=dry_run,
                timeline_start=start_sec,
                timeline_end=end_sec,
            )
        return result

    def play_ab_wavs(
        self,
        wav_a: Path | str,
        wav_b: Path | str,
        *,
        gap_sec: float = 0.4,
        dry_run: bool = False,
        player: str | None = None,
        publish_audition: bool = False,
        start_sec: float = 0.0,
        end_sec: float = 0.0,
    ) -> PlayResult:
        """Play A then B with a short silence gap (one concat WAV, one player)."""
        path_a = Path(wav_a)
        path_b = Path(wav_b)
        if not path_a.is_file():
            raise FileNotFoundError(f"A wav not found: {path_a}")
        if not path_b.is_file():
            raise FileNotFoundError(f"B wav not found: {path_b}")

        gap = max(0.0, float(gap_sec))
        out = self._ab_concat_path(path_a, path_b, gap)
        if not out.is_file():
            tmp = self._temp_beside(out)
            published = False
            try:
                self._write_ab_concat(path_a, path_b, tmp, gap_sec=gap)
                self._publish_atomic(tmp, out)
                published = True
            finally:
                if not published:
                    tmp.unlink(missing_ok=True)

        cmd = None if dry_run else self._player_command(player, out)
        if cmd:
            run(cmd, check=True)
        result = PlayResult(
            wav_path=out,
            player_cmd=cmd,
            source_label="ab",
            start_sec=start_sec,
            end_sec=end_sec if end_sec > start_sec else start_sec,
            tier="ab_concat",
            compare_segments=[
                {"label": "A", "wav": str(path_a.resolve())},
                {"label": "gap_sec", "gap_sec": gap},
                {"label": "B", "wav": str(path_b.resolve())},
            ],
        )
        if publish_audition and end_sec > start_sec:
            self._publish_audition(
                PlayRequest(
                    source="ab",
                    start_sec=start_sec,
                    end_sec=end_sec,
                ),
                result,
                dry_run=dry_run,
                timeline_start=start_sec,
                timeline_end=end_sec,
            )
        return result

    def play_history_ab(
        self,
        before_index: int,
        after_index: int,
        req: PlayRequest,
        *,
        gap_sec: float = 0.4,
        dry_run: bool = False,
        player: str | None = None,
    ) -> PlayResult:
        """Extract the same range at two history indices, then play A→gap→B."""
        from podcast_mcp.services.history import HistoryService

        if before_index == after_index:
            raise ValueError("before_index and after_index must differ")

        hist = HistoryService(self.ws)
        out_dir = self.project.artifacts_dir() / "play_cache"
        out_dir.mkdir(parents=True, exist_ok=True)
        # Include snapshot ids so re-recording the same indices cannot reuse
        # stale A/B wavs after history was rewritten (goto + new mutate).
        entries = list(self.project.history.entries) if self.project.history is not None else []
        before_id = entries[before_index].id if 0 <= before_index < len(entries) else ""
        after_id = entries[after_index].id if 0 <= after_index < len(entries) else ""
        pair_key = (
            f"{before_index}:{before_id}:{after_index}:{after_id}:"
            f"{req.source}:{req.start_sec:.3f}:{req.end_sec:.3f}:"
            f"{req.rerender}:{gap_sec:.3f}"
        )
        digest = hashlib.sha256(pair_key.encode()).hexdigest()[:16]
        stable_a = out_dir / f"ab_hist_{digest}_a.wav"
        stable_b = out_dir / f"ab_hist_{digest}_b.wav"

        hist.goto(before_index)
        self.project = self.ws.project
        a_result = self.play(req, dry_run=True, publish_audition=False)
        shutil.copy2(a_result.wav_path, stable_a)

        hist.goto(after_index)
        self.project = self.ws.project
        b_result = self.play(req, dry_run=True, publish_audition=False)
        shutil.copy2(b_result.wav_path, stable_b)

        return self.play_ab_wavs(
            stable_a,
            stable_b,
            gap_sec=gap_sec,
            dry_run=dry_run,
            player=player,
            publish_audition=True,
            start_sec=req.start_sec,
            end_sec=req.end_sec,
        )

    def play_pending_preview(
        self,
        edit_id: str,
        *,
        mode: str = "suggested",
        pad_sec: float = 0.5,
        gap_sec: float = 0.4,
        source: str = "premix",
        dry_run: bool = False,
        player: str | None = None,
        rerender: bool = False,
    ) -> PlayResult:
        """Extract Current / Suggested / A/B around a pending session remove."""
        kind = (mode or "suggested").strip().lower()
        if kind not in {"current", "suggested", "ab"}:
            raise ValueError("mode must be current, suggested, or ab")
        window = resolve_pending_preview(self.project, edit_id, pad_sec=pad_sec)
        if kind != "current" and not window.can_skip:
            raise ValueError(window.skip_reason or "suggested preview unavailable")

        current_wav: Path | None = None
        if kind in {"current", "ab"}:
            current = self.play(
                PlayRequest(
                    source=source,
                    start_sec=window.play_start,
                    end_sec=window.play_end,
                    rerender=rerender,
                ),
                dry_run=True,
                publish_audition=False,
            )
            current_wav = current.wav_path
            if kind == "current":
                cmd = None if dry_run else self._player_command(player, current.wav_path)
                if cmd:
                    run(cmd, check=True)
                return PlayResult(
                    wav_path=current.wav_path,
                    player_cmd=cmd,
                    source_label=f"pending:{kind}",
                    start_sec=window.play_start,
                    end_sec=window.play_end,
                    tier="pending_current",
                )

        suggested = self._pending_suggested_wav(window, source=source, rerender=rerender)
        if kind == "suggested":
            cmd = None if dry_run else self._player_command(player, suggested)
            if cmd:
                run(cmd, check=True)
            return PlayResult(
                wav_path=suggested,
                player_cmd=cmd,
                source_label=f"pending:{kind}",
                start_sec=window.play_start,
                end_sec=window.play_end,
                tier="pending_suggested",
            )

        if current_wav is None:
            raise ValueError("mode must be current, suggested, or ab")
        return self.play_ab_wavs(
            current_wav,
            suggested,
            gap_sec=gap_sec if gap_sec is not None else DEFAULT_AB_GAP_SEC,
            dry_run=dry_run,
            player=player,
            publish_audition=False,
            start_sec=window.play_start,
            end_sec=window.play_end,
        )

    def pending_preview_cached_wav(
        self,
        edit_id: str,
        *,
        mode: str = "suggested",
        pad_sec: float = 0.5,
        gap_sec: float = 0.4,
        source: str = "premix",
    ) -> Path | None:
        """Return the listen-first concat WAV if it already exists (no FFmpeg)."""
        kind = (mode or "suggested").strip().lower()
        if kind not in {"current", "suggested", "ab"}:
            raise ValueError("mode must be current, suggested, or ab")
        window = resolve_pending_preview(self.project, edit_id, pad_sec=pad_sec)
        if kind != "current" and not window.can_skip:
            raise ValueError(window.skip_reason or "suggested preview unavailable")
        if kind == "current":
            premix = self.project.artifacts_dir() / "premix.wav"
            if not premix.is_file():
                return None
            path = self._cache_path("premix", window.play_start, window.play_end, premix)
            return path if path.is_file() else None
        suggested = self._pending_suggested_path(window, source=source)
        if kind == "suggested":
            return suggested if suggested.is_file() else None
        current = self.pending_preview_cached_wav(
            edit_id,
            mode="current",
            pad_sec=pad_sec,
            source=source,
        )
        if current is None or not suggested.is_file():
            return None
        gap = gap_sec if gap_sec is not None else DEFAULT_AB_GAP_SEC
        out = self._ab_concat_path(current, suggested, max(0.0, float(gap)))
        return out if out.is_file() else None

    def _ab_concat_path(self, wav_a: Path, wav_b: Path, gap: float) -> Path:
        out_dir = self.project.artifacts_dir() / "play_cache"
        out_dir.mkdir(parents=True, exist_ok=True)
        key = (
            f"{wav_a.resolve()}:{wav_a.stat().st_mtime_ns}:"
            f"{wav_b.resolve()}:{wav_b.stat().st_mtime_ns}:{gap:.3f}"
        )
        digest = hashlib.sha256(key.encode()).hexdigest()[:16]
        return out_dir / f"ab_concat_{digest}.wav"

    def _pending_suggested_path(self, window: PendingPreviewWindow, *, source: str) -> Path:
        out_dir = self.project.artifacts_dir() / "play_cache"
        out_dir.mkdir(parents=True, exist_ok=True)
        mtime = self._source_mtime_ns(source)
        key = (
            f"pending:{window.edit_id}:{window.play_start:.3f}:"
            f"{window.timeline_start:.3f}:{window.timeline_end:.3f}:"
            f"{window.play_end:.3f}:{source}:{mtime}"
        )
        digest = hashlib.sha256(key.encode()).hexdigest()[:16]
        return out_dir / f"pending_suggested_{digest}.wav"

    def _pending_suggested_wav(
        self,
        window: PendingPreviewWindow,
        *,
        source: str,
        rerender: bool,
    ) -> Path:
        out = self._pending_suggested_path(window, source=source)
        if out.is_file() and not rerender:
            return out
        parts: list[Path] = []
        before_end = window.timeline_start
        after_start = window.timeline_end
        if before_end - window.play_start > 0.05:
            before = self.play(
                PlayRequest(
                    source=source,
                    start_sec=window.play_start,
                    end_sec=before_end,
                    rerender=rerender,
                ),
                dry_run=True,
                publish_audition=False,
            )
            parts.append(before.wav_path)
        if window.play_end - after_start > 0.05:
            after = self.play(
                PlayRequest(
                    source=source,
                    start_sec=after_start,
                    end_sec=window.play_end,
                    rerender=rerender,
                ),
                dry_run=True,
                publish_audition=False,
            )
            parts.append(after.wav_path)
        if not parts:
            raise ValueError("suggested preview has no audible pad around the cut")
        return self._join_parts_atomic(parts, out)

    def _write_ab_concat(self, wav_a: Path, wav_b: Path, out: Path, *, gap_sec: float) -> Path:
        """Write A + optional silence + B into ``out`` (pcm_s16le)."""
        eng = FFmpegEngine()
        if gap_sec <= 1e-9:
            return eng.join_audio_parts([wav_a, wav_b], out)

        with wave.open(str(wav_a), "rb") as w:
            rate = w.getframerate() or 48000
            channels = w.getnchannels() or 1

        ch_layout = "mono" if channels <= 1 else "stereo"
        silence = out.with_name(f".{out.stem}_gap.wav")
        cmd_sil = [
            eng.ffmpeg,
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"anullsrc=r={rate}:cl={ch_layout}",
            "-t",
            f"{gap_sec:.6f}",
            "-acodec",
            "pcm_s16le",
            str(silence),
        ]
        run(cmd_sil, check=True, capture_output=True)
        try:
            # Filter concat so mismatched layouts still join cleanly.
            cmd = [
                eng.ffmpeg,
                "-y",
                "-i",
                str(wav_a),
                "-i",
                str(silence),
                "-i",
                str(wav_b),
                "-filter_complex",
                "[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]",
                "-map",
                "[out]",
                "-acodec",
                "pcm_s16le",
                str(out),
            ]
            run(cmd, check=True, capture_output=True)
        finally:
            silence.unlink(missing_ok=True)
        return out

    def _player_command(self, player: str | None, wav: Path) -> list[str]:
        if player:
            return [player, str(wav)]
        if platform.system() == "Darwin":
            return ["afplay", str(wav)]
        return ["ffplay", "-nodisp", "-autoexit", str(wav)]
