from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field

from podcast_mcp.engines.mastering import MasterQcLimits, MasterTarget, master_qc_issues
from podcast_mcp.export.audio import ExportFormatSpec
from podcast_mcp.util.pinned_media import open_pinned_media
from podcast_mcp.util.wav import rendered_wav_is_complete

if TYPE_CHECKING:
    from .export_variant import ExportTarget, VariantQc, _SourcePayload


class InvalidReceipt(ValueError):
    pass


def _finite(value: object) -> int | float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise InvalidReceipt("expected a finite number")
    try:
        valid = math.isfinite(value)
    except OverflowError:
        valid = False
    if not valid:
        raise InvalidReceipt("expected a representable finite number")
    return value


Number = Annotated[int | float, BeforeValidator(_finite)]
Integer = Annotated[int, BeforeValidator(_finite)]
Digest = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
ShortDigest = Annotated[str, Field(pattern=r"^[0-9a-f]{16}$")]


class _Record(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", frozen=True)


class _Target(_Record):
    integrated_lufs: Number
    true_peak_db: Number
    lra: Number


class _Limits(_Record):
    lufs_tolerance_lu: Number
    true_peak_tolerance_db: Number


class _Format(_Record):
    ext: str
    codec: str | None
    format: str | None
    bitrate_kbps: Integer | None
    sample_rate: Integer | None
    channels: Integer | None
    extra_args: list[str]


class _Limiter(_Record):
    gain_db: Number
    drive_db: Number
    limit_db: Number
    renders: Integer
    converged: bool
    trim_db: Number
    peak_reduction_db: Number
    loudness_reduction_lu: Number


class _Qc(_Record):
    target: _Target
    limits: _Limits
    measured: dict[str, Number | None]
    input_stats: dict[str, Number] | None
    plan: str
    normalization_type: str | None
    limiter: _Limiter | None
    issues: list[str]
    within_tolerance: bool


class _Source(_Record):
    kind: Literal["premix"]
    premix_sha256: Digest
    master_source: ShortDigest
    mix_hash: ShortDigest
    mix_gains: list[list[str | Number]]
    stem_state: list[list[str | Integer]]
    premix_revision: list[Integer]


class _File(_Record):
    sha256: Digest
    size: Annotated[Integer, Field(gt=0)]


class _Receipt(_Record):
    schema_revision: Integer = Field(alias="schema")
    identity: Digest
    target: str
    master_target: _Target
    qc_limits: _Limits
    source_digest: Digest
    source: _Source
    master_semantics_rev: Integer
    variant_semantics_rev: Integer
    encoding_semantics_rev: Integer
    formats: list[_Format]
    metadata: dict[str, str]
    edit_head_id: str | None
    qc: _Qc
    files: dict[str, _File]


@dataclass(frozen=True)
class AdmittedAudio:
    spec: ExportFormatSpec
    size: int
    sha256: str

    @property
    def name(self) -> str:
        return f"audio.{self.spec.ext}"


@dataclass(frozen=True)
class AdmittedBundle:
    identity: str
    target: ExportTarget
    source_digest: str
    generation_edit_head_id: str | None
    qc: VariantQc
    audio: tuple[AdmittedAudio, ...]


def _object(pairs: list[tuple[str, object]]) -> object:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise InvalidReceipt("duplicate JSON key")
        result[key] = value
    return result


def _constant(_value: str) -> None:
    raise InvalidReceipt("nonfinite JSON constant")


def _json(path: Path) -> object:
    if path.is_symlink() or not path.is_file():
        raise InvalidReceipt("unsafe JSON member")
    with open_pinned_media(path) as handle:
        return json.loads(handle.read(), object_pairs_hook=_object, parse_constant=_constant)


def _source_payload(source: _Source) -> _SourcePayload:
    from .export_variant import _source_payload as payload

    def revision(row: list[object]) -> tuple[int, int, int, int]:
        if len(row) != 4 or any(type(item) is not int for item in row):
            raise InvalidReceipt("invalid revision")
        a, b, c, d = row
        if not (
            isinstance(a, int) and isinstance(b, int) and isinstance(c, int) and isinstance(d, int)
        ):
            raise InvalidReceipt("invalid revision")
        return a, b, c, d

    gains: list[tuple[str, float]] = []
    for row in source.mix_gains:
        if len(row) != 2 or not isinstance(row[0], str):
            raise InvalidReceipt("invalid gain row")
        gains.append((row[0], float(_finite(row[1]))))
    stems = []
    for stem_row in source.stem_state:
        if (
            len(stem_row) != 6
            or not isinstance(stem_row[0], str)
            or not isinstance(stem_row[1], str)
        ):
            raise InvalidReceipt("invalid stem row")
        if len(stem_row[1]) != 16 or any(c not in "0123456789abcdef" for c in stem_row[1]):
            raise InvalidReceipt("invalid stem hash")
        stems.append((stem_row[0], stem_row[1], revision(list(stem_row[2:]))))
    ids = [key for key, _ in gains]
    if not ids or ids != sorted(set(ids)) or ids != [row[0] for row in stems]:
        raise InvalidReceipt("invalid source tracks")
    return payload(
        source.premix_sha256,
        revision(list(source.premix_revision)),
        source.master_source,
        source.mix_hash,
        gains,
        stems,
    )


def admit_bundle(directory: Path, bundle_id: str) -> AdmittedBundle:
    from .export_variant import (
        ENCODING_SEMANTICS_REV,
        MASTER_SEMANTICS_REV,
        RECEIPT_SCHEMA,
        TARGET_INTEGRATED_LUFS,
        VARIANT_SEMANTICS_REV,
        ExportTarget,
        VariantQc,
        _canonical_json,
        _format_record,
        _parse_variant_format,
        _sha256_file,
    )

    if directory.is_symlink() or not directory.is_dir():
        raise InvalidReceipt("unsafe bundle")
    record = _Receipt.model_validate(_json(directory / "receipt.json"))
    target = ExportTarget(record.target)
    master = MasterTarget(**record.master_target.model_dump())
    limits = MasterQcLimits(**record.qc_limits.model_dump())
    if (
        record.schema_revision != RECEIPT_SCHEMA
        or record.identity != bundle_id
        or record.master_semantics_rev != MASTER_SEMANTICS_REV
        or record.variant_semantics_rev != VARIANT_SEMANTICS_REV
        or record.encoding_semantics_rev != ENCODING_SEMANTICS_REV
        or master.integrated_lufs != TARGET_INTEGRATED_LUFS[target]
        or set(record.metadata) != {"album", "title"}
    ):
        raise InvalidReceipt("invalid bundle inputs")
    if (
        hashlib.sha256(_canonical_json(_source_payload(record.source))).hexdigest()
        != record.source_digest
    ):
        raise InvalidReceipt("source certificate mismatch")
    specs = tuple(_parse_variant_format(item.model_dump()) for item in record.formats)
    if (
        not specs
        or len({spec.ext for spec in specs}) != len(specs)
        or any(
            item.model_dump() != _format_record(spec)
            for item, spec in zip(record.formats, specs, strict=True)
        )
    ):
        raise InvalidReceipt("noncanonical formats")
    identity = {
        "source": record.source_digest,
        "master_target": record.master_target.model_dump(),
        "master_semantics_rev": record.master_semantics_rev,
        "variant_semantics_rev": record.variant_semantics_rev,
        "encoding_semantics_rev": record.encoding_semantics_rev,
        "formats": [_format_record(spec) for spec in specs],
        "metadata": record.metadata,
        "qc_limits": record.qc_limits.model_dump(),
    }
    if hashlib.sha256(_canonical_json(identity)).hexdigest() != bundle_id:
        raise InvalidReceipt("bundle identity mismatch")
    raw_qc = record.qc
    measured = {
        key: float(value) if value is not None else None for key, value in raw_qc.measured.items()
    }
    limiter = raw_qc.limiter.model_dump() if raw_qc.limiter else None
    issues = master_qc_issues(measured, master, limits, limiter)
    if (
        any(measured.get(key) is None for key in ("integrated_lufs", "true_peak_db"))
        or raw_qc.target != record.master_target
        or raw_qc.limits != record.qc_limits
        or issues
        or raw_qc.issues
        or not raw_qc.within_tolerance
    ):
        raise InvalidReceipt("bundle QC did not pass")
    qc = VariantQc(
        master,
        limits,
        measured,
        raw_qc.input_stats,
        raw_qc.plan,
        raw_qc.normalization_type,
        limiter,
        tuple(issues),
    )
    if _Qc.model_validate(_json(directory / "master_qc.json")) != raw_qc:
        raise InvalidReceipt("QC sidecar mismatch")
    expected = {"master.wav", "master_qc.json", *[f"audio.{spec.ext}" for spec in specs]}
    if set(record.files) != expected:
        raise InvalidReceipt("incomplete inventory")
    for name, registered in record.files.items():
        path = directory / name
        if path.is_symlink() or not path.is_file():
            raise InvalidReceipt("unsafe member")
        digest, size, _ = _sha256_file(path)
        if registered.size != size or registered.sha256 != digest:
            raise InvalidReceipt("member integrity mismatch")
        if name.endswith(".wav") and not rendered_wav_is_complete(path):
            raise InvalidReceipt("incomplete WAV")
    return AdmittedBundle(
        bundle_id,
        target,
        record.source_digest,
        record.edit_head_id,
        qc,
        tuple(
            AdmittedAudio(
                spec,
                record.files[f"audio.{spec.ext}"].size,
                record.files[f"audio.{spec.ext}"].sha256,
            )
            for spec in specs
        ),
    )
