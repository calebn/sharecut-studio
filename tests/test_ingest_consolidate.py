from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.engines.align import AlignmentResult
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.transcript_align import TranscriptAlignResult
from podcast_mcp.ingest.consolidate import (
    _alignment_confidence,
    alignment_report,
    consolidate_speakers,
    list_audio_files,
)
from podcast_mcp.ingest.manifest import IngestManifest


def _two_speaker_manifest(tmp_path: Path, sample_wav: Path) -> tuple[Path, IngestManifest]:
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    ref = audio_dir / "ref.wav"
    guest = audio_dir / "guest.wav"
    ref.write_bytes(sample_wav.read_bytes())
    guest.write_bytes(sample_wav.read_bytes())
    manifest_path = tmp_path / "ingest.yaml"
    manifest_path.write_text(
        """
session:
  reference_speaker: Ref
speakers:
  - name: Ref
    sources: [ref.wav]
  - name: Guest
    sources: [guest.wav]
""",
        encoding="utf-8",
    )
    return audio_dir, IngestManifest.load(manifest_path)


def test_consolidate_full_file_without_extract_window(
    sample_wav: Path,
    tmp_path: Path,
) -> None:
    audio_dir, manifest = _two_speaker_manifest(tmp_path, sample_wav)
    out_dir = tmp_path / "raw"
    result = consolidate_speakers(
        manifest,
        audio_dir,
        out_dir,
        analysis_start_sec=0.0,
        analysis_duration_sec=1.5,
    )
    assert set(result.speaker_tracks) == {"Ref", "Guest"}
    assert all(p.is_file() for p in result.speaker_tracks.values())


def test_consolidate_manual_session_offset(sample_wav: Path, tmp_path: Path) -> None:
    audio_dir, manifest = _two_speaker_manifest(tmp_path, sample_wav)
    manifest.speakers[1].session_offset_sec = 0.75
    out_dir = tmp_path / "raw"
    result = consolidate_speakers(
        manifest,
        audio_dir,
        out_dir,
        analysis_start_sec=0.0,
        analysis_duration_sec=1.5,
        align_mode="audio",
    )
    assert result.cross_speaker_offsets["Guest"] == 0.75
    assert result.cross_speaker_align_method["Guest"] == "manual"


def test_consolidate_manual_session_start_in_file(
    sample_wav: Path,
    tmp_path: Path,
) -> None:
    audio_dir, manifest = _two_speaker_manifest(tmp_path, sample_wav)
    manifest.speakers[1].session_start_in_file_sec = 3.0
    out_dir = tmp_path / "raw"
    with patch(
        "podcast_mcp.ingest.consolidate.cross_speaker_offsets",
        return_value={},
    ):
        result = consolidate_speakers(
            manifest,
            audio_dir,
            out_dir,
            extract_start_sec=0.0,
            extract_duration_sec=1.0,
            align_mode="audio",
        )
    assert result.session_start_in_file_sec["Guest"] == 3.0


def test_consolidate_audio_rejected_weak_peak(sample_wav: Path, tmp_path: Path) -> None:
    audio_dir, manifest = _two_speaker_manifest(tmp_path, sample_wav)
    weak = AlignmentResult(
        reference=audio_dir / "ref.wav",
        source=audio_dir / "guest.wav",
        offset_sec=0.5,
        correlation_peak=0.01,
    )
    with patch(
        "podcast_mcp.ingest.consolidate.cross_speaker_offsets",
        return_value={"Guest": weak},
    ):
        result = consolidate_speakers(
            manifest,
            audio_dir,
            tmp_path / "raw",
            analysis_start_sec=0.0,
            analysis_duration_sec=1.5,
            min_cross_speaker_peak=0.05,
            align_mode="audio",
        )
    assert result.cross_speaker_offsets["Guest"] == 0.0
    assert result.cross_speaker_align_method["Guest"] == "audio_rejected"


