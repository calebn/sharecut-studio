"""podcast-relay - TLS-edge reverse tunnel for host-online DAW sharing."""

from __future__ import annotations

from fastapi import FastAPI

from podcast_mcp import settings
from podcast_mcp.util.body_limits import relay_ws_max_size
from podcast_relay.reports import router as reports_router
from podcast_relay.reports import start_report_worker
from podcast_relay.routes.guest_ws import build_guest_ws_router
from podcast_relay.routes.proxy import build_proxy_router
from podcast_relay.routes.status import build_status_router
from podcast_relay.routes.tunnel import build_tunnel_router
from podcast_relay.state import RelayState
from podcast_relay.version import read_relay_version


def _parse_host_tokens() -> tuple[set[str], dict[str, str]]:
    from podcast_mcp.util.relay_protocol.share_claims import parse_host_token_map

    raw = settings.text("PODCAST_RELAY_HOST_TOKENS")
    if not raw:
        return set(), {}
    return parse_host_token_map(raw)


def _allow_open_tunnel() -> bool:
    return settings.flag("PODCAST_RELAY_ALLOW_OPEN_TUNNEL")


def create_relay_app() -> FastAPI:
    shared, by_host = _parse_host_tokens()
    state = RelayState(
        shared,
        allow_open_tunnel=_allow_open_tunnel(),
        host_secrets=by_host,
    )
    app = FastAPI(
        title="Podcast Relay",
        version=read_relay_version(),
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.relay = state
    app.include_router(reports_router)
    app.router.on_startup.append(start_report_worker)
    app.include_router(build_status_router(state))
    app.include_router(build_tunnel_router(state))
    app.include_router(build_proxy_router(state))
    app.include_router(build_guest_ws_router(state))
    return app


def main() -> None:
    import sys

    import uvicorn

    shared, by_host = _parse_host_tokens()
    if not shared and not by_host and not _allow_open_tunnel():
        print(
            "FATAL: PODCAST_RELAY_HOST_TOKENS is empty. "
            "Set one or more host tokens, or set "
            "PODCAST_RELAY_ALLOW_OPEN_TUNNEL=1 for local/dev only.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    # Bind-all is intentional for the public relay edge; override via env for local.
    default_host = "0.0.0.0"  # nosec B104
    host = settings.value("PODCAST_RELAY_HOST", default_host)
    port = int(settings.value("PODCAST_RELAY_PORT", "8081"))
    ws_max_size = relay_ws_max_size()
    uvicorn.run(
        "podcast_relay.app:create_relay_app",
        factory=True,
        host=host,
        port=port,
        log_level="info",
        ws_max_size=ws_max_size,
        forwarded_allow_ips=settings.value("PODCAST_RELAY_FORWARDED_ALLOW_IPS", "127.0.0.1"),
    )


if __name__ == "__main__":
    main()
