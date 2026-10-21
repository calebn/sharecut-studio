"""Composed auditions: tracks mixed, A/B pairs, history A/B and selected ranges."""

from __future__ import annotations

import json
import secrets
from pathlib import Path

from podcast_mcp.config.defaults import mix_peak_ceiling_db
from podcast_mcp.engines.ffmpeg import MIX_SEMANTICS_REV, FFmpegEngine
from podcast_mcp.models.episode import ExactRangeTarget
from podcast_mcp.util.atomic_render import render_atomic
from podcast_mcp.util.coded_error import CodedFileNotFoundError, CodedValueError
from podcast_mcp.util.hashing import short_digest
from podcast_mcp.util.process import run
from podcast_mcp.util.project_state import (
    snapshot_project,
)

from .play_stems import _PlayStems
from .play_support import PlayRequest, PlayResult, _compose_gain_db, _mix_cache_extra


class _PlayCompose(_PlayStems):
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
        from podcast_mcp.services.pipeline import prosody_params_for

        return build_audition_context(
            self.project,
            timeline_start,
            timeline_end,
            skew_warn_sec=(DEFAULT_SKEW_WARN_SEC if skew_warn_sec is None else skew_warn_sec),
            detail=detail,  # type: ignore[arg-type]
            include_dsp=include_dsp,
            prosody_params=prosody_params_for(self.ws.path),
            defaults=self._defaults,
        )

    def prosody_overlay(self) -> dict:
        """Timeline-mapped prosody profile per dialogue track for the DAW overlay (#719)."""
        from podcast_mcp.edits.prosody_profile import prosody_overlay
        from podcast_mcp.services.pipeline import prosody_params_for

        return prosody_overlay(self.project, params=prosody_params_for(self.ws.path))

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
            raise CodedValueError("end must be after start", code="range_end_before_start")
        kind = (tier or "processed").strip().lower()
        if kind not in {"processed", "raw"}:
            raise CodedValueError("tier must be processed or raw", code="tier_invalid")
        ids = [tid.strip() for tid in track_ids if tid and str(tid).strip()]
        if not ids:
            raise CodedValueError("track_ids must not be empty", code="track_ids_empty")
        known = {t.id for t in self.project.tracks}
        unknown = [tid for tid in ids if tid not in known]
        if unknown:
            raise CodedValueError(f"unknown track_ids: {sorted(unknown)}", code="track_not_found")

        segments: list[tuple[Path, float]] = []
        for tid in ids:
            source = f"track:{tid}" if kind == "raw" else f"processed:{tid}"
            wav, tier_used, _, _, _ = self._resolve_audio(
                source, start_sec, end_sec, rerender=rerender
            )
            track = self.project.track_by_id(tid)
            segments.append((wav, _compose_gain_db(track, tier_used)))

        ceiling = mix_peak_ceiling_db(self._defaults)
        extra = f"mix{MIX_SEMANTICS_REV}:tp{ceiling:g}:{_mix_cache_extra(segments)}"
        out = self._cache_path(
            f"compose_{kind}_{'-'.join(ids)}",
            start_sec,
            end_sec,
            segments[0][0],
            extra=extra,
        )
        if not out.is_file() or rerender:
            render_atomic(
                out, lambda tmp: FFmpegEngine().mix_tracks(segments, tmp, peak_ceiling_db=ceiling)
            )
        self._mark_play_cache_used(out)

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
            raise CodedFileNotFoundError(f"A wav not found: {path_a.name}", code="file_not_found")
        if not path_b.is_file():
            raise CodedFileNotFoundError(f"B wav not found: {path_b.name}", code="file_not_found")

        gap = max(0.0, float(gap_sec))
        out = self._ab_concat_path(path_a, path_b, gap)
        if not out.is_file():
            render_atomic(out, lambda tmp: self._write_ab_concat(path_a, path_b, tmp, gap_sec=gap))
        self._mark_play_cache_used(out)

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

    def play_selected_range(
        self, target: ExactRangeTarget, *, full_mix_path: Path | None = None
    ) -> Path:
        from podcast_mcp.edits.range_edits import resolve_range
        from podcast_mcp.services.media import render_range_audio

        with self.ws.transaction() as project:
            target = resolve_range(project, target)
            current = snapshot_project(project)
        digest = short_digest(json.dumps(target.model_dump(mode="json"), sort_keys=True))
        context = "full-mix" if full_mix_path is not None else "selected-tracks"
        output = (
            self._play_cache_dir() / f"selected-range-{context}-{digest}-{secrets.token_hex(8)}.wav"
        )
        render_atomic(
            output,
            lambda temporary: render_range_audio(
                current,
                target,
                temporary,
                full_mix_path=full_mix_path,
                defaults=self._defaults,
            ),
        )
        self._mark_play_cache_used(output)
        return output
