from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
from collections.abc import Callable, Mapping
from contextlib import AbstractContextManager, contextmanager
from dataclasses import asdict, dataclass
from enum import StrEnum
from pathlib import Path
from types import MappingProxyType
from typing import Any, TypedDict, cast
from uuid import uuid4

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
from podcast_mcp.util.atomic_directory import rename_noreplace
from podcast_mcp.util.atomic_json import load_json_object, write_json_atomic
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.hashing import sha256_file
from podcast_mcp.util.progress import raise_if_cancel_requested
from podcast_mcp.util.project_state import FileRevision, file_revision
from podcast_mcp.util.tracks import stem_path
from podcast_mcp.util.wav import rendered_wav_is_complete


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
_FILES = {"master.wav", "master_qc.json", "receipt.json"}
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
    current: bool
    path: Path


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
        raise _VariantValidationError("variant format needs a safe audio extension")
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
    explicit_specs: list[ExportFormatSpec] = []
    for item in resolve_export_formats(export_cfg):
        if not isinstance(item, ExportFormatSpec):
            raise _VariantValidationError("variant export format is invalid")
        raw = (
            next(
                (
                    entry
                    for entry in export_cfg.get("formats", [])
                    if isinstance(entry, Mapping)
                    and str(entry.get("ext", entry.get("extension", ""))).lstrip(".").lower()
                    == item.ext
                ),
                None,
            )
            if "formats" in export_cfg
            else None
        )
        if raw is None:
            raw = _format_record(item)
        explicit_specs.append(_parse_variant_format(raw))
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
    premix_mtime = source.stat().st_mtime_ns
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
    premix_sha, _, premix_revision = _sha256_file(source)
    source_hash = master_source_hash(project)
    if source_hash is None:
        raise CodedValueError(
            "No current mix is available. Refresh the mix, then retry.", code="no_mix"
        )
    payload = {
        "source_contract_rev": 1,
        "source": "premix",
        "premix_sha256": premix_sha,
        "premix_revision": premix_revision,
        "master_source": source_hash,
        "mix_hash": recorded,
        "mix_gains": sorted((key, float(value)) for key, value in gains.items()),
        "stems": stems,
    }
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


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def _request(
    target: ExportTarget,
    defaults: EffectiveConfig,
    formats: list[dict[str, Any]] | None,
    project: EpisodeProject,
    source: _SourceCertificate,
) -> _VariantRequest:
    master_target = master_target_for(target, defaults)
    limits = MasterQcLimits.from_defaults(defaults)
    metadata = (("album", project.name), ("title", project.name))
    resolved = _resolve_formats(defaults, formats)
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
        if (
            raw is None
            or isinstance(raw, bool)
            or not isinstance(raw, int | float)
            or not math.isfinite(raw)
        ):
            values[key] = None
        else:
            values[key] = float(raw)
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


def _validate_qc_record(raw: Any, target: MasterTarget, limits: MasterQcLimits) -> VariantQc:
    if not isinstance(raw, dict) or not isinstance(raw.get("measured"), dict):
        raise _VariantValidationError("invalid variant QC record")
    measured = raw["measured"]
    qc = _qc_from_measurement(
        measured,
        {
            "plan": raw.get("plan"),
            "normalization_type": raw.get("normalization_type"),
            "limiter": raw.get("limiter"),
            "input_stats": raw.get("input_stats"),
        },
        target,
        limits,
    )
    if raw.get("target") != asdict(target) or raw.get("limits") != asdict(limits):
        raise _VariantValidationError("variant QC inputs do not match the bundle identity")
    if (
        raw.get("issues") != list(qc.issues)
        or raw.get("within_tolerance") is not qc.within_tolerance
    ):
        raise _VariantValidationError("variant QC verdict does not match its measurement")
    return qc


def variant_identity(
    project: EpisodeProject,
    defaults: EffectiveConfig,
    target: ExportTarget,
    formats: list[dict[str, Any]] | None,
) -> tuple[str, str]:
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
    digest, size, _ = _sha256_file(path)
    return {"sha256": digest, "size": size}


