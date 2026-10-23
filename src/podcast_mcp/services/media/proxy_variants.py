from __future__ import annotations

import json
import math
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.play_audit import proxy_render_hash, track_render_hash
from podcast_mcp.engines.session_timeline import origin_resolver
from podcast_mcp.engines.source_proxy_audio import SourceProxyInputs, render_source_proxy_inputs
from podcast_mcp.models.episode import (
    EpisodeProject,
    ProxyClipBasis,
    ProxyManifestGeneration,
    ProxyOccurrenceBinding,
    ProxyProjectBasis,
    ProxyPublishedArtifact,
    TrackProxy,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.media import proxy_media
from podcast_mcp.util.atomic_directory import rename_noreplace
from podcast_mcp.util.coded_error import CodedKeyError, CodedValueError
from podcast_mcp.util.hashing import sha256_file, short_digest
from podcast_mcp.util.project_state import file_revision, render_lock
from podcast_mcp.util.tracks import dialogue_track_ids
from podcast_mcp.util.workspace_paths import resolve_within

_SAFE_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
_HASH = re.compile(r"(?:[0-9a-f]{16}|[0-9a-f]{64})\Z")
_SERVICE_REVISION = "proxy-service-v1"


def _digest(payload: Any) -> str:
    return short_digest(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False), 64
    )


def _not_found() -> CodedKeyError:
    return CodedKeyError("Proxy chunk is not available", code="proxy_not_found")


def _damaged() -> CodedValueError:
    return CodedValueError("Proxy artifact is incomplete or damaged", code="proxy_artifact_damaged")


def _safe_id(value: str) -> None:
    if not _SAFE_ID.fullmatch(value):
        raise _not_found()


def _proxy_root(project: EpisodeProject) -> Path:
    try:
        artifacts = resolve_within(project.workspace_path(), str(project.artifacts_dir()))
        root = resolve_within(artifacts, "proxy")
        if (artifacts / "proxy").is_symlink():
            raise _not_found()
        return root
    except ValueError:
        raise _not_found() from None


def artifact_directory(project: EpisodeProject, context: str, hash_: str) -> Path:
    _safe_id(context)
    if not _HASH.fullmatch(hash_):
        raise _not_found()
    root = _proxy_root(project)
    try:
        directory = resolve_within(root, f"{context}/{hash_}")
    except ValueError:
        raise _not_found() from None
    if (root / context).is_symlink() or (root / context / hash_).is_symlink():
        raise _not_found()
    return directory


def project_basis(project: EpisodeProject, defaults: EffectiveConfig) -> ProxyProjectBasis:
    origin = origin_resolver(project)
    return ProxyProjectBasis(
        history_head_id=project.history.head_id(),
        render_hashes={
            tid: track_render_hash(project, tid, defaults=defaults)
            for tid in dialogue_track_ids(project)
        },
        clips={
            clip.id: ProxyClipBasis(
                track_id=clip.track_id,
                origin_track_id=origin(clip),
                source_id=clip.source_id,
                source_start=clip.source_start,
                source_end=clip.source_end,
                timeline_start=clip.timeline_start,
                timeline_end=clip.timeline_end,
            )
            for clip in project.clips
        },
    )


def _geometry(proxy: TrackProxy) -> dict[str, Any]:
    return {
        "chunk_sec": proxy.chunk_sec,
        "overlap_ms": proxy.overlap_ms,
        "chunk_count": proxy.chunk_count,
        "duration_sec": proxy.duration_sec,
        "codec": proxy.codec,
        "bitrate_kbps": proxy.bitrate_kbps,
    }


def _content_hash(input_hash: str, proxy: TrackProxy, digests: list[str]) -> str:
    return _digest(
        {"revision": _SERVICE_REVISION, "input": input_hash, **_geometry(proxy), "chunks": digests}
    )


