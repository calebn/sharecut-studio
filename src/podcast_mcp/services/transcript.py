from __future__ import annotations

from pathlib import Path

from podcast_mcp.edits.transcript_cuts import format_transcript_timestamps
from podcast_mcp.engines import TranscriptionEngine
from podcast_mcp.export.transcript import write_combined_transcript_markdown
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.transcript_context import load_transcript_context
from podcast_mcp.whisper_models import resolve_whisper_model


class TranscriptService:
    def __init__(self, workspace: ProjectWorkspace, *, model: str | None = None) -> None:
        self.ws = workspace
        self._engine = TranscriptionEngine(resolve_whisper_model(requested=model))

    def transcribe(self, track_id: str | None = None) -> list[str]:
        ctx = load_transcript_context(self.ws.project.workspace_path())
        prompt = ctx.initial_prompt_text()
        # Prompt and vocabulary_revision must come from this one load: a concurrent
        # edit mints a newer revision, so these transcripts stay stale in Studio.

        def mutate(p) -> list[str]:
            if track_id:
                t = self._engine.transcribe_track(p, track_id, initial_prompt=prompt)
                t.vocabulary_revision = ctx.vocabulary_revision
                p.transcripts = [x for x in p.transcripts if x.track_id != track_id]
                p.transcripts.append(t)
                return [t.track_id]
            transcripts = self._engine.transcribe_all_dialogue(p, initial_prompt=prompt)
            for t in transcripts:
                t.vocabulary_revision = ctx.vocabulary_revision
            p.transcripts = transcripts
            return [t.track_id for t in p.transcripts]

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
