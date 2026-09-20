"""HTTP request-validation errors remain structured without leaking Pydantic detail."""

from __future__ import annotations

from urllib.parse import quote

from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.gui.validation_errors import format_validation_errors


def _post_command(client: TestClient, project, body: dict) -> dict:
    response = client.post(f"/api/document/command?path={quote(str(project))}", json=body)
    assert response.status_code == 422
    payload = response.json()
    assert isinstance(payload["detail"], list)
    assert isinstance(payload["message"], str)
    return payload


def test_invalid_document_tag_has_safe_structured_error(minimal_project) -> None:
    payload = _post_command(
        TestClient(create_app()),
        minimal_project,
        {"type": "NotACommand", "payload": {}, "client_id": "test", "client_seq": 1},
    )

    assert payload["message"] == "Unknown command type 'NotACommand'. Please refresh and try again."
    assert "expected_tags" not in str(payload["detail"])
    assert "union_tag" not in str(payload["detail"])


def test_missing_document_discriminator_has_safe_structured_error(minimal_project) -> None:
    payload = _post_command(
        TestClient(create_app()),
        minimal_project,
        {"payload": {}, "client_id": "test", "client_seq": 1},
    )

    assert payload["message"] == "Missing required field 'type'."
    assert "discriminator" not in str(payload["detail"])


def test_nested_missing_document_field_has_safe_structured_error(minimal_project) -> None:
    payload = _post_command(
        TestClient(create_app()),
        minimal_project,
        {
            "type": "ApproveEdits",
            "payload": {},
            "client_id": "test",
            "client_seq": 1,
        },
    )

    assert "Missing required field" in payload["message"]
    assert "ids" in payload["message"]


def test_invalid_scalar_has_safe_structured_error(minimal_project) -> None:
    payload = _post_command(
        TestClient(create_app()),
        minimal_project,
        {
            "type": "ApproveEdits",
            "payload": {"ids": []},
            "client_id": "test",
            "client_seq": "not-a-number",
        },
    )

    assert payload["message"] == "Invalid value for 'client_seq'."
    assert "Input should" not in str(payload["detail"])


def test_empty_validation_errors_still_have_a_safe_message() -> None:
    assert format_validation_errors([]) == {
        "message": "Invalid request. Please refresh and try again.",
        "detail": [],
    }