def _input_hash(
    project: EpisodeProject, inputs: SourceProxyInputs, defaults: EffectiveConfig
) -> str:
    identity = inputs.identity_payload
    policy = {
        "revision": _SERVICE_REVISION,
        "binaries": identity["binaries"],
        "ffmpeg_policy": identity["ffmpeg_policy"],
        "codec": "mp3",
        "bitrate_kbps": proxy_media.PROXY_BITRATE_KBPS,
        "channels": 1,
        "chunk_sec": proxy_media.CHUNK_SEC,
        "overlap_ms": proxy_media.OVERLAP_MS,
    }
    if inputs.selector == "legacy":
        policy["legacy"] = proxy_render_hash(project, inputs.context_track_id, defaults=defaults)
    else:
        policy["source"] = inputs.input_hash
    return _digest(policy)


def _measure(directory: Path, proxy: TrackProxy) -> list[str]:
    if (
        proxy.chunk_count < 1
        or not math.isfinite(proxy.duration_sec)
        or proxy.duration_sec <= 0
        or not math.isfinite(proxy.chunk_sec)
        or proxy.chunk_sec <= 0
        or proxy.overlap_ms < 0
        or proxy.chunk_count
        != proxy_media.chunk_count_for(proxy.duration_sec, chunk_sec=proxy.chunk_sec)
        or proxy.codec != "mp3"
        or proxy.bitrate_kbps <= 0
        or directory.is_symlink()
    ):
        raise _damaged()
    try:
        expected = [f"{index:05d}.mp3" for index in range(proxy.chunk_count)]
        if sorted(entry.name for entry in directory.iterdir()) != expected:
            raise _damaged()
        digests = []
        for name in expected:
            chunk = directory / name
            if chunk.is_symlink() or not chunk.is_file() or chunk.stat().st_size <= 0:
                raise _damaged()
            before = file_revision(chunk)
            digests.append(sha256_file(chunk))
            if file_revision(chunk) != before:
                raise _damaged()
        return digests
    except OSError:
        raise _damaged() from None


def _verify(project: EpisodeProject, artifact: ProxyPublishedArtifact) -> None:
    path = artifact_directory(project, artifact.context_track_id, artifact.hash)
    if _measure(path, artifact) != artifact.chunk_sha256:
        raise _damaged()
    if (
        len(artifact.hash) == 64
        and _content_hash(artifact.input_hash, artifact, artifact.chunk_sha256) != artifact.hash
    ):
        raise _damaged()


def _sync_directory(directory: Path) -> None:
    if os.name == "posix":
        descriptor = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


@dataclass(frozen=True)
class _PreparedArtifact:
    inputs: SourceProxyInputs
    artifact: ProxyPublishedArtifact
    private_directory: Path | None = None

    def publish(self, project: EpisodeProject) -> None:
        artifact = self.artifact
        destination = artifact_directory(project, artifact.context_track_id, artifact.hash)
        if self.private_directory is not None:
            if _measure(self.private_directory, artifact) != artifact.chunk_sha256:
                raise _damaged()
            destination.parent.mkdir(parents=True, exist_ok=True)
            artifact_directory(project, artifact.context_track_id, artifact.hash)
            if not destination.exists():
                try:
                    if os.name == "nt":
                        os.rename(self.private_directory, destination)
                    else:
                        descriptor = os.open(
                            destination.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
                        )
                        try:
                            rename_noreplace(
                                self.private_directory.name, destination.name, descriptor
                            )
                        finally:
                            os.close(descriptor)
                except FileExistsError:
                    pass
        _verify(project, artifact)
        for index in range(artifact.chunk_count):
            with (destination / f"{index:05d}.mp3").open("rb") as chunk:
                os.fsync(chunk.fileno())
        workspace = project.workspace_path().resolve()
        for directory in (destination, *destination.parents):
            _sync_directory(directory)
            if directory == workspace:
                break


