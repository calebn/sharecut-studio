from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.transcript_search import ensure_combined_transcript
from podcast_mcp.export.transcript import ReadableTranscriptTimingError
from podcast_mcp.gui.schemas import GuestTranscriptExportRequest
from podcast_mcp.models import (
    Clip,
    CombinedTranscript,
    CombinedUtterance,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.models.clip_timing import ClipTiming, TimingStep
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import TranscriptService
from podcast_mcp.services.document.export_files import ExportFilesService
from podcast_mcp.util.coded_error import CodedFileNotFoundError


def _word(text: str, start: float) -> TranscriptWord:
    return TranscriptWord(text=text, start=start, end=start + 0.3)


def _workspace(path: Path) -> ProjectWorkspace:
    project = load_project(path)
    project.name = "Readable sample"
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                _word("First", 0),
                _word("thought.", 0.4),
                _word("Second", 1.2),
                _word("idea!", 1.6),
            ],
        ),
        Transcript(track_id="guest", words=[_word("Reply.", 3)]),
    ]
    ensure_combined_transcript(project, defaults=load_defaults())
    save_project(project, path)
    return ProjectWorkspace.open(path)


def test_service_exports_readable_paragraphs_with_one_header(minimal_project: Path) -> None:
    ws = _workspace(minimal_project)

    result = TranscriptService(ws).export(["readable.txt"])

    assert result.files[0].name == "Readable_sample.readable.txt"
    assert Path(result.files[0].path).read_text(encoding="utf-8") == (
        "Readable sample\n\nhost  0:00\nFirst thought. Second idea!\n\nguest  0:03\nReply.\n"
    )


def test_service_keeps_nonadjacent_speaker_turns_separate(minimal_project: Path) -> None:
    ws = _workspace(minimal_project)
    project = load_project(ws.path)
    project.transcripts = [
        Transcript(track_id="host", words=[_word("A.", 0), _word("A-again.", 4)]),
        Transcript(track_id="guest", words=[_word("B.", 2)]),
    ]
    ensure_combined_transcript(project, defaults=load_defaults())
    save_project(project, ws.path)

    result = TranscriptService(ws).export(["readable.txt"])

    assert Path(result.files[0].path).read_text(encoding="utf-8") == (
        "Readable sample\n\nhost  0:00\nA.\n\nguest  0:02\nB.\n\nhost  0:04\nA-again.\n"
    )


def test_overlapping_speaker_runs_do_not_interleave_words(minimal_project: Path) -> None:
    ws = _workspace(minimal_project)
    project = load_project(ws.path)
    project.transcripts = [
        Transcript(track_id="host", words=[_word("Host", 0), _word("continues.", 0.7)]),
        Transcript(track_id="guest", words=[_word("Guest", 0.4), _word("interrupts.", 0.9)]),
    ]
    ensure_combined_transcript(project, defaults=load_defaults())
    save_project(project, ws.path)

    result = TranscriptService(ProjectWorkspace.open(ws.path)).export(["readable.txt"])

    assert Path(result.files[0].path).read_text(encoding="utf-8") == (
        "Readable sample\n\nhost  0:00\nHost continues.\n\nguest  0:00\nGuest interrupts.\n"
    )


def test_legacy_formats_remain_available(minimal_project: Path) -> None:
    ws = _workspace(minimal_project)

    result = TranscriptService(ws).export(["txt", "md", "srt", "vtt"])

    assert [item.format for item in result.files] == ["txt", "md", "srt", "vtt"]
    assert (
        Path(result.files[0].path)
        .read_text(encoding="utf-8")
        .startswith("Readable sample\nLanguage: en\n\n")
    )


def test_unknown_format_still_fails_at_service_boundary(minimal_project: Path) -> None:
    ws = _workspace(minimal_project)

    with pytest.raises(ValueError, match="html") as error:
        TranscriptService(ws).export(["html"])

    assert getattr(error.value, "code", None) == "invalid_format"