def test_consolidate_transcript_align_mode(sample_wav: Path, tmp_path: Path) -> None:
    audio_dir, manifest = _two_speaker_manifest(tmp_path, sample_wav)
    transcript_path = tmp_path / "transcripts.json"
    transcript_path.write_text(
        json.dumps(
            {
                "per_track": [
                    {
                        "track_id": "ref",
                        "words": [{"text": "hi", "start": 0.0, "end": 0.5}],
                    },
                    {
                        "track_id": "guest",
                        "words": [{"text": "hey", "start": 0.1, "end": 0.6}],
                    },
                ]
            }
        ),
        encoding="utf-8",
    )
    transcript_result = TranscriptAlignResult(
        offset_sec=0.2,
        overlap_sec=0.4,
        overlap_at_zero_sec=0.1,
        method="turn_taking",
    )
    with patch(
        "podcast_mcp.ingest.consolidate.cross_speaker_offsets_from_transcripts",
        return_value={"Guest": transcript_result},
    ):
        result = consolidate_speakers(
            manifest,
            audio_dir,
            tmp_path / "raw",
            align_mode="transcript",
            transcript_path=transcript_path,
        )
    assert result.cross_speaker_offsets["Guest"] == 0.2
    assert result.cross_speaker_align_method["Guest"] == "turn_taking"
    assert result.transcript_overlap_sec["Guest"] == 0.4


def test_alignment_report_confidence_branches(
    sample_wav: Path,
    tmp_path: Path,
) -> None:
    audio_dir, manifest = _two_speaker_manifest(tmp_path, sample_wav)
    manifest.speakers[1].session_offset_sec = 0.1
    rows = alignment_report(
        manifest,
        audio_dir,
        analysis_start_sec=0.0,
        analysis_duration_sec=1.5,
        align_mode="audio",
    )
    ref_row = next(r for r in rows if r["speaker"] == "Ref")
    guest_row = next(r for r in rows if r["speaker"] == "Guest")
    assert ref_row["confidence"] == "reference"
    assert guest_row["align_method"] == "manual"
    assert guest_row["confidence"] == "high"


@pytest.mark.parametrize(
    "method,peak,overlap,expected",
    [
        ("manual", None, 0.0, "high"),
        ("anchor", None, 0.0, "high"),
        ("audio_rejected", 0.1, 0.0, "low"),
        ("audio", 0.05, 50.0, "low"),
        ("audio", 0.05, 10.0, "medium"),
        ("audio", 0.2, 5.0, "high"),
        ("audio", 0.2, 20.0, "medium"),
    ],
)
def test_alignment_confidence_helper(
    method: str,
    peak: float | None,
    overlap: float,
    expected: str,
) -> None:
    assert _alignment_confidence(method, peak, overlap, 90.0) == expected


def test_probe_durations_and_list_audio_files(
    sample_wav: Path,
    tmp_path: Path,
) -> None:
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    wav = audio_dir / "clip.wav"
    wav.write_bytes(sample_wav.read_bytes())
    (audio_dir / "notes.txt").write_text("skip", encoding="utf-8")
    durations = {wav.name: FFmpegEngine().probe(wav).duration_sec}
    assert durations["clip.wav"] == pytest.approx(2.0, abs=0.1)
    listed = list_audio_files(audio_dir)
    assert listed == [wav]


def test_consolidate_skips_empty_source_groups(
    sample_wav: Path,
    tmp_path: Path,
) -> None:
    audio_dir, manifest = _two_speaker_manifest(tmp_path, sample_wav)
    ref_path = audio_dir / "ref.wav"
    with patch.object(
        IngestManifest,
        "resolve_sources",
        return_value=[("Ref", [ref_path]), ("Guest", [])],
    ):
        result = consolidate_speakers(
            manifest,
            audio_dir,
            tmp_path / "raw",
            analysis_start_sec=0.0,
            analysis_duration_sec=1.5,
            align_mode="audio",
        )
    assert set(result.speaker_tracks) == {"Ref"}
    assert result.ignored_sources == []