def _accepted(project: EpisodeProject) -> list[ProxyPublishedArtifact]:
    return [
        artifact
        for generation in project.render.proxy_manifests
        for artifact in [*generation.tracks.values(), *generation.artifacts.values()]
    ]


def _prepare(
    project: EpisodeProject,
    inputs: SourceProxyInputs,
    engine: FFmpegEngine,
    temporary: Path,
    *,
    legacy: bool,
    defaults: EffectiveConfig,
) -> _PreparedArtifact:
    input_hash = _input_hash(project, inputs, defaults)
    accepted = _accepted(project)
    for artifact in accepted:
        if (
            artifact.context_track_id == inputs.context_track_id
            and artifact.input_hash == input_hash
        ):
            _verify(project, artifact)
            return _PreparedArtifact(inputs, artifact.model_copy(deep=True))
    track = project.track_by_id(inputs.context_track_id)
    current = track.proxy if legacy and track is not None else None
    if current is not None:
        exact = next(
            (
                a
                for a in accepted
                if a.context_track_id == inputs.context_track_id and a.hash == current.hash
            ),
            None,
        )
        if exact is not None:
            _verify(project, exact)
        bootstrap = not project.render.proxy_manifests and current.hash == proxy_render_hash(
            project, inputs.context_track_id, defaults=defaults
        )
        if bootstrap or len(current.hash) == 64:
            try:
                digests = _measure(
                    artifact_directory(project, inputs.context_track_id, current.hash), current
                )
            except CodedValueError:
                if bootstrap or exact is not None:
                    raise
                digests = []
            if bootstrap or (
                digests and _content_hash(input_hash, current, digests) == current.hash
            ):
                return _PreparedArtifact(
                    inputs,
                    ProxyPublishedArtifact(
                        **current.model_dump(),
                        context_track_id=inputs.context_track_id,
                        input_hash=input_hash,
                        chunk_sha256=digests,
                    ),
                )
    wav = temporary / f"{len(list(temporary.iterdir()))}.wav"
    render_source_proxy_inputs(project, inputs, wav, engine=engine, defaults=defaults)
    duration = engine.probe(wav).require_duration_sec()
    count = proxy_media.chunk_count_for(duration, chunk_sec=proxy_media.CHUNK_SEC)
    descriptor = TrackProxy(
        hash="0" * 64,
        chunk_sec=proxy_media.CHUNK_SEC,
        overlap_ms=proxy_media.OVERLAP_MS,
        chunk_count=count,
        duration_sec=duration,
        bitrate_kbps=proxy_media.PROXY_BITRATE_KBPS,
    )
    root = _proxy_root(project)
    _safe_id(inputs.context_track_id)
    parent = root / inputs.context_track_id
    artifact_directory(project, inputs.context_track_id, descriptor.hash)
    parent.mkdir(parents=True, exist_ok=True)
    private = Path(tempfile.mkdtemp(prefix=".proxy-", dir=parent))
    try:
        for index in range(count):
            start, duration_chunk = proxy_media.chunk_window(
                index, duration, chunk_sec=descriptor.chunk_sec, overlap_ms=descriptor.overlap_ms
            )
            output = private / f"{index:05d}.mp3"
            proxy_media._encode_chunk(
                engine, wav, output, start, duration_chunk, bitrate_kbps=descriptor.bitrate_kbps
            )
            with output.open("rb") as handle:
                os.fsync(handle.fileno())
        digests = _measure(private, descriptor)
        _sync_directory(private)
        descriptor.hash = _content_hash(input_hash, descriptor, digests)
        artifact = ProxyPublishedArtifact(
            **descriptor.model_dump(),
            context_track_id=inputs.context_track_id,
            input_hash=input_hash,
            chunk_sha256=digests,
        )
        return _PreparedArtifact(inputs, artifact, private)
    except BaseException:
        _remove_private(private)
        raise


def _remove_private(directory: Path) -> None:
    if directory.exists():
        for chunk in directory.iterdir():
            chunk.unlink()
        directory.rmdir()


