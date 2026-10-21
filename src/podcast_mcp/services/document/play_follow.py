"""Play-follow-transcript: a transcript search played as a track, a mix or a comparison."""

from __future__ import annotations

from pathlib import Path

from podcast_mcp.config.defaults import mix_peak_ceiling_db
from podcast_mcp.engines.ffmpeg import MIX_SEMANTICS_REV, FFmpegEngine
from podcast_mcp.engines.transcript_gated_play import (
    dialogue_tracks_for_play,
    transcript_gate_fingerprint,
    word_intervals,
)
from podcast_mcp.util.atomic_render import render_atomic
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.process import run

from .play_stems import _PlayStems
from .play_support import PlayRequest, PlayResult, _compose_gain_db, _mix_cache_extra


class _PlayFollow(_PlayStems):
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
            raise CodedValueError("end must be after start", code="range_end_before_start")

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
        segment, tier, _, _ = self._follow_transcript_audio(track_id, start, end, rerender=rerender)
        # Same level rule as the gated mix and play_compose: output gain minus what the tier baked.
        gain_db = _compose_gain_db(self.project.track_by_id(track_id), tier)
        intervals = word_intervals(self.project, track_id, start, end)
        fp = transcript_gate_fingerprint(self.project, [track_id], start, end)
        out = self._cache_path(
            f"follow_{track_id}_{fp}",
            start,
            end,
            segment,
            extra=(
                f"mix{MIX_SEMANTICS_REV}:tp{mix_peak_ceiling_db(self._defaults):g}:gain={gain_db}"
            ),
        )
        if not out.is_file():
            ceiling = mix_peak_ceiling_db(self._defaults)
            render_atomic(
                out,
                lambda tmp: FFmpegEngine().mix_tracks(
                    [(segment, gain_db)], tmp, peak_ceiling_db=ceiling
                ),
            )
        self._mark_play_cache_used(out)
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
            raise CodedValueError(
                "follow-transcript mix requires dialogue tracks",
                code="follow_transcript_needs_dialogue",
            )

        segments: list[tuple[str, Path]] = []
        gains_db: dict[str, float] = {}
        for tid in track_ids:
            seg, tier, _, _ = self._follow_transcript_audio(tid, start, end, rerender=rerender)
            segments.append((tid, seg))
            # Segment renders bake the staging gain; stems don't, and neither bakes the fader.
            gains_db[tid] = _compose_gain_db(self.project.track_by_id(tid), tier)

        intervals_by_track = {
            tid: [(s - start, e - start) for s, e in word_intervals(self.project, tid, start, end)]
            for tid in track_ids
        }
        fp = transcript_gate_fingerprint(self.project, track_ids, start, end)
        label = f"follow_mix_{fp}"
        ceiling = mix_peak_ceiling_db(self._defaults)
        out = self._cache_path(
            label,
            start,
            end,
            segments[0][1],
            extra=(
                f"mix{MIX_SEMANTICS_REV}:tp{ceiling:g}:"
                f"{_mix_cache_extra([(seg, gains_db[tid]) for tid, seg in segments])}"
            ),
        )
        if not out.is_file():
            render_atomic(
                out,
                lambda tmp: FFmpegEngine().mix_tracks(
                    [(segment, gains_db[tid]) for tid, segment in segments],
                    tmp,
                    peak_ceiling_db=ceiling,
                ),
            )
        self._mark_play_cache_used(out)
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
            raise CodedValueError(
                "follow-transcript compare requires dialogue tracks",
                code="follow_transcript_needs_dialogue",
            )

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
