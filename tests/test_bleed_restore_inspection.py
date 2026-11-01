from __future__ import annotations

import os
import wave
from pathlib import Path

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.bleed_restore_targets import BleedRestoreChangedError
from podcast_mcp.engines.bleed_gate import BleedGatePlan
from podcast_mcp.models import Clip, ClipOffSpeakerMuteRegion, EpisodeProject, MediaAsset, Track
from podcast_mcp.models.episode import (
    ClipBleedRestore,
    SourceRecording,
    SourceSpan,
    TranscriptGateScope,
)
from podcast_mcp.project.history import HistoryManager
from podcast_mcp.project.store import ProjectStore, save_project
from podcast_mcp.services.app.workspace import ProjectWorkspace
from podcast_mcp.services.document.bleed_inspection import inspect_clip_bleed, restore_clip_bleed


@pytest.fixture
def workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectWorkspace:
    with wave.open(str(tmp_path / "host.wav"), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b"\x01\x00" * 80000)
    project = EpisodeProject.create("inspection", str(tmp_path))
    project.ensure_dirs()
    project.tracks.append(
        Track(
            id="host",
            label="Host",
            media=MediaAsset(path="host.wav", duration_sec=10),
            transcript_gate=True,
        )
    )
    project.clips = [
        Clip(id="selected", track_id="host", source_start=2, source_end=8, timeline_start=10),
        Clip(id="other", track_id="host", source_start=2, source_end=8, timeline_start=10),
    ]
    monkeypatch.setattr(
        "podcast_mcp.services.document.bleed_inspection.build_bleed_gate_plan",
        lambda *_args, **_kwargs: BleedGatePlan(attenuation_spans=((11, 15),)),
    )
    return ProjectWorkspace.open(save_project(project))


def test_inspection_maps_actual_plan_and_does_not_change_project(workspace):
    before = workspace.project.model_dump(mode="json")
    inspection = inspect_clip_bleed(workspace, "selected", track_id="host")
    assert inspection.plan_state == "ready"
    assert inspection.artifact_state == "missing"
    region = inspection.regions[0]
    assert (region.source.start_s, region.source.end_s) == (3, 7)
    assert (region.timeline.start, region.timeline.end) == (11, 15)
    assert region.target.expected_head_id == "root"
    assert workspace.project.model_dump(mode="json") == before


def test_authored_mask_is_actionable_when_late_gate_is_disabled(workspace):
    workspace.project.tracks[0].transcript_gate = False
    workspace.project.clips[0].off_speaker_mute_regions = [
        ClipOffSpeakerMuteRegion(start_s=1, end_s=5)
    ]
    workspace.save()
    inspection = inspect_clip_bleed(workspace, "selected", track_id="host")
    assert inspection.plan_state == "disabled"
    assert [region.kind for region in inspection.regions] == ["bleed_mute:off_speaker"]
    assert (inspection.regions[0].source.start_s, inspection.regions[0].source.end_s) == (2, 5)
    assert inspection.regions[0].actual_source.start_s == 1
    before = workspace.project.clips[1].model_copy(deep=True)
    result = restore_clip_bleed(workspace, inspection.regions[0].target)
    assert result["history_head_id"] == workspace.project.history.head_id()
    assert workspace.project.clips[1] == before
    assert workspace.project.clips[0].off_speaker_mute_regions[0].start_s == 1
    assert workspace.project.clips[0].bleed_restore.regions[0].start_s == 2