def test_resolve_session_starts_without_reference_files(
    sample_wav: Path,
    tmp_path: Path,
) -> None:
    audio_dir, manifest = _two_speaker_manifest(tmp_path, sample_wav)
    guest_path = audio_dir / "guest.wav"
    with (
        patch.object(
            IngestManifest,
            "resolve_sources",
            return_value=[("Ref", []), ("Guest", [guest_path])],
        ),
        patch(
            "podcast_mcp.ingest.consolidate.cross_speaker_offsets",
            return_value={},
        ),
    ):
        result = consolidate_speakers(
            manifest,
            audio_dir,
            tmp_path / "raw",
            analysis_start_sec=0.0,
            analysis_duration_sec=1.5,
            align_mode="audio",
        )
    assert result.session_start_in_file_sec == {}


def test_alignment_report_includes_transcript_overlap(
    sample_wav: Path,
    tmp_path: Path,
) -> None:
    audio_dir, manifest = _two_speaker_manifest(tmp_path, sample_wav)
    transcript_path = tmp_path / "transcripts.json"
    transcript_path.write_text("{}", encoding="utf-8")
    transcript_result = TranscriptAlignResult(
        offset_sec=0.15,
        overlap_sec=0.55,
        overlap_at_zero_sec=0.1,
        method="anchor",
    )
    with patch(
        "podcast_mcp.ingest.consolidate.cross_speaker_offsets_from_transcripts",
        return_value={"Guest": transcript_result},
    ):
        rows = alignment_report(
            manifest,
            audio_dir,
            analysis_start_sec=0.0,
            analysis_duration_sec=1.5,
            align_mode="transcript",
            transcript_path=transcript_path,
        )
    guest_row = next(r for r in rows if r["speaker"] == "Guest")
    assert guest_row["transcript_overlap_sec"] == 0.55
    assert guest_row["confidence"] == "high"


def test_alignment_report_includes_correlation_peak(
    sample_wav: Path,
    tmp_path: Path,
) -> None:
    audio_dir, manifest = _two_speaker_manifest(tmp_path, sample_wav)
    audio_align = AlignmentResult(
        reference=audio_dir / "ref.wav",
        source=audio_dir / "guest.wav",
        offset_sec=0.2,
        correlation_peak=0.12,
    )
    with (
        patch(
            "podcast_mcp.ingest.consolidate.cross_speaker_offsets",
            return_value={"Guest": audio_align},
        ),
        patch(
            "podcast_mcp.ingest.consolidate.vad_speech_intervals",
            return_value=[(0.0, 1.0)],
        ),
        patch(
            "podcast_mcp.ingest.consolidate.simultaneous_speech_sec",
            return_value=5.0,
        ),
    ):
        rows = alignment_report(
            manifest,
            audio_dir,
            analysis_start_sec=0.0,
            analysis_duration_sec=1.5,
            align_mode="audio",
        )
    guest_row = next(r for r in rows if r["speaker"] == "Guest")
    assert guest_row["correlation_peak"] == 0.12


def test_alignment_report_skips_empty_source_groups(
    sample_wav: Path,
    tmp_path: Path,
) -> None:
    audio_dir, manifest = _two_speaker_manifest(tmp_path, sample_wav)
    ref_path = audio_dir / "ref.wav"
    with patch.object(
        IngestManifest,
        "resolve_sources",
        return_value=[("Ref", [ref_path]), ("Guest", [])],
    ):
        rows = alignment_report(
            manifest,
            audio_dir,
            analysis_start_sec=0.0,
            analysis_duration_sec=1.5,
            align_mode="audio",
        )
    assert len(rows) == 1
    assert rows[0]["speaker"] == "Ref"