def test_guest_gui_contract_accepts_all_formats_and_rejects_invalid_selections() -> None:
    request = GuestTranscriptExportRequest(formats=["txt", "md", "readable.txt", "srt", "vtt"])

    assert request.formats == ["txt", "md", "readable.txt", "srt", "vtt"]
    with pytest.raises(ValueError):
        GuestTranscriptExportRequest(formats=["html"])
    with pytest.raises(ValueError):
        GuestTranscriptExportRequest(formats=["txt", "md", "readable.txt", "srt", "vtt", "txt"])


def test_readable_output_keeps_corrections_and_drops_suppressed_words(
    minimal_project: Path,
) -> None:
    ws = _workspace(minimal_project)
    project = load_project(ws.path)
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                _word("Budapest", 0),
                TranscriptWord(text="Wrong.", start=0.4, end=0.7, suppressed=True),
                _word("corrected.", 0.8),
            ],
        )
    ]
    ensure_combined_transcript(project, defaults=load_defaults())
    save_project(project, ws.path)

    result = TranscriptService(ProjectWorkspace.open(ws.path)).export(["readable.txt"])

    assert Path(result.files[0].path).read_text(encoding="utf-8") == (
        "Readable sample\n\nhost  0:00\nBudapest corrected.\n"
    )


def test_readable_output_omits_cut_words_and_keeps_boundary_word(minimal_project: Path) -> None:
    ws = _workspace(minimal_project)
    project = load_project(ws.path)
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                _word("Keep", 0.1),
                _word("straddles", 0.9),
                _word("remove", 1.2),
                _word("keep.", 2.2),
            ],
        )
    ]
    project.clips = [
        Clip(id="before", track_id="host", source_start=0, source_end=1, timeline_start=0),
        Clip(id="after", track_id="host", source_start=2, source_end=4, timeline_start=2),
    ]
    ensure_combined_transcript(project, defaults=load_defaults())
    save_project(project, ws.path)

    result = TranscriptService(ProjectWorkspace.open(ws.path)).export(["readable.txt"])

    assert Path(result.files[0].path).read_text(encoding="utf-8") == (
        "Readable sample\n\nhost  0:00\nKeep straddles keep.\n"
    )


def test_combined_only_partial_cut_refuses_readable_before_publication(
    minimal_project: Path,
) -> None:
    ws = _workspace(minimal_project)
    project = load_project(ws.path)
    project.transcripts = []
    project.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host", speaker="host", start=0, end=3, text="Cannot split this."
            )
        ]
    )
    project.clips = [
        Clip(id="before", track_id="host", source_start=0, source_end=1, timeline_start=0),
        Clip(id="after", track_id="host", source_start=2, source_end=3, timeline_start=1),
    ]
    save_project(project, ws.path)
    export_path = (
        ProjectWorkspace.open(ws.path).project.export_dir() / "Readable_sample.readable.txt"
    )

    with pytest.raises(ReadableTranscriptTimingError) as error:
        TranscriptService(ProjectWorkspace.open(ws.path)).export(["readable.txt"])

    assert error.value.code == "readable_timing_unavailable"
    assert not export_path.exists()

    with pytest.raises(ReadableTranscriptTimingError):
        TranscriptService(ProjectWorkspace.open(ws.path)).export(["readable.txt"], dry_run=True)
    assert not export_path.exists()


def test_combined_only_intact_and_fully_removed_utterances(minimal_project: Path) -> None:
    ws = _workspace(minimal_project)
    project = load_project(ws.path)
    project.transcripts = []
    project.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(track_id="host", speaker="Host", start=0, end=1, text="Intact.")
        ]
    )
    save_project(project, ws.path)

    intact = TranscriptService(ProjectWorkspace.open(ws.path)).export(["readable.txt"])

    assert Path(intact.files[0].path).read_text(encoding="utf-8") == (
        "Readable sample\n\nHost  0:00\nIntact.\n"
    )

    project.clips = [
        Clip(id="outside", track_id="host", source_start=2, source_end=3, timeline_start=0)
    ]
    save_project(project, ws.path)
    with pytest.raises(ValueError, match="Every word is cut"):
        TranscriptService(ProjectWorkspace.open(ws.path)).export(["readable.txt"])