def test_real_unity_plan_has_no_late_restore_target(tmp_path, monkeypatch):
    from podcast_mcp.engines.bleed_gate import build_bleed_gate_plan
    from test_bleed_attenuation import _configure, _talking_over

    _configure(monkeypatch, tmp_path, bleed_handling="attenuate", bleed_attenuation_db=0.0)
    project = _talking_over(tmp_path)
    project.clips[0].off_speaker_mute_regions = [ClipOffSpeakerMuteRegion(start_s=3, end_s=5)]
    ws = ProjectWorkspace.open(save_project(project))
    plan = build_bleed_gate_plan(ws.project, "host", defaults=load_defaults())
    assert plan.attenuation_spans and plan.floor_gain == 1.0
    inspection = inspect_clip_bleed(ws, "clip-host", track_id="host")
    assert inspection.plan_state == "ready"
    assert [region.kind for region in inspection.regions] == ["bleed_mute:off_speaker"]
    assert inspection.regions[0].target is not None


@pytest.mark.parametrize(
    "plan",
    [
        BleedGatePlan(),
        BleedGatePlan(attenuation_spans=((11, 15),), reasons=("unavailable_peer_source",)),
    ],
)
def test_authored_targets_do_not_depend_on_late_plan_evidence(workspace, monkeypatch, plan):
    workspace.project.clips[0].off_speaker_mute_regions = [
        ClipOffSpeakerMuteRegion(start_s=3, end_s=7)
    ]
    workspace.save()
    monkeypatch.setattr(
        "podcast_mcp.services.document.bleed_inspection.build_bleed_gate_plan",
        lambda *_, **_kw: plan,
    )
    inspection = inspect_clip_bleed(workspace, "selected", track_id="host")
    authored = [r for r in inspection.regions if r.kind == "bleed_mute:off_speaker"]
    assert len(authored) == 1 and authored[0].target is not None
    assert all(r.target is None for r in inspection.regions if r.kind == "late_gate")
    restore_clip_bleed(workspace, authored[0].target)


def test_valid_empty_plan_and_ordinary_masks_do_not_invent_automatic_regions(
    workspace, monkeypatch
):
    from podcast_mcp.models import ClipMuteRegion, Transcript, TranscriptWord

    monkeypatch.setattr(
        "podcast_mcp.services.document.bleed_inspection.build_bleed_gate_plan",
        lambda *_, **_kw: BleedGatePlan(),
    )
    workspace.project.clips[0].mute_regions = [
        ClipMuteRegion(start_s=3, end_s=6),
        ClipMuteRegion(start_s=6, end_s=7, gain_db=-6),
    ]
    workspace.project.transcripts.append(
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(
                    text="word",
                    start=3,
                    end=4,
                    suppressed=True,
                    ignored=True,
                    audibility_status="bleed",
                )
            ],
        )
    )
    workspace.save()
    inspection = inspect_clip_bleed(workspace, "selected", track_id="host")
    assert inspection.plan_state == "ready" and inspection.regions == []


def test_saved_choices_partition_rows_and_each_target_names_its_own_fragment(workspace):
    from podcast_mcp.util.hashing import sha256_file

    workspace.project.clips[0].bleed_restore = ClipBleedRestore(
        source_sha256=sha256_file(workspace.path.parent / "host.wav"),
        regions=[SourceSpan(start_s=4, end_s=6)],
    )
    workspace.save()
    inspection = inspect_clip_bleed(workspace, "selected", track_id="host")
    assert inspection.restore_state == "current"
    assert [(r.source.start_s, r.source.end_s, r.restore_state) for r in inspection.regions] == [
        (3, 4, "available"),
        (4, 6, "saved"),
        (6, 7, "available"),
    ]
    available = [r for r in inspection.regions if r.target]
    assert all(r.target.region == r.source for r in available)
    assert len({r.target.model_dump_json() for r in available}) == 2
    restore_clip_bleed(workspace, available[0].target)
    assert [(r.start_s, r.end_s) for r in workspace.project.clips[0].bleed_restore.regions] == [
        (3, 6)
    ]


