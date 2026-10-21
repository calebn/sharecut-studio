"""The play cache: where windows live, how they are evicted, and the external player command."""

from __future__ import annotations

import os
import platform
import re
import time
from contextlib import suppress
from pathlib import Path

from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.coded_error import CodedFileNotFoundError
from podcast_mcp.util.file_locks import hold_shared_file_lock
from podcast_mcp.util.fingerprint import file_stamp, mtime_ns_if_file
from podcast_mcp.util.hashing import short_digest
from podcast_mcp.util.process import run
from podcast_mcp.util.project_state import (
    play_cache_lock_path,
)
from podcast_mcp.util.wav import open_wav

_PLAY_CACHE_MAX_AGE_SEC = 7 * 24 * 60 * 60
_PLAY_CACHE_MIN_EVICT_AGE_SEC = 60 * 60
_PLAY_CACHE_MAX_FILES = 512
_PLAY_CACHE_HARD_MAX_FILES = 4096
_PLAY_CACHE_LOCK_TIMEOUT_SEC = 30.0


def _cache_last_used(path: Path) -> float:
    """Last-use time of a play-cache WAV: its filesystem ``st_atime``.

    ``_refresh_cache_access`` renews this lease whenever PlayService serves or
    reuses the WAV, and eviction reads it only through this function. The seam
    lets tests pin last-use times (#735); it does not make production LRU
    exact. External readers (Spotlight, backup or sync agents) also bump atime,
    so a WAV PlayService has not served can look recently used and outlive
    files it served more recently. ``_PLAY_CACHE_MAX_FILES`` and
    ``_PLAY_CACHE_HARD_MAX_FILES`` still bound the cache.
    Raises ``FileNotFoundError`` when the file is gone.
    """
    return path.stat().st_atime


class _PlayCache:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.ws = workspace
        self.project = workspace.project
        self._defaults = workspace.effective_config()

    def _play_cache_dir(self, *protected: Path) -> Path:
        """Keep old generated auditions bounded without touching active outputs."""
        out_dir = self.project.artifacts_dir() / "play_cache"
        out_dir.mkdir(parents=True, exist_ok=True)
        with hold_shared_file_lock(
            play_cache_lock_path(out_dir), timeout=_PLAY_CACHE_LOCK_TIMEOUT_SEC
        ):
            now = time.time()
            candidates: list[tuple[float, Path]] = []
            for path in protected:
                self._refresh_cache_access(path, out_dir)
            for path in out_dir.glob("*.wav"):
                if path.is_symlink() or not path.is_file():
                    continue
                try:
                    accessed = _cache_last_used(path)
                except FileNotFoundError:
                    continue
                candidates.append((accessed, path))
            candidates.sort(key=lambda item: item[0], reverse=True)
            protected_paths = {path.resolve() for path in protected}
            unprotected_index = 0
            for index, (_, path) in enumerate(candidates):
                if path.resolve() in protected_paths:
                    continue
                # Re-stat under the lock: a concurrent serve may have refreshed it.
                try:
                    age = now - _cache_last_used(path)
                except FileNotFoundError:
                    continue
                if age <= _PLAY_CACHE_MIN_EVICT_AGE_SEC:
                    continue
                if (
                    age > _PLAY_CACHE_MAX_AGE_SEC
                    or unprotected_index >= _PLAY_CACHE_HARD_MAX_FILES
                    or index >= _PLAY_CACHE_MAX_FILES
                ):
                    path.unlink(missing_ok=True)
                unprotected_index += 1
        return out_dir

    @staticmethod
    def _refresh_cache_access(path: Path, out_dir: Path) -> None:
        if path.parent != out_dir or path.is_symlink():
            return
        with suppress(FileNotFoundError):
            stat = path.stat()
            os.utime(path, ns=(time.time_ns(), stat.st_mtime_ns), follow_symlinks=False)

    def _mark_play_cache_used(self, path: Path) -> None:
        """Refresh an audition lease before returning a cached WAV to a caller."""
        out_dir = self.project.artifacts_dir() / "play_cache"
        with hold_shared_file_lock(
            play_cache_lock_path(out_dir), timeout=_PLAY_CACHE_LOCK_TIMEOUT_SEC
        ):
            self._refresh_cache_access(path, out_dir)

    def _segment_cache_path(
        self,
        track_id: str,
        start: float,
        end: float,
        edit_hash: str,
    ) -> Path:
        out_dir = self.project.artifacts_dir() / "play_cache"
        path = out_dir / f"processed_{track_id}_{start:.2f}_{end:.2f}_{edit_hash}.wav"
        self._play_cache_dir(path)
        return path

    def _latest_export_wav(self) -> Path:
        export = self.project.export_dir()
        wavs = sorted(export.glob("*.wav"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not wavs:
            raise CodedFileNotFoundError(f"no WAV files in {export}", code="file_not_found")
        return wavs[0]

    def _cache_path(self, label: str, start: float, end: float, src: Path, extra: str = "") -> Path:
        # Include mtime so re-rendered stems invalidate prior extracts even when
        # the path and edit hash are unchanged.
        mtime = mtime_ns_if_file(src)
        key = f"{src}:{mtime}:{label}:{start:.3f}:{end:.3f}:{extra}"
        digest = short_digest(key)
        safe = re.sub(r"[^a-z0-9_-]+", "_", label.lower())[:40]
        out_dir = self.project.artifacts_dir() / "play_cache"
        path = out_dir / f"{safe}_{digest}.wav"
        self._play_cache_dir(src, path)
        return path

    def _ab_concat_path(self, wav_a: Path, wav_b: Path, gap: float) -> Path:
        key = (
            f"{wav_a.resolve()}:{file_stamp(wav_a).mtime_ns}:"
            f"{wav_b.resolve()}:{file_stamp(wav_b).mtime_ns}:{gap:.3f}"
        )
        digest = short_digest(key)
        out_dir = self.project.artifacts_dir() / "play_cache"
        path = out_dir / f"ab_concat_{digest}.wav"
        self._play_cache_dir(wav_a, wav_b, path)
        return path

    def _write_ab_concat(self, wav_a: Path, wav_b: Path, out: Path, *, gap_sec: float) -> Path:
        """Write A + optional silence + B into ``out`` (pcm_s16le)."""
        eng = FFmpegEngine()
        if gap_sec <= 1e-9:
            return eng.join_audio_parts([wav_a, wav_b], out)

        with open_wav(wav_a) as w:
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
