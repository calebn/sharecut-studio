from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from collections.abc import Callable, Mapping, Sequence, Set
from contextlib import AbstractContextManager, contextmanager
from dataclasses import asdict, dataclass
from enum import StrEnum
from pathlib import Path
from types import MappingProxyType
from typing import Any, TypedDict, cast

from podcast_mcp.config.defaults import EffectiveConfig, mix_peak_ceiling_db
from podcast_mcp.engines.ffmpeg import MASTER_SEMANTICS_REV, FFmpegEngine
from podcast_mcp.engines.mastering import (
    MasterQcLimits,
    MasterResult,
    MasterTarget,
    master_qc_issues,
)
from podcast_mcp.engines.play_audit import (
    master_source_hash,
    mix_gains,
    mix_render_hash,
    premix_path,
    read_premix_hash,
    stem_blocks_premix_reuse,
    stem_is_fresh,
    track_render_hash,
)
from podcast_mcp.export.audio import (
    AUDIO_EXPORT_MEDIA,
    EXPORT_PRESETS,
    ExportFormatSpec,
    export_wav_enabled,
    render_audio_formats,
    resolve_export_formats,
)
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.atomic_json import write_json_atomic
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.hashing import sha256_file
from podcast_mcp.util.owned_stage import OwnedStage, owned_stage_supported
from podcast_mcp.util.progress import CancelledProgress, raise_if_cancel_requested
from podcast_mcp.util.project_state import FileRevision, file_revision
from podcast_mcp.util.tracks import stem_path
from podcast_mcp.util.wav import rendered_wav_is_complete

from .export_config import require_source_config
from .export_variant_receipt import AdmittedBundle, InvalidReceipt, _finite, admit_bundle


class _VariantValidationError(ValueError):
    pass


class MasterTargetRecord(TypedDict):
    integrated_lufs: float
    true_peak_db: float
    lra: float


class MasterQcLimitsRecord(TypedDict):
    lufs_tolerance_lu: float
    true_peak_tolerance_db: float


class VariantFormatRecord(TypedDict):
    ext: str
    codec: str | None
    format: str | None
    bitrate_kbps: int | None
    sample_rate: int | None
    channels: int | None
    extra_args: list[str]


class VariantFileRecord(TypedDict):
    sha256: str
    size: int


class VariantQcRecord(TypedDict):
    target: MasterTargetRecord
    limits: MasterQcLimitsRecord
    measured: dict[str, float | None]
    input_stats: dict[str, float] | None
    plan: str
    normalization_type: str | None
    limiter: dict[str, int | float | bool] | None
    issues: list[str]
    within_tolerance: bool


class VariantSourceRecord(TypedDict):
    kind: str
    premix_sha256: str
    master_source: str
    mix_hash: str
    mix_gains: list[list[str | float]]
    stem_state: list[list[str | int]]
    premix_revision: list[int]


class VariantReceipt(TypedDict):
    schema: int
    identity: str
    target: str
    master_target: MasterTargetRecord
    qc_limits: MasterQcLimitsRecord
    source_digest: str
    source: VariantSourceRecord
    master_semantics_rev: int
    variant_semantics_rev: int
    encoding_semantics_rev: int
    formats: list[VariantFormatRecord]
    metadata: dict[str, str]
    edit_head_id: str | None
    qc: VariantQcRecord
    files: dict[str, VariantFileRecord]


class VariantJobResult(TypedDict):
    file_ids: list[str]
    target: str
    master: VariantQcRecord
    edit_head_id: str | None


class ExportTarget(StrEnum):
    BROADCAST = "broadcast"
    PODCAST = "podcast"
    STREAMING = "streaming"


TARGET_INTEGRATED_LUFS: Mapping[ExportTarget, float] = MappingProxyType(
    {
        ExportTarget.BROADCAST: -23.0,
        ExportTarget.PODCAST: -16.0,
        ExportTarget.STREAMING: -14.0,
    }
)

