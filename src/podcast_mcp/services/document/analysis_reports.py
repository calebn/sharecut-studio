"""Read-only cleanup, fade, audibility, bleed and reconcile reports."""

from __future__ import annotations

from typing import cast

from podcast_mcp.edits.audio_quality import (
    audio_diagnostics_report,
    bleed_words,
    cleanup_analysis_report,
    fade_recommendations,
    gate_overreach_report,
)
from podcast_mcp.edits.audio_quality import (
    low_audibility_words as audit_low_audibility_words,
)
from podcast_mcp.edits.transcript_reconcile import (
    audibility_map as build_audibility_map,
)
from podcast_mcp.edits.transcript_reconcile import (
    flagged_words as list_flagged_transcript_words,
)
from podcast_mcp.edits.transcript_reconcile import (
    overlap_duplicate_report,
    reconciliation_status_report,
)
from podcast_mcp.services.document.analysis_report_results import (
    AudioDiagnosticsReport,
    CleanupAnalysisReport,
    GateOverreach,
    ReconciliationStatus,
)
from podcast_mcp.services.document.effects import EffectsService
from podcast_mcp.services.document.overlap_results import (
    OverlapDuplicateReport,
    overlap_duplicate_report_result,
)
from podcast_mcp.util.progress import ProgressReporter


class AnalysisReportService(EffectsService):
    def analyze_cleanup(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        progress: ProgressReporter | None = None,
    ) -> CleanupAnalysisReport:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)
        return cast(
            CleanupAnalysisReport,
            cleanup_analysis_report(
                self.ws.project,
                track_id=tid,
                progress=progress,
                defaults=self.ws.effective_config(),
            ),
        )

    def audio_diagnostics(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        start_sec: float | None = None,
        end_sec: float | None = None,
    ) -> AudioDiagnosticsReport:
        tid = self._resolve(track_id, speaker)
        return cast(
            AudioDiagnosticsReport,
            audio_diagnostics_report(
                self.ws.project,
                tid,
                start_sec=start_sec,
                end_sec=end_sec,
                defaults=self.ws.effective_config(),
            ),
        )

    def recommend_fades(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
    ) -> list[dict]:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)
        return fade_recommendations(
            self.ws.project, track_id=tid, defaults=self.ws.effective_config()
        )

    def low_audibility_words(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        progress: ProgressReporter | None = None,
    ) -> list[dict]:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)
        return audit_low_audibility_words(
            self.ws.project, track_id=tid, progress=progress, defaults=self.ws.effective_config()
        )

    def list_bleed_words(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        start_sec: float | None = None,
        end_sec: float | None = None,
        progress: ProgressReporter | None = None,
    ) -> list[dict]:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)
        return bleed_words(
            self.ws.project,
            track_id=tid,
            start_sec=start_sec,
            end_sec=end_sec,
            progress=progress,
            defaults=self.ws.effective_config(),
        )

    def overlap_duplicates(
        self,
        *,
        start_sec: float | None = None,
        end_sec: float | None = None,
        progress: ProgressReporter | None = None,
    ) -> OverlapDuplicateReport:
        return overlap_duplicate_report_result(
            overlap_duplicate_report(
                self.ws.project,
                start_sec=start_sec,
                end_sec=end_sec,
                progress=progress,
                defaults=self.ws.effective_config(),
            )
        )

    def gate_overreach(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        progress: ProgressReporter | None = None,
    ) -> GateOverreach:
        tid = self._resolve(track_id, speaker)
        return cast(
            GateOverreach,
            gate_overreach_report(
                self.ws.project, tid, progress=progress, defaults=self.ws.effective_config()
            ),
        )

    def audibility_map(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        progress: ProgressReporter | None = None,
    ) -> list[dict]:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)
        return build_audibility_map(
            self.ws.project, track_id=tid, progress=progress, defaults=self.ws.effective_config()
        )

    def flagged_words(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        progress: ProgressReporter | None = None,
    ) -> list[dict]:
        tid: str | None = None
        if track_id or speaker:
            tid = self._resolve(track_id, speaker)
        return list_flagged_transcript_words(
            self.ws.project, track_id=tid, progress=progress, defaults=self.ws.effective_config()
        )

    def reconciliation_status(self) -> ReconciliationStatus:
        return cast(
            ReconciliationStatus,
            reconciliation_status_report(self.ws.project, defaults=self.ws.effective_config()),
        )