@pytest.mark.parametrize(
    "change",
    [
        "geometry",
        "source",
        "gate_disabled",
        "automatic_mask",
        "scope",
        "other_choice",
        "history",
        "peer",
        "policy",
        "plan",
        "content",
        "atomic_content",
    ],
)
def test_changed_inputs_refuse_before_any_mutation(workspace, monkeypatch, change):
    workspace.project.tracks.append(
        Track(id="peer", label="Peer", media=MediaAsset(path="host.wav", duration_sec=10))
    )
    workspace.save()
    target = inspect_clip_bleed(workspace, "selected", track_id="host").regions[0].target
    if change == "geometry":
        workspace.project.clips[0].timeline_start += 1
    elif change == "source":
        workspace.project.sources.append(SourceRecording(id="secondary", path="host.wav"))
        workspace.project.clips[0].source_id = "secondary"
    elif change == "gate_disabled":
        workspace.project.tracks[0].transcript_gate = False
    elif change == "automatic_mask":
        workspace.project.clips[0].off_speaker_mute_regions = [
            ClipOffSpeakerMuteRegion(start_s=3, end_s=4)
        ]
    elif change == "scope":
        workspace.project.tracks[0].transcript_gate_scope = [
            TranscriptGateScope(start_s=3, end_s=5)
        ]
    elif change == "other_choice":
        workspace.project.clips[1].bleed_restore = ClipBleedRestore(
            source_sha256=target.source_sha256, regions=[SourceSpan(start_s=3, end_s=4)]
        )
    elif change == "history":
        workspace.record_snapshot("external history", force=True)
    elif change == "peer":
        workspace.project.tracks[1].timeline_empty = True
    elif change == "policy":
        import podcast_mcp.services.document.bleed_inspection as service

        original = service.bleed_gate_payload
        monkeypatch.setattr(
            service,
            "bleed_gate_payload",
            lambda *args, **_kw: {**original(*args, **_kw), "policy": {"changed": True}},
        )
    elif change == "plan":
        monkeypatch.setattr(
            "podcast_mcp.services.document.bleed_inspection.build_bleed_gate_plan",
            lambda *_, **_kw: BleedGatePlan(attenuation_spans=((11, 14),)),
        )
    else:
        path = workspace.path.parent / "host.wav"
        previous = path.stat()
        content = path.read_bytes()
        if change == "atomic_content":
            replacement = path.with_suffix(".replacement")
            replacement.write_bytes(content[:-2] + b"\x02\x00")
            os.utime(replacement, ns=(previous.st_atime_ns, previous.st_mtime_ns))
            replacement.replace(path)
        else:
            path.write_bytes(content[:-2] + b"\x02\x00")
    workspace.save()
    before = workspace.path.read_bytes()
    monkeypatch.setattr(
        workspace, "mutate", lambda *_args, **_kwargs: pytest.fail("stale target reached mutate")
    )
    with pytest.raises(BleedRestoreChangedError, match="Inspect"):
        restore_clip_bleed(workspace, target)
    assert workspace.path.read_bytes() == before


@pytest.mark.parametrize(
    "field,value",
    [
        ("clip", None),
        ("kind", "bleed_mute:off_speaker"),
        ("media_seal", "forged"),
        ("dependencies_digest", "forged"),
        ("plan_digest", "forged"),
        ("region", SourceSpan(start_s=3, end_s=6)),
    ],
)
def test_forged_targets_refuse_before_mutation(workspace, monkeypatch, field, value):
    target = inspect_clip_bleed(workspace, "selected", track_id="host").regions[0].target
    if field == "clip":
        value = target.clip.model_copy(update={"id": "unknown"})
    forged = target.model_copy(update={field: value})
    monkeypatch.setattr(
        workspace, "mutate", lambda *_args, **_kwargs: pytest.fail("forged target reached mutate")
    )
    with pytest.raises(BleedRestoreChangedError):
        restore_clip_bleed(workspace, forged)