VARIANT_SEMANTICS_REV = 1
ENCODING_SEMANTICS_REV = 1
RECEIPT_SCHEMA = 1
_BUNDLE_ID = re.compile(r"[0-9a-f]{64}\Z")
_EXT = re.compile(r"[a-z0-9]{1,8}\Z")
_PARTIAL = ".partial-"
_FORMAT_FIELDS = {
    "ext",
    "extension",
    "codec",
    "format",
    "bitrate_kbps",
    "sample_rate",
    "channels",
    "extra_args",
}
_MP3_SAMPLE_RATES = frozenset({44100, 48000, 32000, 22050, 24000, 16000, 11025, 12000, 8000})
_MP3_CHANNEL_COUNTS = frozenset({1, 2})


@dataclass(frozen=True)
class VariantQc:
    target: MasterTarget
    limits: MasterQcLimits
    measured: Mapping[str, float | None]
    input_stats: Mapping[str, float] | None
    plan: str
    normalization_type: str | None
    limiter: Mapping[str, Any] | None
    issues: tuple[str, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "measured", MappingProxyType(dict(self.measured)))
        if self.input_stats is not None:
            object.__setattr__(self, "input_stats", MappingProxyType(dict(self.input_stats)))
        if self.limiter is not None:
            object.__setattr__(self, "limiter", MappingProxyType(dict(self.limiter)))

    @property
    def within_tolerance(self) -> bool:
        return not self.issues

    def to_record(self) -> VariantQcRecord:
        return {
            "target": _master_target_record(self.target),
            "limits": _qc_limits_record(self.limits),
            "measured": dict(self.measured),
            "input_stats": dict(self.input_stats) if self.input_stats is not None else None,
            "plan": self.plan,
            "normalization_type": self.normalization_type,
            "limiter": dict(self.limiter) if self.limiter is not None else None,
            "issues": list(self.issues),
            "within_tolerance": self.within_tolerance,
        }


@dataclass(frozen=True)
class VariantExportResult:
    file_ids: tuple[str, ...]
    target: ExportTarget
    master: VariantQc
    edit_head_id: str | None


@dataclass(frozen=True)
class VariantFile:
    file_id: str
    name: str
    format: str
    target: ExportTarget
    source_digest: str
    size: int
    content_sha256: str
    path: Path


class _SourcePayload(TypedDict):
    source_contract_rev: int
    source: str
    premix_sha256: str
    premix_revision: FileRevision
    master_source: str
    mix_hash: str
    mix_gains: list[tuple[str, float]]
    stems: list[tuple[str, str, FileRevision]]


@dataclass(frozen=True)
class _SourceCertificate:
    digest: str
    premix_sha256: str
    master_source: str
    mix_hash: str
    mix_gains: tuple[tuple[str, float], ...]
    stem_state: tuple[tuple[str, str, FileRevision], ...]
    premix_revision: FileRevision


@dataclass(frozen=True)
class _VariantRequest:
    target: ExportTarget
    master_target: MasterTarget
    limits: MasterQcLimits
    formats: tuple[ExportFormatSpec, ...]
    metadata: tuple[tuple[str, str], ...]
    identity: str


def _master_target_record(target: MasterTarget) -> MasterTargetRecord:
    return {
        "integrated_lufs": target.integrated_lufs,
        "true_peak_db": target.true_peak_db,
        "lra": target.lra,
    }


def _qc_limits_record(limits: MasterQcLimits) -> MasterQcLimitsRecord:
    return {
        "lufs_tolerance_lu": limits.lufs_tolerance_lu,
        "true_peak_tolerance_db": limits.true_peak_tolerance_db,
    }


def master_target_for(choice: ExportTarget, defaults: EffectiveConfig) -> MasterTarget:
    configured = MasterTarget.from_defaults(defaults)
    return MasterTarget(TARGET_INTEGRATED_LUFS[choice], configured.true_peak_db, configured.lra)


