"""The audition and transport service. The themes live in the ``play_*`` modules; this one composes them."""

from __future__ import annotations

import shutil
from pathlib import Path

from podcast_mcp.models import TrackRole
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.hashing import short_digest
from podcast_mcp.util.process import run

from .play_boundary import _PlayBoundary
from .play_follow import _PlayFollow
from .play_session import _PlaySession
from .play_support import PlayRequest, PlayResult, TransportPath, _compose_gain_db

__all__ = ["PlayRequest", "PlayResult", "PlayService", "TransportPath", "_compose_gain_db"]


class PlayService(_PlaySession, _PlayFollow, _PlayBoundary):
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
                req, dry_run=dry_run, player=player, publish_audition=publish_audition
            )
        if req.compare:
            return self._play_compare(
                req, dry_run=dry_run, player=player, publish_audition=publish_audition
            )
        source, start, end = self._resolve_source_and_times(req)
        if req.raw and source.startswith("processed:"):
            source = "track:" + source.split(":", 1)[1]

        wav_path, tier, ext_start, ext_end, busy = self._resolve_audio(
            source, start, end, rerender=req.rerender
        )
        self._mark_play_cache_used(wav_path)

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
            render_busy=busy,
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

    def _play_compare(
        self,
        req: PlayRequest,
        *,
        dry_run: bool = False,
        player: str | None = None,
        publish_audition: bool = True,
    ) -> PlayResult:
        if req.end_sec <= req.start_sec:
            raise CodedValueError("end must be after start", code="range_end_before_start")
        dialogue = [
            t
            for t in self.project.tracks
            if t.role == TrackRole.DIALOGUE and t.media and not t.muted
        ]
        if not dialogue:
            raise CodedValueError("compare requires dialogue tracks", code="compare_needs_dialogue")

        segments: list[dict] = []
        last_wav: Path | None = None
        last_cmd: list[str] | None = None
        order: list[tuple[str, str]] = [
            *(("track", t.id) for t in dialogue),
            ("premix", "premix"),
        ]
        busy = False
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
            busy = busy or result.render_busy

        result = PlayResult(
            wav_path=last_wav or Path("."),
            player_cmd=last_cmd,
            source_label="compare",
            start_sec=req.start_sec,
            end_sec=req.end_sec,
            tier="compare",
            compare_segments=segments,
            render_busy=busy,
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
        from .history import HistoryService

        if before_index == after_index:
            raise CodedValueError(
                "before_index and after_index must differ", code="history_indexes_equal"
            )

        hist = HistoryService(self.ws)
        out_dir = self._play_cache_dir()
        # Include snapshot ids so re-recording the same indices cannot reuse
        # stale A/B wavs after history was rewritten (goto + new mutate).
        entries = list(self.project.history.entries)
        before_id = entries[before_index].id if 0 <= before_index < len(entries) else ""
        after_id = entries[after_index].id if 0 <= after_index < len(entries) else ""
        pair_key = (
            f"{before_index}:{before_id}:{after_index}:{after_id}:"
            f"{req.source}:{req.start_sec:.3f}:{req.end_sec:.3f}:"
            f"{req.rerender}:{gap_sec:.3f}"
        )
        digest = short_digest(pair_key)
        stable_a = out_dir / f"ab_hist_{digest}_a.wav"
        stable_b = out_dir / f"ab_hist_{digest}_b.wav"

        hist.goto(before_index)
        self.project = self.ws.project
        a_result = self.play(req, dry_run=True, publish_audition=False)
        shutil.copy2(a_result.wav_path, stable_a)
        self._mark_play_cache_used(stable_a)

        hist.goto(after_index)
        self.project = self.ws.project
        b_result = self.play(req, dry_run=True, publish_audition=False)
        shutil.copy2(b_result.wav_path, stable_b)
        self._mark_play_cache_used(stable_b)

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