def test_consolidate_keeps_extra_sources_as_whole_files(
    sample_wav: Path,
    tmp_path: Path,
) -> None:
    audio_dir, manifest = _two_speaker_manifest(tmp_path, sample_wav)
    extra = audio_dir / "guest_alt.wav"
    extra.write_bytes(sample_wav.read_bytes())
    manifest.speakers[1].sources.append("guest_alt.wav")
    result = consolidate_speakers(
        manifest,
        audio_dir,
        tmp_path / "raw",
        analysis_start_sec=0.0,
        analysis_duration_sec=1.5,
        align_mode="audio",
    )
    assert result.ignored_sources == []
    guest_align = next(a for a in result.alignments if a.name == manifest.speakers[1].name)
    assert len(guest_align.sources) == 2
    assert all(ar.source.is_file() for ar in guest_align.sources)


def test_consolidate_deletes_partial_outs_on_failure(
    sample_wav: Path,
    tmp_path: Path,
) -> None:
    audio_dir, manifest = _two_speaker_manifest(tmp_path, sample_wav)
    extra = audio_dir / "ref2.wav"
    extra.write_bytes(sample_wav.read_bytes())
    manifest.speakers[0].sources.append("ref2.wav")
    out_dir = tmp_path / "raw"
    n = {"c": 0}

    def boom(_self, _src, dest, _start, _end):
        n["c"] += 1
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"partial")
        if n["c"] >= 2:
            raise RuntimeError("extract failed")

    with patch.object(FFmpegEngine, "extract_segment", boom):
        with pytest.raises(RuntimeError, match="extract failed"):
            consolidate_speakers(
                manifest,
                audio_dir,
                out_dir,
                analysis_start_sec=0.0,
                analysis_duration_sec=1.5,
            )
    assert list(out_dir.glob("*.wav")) == []


def test_consolidate_short_files_default_analysis_start(tmp_path: Path, sample_wav: Path) -> None:
    audio_dir, manifest = _two_speaker_manifest(tmp_path, sample_wav)
    result = consolidate_speakers(manifest, audio_dir, tmp_path / "raw")
    assert set(result.speaker_tracks) == {"Ref", "Guest"}
    assert result.session_trimmed is False


def test_cross_speaker_reference_follows_manifest(tmp_path: Path, sample_wav: Path) -> None:
    audio_dir, manifest = _two_speaker_manifest(tmp_path, sample_wav)
    manifest.session.reference_speaker = "Guest"
    seen: list[str] = []

    def fake(groups, **_kw):
        seen.extend(n for n, _ in groups)
        return {}

    with patch("podcast_mcp.ingest.consolidate.cross_speaker_offsets", fake):
        consolidate_speakers(manifest, audio_dir, tmp_path / "raw", analysis_start_sec=0.0)
    assert seen[0] == "Guest"


def test_consolidate_extract_start_alone_trims_to_eof(tmp_path: Path, sample_wav: Path) -> None:
    audio_dir, manifest = _two_speaker_manifest(tmp_path, sample_wav)
    with patch("podcast_mcp.ingest.consolidate.cross_speaker_offsets", return_value={}):
        result = consolidate_speakers(
            manifest, audio_dir, tmp_path / "raw", extract_start_sec=0.5, align_mode="audio"
        )
    assert result.session_trimmed is True
    dur = FFmpegEngine().probe(result.speaker_tracks["Ref"]).duration_sec
    assert abs(dur - 1.5) < 0.1


def test_alignment_report_labels_manifest_reference(tmp_path: Path, sample_wav: Path) -> None:
    audio_dir, manifest = _two_speaker_manifest(tmp_path, sample_wav)
    manifest.session.reference_speaker = "Guest"
    with patch("podcast_mcp.ingest.consolidate.cross_speaker_offsets", return_value={}):
        rows = alignment_report(
            manifest,
            audio_dir,
            analysis_start_sec=0.0,
            analysis_duration_sec=1.5,
            align_mode="audio",
        )
    assert [r["speaker"] for r in rows] == ["Ref", "Guest"]
    by_name = {r["speaker"]: r for r in rows}
    assert by_name["Guest"]["align_method"] == "reference"
    assert by_name["Guest"]["content_align_sec"] == 0.0
    assert by_name["Ref"]["align_method"] != "reference"