def _format_record(spec: ExportFormatSpec) -> VariantFormatRecord:
    return {
        "ext": spec.ext,
        "codec": spec.codec,
        "format": spec.format,
        "bitrate_kbps": spec.bitrate_kbps,
        "sample_rate": spec.sample_rate,
        "channels": spec.channels,
        "extra_args": list(spec.extra_args),
    }


def _positive_integer(raw: Any, field: str, low: int, high: int) -> int | None:
    if raw is None:
        return None
    if isinstance(raw, bool) or not isinstance(raw, int) or not low <= raw <= high:
        raise _VariantValidationError(f"variant {field} must be an integer from {low} to {high}")
    return raw


def _parse_variant_format(raw: Mapping[str, Any]) -> ExportFormatSpec:
    if set(raw) - _FORMAT_FIELDS:
        raise _VariantValidationError("variant format contains unsupported fields")
    ext = raw.get("ext", raw.get("extension"))
    if not isinstance(ext, str) or not _EXT.fullmatch(ext.lower().lstrip(".")):
        raise _VariantValidationError("Choose a supported audio format with a safe extension")
    ext = ext.lower().lstrip(".")
    if "ext" in raw and "extension" in raw and raw["ext"] != raw["extension"]:
        raise _VariantValidationError("variant format has conflicting extensions")
    extra = raw.get("extra_args")
    if extra not in (None, [], (), ""):
        raise _VariantValidationError("variant exports do not accept extra FFmpeg arguments")
    codec, muxer = raw.get("codec"), raw.get("format")
    bitrate = _positive_integer(raw.get("bitrate_kbps"), "bitrate_kbps", 8, 512)
    sample_rate = _positive_integer(raw.get("sample_rate"), "sample_rate", 8000, 192000)
    channels = _positive_integer(raw.get("channels"), "channels", 1, 8)
    if ext == "wav":
        if any(value is not None for value in (codec, muxer, bitrate, sample_rate, channels)):
            raise _VariantValidationError(
                "variant WAV is a plain copy and does not accept encoder options"
            )
        return ExportFormatSpec(ext="wav")
    if ext == "mp3":
        if codec not in (None, "libmp3lame") or muxer not in (None, "mp3"):
            raise _VariantValidationError(
                "MP3 variants require the libmp3lame encoder and mp3 muxer"
            )
        if (sample_rate is not None and sample_rate not in _MP3_SAMPLE_RATES) or (
            channels is not None and channels not in _MP3_CHANNEL_COUNTS
        ):
            raise _VariantValidationError(
                "MP3 variants require a libmp3lame-supported sample rate and channel count"
            )
        return ExportFormatSpec(
            ext="mp3",
            codec="libmp3lame",
            format="mp3",
            bitrate_kbps=bitrate or 128,
            sample_rate=sample_rate,
            channels=channels,
        )
    if ext == "flac":
        if codec not in (None, "flac") or muxer not in (None, "flac") or bitrate is not None:
            raise _VariantValidationError("FLAC variants require the flac encoder and muxer")
        return ExportFormatSpec(
            ext="flac", codec="flac", format="flac", sample_rate=sample_rate, channels=channels
        )
    if ext == "m4a":
        preset = EXPORT_PRESETS["m4a"]
        if any(value is not None for value in (sample_rate, channels)):
            raise _VariantValidationError("M4A variants use the tested AAC delivery settings")
        if codec not in (None, preset.codec) or muxer not in (None, preset.format):
            raise _VariantValidationError("M4A variants require the AAC encoder and ipod muxer")
        if bitrate not in (None, preset.bitrate_kbps):
            raise _VariantValidationError("M4A variants use the tested AAC bitrate")
        return preset
    if ext not in AUDIO_EXPORT_MEDIA:
        raise _VariantValidationError("variant format is not a supported audio extension")
    raise _VariantValidationError(f"{ext} is not an enabled variant format")


