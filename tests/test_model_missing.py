"""``require_model`` / ``ModelMissing``: one refusal for a model that is not installed (#2046)."""

from __future__ import annotations

import pickle
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.engines.models import registry
from podcast_mcp.engines.models.registry import (
    MODELS,
    ModelProblem,
    model_record,
    model_spec,
    require_model,
)
from podcast_mcp.engines.models.speaker_ecapa import speaker_ecapa_path
from podcast_mcp.gui.server import create_app
from podcast_mcp.services.pipeline import bootstrap as boot
from podcast_mcp.util.coded_error import CodedError
from podcast_mcp.util.model_missing import ModelMissing
from podcast_mcp.util.tool_refusal import refusal_tool_result, tool_refusal

CODE = "X-Sharecut-Error-Code"
GUEST_COPY = "The host needs to download a model first; ask the host to open ShareCut Studio."
IDS = [spec.id for spec in MODELS]


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("PODCAST_MCP_RNNOISE_MODEL", str(tmp_path / "model.rnnn"))
    monkeypatch.delenv("PODCAST_WHISPER_MODEL", raising=False)
    monkeypatch.delenv("PODCAST_MCP_SPEAKER_ECAPA_MODEL", raising=False)


def _problem(monkeypatch: pytest.MonkeyPatch, model_id: str, found: ModelProblem | None) -> None:
    spec = model_spec(model_id)
    monkeypatch.setitem(
        registry._BY_ID, model_id, replace(spec, problem=lambda variant, memoize: found)
    )


def _speaker_missing() -> ModelMissing:
    with pytest.raises(ModelMissing) as caught:
        require_model("speaker-ecapa")
    return caught.value


def test_model_missing_carries_the_record_fields() -> None:
    exc = _speaker_missing()
    assert exc.code == "model_needed"
    assert isinstance(exc, CodedError)
    assert isinstance(exc, RuntimeError)
    assert not isinstance(exc, ValueError)
    assert exc.payload() == {
        "id": "speaker-ecapa",
        "model": "speaker-ecapa",
        "label": "Speaker recognition (ECAPA, ONNX)",
        "purpose": "speaker recognition and split",
        "size": "~80 MB",
        "size_bytes": None,
        "command": "podcast bootstrap --component speaker-ecapa",
        "state": "missing",
    }
    assert str(exc) == (
        "needs Speaker recognition (ECAPA, ONNX) (~80 MB); "
        "run `podcast bootstrap --component speaker-ecapa`"
    )


def test_message_and_payload_never_hold_the_host_path(tmp_path: Path) -> None:
    with pytest.raises(ModelMissing) as caught:
        require_model("rnnoise")
    exc = caught.value
    assert str(tmp_path) not in str(exc)
    assert str(tmp_path) not in str(exc.payload())
    assert "path" not in exc.payload()
    assert "hint" not in exc.payload()


def test_model_missing_survives_pickle() -> None:
    exc = pickle.loads(pickle.dumps(_speaker_missing()))
    assert isinstance(exc, ModelMissing)
    assert exc.code == "model_needed"
    assert exc.payload() == _speaker_missing().payload()
    assert str(exc) == str(_speaker_missing())


@pytest.mark.parametrize("model_id", IDS)
def test_require_model_by_state(model_id: str, monkeypatch: pytest.MonkeyPatch) -> None:
    _problem(monkeypatch, model_id, None)
    assert require_model(model_id) is None

    _problem(monkeypatch, model_id, ModelProblem("gone", "podcast bootstrap --component x"))
    with pytest.raises(ModelMissing) as missing:
        require_model(model_id)
    assert missing.value.id == model_id
    assert missing.value.state == "missing"
    assert missing.value.command == "podcast bootstrap --component x"

    _problem(monkeypatch, model_id, ModelProblem("stale", "podcast bootstrap --upgrade", True))
    with pytest.raises(ModelMissing) as stale:
        require_model(model_id)
    assert stale.value.state == "update_needed"
    assert stale.value.command.endswith("--upgrade")


def test_require_model_unknown_id_is_a_key_error() -> None:
    with pytest.raises(KeyError):
        require_model("no-such-model")


def test_require_model_passes_variant_and_memoize(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[tuple[str | None, bool]] = []

    def problem(variant: str | None, memoize: bool) -> None:
        seen.append((variant, memoize))

    monkeypatch.setitem(registry._BY_ID, "whisper", replace(model_spec("whisper"), problem=problem))
    require_model("whisper", "tiny.en")
    require_model("whisper", "tiny.en", memoize=False)
    assert seen == [("tiny.en", True), ("tiny.en", False)]


def test_require_model_is_quiet_once_the_file_is_there(tmp_path: Path) -> None:
    with pytest.raises(ModelMissing):
        require_model("rnnoise")
    (tmp_path / "model.rnnn").write_bytes(b"x")
    require_model("rnnoise")


def test_a_stale_speaker_file_is_update_needed_with_upgrade() -> None:
    path = speaker_ecapa_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"not the pinned bytes")
    rec = model_record("speaker-ecapa")
    assert rec["state"] == "update_needed"
    assert rec["bootstrap"] == "podcast bootstrap --component speaker-ecapa --upgrade"
    with pytest.raises(ModelMissing) as caught:
        require_model("speaker-ecapa")
    assert caught.value.state == "update_needed"
    assert caught.value.command.endswith(" --upgrade")

    path.unlink()
    assert model_record("speaker-ecapa")["bootstrap"] == model_spec("speaker-ecapa").fix_command