def _legacy_descriptor(
    artifact: ProxyPublishedArtifact, current: TrackProxy | None = None
) -> TrackProxy:
    result = TrackProxy.model_validate(artifact.model_dump())
    if current is not None and current.hash == result.hash:
        result.object_store_prefix = current.object_store_prefix
        result.object_store_uploaded_at = current.object_store_uploaded_at
    return result


def _save_confirmed(ws: ProjectWorkspace, expected: EpisodeProject) -> None:
    try:
        ws.save()
    except BaseException:
        saved = ws.discard_changes()
        if saved.model_dump(mode="json") != expected.model_dump(mode="json"):
            raise


def _ensure(ws: ProjectWorkspace, track_id: str | None) -> ProxyManifestGeneration | TrackProxy:
    with render_lock(ws.project):
        engine = FFmpegEngine()
        defaults = ws.effective_config()
        prepared: list[_PreparedArtifact] = []
        try:
            with ws.transaction() as current:
                snapshot = current.model_copy(deep=True)
                basis = project_basis(snapshot, defaults)
                ids = dialogue_track_ids(snapshot) if track_id is None else [track_id]
                for tid in ids:
                    _safe_id(tid)
                    if snapshot.track_by_id(tid) is None:
                        raise CodedKeyError("Track is not available", code="track_not_found")
                captures = [
                    (
                        tid,
                        SourceProxyInputs.capture_legacy(
                            snapshot, tid, engine, defaults=ws.effective_config()
                        ),
                    )
                    for tid in ids
                ]
                choices = [
                    (
                        clip.id,
                        SourceProxyInputs.capture_occurrence(
                            snapshot, clip.id, engine, defaults=ws.effective_config()
                        ),
                    )
                    for clip in snapshot.clips
                    if track_id is None
                    and clip.bleed_restore is not None
                    and clip.bleed_restore.regions
                ]
            with tempfile.TemporaryDirectory(prefix="proxy-wav-") as temporary:
                tracks = {}
                artifacts = {}
                occurrences = {}
                for tid, inputs in captures:
                    item = _prepare(
                        snapshot, inputs, engine, Path(temporary), legacy=True, defaults=defaults
                    )
                    prepared.append(item)
                    tracks[tid] = item.artifact
                for clip_id, inputs in choices:
                    input_hash = _input_hash(snapshot, inputs, defaults)
                    candidate = next(
                        (
                            p
                            for p in prepared
                            if p.inputs.selector == "occurrence"
                            and p.artifact.input_hash == input_hash
                        ),
                        None,
                    )
                    if candidate is None:
                        candidate = _prepare(
                            snapshot,
                            inputs,
                            engine,
                            Path(temporary),
                            legacy=False,
                            defaults=defaults,
                        )
                        prepared.append(candidate)
                    artifacts[candidate.artifact.hash] = candidate.artifact
                    occurrences[clip_id] = ProxyOccurrenceBinding(
                        artifact_id=candidate.artifact.hash, output_track_id=inputs.context_track_id
                    )
                payload = {
                    "project_basis": basis.model_dump(mode="json"),
                    "tracks": {k: v.model_dump(mode="json") for k, v in tracks.items()},
                    "artifacts": {k: v.model_dump(mode="json") for k, v in artifacts.items()},
                    "occurrences": {k: v.model_dump(mode="json") for k, v in occurrences.items()},
                }
                generation = ProxyManifestGeneration(
                    revision=_digest(payload),
                    project_basis=basis,
                    tracks=tracks,
                    artifacts=artifacts,
                    occurrences=occurrences,
                )
                with ws.transaction() as current:
                    if project_basis(current, defaults) != basis:
                        raise CodedValueError(
                            "Proxy inputs changed; retry", code="proxy_inputs_changed"
                        )
                    for _, inputs in [*captures, *choices]:
                        inputs.validate(current, engine, defaults=ws.effective_config())
                    for item in prepared:
                        item.publish(current)
                    before = current.model_dump(mode="json")
                    for tid, artifact in tracks.items():
                        track = current.track_by_id(tid)
                        assert track is not None
                        track.proxy = _legacy_descriptor(artifact, track.proxy)
                    if track_id is None:
                        generations = current.render.proxy_manifests
                        if not generations or generations[0].revision != generation.revision:
                            current.render.proxy_manifests = [
                                generation,
                                *[g for g in generations if g.revision != generation.revision],
                            ][:2]
                    if current.model_dump(mode="json") != before:
                        _save_confirmed(ws, current.model_copy(deep=True))
                    if track_id is None:
                        return generation
                    track = current.track_by_id(track_id)
                    assert track is not None and track.proxy is not None
                    return track.proxy.model_copy(deep=True)
        finally:
            for item in prepared:
                if item.private_directory is not None:
                    _remove_private(item.private_directory)