def _resolve_formats(
    defaults: EffectiveConfig, formats: list[dict[str, Any]] | None
) -> tuple[ExportFormatSpec, ...]:
    export_cfg = dict(defaults.get("export") or {})
    if formats is not None:
        export_cfg["formats"] = formats
    if "formats" in export_cfg:
        raw_formats = [] if export_cfg["formats"] is None else export_cfg["formats"]
        if not isinstance(raw_formats, list) or any(
            not isinstance(item, Mapping) for item in raw_formats
        ):
            raise _VariantValidationError("variant formats must be a list of records")
        explicit_specs = [_parse_variant_format(item) for item in raw_formats]
    else:
        explicit_specs = [
            _parse_variant_format(_format_record(item))
            for item in resolve_export_formats(export_cfg)
        ]
    extensions = [spec.ext for spec in explicit_specs]
    if len(extensions) != len(set(extensions)):
        raise _VariantValidationError("variant formats must select unique audio extensions")
    specs = list(explicit_specs)
    if export_wav_enabled(export_cfg) and "wav" not in extensions:
        specs.insert(0, ExportFormatSpec(ext="wav"))
    if not specs:
        raise _VariantValidationError("variant formats must select at least one audio extension")
    return tuple(specs)


def _sha256_file(path: Path) -> tuple[str, int, FileRevision]:
    before = file_revision(path)
    digest = sha256_file(path)
    after = file_revision(path)
    if before != after or after is None:
        raise CodedValueError(
            "The mix changed while this export was being checked. Refresh the mix and retry.",
            code="stale_mix",
        )
    return digest, after[2], after


def _source_certificate(project: EpisodeProject, defaults: EffectiveConfig) -> _SourceCertificate:
    source = premix_path(project)
    if source.is_symlink() or not source.is_file() or not rendered_wav_is_complete(source):
        raise CodedValueError(
            "No complete current mix is available. Refresh the mix, then retry this export.",
            code="no_mix",
        )
    gains = mix_gains(project)
    recorded = read_premix_hash(project)
    expected_mix_hash = mix_render_hash(gains, mix_peak_ceiling_db(defaults), defaults=defaults)
    if not gains or recorded is None or recorded != expected_mix_hash:
        raise CodedValueError(
            "The mix is out of date or its source cannot be verified. Refresh the mix, then retry this export.",
            code="stale_mix",
        )
    stems: list[tuple[str, str, FileRevision]] = []
    premix_sha, _, premix_revision = _sha256_file(source)
    premix_mtime = premix_revision[3]
    for track_id in sorted(gains):
        stem = stem_path(project, track_id)
        if stem.is_symlink() or stem_blocks_premix_reuse(project, track_id):
            raise CodedValueError(
                "The mix is out of date or its source cannot be verified. Refresh the mix, then retry this export.",
                code="stale_mix",
            )
        try:
            revision = file_revision(stem)
            fresh = stem_is_fresh(project, track_id, defaults=defaults)
            render_hash = track_render_hash(project, track_id, defaults=defaults)
        except (FileNotFoundError, OSError, ValueError):
            fresh = False
            revision = None
            render_hash = ""
        if not fresh or revision is None or revision[3] >= premix_mtime:
            raise CodedValueError(
                "The mix is out of date or its source cannot be verified. Refresh the mix, then retry this export.",
                code="stale_mix",
            )
        stems.append((track_id, render_hash, revision))
    if file_revision(source) != premix_revision:
        raise CodedValueError("The mix changed. Refresh the mix and retry.", code="stale_mix")
    source_hash = master_source_hash(project)
    if source_hash is None:
        raise CodedValueError(
            "No current mix is available. Refresh the mix, then retry.", code="no_mix"
        )
    payload = _source_payload(
        premix_sha,
        premix_revision,
        source_hash,
        recorded,
        sorted((key, float(value)) for key, value in gains.items()),
        stems,
    )
    digest = hashlib.sha256(_canonical_json(payload)).hexdigest()
    return _SourceCertificate(
        digest,
        premix_sha,
        source_hash,
        recorded,
        tuple(sorted((key, float(value)) for key, value in gains.items())),
        tuple(stems),
        premix_revision,
    )