def test_external_commit_is_adopted_before_history_validation(workspace, monkeypatch):
    target = inspect_clip_bleed(workspace, "selected", track_id="host").regions[0].target
    outside = ProjectWorkspace.open(workspace.path)
    outside.mutate(
        "before outside", "after outside", lambda p: setattr(p.tracks[0], "label", "Outside label")
    )
    before = workspace.path.read_bytes()
    monkeypatch.setattr(
        workspace, "mutate", lambda *_args, **_kwargs: pytest.fail("outside commit overwritten")
    )
    with pytest.raises(BleedRestoreChangedError):
        restore_clip_bleed(workspace, target)
    assert workspace.project.tracks[0].label == "Outside label"
    assert workspace.path.read_bytes() == before


def test_implicit_inspection_is_read_only_and_restore_materializes_selected_lane_once(
    workspace, monkeypatch
):
    workspace.project.clips = []
    workspace.project.tracks.append(
        Track(id="peer", label="Peer", media=MediaAsset(path="host.wav", duration_sec=10))
    )
    workspace.save()
    monkeypatch.setattr(
        "podcast_mcp.services.document.bleed_inspection.build_bleed_gate_plan",
        lambda *_, **_kw: BleedGatePlan(attenuation_spans=((1, 5),)),
    )
    before = workspace.path.read_bytes()
    inspection = inspect_clip_bleed(workspace, "clip_host_full", track_id="host")
    assert workspace.project.clips == [] and workspace.path.read_bytes() == before
    target = inspection.regions[0].target
    assert target.occurrence_kind == "implicit"
    result = restore_clip_bleed(workspace, target)
    assert [c.id for c in workspace.project.clips] == ["clip_host_full"]
    manager = HistoryManager(ProjectStore(workspace.path))
    manager.undo(workspace.project, expected_head_id=result["history_head_id"])
    assert workspace.project.clips == []
    manager.redo(workspace.project, expected_head_id=workspace.project.history.head_id())
    assert [c.id for c in workspace.project.clips] == ["clip_host_full"]


def test_changed_content_deactivates_choices_and_explicit_new_target_binds_new_bytes(workspace):
    target = inspect_clip_bleed(workspace, "selected", track_id="host").regions[0].target
    restore_clip_bleed(workspace, target)
    path = workspace.path.parent / "host.wav"
    path.write_bytes(path.read_bytes()[:-2] + b"\x02\x00")
    inspection = inspect_clip_bleed(workspace, "selected", track_id="host")
    assert inspection.restore_state == "changed_content"
    assert inspection.regions[0].restore_state == "available"
    new_target = inspection.regions[0].target
    assert new_target.source_sha256 != target.source_sha256
    restore_clip_bleed(workspace, new_target)
    assert inspect_clip_bleed(workspace, "selected", track_id="host").restore_state == "current"


def test_missing_recording_leaves_saved_intent_unverified_and_issues_no_targets(workspace):
    workspace.project.clips[0].bleed_restore = ClipBleedRestore(
        source_sha256="a" * 64, regions=[SourceSpan(start_s=3, end_s=4)]
    )
    workspace.save()
    (workspace.path.parent / "host.wav").unlink()
    inspection = inspect_clip_bleed(workspace, "selected", track_id="host")
    assert inspection.restore_state == "unverified"
    assert inspection.saved_source_regions == [SourceSpan(start_s=3, end_s=4)]
    assert all(region.target is None for region in inspection.regions)


@pytest.mark.parametrize("during", ["hash", "plan"])
def test_media_replaced_during_inspection_is_refused(workspace, monkeypatch, during):
    import podcast_mcp.services.document.bleed_inspection as service

    path = workspace.path.parent / "host.wav"

    def replace():
        replacement = path.with_suffix(".replacement")
        replacement.write_bytes(path.read_bytes())
        replacement.replace(path)

    if during == "hash":
        original = service.sha256_file

        def changed_hash(path):
            digest = original(path)
            replace()
            return digest

        monkeypatch.setattr(service, "sha256_file", changed_hash)
    else:

        def changed_plan(*_args, **_kw):
            replace()
            return BleedGatePlan(attenuation_spans=((11, 15),))

        monkeypatch.setattr(service, "build_bleed_gate_plan", changed_plan)
    before = workspace.path.read_bytes()
    with pytest.raises(BleedRestoreChangedError):
        inspect_clip_bleed(workspace, "selected", track_id="host")
    assert workspace.path.read_bytes() == before