def _valid_source_record(raw: VariantSourceRecord) -> bool:
    if (
        not isinstance(raw.get("premix_sha256"), str)
        or not re.fullmatch(r"[0-9a-f]{64}", raw["premix_sha256"])
        or not isinstance(raw.get("master_source"), str)
        or not re.fullmatch(r"[0-9a-f]{16}", raw["master_source"])
        or not isinstance(raw.get("mix_hash"), str)
        or not re.fullmatch(r"[0-9a-f]{16}", raw["mix_hash"])
    ):
        return False
    gains = raw.get("mix_gains")
    revisions = raw.get("premix_revision")
    stems = raw.get("stem_state")
    if (
        not isinstance(gains, list)
        or not gains
        or not isinstance(revisions, list)
        or len(revisions) != 4
        or any(type(value) is not int for value in revisions)
        or not isinstance(stems, list)
        or not stems
    ):
        return False
    if any(
        not isinstance(item, list)
        or len(item) != 2
        or not isinstance(item[0], str)
        or isinstance(item[1], bool)
        or not isinstance(item[1], int | float)
        or not math.isfinite(item[1])
        for item in gains
    ):
        return False
    return all(
        isinstance(item, list)
        and len(item) == 6
        and isinstance(item[0], str)
        and isinstance(item[1], str)
        and re.fullmatch(r"[0-9a-f]{16}", item[1]) is not None
        and all(type(value) is int for value in item[2:])
        for item in stems
    )


def _load_bundle(
    root: Path,
    bundle_id: str,
    *,
    expected_identity: str | None = None,
) -> tuple[VariantReceipt, VariantQc, dict[str, Path]]:
    if not _BUNDLE_ID.fullmatch(bundle_id):
        raise _VariantValidationError("invalid bundle id")
    directory = root / bundle_id
    return _validate_bundle(directory, bundle_id, expected_identity=expected_identity)