def _source_payload(
    premix_sha: str,
    premix_revision: FileRevision,
    source_hash: str,
    recorded: str,
    gains: list[tuple[str, float]],
    stems: list[tuple[str, str, FileRevision]],
) -> _SourcePayload:
    return {
        "source_contract_rev": 1,
        "source": "premix",
        "premix_sha256": premix_sha,
        "premix_revision": premix_revision,
        "master_source": source_hash,
        "mix_hash": recorded,
        "mix_gains": gains,
        "stems": stems,
    }


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def _config_container(value: Any) -> bool:
    return isinstance(value, (Mapping, Sequence, Set)) and not isinstance(
        value, (str, bytes, bytearray)
    )


def _request(
    target: ExportTarget,
    defaults: EffectiveConfig,
    formats: list[dict[str, Any]] | None,
    project: EpisodeProject,
    source: _SourceCertificate,
) -> _VariantRequest:
    config_message = (
        "Export settings contain an invalid value. Correct the pipeline configuration and retry."
    )
    for name in ("master", "export"):
        section = defaults.get(name)
        if not isinstance(section, Mapping) and (_config_container(section) or section):
            raise _variant_error(config_message, "pipeline_config_value_invalid")
    if _config_container((defaults.get("export") or {}).get("wav")):
        raise _variant_error(config_message, "pipeline_config_value_invalid")
    try:
        master_target = master_target_for(target, defaults)
        limits = MasterQcLimits.from_defaults(defaults)
    except (TypeError, ValueError, OverflowError) as exc:
        raise _variant_error(config_message, "pipeline_config_value_invalid") from exc
    try:
        resolved = _resolve_formats(defaults, formats)
    except (TypeError, ValueError, OverflowError) as exc:
        message = (
            str(exc)
            if isinstance(exc, _VariantValidationError)
            else "Variant export format is invalid. Choose a supported audio format."
        )
        raise _variant_error(message, "export_variant_format_invalid") from exc
    metadata = (("album", project.name), ("title", project.name))
    identity_value = {
        "source": source.digest,
        "master_target": asdict(master_target),
        "master_semantics_rev": MASTER_SEMANTICS_REV,
        "variant_semantics_rev": VARIANT_SEMANTICS_REV,
        "formats": [_format_record(spec) for spec in resolved],
        "encoding_semantics_rev": ENCODING_SEMANTICS_REV,
        "metadata": dict(metadata),
        "qc_limits": asdict(limits),
    }
    digest = hashlib.sha256(_canonical_json(identity_value)).hexdigest()
    return _VariantRequest(
        target,
        master_target,
        limits,
        resolved,
        metadata,
        digest,
    )


def _qc_from_measurement(
    measured: Mapping[str, Any] | None,
    result: MasterResult | Mapping[str, Any],
    target: MasterTarget,
    limits: MasterQcLimits,
) -> VariantQc:
    if not isinstance(measured, Mapping):
        raise CodedValueError(
            "The mastered audio could not be measured; no export was published.",
            code="export_variant_unmeasured",
        )
    required = ("integrated_lufs", "true_peak_db")
    values: dict[str, float | None] = {}
    for key, raw in measured.items():
        try:
            values[key] = float(_finite(raw))
        except InvalidReceipt:
            values[key] = None
    if any(values.get(key) is None for key in required):
        raise CodedValueError(
            "The mastered audio has no finite loudness and true-peak measurements; no export was published.",
            code="export_variant_unmeasured",
        )
    if isinstance(result, MasterResult):
        plan = result.plan.kind
        normalization = result.normalization_type
        limiter = asdict(result.limiter) if result.limiter else None
        input_stats = result.input_stats
    else:
        plan = str(result.get("plan") or "unknown")
        normalization = result.get("normalization_type")
        limiter = result.get("limiter")
        input_stats = result.get("input_stats")
    issues = tuple(master_qc_issues(values, target, limits, limiter))
    return VariantQc(target, limits, values, input_stats, plan, normalization, limiter, issues)


