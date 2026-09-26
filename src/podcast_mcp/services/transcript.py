from __future__ import annotations

from pathlib import Path

from podcast_mcp.edits.transcript_cuts import format_transcript_timestamps
from podcast_mcp.edits.transcript_reuse import plan_transcription, run_transcribe_plan
from podcast_mcp.engines import TranscriptionEngine
from podcast_mcp.engines.transcribe import dialogue_transcribe_jobs, track_transcribe_job
from podcast_mcp.export.transcript import write_combined_transcript_markdown
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.whisper_models import resolve_whisper_model


class TranscriptService:
    def __init__(self, workspace: ProjectWorkspace, *, model: str | None = None) -> None:
        self.ws = workspace
        self._engine = TranscriptionEngine(resolve_whisper_model(requested=model))

    def transcribe(self, track_id: str | None = None) -> list[str]:
        def mutate(p) -> list[str]:
            jobs = [track_transcribe_job(p, track_id)] if track_id else dialogue_transcribe_jobs(p)
            # An explicit transcribe is an attended overwrite: edited transcripts are
            # replaced with a warning, never silently, and nothing else is touched.
            plan = plan_transcription(p, jobs, overwrite=True, unattended=False)
            # The ASR disk cache still counts (docs/transcript-workflow.md): unchanged
            # audio, model and prompt reuse it.
            transcripts = run_transcribe_plan(p, plan, lambda: self._engine, use_cache=True)
            return list(dict.fromkeys(t.track_id for t in transcripts))

        return self.ws.mutate("before transcribe", "after transcribe", mutate)

    def get(
        self,
        *,
        combined: bool = False,
        format: str = "json",
    ) -> str:
        p = self.ws.project
        if format == "timestamps":
            return format_transcript_timestamps(p)
        if combined:
            transcript = p.combined_transcript or self._engine.merge_transcripts(p)
            return transcript.model_dump_json(indent=2)
        import json

        return json.dumps([t.model_dump() for t in p.transcripts], indent=2)

    def export_markdown(self) -> Path:
        with self.ws.transaction() as p:
            if not p.combined_transcript:
                p.combined_transcript = self._engine.merge_transcripts(p)
            out = write_combined_transcript_markdown(p)
            self.ws.save()
        return out

    def export_subtitles(self, fmt: str = "srt") -> Path:
        from podcast_mcp.export.names import sanitize_export_stem
        from podcast_mcp.export.transcript import utterances_to_srt, utterances_to_vtt

        with self.ws.transaction() as p:
            if not p.combined_transcript:
                p.combined_transcript = self._engine.merge_transcripts(p)
            p.export_dir().mkdir(parents=True, exist_ok=True)
            if fmt == "vtt":
                out = p.export_dir() / f"{sanitize_export_stem(p.name)}.vtt"
                out.write_text(utterances_to_vtt(p), encoding="utf-8")
            else:
                out = p.export_dir() / f"{sanitize_export_stem(p.name)}.srt"
                out.write_text(utterances_to_srt(p), encoding="utf-8")
            self.ws.save()
        return out