def test_restore_changes_only_selected_choice_and_preserves_metadata_through_reload_and_undo(
    workspace, monkeypatch
):
    from podcast_mcp.models import ClipMuteRegion, Transcript, TranscriptWord

    workspace.project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(
                    text="word",
                    start=3,
                    end=4,
                    suppressed=True,
                    audibility_status="bleed",
                    ignored=True,
                    audibility_locked=True,
                    timing_edited=True,
                )
            ],
        )
    ]
    workspace.project.clips[0].mute_regions = [ClipMuteRegion(start_s=3, end_s=5)]
    workspace.project.clips[0].off_speaker_mute_regions = [
        ClipOffSpeakerMuteRegion(start_s=3, end_s=6)
    ]
    workspace.project.tracks[0].transcript_gate_scope = [TranscriptGateScope(start_s=3, end_s=7)]
    workspace.save()
    before = workspace.project.model_copy(deep=True)
    target = inspect_clip_bleed(workspace, "selected", track_id="host").regions[0].target
    calls = []
    original = workspace.mutate

    def counted(*args, **kwargs):
        calls.append(args)
        return original(*args, **kwargs)

    monkeypatch.setattr(workspace, "mutate", counted)
    monkeypatch.setattr(
        "podcast_mcp.project.history.session.maybe_auto_reconcile",
        lambda *_args, **_kwargs: pytest.fail("Restore reconciled transcript"),
    )
    result = restore_clip_bleed(workspace, target)
    assert len(calls) == 1 and workspace.project.history.cursor == 1
    after = ProjectWorkspace.open(workspace.path).project
    assert after.transcripts == before.transcripts
    assert after.tracks == before.tracks
    assert after.clips[1] == before.clips[1]
    assert after.clips[0].model_dump(exclude={"bleed_restore"}) == before.clips[0].model_dump(
        exclude={"bleed_restore"}
    )
    assert after.clips[0].bleed_restore is not None
    with pytest.raises(BleedRestoreChangedError):
        restore_clip_bleed(workspace, target)
    assert len(calls) == 1
    HistoryManager(ProjectStore(workspace.path)).undo(
        workspace.project, expected_head_id=result["history_head_id"]
    )
    assert workspace.project.clips == before.clips


def test_explicit_inspection_and_restore_do_not_render_full_fx(workspace, monkeypatch):
    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    monkeypatch.setattr(
        FFmpegEngine,
        "render_timeline",
        lambda *_args, **_kwargs: pytest.fail("inspection rendered FX"),
    )
    monkeypatch.setattr(
        FFmpegEngine,
        "filter_audio",
        lambda *_args, **_kwargs: pytest.fail("inspection rendered FX"),
    )
    target = inspect_clip_bleed(workspace, "selected", track_id="host").regions[0].target
    restore_clip_bleed(workspace, target)


def test_ordinary_project_projection_does_not_inspect_or_hash_recordings(workspace, monkeypatch):
    from podcast_mcp.gui.assembler import build_project_view

    def forbidden(*_args, **_kwargs):
        pytest.fail("ordinary projection performed acoustic inspection")

    monkeypatch.setattr("podcast_mcp.services.document.bleed_inspection.sha256_file", forbidden)
    monkeypatch.setattr(
        "podcast_mcp.services.document.bleed_inspection.build_bleed_gate_plan", forbidden
    )
    monkeypatch.setattr("podcast_mcp.util.hashing.sha256_file", forbidden)
    monkeypatch.setattr("podcast_mcp.engines.bleed_gate.build_bleed_gate_plan", forbidden)
    from podcast_mcp.util.registry_privacy_error import RegistryPrivacyError

    try:
        view = build_project_view(workspace)
    except RegistryPrivacyError:
        pytest.skip("Disposable registry refuses this environment's ancestor ownership")
    assert view.clips