def variant_identity(
    project: EpisodeProject,
    defaults: EffectiveConfig,
    target: ExportTarget,
    formats: list[dict[str, Any]] | None,
) -> tuple[str, str]:
    require_source_config(project, defaults)
    source = _source_certificate(project, defaults)
    request = _request(target, defaults, formats, project, source)
    return source.digest, request.identity


@contextmanager
def project_commit_guard(
    workspace: Any,
    defaults_provider: Callable[[], EffectiveConfig],
    target: ExportTarget,
    formats: list[dict[str, Any]] | None,
    expected_source: str,
    expected_identity: str,
    expected_edit_head_id: str | None,
):
    with workspace.transaction():
        current_defaults = defaults_provider()
        source, identity = variant_identity(workspace.project, current_defaults, target, formats)
        current_edit_head_id = workspace.project.history.edit_head_id()
        if (
            source != expected_source
            or identity != expected_identity
            or current_edit_head_id != expected_edit_head_id
        ):
            raise CodedValueError(
                "The mix or export settings changed while this export was rendering. Refresh the mix, then retry.",
                code="stale_mix",
            )
        yield


def _safe_bundle_root(project: EpisodeProject, *, create: bool) -> Path:
    export_root = project.export_dir()
    if export_root.is_symlink():
        raise CodedValueError(
            "The variant export folder is not a safe directory.",
            code="export_variant_storage_invalid",
        )
    variants = export_root / "variants"
    if create:
        variants.mkdir(parents=True, exist_ok=True, mode=0o700)
    if variants.is_symlink() or (variants.exists() and not variants.is_dir()):
        raise CodedValueError(
            "The variant export folder is not a safe directory.",
            code="export_variant_storage_invalid",
        )
    return variants


def _file_record(path: Path) -> VariantFileRecord:
    try:
        digest, size, _ = _sha256_file(path)
    except CodedValueError as exc:
        raise _VariantValidationError("variant output changed") from exc
    return {"sha256": digest, "size": size}


def _load_bundle(
    root: Path, bundle_id: str, *, expected_identity: str | None = None
) -> AdmittedBundle:
    return _validate_bundle(root / bundle_id, bundle_id, expected_identity=expected_identity)


def _validate_bundle(
    directory: Path, bundle_id: str, *, expected_identity: str | None = None
) -> AdmittedBundle:
    try:
        if not _BUNDLE_ID.fullmatch(bundle_id) or (
            expected_identity is not None and expected_identity != bundle_id
        ):
            raise _VariantValidationError("invalid bundle identity")
        return admit_bundle(directory, bundle_id)
    except (ValueError, TypeError, OSError, OverflowError, RecursionError) as exc:
        raise _VariantValidationError("variant bundle is corrupt") from exc


def _receipt(
    request: _VariantRequest,
    source: _SourceCertificate,
    edit_head_id: str | None,
    qc: VariantQc,
    files: dict[str, VariantFileRecord],
) -> VariantReceipt:
    return {
        "schema": RECEIPT_SCHEMA,
        "identity": request.identity,
        "target": request.target.value,
        "master_target": _master_target_record(request.master_target),
        "qc_limits": _qc_limits_record(request.limits),
        "source_digest": source.digest,
        "source": {
            "kind": "premix",
            "premix_sha256": source.premix_sha256,
            "master_source": source.master_source,
            "mix_hash": source.mix_hash,
            "mix_gains": [[key, gain] for key, gain in source.mix_gains],
            "stem_state": [
                [track_id, render_hash, *revision]
                for track_id, render_hash, revision in source.stem_state
            ],
            "premix_revision": list(source.premix_revision),
        },
        "master_semantics_rev": MASTER_SEMANTICS_REV,
        "variant_semantics_rev": VARIANT_SEMANTICS_REV,
        "encoding_semantics_rev": ENCODING_SEMANTICS_REV,
        "formats": [_format_record(spec) for spec in request.formats],
        "metadata": dict(request.metadata),
        "edit_head_id": edit_head_id,
        "qc": qc.to_record(),
        "files": files,
    }