def test_blank_entries_do_not_choose_the_turn_header(minimal_project: Path) -> None:
    ws = _workspace(minimal_project)
    project = load_project(ws.path)
    project.transcripts = [
        Transcript(track_id="host", words=[_word("  \n\t ", 0), _word("Visible.", 3)])
    ]
    ensure_combined_transcript(project, defaults=load_defaults())
    save_project(project, ws.path)

    result = TranscriptService(ProjectWorkspace.open(ws.path)).export(["readable.txt"])

    assert Path(result.files[0].path).read_text(encoding="utf-8") == (
        "Readable sample\n\nhost  0:03\nVisible.\n"
    )


def test_readable_file_lists_with_plain_text_mime_and_currentness(minimal_project: Path) -> None:
    ws = _workspace(minimal_project)
    result = TranscriptService(ws).export(["readable.txt"])

    exported = TranscriptService(ProjectWorkspace.open(ws.path)).exported()

    assert [(item.format, item.name, item.mime, item.current) for item in exported] == [
        ("readable.txt", "Readable_sample.readable.txt", "text/plain", True)
    ]
    assert result.files[0].current is True

    files = ExportFilesService(ProjectWorkspace.open(ws.path))
    listed = files.list()
    assert [(file.name, file.label, file.current) for file in listed] == [
        ("Readable_sample.readable.txt", "Reading copy", True)
    ]
    served = files.open("Readable_sample.readable.txt")
    assert served.media_type == "text/plain"
    with pytest.raises(CodedFileNotFoundError):
        files.open("../Readable_sample.readable.txt")


def test_readable_projection_sorts_shifted_and_repeated_placements(minimal_project: Path) -> None:
    ws = _workspace(minimal_project)
    project = load_project(ws.path)
    project.transcripts = [
        Transcript(track_id="host", words=[_word("First", 0.1), _word("second.", 2.1)])
    ]
    project.clips = [
        Clip(
            id="later-source-first", track_id="host", source_start=0, source_end=1, timeline_start=3
        ),
        Clip(
            id="earlier-source-second",
            track_id="host",
            source_start=2,
            source_end=3,
            timeline_start=0,
        ),
        Clip(id="repeat", track_id="host", source_start=0, source_end=1, timeline_start=5),
    ]
    ensure_combined_transcript(project, defaults=load_defaults())
    save_project(project, ws.path)

    result = TranscriptService(ProjectWorkspace.open(ws.path)).export(["readable.txt"])

    assert Path(result.files[0].path).read_text(encoding="utf-8") == (
        "Readable sample\n\nhost  0:00\nsecond. First First\n"
    )


def test_partial_reuse_keeps_each_clip_occurrence_in_source_order(minimal_project: Path) -> None:
    ws = _workspace(minimal_project)
    project = load_project(ws.path)
    project.transcripts = [
        Transcript(track_id="host", words=[_word("A", 0), _word("B", 1), _word("C", 2)])
    ]
    project.clips = [
        Clip(id="first", track_id="host", source_start=0, source_end=1.5, timeline_start=0),
        Clip(id="second", track_id="host", source_start=1, source_end=2.5, timeline_start=10),
    ]
    ensure_combined_transcript(project, defaults=load_defaults())
    save_project(project, ws.path)

    result = TranscriptService(ProjectWorkspace.open(ws.path)).export(["readable.txt"])

    assert Path(result.files[0].path).read_text(encoding="utf-8") == (
        "Readable sample\n\nhost  0:00\nA B B C\n"
    )


