from podcast_mcp.util.relay_protocol.guest_ws_log import log_guest_ws_close, redact_share_token


def test_redact_share_token_masks_middle():
    assert redact_share_token("abcdefghijklmnop") == "abcd…mnop"
    assert redact_share_token("short") == "***"


def test_log_guest_ws_close_emits_info(caplog):
    import logging

    caplog.set_level(logging.INFO, logger="podcast_mcp.util.relay_protocol.guest_ws_log")
    log_guest_ws_close(
        "relay",
        "relay.host_offline",
        share_token="abcdefghijklmnop",
        stream_id="stream-1",
        code=1013,
        reason="host offline",
    )
    assert "relay guest ws close" in caplog.text
    assert "abcd…mnop" in caplog.text
    assert "relay.host_offline" in caplog.text


def test_a_guest_socket_task_label_names_the_share_and_not_the_token():
    from unittest.mock import MagicMock

    from podcast_mcp.gui.routes.guest_ws_common import GuestWsConnection

    conn = GuestWsConnection(
        MagicMock(),
        "velvet-quokka-umbra",
        share_id="a1b2c3d4e5f6",
        gate_held=False,
        log_label="guest ws",
    )

    assert conn._tasks._log_label == "guest ws share=a1b2c3d4e5f6"