def _publish(stage: OwnedStage, bundle_id: str) -> None:
    stage.publish(bundle_id)


def _fsync_file(path: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _variant_error(message: str, code: str) -> CodedValueError:
    return CodedValueError(message, code=code)


def _qc_number(value: float | None) -> str:
    if value is None:
        return "unavailable"
    text = format(value, ".6g")
    return text if "." in text or "e" in text else text + ".0"


def _result(bundle: AdmittedBundle, edit_head_id: str | None) -> VariantExportResult:
    return VariantExportResult(
        tuple(f"variants/{bundle.identity}/{audio.name}" for audio in bundle.audio),
        bundle.target,
        bundle.qc,
        edit_head_id,
    )


def export_variant_bundle(
    project: EpisodeProject,
    defaults: EffectiveConfig,
    target: ExportTarget,
    formats: list[dict[str, Any]] | None,
    engine: FFmpegEngine,
    *,
    edit_head_id: str | None,
    cancel_check: Callable[[], bool] | None,
    commit_guard: Callable[[str, str], AbstractContextManager[None]],
) -> VariantExportResult:
    raise_if_cancel_requested(cancel_check, "Export cancelled")
    if not owned_stage_supported():
        raise _variant_error(
            "This host cannot safely store isolated exports. Use the default export.",
            "export_variant_storage_invalid",
        )
    require_source_config(project, defaults)
    source = _source_certificate(project, defaults)
    request = _request(target, defaults, formats, project, source)
    try:
        root = _safe_bundle_root(project, create=True)
    except OSError as exc:
        raise _variant_error(
            "The variant export folder could not be prepared. Check the host's export folder and retry.",
            "export_variant_storage_invalid",
        ) from exc
    final = root / request.identity
    if final.exists() or final.is_symlink():
        try:
            bundle = _load_bundle(root, request.identity, expected_identity=request.identity)
        except ValueError as exc:
            raise _variant_error(
                "A saved variant bundle is damaged and was not replaced. Contact the host for help.",
                "export_variant_cache_corrupt",
            ) from exc
        with commit_guard(source.digest, request.identity):
            return _result(bundle, edit_head_id)

    try:
        owned = OwnedStage(root)
    except OSError as exc:
        raise _variant_error(
            "The variant export folder could not be prepared. Retry the export.",
            "export_variant_storage_invalid",
        ) from exc
    try:
        stage = owned.path
        try:
            raise_if_cancel_requested(cancel_check, "Export cancelled")
            owned.verify()
            master_path = stage / "master.wav"
            master_result = engine.master_loudness(
                premix_path(project),
                master_path,
                integrated_lufs=request.master_target.integrated_lufs,
                true_peak_db=request.master_target.true_peak_db,
                lra=request.master_target.lra,
            )
            raise_if_cancel_requested(cancel_check, "Export cancelled")
            owned.verify()
            if master_path.is_symlink() or not rendered_wav_is_complete(master_path):
                raise _variant_error(
                    "The mastered audio is incomplete. No variant was published.",
                    "export_variant_unmeasured",
                )
            measured = engine.measure_loudness_full(master_path)
            qc = _qc_from_measurement(
                measured, master_result, request.master_target, request.limits
            )
            if qc.issues:
                measured_lufs = _qc_number(qc.measured.get("integrated_lufs"))
                measured_peak = _qc_number(qc.measured.get("true_peak_db"))
                raise _variant_error(
                    f"Loudness QC failed. Requested {request.master_target.integrated_lufs:.6g} LUFS and at most {request.master_target.true_peak_db:.6g} dBTP; measured {measured_lufs!s} LUFS and {measured_peak!s} dBTP. No variant was published.",
                    "export_variant_qc_failed",
                )
            raise_if_cancel_requested(cancel_check, "Export cancelled")
            outputs = [(spec, stage / f"audio.{spec.ext}") for spec in request.formats]
            try:
                render_audio_formats(
                    engine,
                    master_path,
                    outputs,
                    metadata=dict(request.metadata),
                    max_workers=(defaults.get("performance") or {}).get("max_workers"),
                    cancel_check=cancel_check,
                )
                raise_if_cancel_requested(cancel_check, "Export cancelled")
                owned.verify()
                write_json_atomic(stage / "master_qc.json", cast(dict[str, Any], qc.to_record()))
                for _, path in outputs:
                    if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
                        raise _VariantValidationError("invalid encoder output")
                files: dict[str, VariantFileRecord] = {
                    name: _file_record(stage / name)
                    for name in [
                        "master.wav",
                        "master_qc.json",
                        *[path.name for _, path in outputs],
                    ]
                }
                receipt = _receipt(request, source, edit_head_id, qc, files)
                write_json_atomic(stage / "receipt.json", cast(dict[str, Any], receipt))
                expected_names = {
                    "master.wav",
                    "master_qc.json",
                    "receipt.json",
                    *[p.name for _, p in outputs],
                }
                if {path.name for path in stage.iterdir()} != expected_names:
                    raise _VariantValidationError("staging bundle has unexpected files")
                for path in stage.iterdir():
                    if path.is_symlink() or not path.is_file():
                        raise _VariantValidationError("staging bundle contains unsafe output")
                    _fsync_file(path)
                bundle = _validate_bundle(
                    stage, request.identity, expected_identity=request.identity
                )
            except (CodedValueError, CancelledProgress):
                raise
            except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as exc:
                raise _variant_error(
                    "The mastered or encoded variant output is incomplete or invalid. No variant was published.",
                    "export_variant_unmeasured",
                ) from exc
        except (CodedValueError, CancelledProgress):
            raise
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
            raise _variant_error(
                "The mastered or encoded output is incomplete or unsafe. No variant was published.",
                "export_variant_unmeasured",
            ) from exc
        with commit_guard(source.digest, request.identity):
            raise_if_cancel_requested(cancel_check, "Export cancelled")
            try:
                _publish(owned, request.identity)
            except OSError as exc:
                raise _variant_error(
                    "The export folder changed or could not be synced. Check saved exports before retrying.",
                    "export_variant_storage_invalid",
                ) from exc
        return _result(bundle, edit_head_id)
    finally:
        owned.close()


def current_source_digest(project: EpisodeProject, defaults: EffectiveConfig | None) -> str | None:
    if defaults is None:
        return None
    try:
        require_source_config(project, defaults)
    except CodedValueError:
        return None
    try:
        return _source_certificate(project, defaults).digest
    except (CodedValueError, OSError):
        return None


def completed_variant_files(project: EpisodeProject) -> tuple[VariantFile, ...]:
    try:
        root = _safe_bundle_root(project, create=False)
    except CodedValueError:
        return ()
    if not root.exists():
        return ()
    try:
        directories = sorted(root.iterdir())
    except OSError:
        return ()
    admitted: list[tuple[Path, AdmittedBundle]] = []
    for directory in directories:
        if directory.name.startswith(_PARTIAL) or not _BUNDLE_ID.fullmatch(directory.name):
            continue
        try:
            bundle = _load_bundle(root, directory.name)
            if bundle.audio:
                admitted.append((directory, bundle))
        except (KeyError, TypeError, ValueError, OSError):
            continue
    if not admitted:
        return ()
    entries: list[VariantFile] = []
    for directory, bundle in admitted:
        for audio in bundle.audio:
            entries.append(
                VariantFile(
                    f"variants/{bundle.identity}/{audio.name}",
                    f"{bundle.target.value.title()} {audio.spec.ext.upper()}",
                    audio.spec.ext,
                    bundle.target,
                    bundle.source_digest,
                    audio.size,
                    audio.sha256,
                    directory / audio.name,
                )
            )
    return tuple(entries)