def test_timed_placement_gap_allows_intervening_speaker(minimal_project: Path) -> None:
    ws = _workspace(minimal_project)
    project = load_project(ws.path)
    project.transcripts = [
        Transcript(track_id="host", words=[_word("Before.", 0), _word("After.", 1)]),
        Transcript(track_id="guest", words=[_word("Between.", 5)]),
    ]
    project.clips = [
        Clip(
            id="timed",
            track_id="host",
            source_start=0,
            source_end=2,
            timeline_start=0,
            timing=ClipTiming(steps=[TimingStep(at=0.5, delta_sec=10)]),
        )
    ]
    ensure_combined_transcript(project, defaults=load_defaults())
    save_project(project, ws.path)

    result = TranscriptService(ProjectWorkspace.open(ws.path)).export(["readable.txt"])

    assert Path(result.files[0].path).read_text(encoding="utf-8") == (
        "Readable sample\n\nhost  0:00\nBefore.\n\nguest  0:05\nBetween.\n\nhost  0:11\nAfter.\n"
    )


def test_combined_only_positive_timing_gap_keeps_fully_retained_text(minimal_project: Path) -> None:
    ws = _workspace(minimal_project)
    project = load_project(ws.path)
    project.transcripts = []
    project.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(track_id="host", speaker="Host", start=0, end=2, text="All retained.")
        ]
    )
    project.clips = [
        Clip(
            id="timed",
            track_id="host",
            source_start=0,
            source_end=2,
            timeline_start=0,
            timing=ClipTiming(steps=[TimingStep(at=1, delta_sec=10)]),
        )
    ]
    save_project(project, ws.path)

    result = TranscriptService(ProjectWorkspace.open(ws.path)).export(["readable.txt"])

    assert Path(result.files[0].path).read_text(encoding="utf-8") == (
        "Readable sample\n\nHost  0:00\nAll retained.\n"
    )


def test_partial_word_repeated_placements_do_not_infer_count_from_duration(
    minimal_project: Path,
) -> None:
    ws = _workspace(minimal_project)
    project = load_project(ws.path)
    project.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="Kept.", start=0, end=1)])
    ]
    project.clips = [
        Clip(id="first", track_id="host", source_start=0, source_end=0.2, timeline_start=0),
        Clip(id="repeat", track_id="host", source_start=0, source_end=0.2, timeline_start=10),
    ]
    ensure_combined_transcript(project, defaults=load_defaults())
    save_project(project, ws.path)

    result = TranscriptService(ProjectWorkspace.open(ws.path)).export(["readable.txt"])

    assert Path(result.files[0].path).read_text(encoding="utf-8") == (
        "Readable sample\n\nhost  0:00\nKept. Kept.\n"
    )


def test_word_crossing_virtual_pieces_occurs_once_per_clip(minimal_project: Path) -> None:
    ws = _workspace(minimal_project)
    project = load_project(ws.path)
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="Across", start=0.4, end=0.8),
                _word("after.", 1),
            ],
        )
    ]
    project.clips = [
        Clip(
            id="timed",
            track_id="host",
            source_start=0,
            source_end=2,
            timeline_start=offset,
            timing=ClipTiming(steps=[TimingStep(at=0.5, delta_sec=10)]),
        )
        for offset in (0, 20)
    ]
    project.clips[1].id = "repeat"
    ensure_combined_transcript(project, defaults=load_defaults())
    save_project(project, ws.path)

    result = TranscriptService(ProjectWorkspace.open(ws.path)).export(["readable.txt"])

    assert Path(result.files[0].path).read_text(encoding="utf-8") == (
        "Readable sample\n\nhost  0:00\nAcross after. Across after.\n"
    )