def test_model_status_keeps_its_record(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    model = tmp_path / "model.rnnn"
    base = {
        "id": "rnnoise",
        "model": "rnnoise",
        "label": "Noise reduction (RNNoise)",
        "purpose": "noise reduction",
        "tier": "recommended",
        "size": "~0.3 MB",
        "size_bytes": 297646,
        "path": str(model),
    }
    missing = boot.model_status("rnnoise")
    assert list(missing) == [*base, "state", "hint", "bootstrap"]
    assert missing == {
        **base,
        "state": "missing",
        "hint": f"RNNoise model not found at {model}. Run `podcast bootstrap --component rnnoise`.",
        "bootstrap": "podcast bootstrap --component rnnoise",
    }
    model.write_bytes(b"x")
    assert list(boot.model_status("rnnoise")) == [*base, "state"]
    assert boot.model_status("rnnoise") == {**base, "state": "installed"}

    def boom(variant: str | None, memoize: bool) -> None:
        raise OSError("disk went away")

    monkeypatch.setitem(registry._BY_ID, "rnnoise", replace(model_spec("rnnoise"), problem=boom))
    failed = boot.model_status("rnnoise")
    assert "path" not in failed
    assert failed == {
        **{k: v for k, v in base.items() if k != "path"},
        "state": "missing",
        "hint": "disk went away",
        "bootstrap": "podcast bootstrap --component rnnoise",
    }


def test_model_record_has_no_path_and_does_not_swallow(monkeypatch: pytest.MonkeyPatch) -> None:
    assert "path" not in model_record("rnnoise")

    def boom(variant: str | None, memoize: bool) -> None:
        raise OSError("disk went away")

    monkeypatch.setitem(registry._BY_ID, "rnnoise", replace(model_spec("rnnoise"), problem=boom))
    with pytest.raises(OSError):
        model_record("rnnoise")


def _client(*, relayed: bool) -> TestClient:
    router = APIRouter()

    @router.get("/api/_test/needs-model")
    def needs_model() -> Any:
        require_model("rnnoise")

    gui = create_app()
    gui.include_router(router)
    headers = {"x-sharecut-relayed": "1"} if relayed else {}
    return TestClient(gui, client=("127.0.0.1", 50000), headers=headers)


def test_host_gets_409_with_the_model_and_no_store() -> None:
    res = _client(relayed=False).get("/api/_test/needs-model")
    assert res.status_code == 409
    assert res.headers[CODE] == "model_needed"
    assert res.headers["Cache-Control"] == "no-store"
    detail = res.json()["detail"]
    assert detail["detail"] == (
        "needs Noise reduction (RNNoise) (~0.3 MB); run `podcast bootstrap --component rnnoise`"
    )
    assert detail["model"]["id"] == "rnnoise"
    assert detail["model"]["state"] == "missing"
    assert detail["model"]["command"] == "podcast bootstrap --component rnnoise"


def test_relayed_guest_gets_only_the_guest_copy(tmp_path: Path) -> None:
    res = _client(relayed=True).get("/api/_test/needs-model")
    assert res.status_code == 409
    assert res.headers[CODE] == "model_needed"
    assert res.headers["Cache-Control"] == "no-store"
    assert res.json() == {"detail": GUEST_COPY}
    for leaked in ("podcast bootstrap", "ECAPA", "rnnoise", "MB", str(tmp_path)):
        assert leaked not in res.text


def test_mcp_refusal_carries_the_model_for_the_owner_only() -> None:
    exc = _speaker_missing()
    owner = tool_refusal(exc)
    assert owner is not None
    assert owner.extra == {"model": exc.payload()}
    structured = refusal_tool_result(owner).structured_content
    assert structured == {
        "ok": False,
        "error": str(exc),
        "error_code": "model_needed",
        "model": exc.payload(),
    }

    guest = tool_refusal(exc, for_guest=True)
    assert guest is not None
    assert guest.message == GUEST_COPY
    assert guest.extra is None
    assert refusal_tool_result(guest).structured_content == {
        "ok": False,
        "error": GUEST_COPY,
        "error_code": "model_needed",
    }


def test_cli_prints_the_model_line(minimal_project: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from podcast_mcp.services.document import HistoryService

    def refuse(self: Any, **kwargs: Any) -> None:
        require_model("speaker-ecapa")

    monkeypatch.setattr(HistoryService, "undo", refuse)
    result = CliRunner().invoke(app, ["undo", "--project", str(minimal_project)])
    assert result.exit_code == 1
    assert result.stderr.startswith(
        "Error: needs Speaker recognition (ECAPA, ONNX) (~80 MB); "
        "run `podcast bootstrap --component speaker-ecapa` (code model_needed)"
    )