def test_clips_projection_does_not_inspect_or_hash_recordings(workspace, monkeypatch):
    from podcast_mcp.edits.timeline_ops import list_clips

    def forbidden(*_args, **_kwargs):
        pytest.fail("CLIPS projection performed acoustic inspection")

    monkeypatch.setattr("podcast_mcp.services.document.bleed_inspection.sha256_file", forbidden)
    monkeypatch.setattr("podcast_mcp.util.hashing.sha256_file", forbidden)
    monkeypatch.setattr("podcast_mcp.engines.bleed_gate.build_bleed_gate_plan", forbidden)
    result = list_clips(workspace.project, secret=b"disposable-test-key")
    assert result["clip_count"] == 2


def test_secondary_recording_and_moved_duplicate_use_the_selected_bytes(workspace):
    from podcast_mcp.util.hashing import sha256_file

    path = workspace.path.parent / "secondary.wav"
    path.write_bytes((workspace.path.parent / "host.wav").read_bytes()[:-2] + b"\x03\x00")
    workspace.project.sources.append(SourceRecording(id="secondary", path="secondary.wav"))
    workspace.project.clips[0].source_id = "secondary"
    workspace.project.clips[1].timeline_start = 11
    workspace.save()
    selected = inspect_clip_bleed(workspace, "selected", track_id="host").regions[0]
    other = inspect_clip_bleed(workspace, "other", track_id="host").regions[0]
    assert selected.target.source_sha256 == sha256_file(path)
    assert other.target.source_sha256 != selected.target.source_sha256
    assert (selected.source.start_s, selected.source.end_s) == (3, 7)
    assert (other.source.start_s, other.source.end_s) == (2, 6)
    restore_clip_bleed(workspace, selected.target)
    assert workspace.project.clips[1].bleed_restore is None


def test_artifact_freshness_is_independent_from_plan_and_saved_choice(workspace):
    from podcast_mcp.engines.play_audit import write_stem_hash
    from podcast_mcp.util.tracks import stem_path

    path = stem_path(workspace.project, "host")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes((workspace.path.parent / "host.wav").read_bytes())
    assert inspect_clip_bleed(workspace, "selected", track_id="host").artifact_state == "stale"
    write_stem_hash(workspace.project, "host", defaults=load_defaults())
    assert inspect_clip_bleed(workspace, "selected", track_id="host").artifact_state == "current"
    target = inspect_clip_bleed(workspace, "selected", track_id="host").regions[0].target
    restore_clip_bleed(workspace, target)
    inspection = inspect_clip_bleed(workspace, "selected", track_id="host")
    assert inspection.restore_state == "current" and inspection.artifact_state == "stale"


def test_relocated_same_bytes_preserve_saved_choice_but_old_target_stays_stale(workspace):
    first = inspect_clip_bleed(workspace, "selected", track_id="host").regions[0].target
    restore_clip_bleed(workspace, first)
    path = workspace.path.parent / "host.wav"
    relocated = path.with_name("relocated.wav")
    path.rename(relocated)
    workspace.project.tracks[0].media.path = "relocated.wav"
    workspace.save()
    inspection = inspect_clip_bleed(workspace, "selected", track_id="host")
    assert inspection.restore_state == "current"
    assert inspection.regions[0].restore_state == "saved"
    assert workspace.project.clips[1].bleed_restore is None
    with pytest.raises(BleedRestoreChangedError):
        restore_clip_bleed(workspace, first)


def test_unknown_track_and_duplicate_clip_ids_refuse(workspace):
    with pytest.raises(BleedRestoreChangedError):
        inspect_clip_bleed(workspace, "selected", track_id="unknown")
    workspace.project.clips[1].id = "selected"
    workspace.save()
    with pytest.raises(BleedRestoreChangedError):
        inspect_clip_bleed(workspace, "selected", track_id="host")