def ensure_proxy_manifest(ws: ProjectWorkspace) -> ProxyManifestGeneration:
    result = _ensure(ws, None)
    assert isinstance(result, ProxyManifestGeneration)
    return result


def ensure_legacy_proxy(ws: ProjectWorkspace, track_id: str) -> TrackProxy:
    result = _ensure(ws, track_id)
    assert isinstance(result, TrackProxy)
    return result


def accepted_proxy_chunk_path(
    ws: ProjectWorkspace,
    context_track_id: str,
    chunk_idx: int,
    *,
    expected_hash: str | None,
) -> Path:
    _safe_id(context_track_id)
    if (
        expected_hash is None
        or not _HASH.fullmatch(expected_hash)
        or not isinstance(chunk_idx, int)
        or isinstance(chunk_idx, bool)
        or chunk_idx < 0
    ):
        raise _not_found()
    with ws.transaction() as project:
        accepted = _accepted(project)
        matching = [
            a
            for a in accepted
            if a.context_track_id == context_track_id and a.hash == expected_hash
        ]
        if not matching:
            if any(a.context_track_id == context_track_id for a in accepted):
                raise CodedKeyError(
                    "Proxy generation is no longer available", code="proxy_generation_unavailable"
                )
            raise _not_found()
        artifact = matching[0]
        if chunk_idx >= artifact.chunk_count:
            raise _not_found()
        path = artifact_directory(project, context_track_id, expected_hash) / f"{chunk_idx:05d}.mp3"
        try:
            _verify(project, artifact)
        except (CodedValueError, OSError):
            raise _not_found() from None
        return path


def proxy_manifest_payload(
    generation: ProxyManifestGeneration,
    token: str,
    *,
    legacy_urls: dict[str, list[str]] | None = None,
) -> dict[str, Any]:
    def descriptor(
        artifact: ProxyPublishedArtifact, urls: list[str] | None = None
    ) -> dict[str, Any]:
        return {
            "hash": artifact.hash,
            "chunk_sec": artifact.chunk_sec,
            "overlap_ms": artifact.overlap_ms,
            "chunk_count": artifact.chunk_count,
            "duration_sec": artifact.duration_sec,
            "urls": urls
            if urls is not None
            else [
                f"/api/review/{token}/daw/proxy/{artifact.context_track_id}/{artifact.hash}/{index}"
                for index in range(artifact.chunk_count)
            ],
        }

    return {
        "revision": generation.revision,
        "project_basis": generation.project_basis.model_dump(mode="json"),
        "tracks": {
            tid: descriptor(artifact, (legacy_urls or {}).get(tid))
            for tid, artifact in generation.tracks.items()
        },
        "artifacts": {key: descriptor(artifact) for key, artifact in generation.artifacts.items()},
        "occurrences": {
            key: {"artifactId": value.artifact_id, "outputTrackId": value.output_track_id}
            for key, value in generation.occurrences.items()
        },
    }