def _validate_bundle(
    directory: Path,
    bundle_id: str,
    *,
    expected_identity: str | None = None,
) -> tuple[VariantReceipt, VariantQc, dict[str, Path]]:
    if directory.is_symlink() or not directory.is_dir():
        raise _VariantValidationError("variant bundle directory is missing or unsafe")
    receipt_path = directory / "receipt.json"
    if receipt_path.is_symlink():
        raise _VariantValidationError("variant receipt is unsafe")
    raw_receipt = load_json_object(receipt_path)
    if (
        raw_receipt is None
        or raw_receipt.get("schema") != RECEIPT_SCHEMA
        or raw_receipt.get("identity") != bundle_id
    ):
        raise _VariantValidationError("variant receipt is invalid")
    if expected_identity is not None and bundle_id != expected_identity:
        raise _VariantValidationError("variant bundle does not match request")
    receipt = cast(VariantReceipt, raw_receipt)
    try:
        target = ExportTarget(receipt["target"])
        master_target = MasterTarget(**receipt["master_target"])
        limits = MasterQcLimits(**receipt["qc_limits"])
        qc = _validate_qc_record(receipt["qc"], master_target, limits)
        formats = receipt["formats"]
        if not isinstance(formats, list) or not formats:
            raise _VariantValidationError("invalid formats")
        specs = tuple(_parse_variant_format(item) for item in formats)
        extensions = [spec.ext for spec in specs]
        if len(extensions) != len(set(extensions)):
            raise _VariantValidationError("duplicate formats")
        members: dict[str, Path] = {name: directory / name for name in _FILES}
        for spec in specs:
            members[f"audio.{spec.ext}"] = directory / f"audio.{spec.ext}"
        files = receipt["files"]
        if not isinstance(files, dict) or set(files) != set(members) - {"receipt.json"}:
            raise _VariantValidationError("variant file inventory is invalid")
        for name, path in members.items():
            if path.is_symlink() or not path.is_file():
                raise _VariantValidationError("variant bundle member is missing or unsafe")
            if name == "receipt.json":
                continue
            recorded = files.get(name)
            if not isinstance(recorded, dict):
                raise _VariantValidationError("variant file record is missing")
            if (
                set(recorded) != {"sha256", "size"}
                or not isinstance(recorded.get("sha256"), str)
                or not re.fullmatch(r"[0-9a-f]{64}", recorded["sha256"])
                or type(recorded.get("size")) is not int
            ):
                raise _VariantValidationError("variant file record is malformed")
            digest, size, _ = _sha256_file(path)
            if recorded != {"sha256": digest, "size": size}:
                raise _VariantValidationError("variant file integrity changed")
        if not rendered_wav_is_complete(members["master.wav"]):
            raise _VariantValidationError("variant master is incomplete")
        qc_disk = load_json_object(members["master_qc.json"])
        if qc_disk != receipt["qc"]:
            raise _VariantValidationError("variant QC file does not match the receipt")
        for spec in specs:
            path = members[f"audio.{spec.ext}"]
            if spec.ext == "wav" and not rendered_wav_is_complete(path):
                raise _VariantValidationError("variant WAV output is incomplete")
            if path.stat().st_size == 0:
                raise _VariantValidationError("variant output is empty")
        identity_record = {
            "source": receipt["source_digest"],
            "master_target": _master_target_record(master_target),
            "master_semantics_rev": receipt["master_semantics_rev"],
            "variant_semantics_rev": receipt["variant_semantics_rev"],
            "formats": [_format_record(spec) for spec in specs],
            "encoding_semantics_rev": receipt["encoding_semantics_rev"],
            "metadata": receipt["metadata"],
            "qc_limits": _qc_limits_record(limits),
        }
        if (
            receipt["master_semantics_rev"] != MASTER_SEMANTICS_REV
            or receipt["variant_semantics_rev"] != VARIANT_SEMANTICS_REV
            or receipt["encoding_semantics_rev"] != ENCODING_SEMANTICS_REV
            or hashlib.sha256(_canonical_json(identity_record)).hexdigest() != bundle_id
        ):
            raise _VariantValidationError("variant identity does not match its receipt")
        metadata = receipt.get("metadata")
        source_record = receipt.get("source")
        if (
            master_target.integrated_lufs != TARGET_INTEGRATED_LUFS[target]
            or not isinstance(metadata, dict)
            or set(metadata) != {"album", "title"}
            or not all(isinstance(value, str) for value in metadata.values())
            or not isinstance(source_record, dict)
            or source_record.get("kind") != "premix"
            or not isinstance(receipt.get("source_digest"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", receipt["source_digest"])
            or not _valid_source_record(source_record)
        ):
            raise _VariantValidationError("variant metadata or target is invalid")
        if set(receipt) != {
            "schema",
            "identity",
            "target",
            "master_target",
            "qc_limits",
            "source_digest",
            "source",
            "master_semantics_rev",
            "variant_semantics_rev",
            "encoding_semantics_rev",
            "formats",
            "metadata",
            "edit_head_id",
            "qc",
            "files",
        }:
            raise _VariantValidationError("variant receipt has unexpected fields")
        return receipt, qc, members
    except (CodedValueError, KeyError, TypeError, ValueError, OSError) as exc:
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


def _publish(stage: Path, root: Path, bundle_id: str) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    root_fd = os.open(root, flags)
    try:
        rename_noreplace(stage.name, bundle_id, root_fd)
        os.fsync(root_fd)
    finally:
        os.close(root_fd)


def _fsync_file(path: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _remove_owned_stage(stage: Path, root: Path) -> None:
    if stage.name.startswith(_PARTIAL) and not stage.is_symlink() and stage.parent == root:
        shutil.rmtree(stage, ignore_errors=True)


def _variant_error(message: str, code: str) -> CodedValueError:
    return CodedValueError(message, code=code)


def _result(
    bundle_id: str,
    receipt: VariantReceipt,
    qc: VariantQc,
) -> VariantExportResult:
    target = ExportTarget(receipt["target"])
    file_ids = tuple(f"variants/{bundle_id}/audio.{spec['ext']}" for spec in receipt["formats"])
    return VariantExportResult(file_ids, target, qc, receipt.get("edit_head_id"))


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
    source = _source_certificate(project, defaults)
    try:
        request = _request(target, defaults, formats, project, source)
    except (AttributeError, KeyError, TypeError, ValueError) as exc:
        message = (
            str(exc)
            if isinstance(exc, _VariantValidationError)
            else "Variant export format is invalid. Choose a supported audio format."
        )
        raise _variant_error(message, "export_variant_format_invalid") from exc
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
            receipt, qc, _members = _load_bundle(
                root, request.identity, expected_identity=request.identity
            )
        except ValueError as exc:
            raise _variant_error(
                "A saved variant bundle is damaged and was not replaced. Contact the host for help.",
                "export_variant_cache_corrupt",
            ) from exc
        with commit_guard(source.digest, request.identity):
            return _result(request.identity, receipt, qc)

    stage = root / f"{_PARTIAL}{uuid4().hex}"
    stage.mkdir(mode=0o700)
    try:
        raise_if_cancel_requested(cancel_check, "Export cancelled")
        master_path = stage / "master.wav"
        master_result = engine.master_loudness(
            premix_path(project),
            master_path,
            integrated_lufs=request.master_target.integrated_lufs,
            true_peak_db=request.master_target.true_peak_db,
            lra=request.master_target.lra,
        )
        raise_if_cancel_requested(cancel_check, "Export cancelled")
        if master_path.is_symlink() or not rendered_wav_is_complete(master_path):
            raise _variant_error(
                "The mastered audio is incomplete. No variant was published.",
                "export_variant_unmeasured",
            )
        measured = engine.measure_loudness_full(master_path)
        qc = _qc_from_measurement(measured, master_result, request.master_target, request.limits)
        if qc.issues:
            measured_lufs = qc.measured.get("integrated_lufs")
            measured_peak = qc.measured.get("true_peak_db")
            details = "; ".join(qc.issues)
            raise _variant_error(
                f"The mastered audio failed variant QC: {details}. Requested {request.master_target.integrated_lufs:g} LUFS and at most {request.master_target.true_peak_db:g} dBTP; measured {measured_lufs!s} LUFS and {measured_peak!s} dBTP. No variant was published.",
                "export_variant_qc_failed",
            )
        raise_if_cancel_requested(cancel_check, "Export cancelled")
        outputs = [(spec, stage / f"audio.{spec.ext}") for spec in request.formats]
        render_audio_formats(
            engine,
            master_path,
            outputs,
            metadata=dict(request.metadata),
            max_workers=(defaults.get("performance") or {}).get("max_workers"),
            cancel_check=cancel_check,
        )
        raise_if_cancel_requested(cancel_check, "Export cancelled")
        write_json_atomic(stage / "master_qc.json", cast(dict[str, Any], qc.to_record()))
        files: dict[str, VariantFileRecord] = {
            name: _file_record(stage / name)
            for name in ["master.wav", "master_qc.json", *[path.name for _, path in outputs]]
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
        try:
            receipt, qc, _members = _validate_bundle(
                stage, request.identity, expected_identity=request.identity
            )
        except (ValueError, OSError) as exc:
            raise _variant_error(
                "The mastered or encoded variant output is incomplete or invalid. No variant was published.",
                "export_variant_unmeasured",
            ) from exc
        with commit_guard(source.digest, request.identity):
            raise_if_cancel_requested(cancel_check, "Export cancelled")
            _publish(stage, root, request.identity)
        receipt, qc, _members = _load_bundle(
            root, request.identity, expected_identity=request.identity
        )
        return _result(request.identity, receipt, qc)
    finally:
        _remove_owned_stage(stage, root)


def completed_variant_files(
    project: EpisodeProject, defaults: EffectiveConfig
) -> tuple[VariantFile, ...]:
    try:
        root = _safe_bundle_root(project, create=False)
    except CodedValueError:
        return ()
    if not root.exists():
        return ()
    try:
        source_digest = _source_certificate(project, defaults).digest
    except (CodedValueError, OSError, ValueError):
        source_digest = ""
    entries: list[VariantFile] = []
    for directory in sorted(root.iterdir()):
        if directory.name.startswith(_PARTIAL) or not _BUNDLE_ID.fullmatch(directory.name):
            continue
        try:
            receipt, _, members = _load_bundle(root, directory.name)
            target = ExportTarget(receipt["target"])
            source = receipt["source_digest"]
            for spec in receipt["formats"]:
                ext = spec["ext"]
                path = members[f"audio.{ext}"]
                entries.append(
                    VariantFile(
                        f"variants/{directory.name}/audio.{ext}",
                        f"{target.value.title()} {ext.upper()}",
                        ext,
                        target,
                        source,
                        path.stat().st_size,
                        receipt["files"][f"audio.{ext}"]["sha256"],
                        bool(source_digest and source_digest == source),
                        path,
                    )
                )
        except (KeyError, TypeError, ValueError, OSError):
            continue
    return tuple(entries)