def test_zero_length_words_keep_clip_end_boundary_fallback(minimal_project: Path) -> None:
    ws = _workspace(minimal_project)
    project = load_project(ws.path)
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="Start", start=0, end=0),
                _word("middle", 0.4),
                TranscriptWord(text="end.", start=1, end=1),
                TranscriptWord(text="cut", start=1.5, end=1.5),
            ],
        )
    ]
    project.clips = [
        Clip(id="kept", track_id="host", source_start=0, source_end=1, timeline_start=3)
    ]
    ensure_combined_transcript(project, defaults=load_defaults())
    save_project(project, ws.path)

    result = TranscriptService(ProjectWorkspace.open(ws.path)).export(["readable.txt"])

    assert Path(result.files[0].path).read_text(encoding="utf-8") == (
        "Readable sample\n\nhost  0:03\nStart middle end.\n"
    )


def test_paragraph_reflow_uses_entry_boundaries_and_keeps_long_single_entry(
    minimal_project: Path,
) -> None:
    ws = _workspace(minimal_project)
    project = load_project(ws.path)
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                _word(" ".join(["word"] * 100), 0),
                _word(" ".join(["word"] * 70), 3),
                _word(" ".join(["long"] * 161), 7),
            ],
        )
    ]
    ensure_combined_transcript(project, defaults=load_defaults())
    save_project(project, ws.path)

    result = TranscriptService(ProjectWorkspace.open(ws.path)).export(["readable.txt"])
    body = Path(result.files[0].path).read_text(encoding="utf-8").split("host  0:00\n", 1)[1]
    paragraphs = body.rstrip("\n").split("\n\n")

    assert paragraphs == [
        " ".join(["word"] * 170),
        " ".join(["long"] * 161),
    ]


def test_blank_only_readable_export_refuses_to_publish(minimal_project: Path) -> None:
    ws = _workspace(minimal_project)
    project = load_project(ws.path)
    project.transcripts = [Transcript(track_id="host", words=[_word(" \n  ", 0)])]
    ensure_combined_transcript(project, defaults=load_defaults())
    save_project(project, ws.path)
    destination = (
        ProjectWorkspace.open(ws.path).project.export_dir() / "Readable_sample.readable.txt"
    )

    with pytest.raises(ValueError, match="No readable transcript text"):
        TranscriptService(ProjectWorkspace.open(ws.path)).export(["readable.txt"])

    assert not destination.exists()


def test_paragraph_reflow_skips_decimal_dots_and_keeps_closing_quotes(
    minimal_project: Path,
) -> None:
    ws = _workspace(minimal_project)
    project = load_project(ws.path)
    phrase = " ".join(["word"] * 78 + ["3.14", 'done."', "Next."])
    project.transcripts = [Transcript(track_id="host", words=[_word(phrase, 0)])]
    ensure_combined_transcript(project, defaults=load_defaults())
    save_project(project, ws.path)

    result = TranscriptService(ProjectWorkspace.open(ws.path)).export(["readable.txt"])

    assert Path(result.files[0].path).read_text(encoding="utf-8") == (
        "Readable sample\n\nhost  0:00\n"
        + " ".join(["word"] * 78 + ["3.14", 'done."'])
        + "\n\nNext.\n"
    )


def test_timing_unavailable_marks_only_readable_listing_stale(minimal_project: Path) -> None:
    ws = _workspace(minimal_project)
    service = TranscriptService(ws)
    readable = service.export(["readable.txt"]).files[0]
    detailed = service.export(["txt"]).files[0]
    project = load_project(ws.path)
    project.transcripts = []
    project.clips = [
        Clip(id="before", track_id="host", source_start=0, source_end=1, timeline_start=0),
        Clip(id="after", track_id="host", source_start=2, source_end=3, timeline_start=1),
    ]
    project.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host", speaker="host", start=0, end=3, text="Partly cut text."
            )
        ]
    )
    save_project(project, ws.path)

    listed = TranscriptService(ProjectWorkspace.open(ws.path)).exported()

    assert [(row.format, row.current) for row in listed] == [
        ("txt", False),
        ("readable.txt", False),
    ]
    assert Path(readable.path).exists() and Path(detailed.path).exists()
