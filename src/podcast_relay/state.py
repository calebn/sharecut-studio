"""Per-app relay state: tunnel sessions, share routing and token ownership."""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket

from podcast_mcp.util.body_limits import relay_ws_max_size
from podcast_mcp.util.relay_protocol.guest_ws_log import log_guest_ws_close
from podcast_mcp.util.relay_protocol.lease import LeaseRefusal
from podcast_mcp.util.relay_protocol.protocol import msg
from podcast_mcp.util.ws_delivery import SerializedWsWriter, WsFrameQueue
from podcast_mcp.util.ws_delivery import TextWsStream as GuestWsStream
from podcast_relay.caps import RelayMeter, SessionMeter, Tier
from podcast_relay.policy import RelayPolicy


def close_relay_guest_stream(
    stream: GuestWsStream,
    site: str,
    code: int,
    reason: str,
    *,
    share_token: str = "",
    stream_id: str = "",
    discard: bool = False,
) -> None:
    if stream.close_code == 1000:
        log_guest_ws_close(
            "relay",
            site,
            share_token=share_token,
            stream_id=stream_id,
            code=code,
            reason=reason,
        )
    stream.close(code, reason, discard=discard)


class TunnelRefused(Exception):
    """A tunnel the relay will not register: the error frame the host is sent and the close code."""

    def __init__(self, detail: str, *, code: int, **frame: Any) -> None:
        super().__init__(detail)
        self.detail = detail
        self.code = code
        self.frame = frame


@dataclass
class PendingHttp:
    headers_ready: asyncio.Event = field(default_factory=asyncio.Event)
    queue: asyncio.Queue[bytes | None] = field(default_factory=asyncio.Queue)
    status: int = 502
    headers: dict[str, str] = field(default_factory=dict)


@dataclass
class TunnelSession:
    host_id: str
    websocket: WebSocket
    host_token: str = ""
    # Set when the tunnel authenticated with a lease; its claim key then signs share claims.
    install_id: str = ""
    # Set only on a relay that signs leases; None means no caps and no first-visit notice.
    meter: SessionMeter | None = None
    # Shares the last register asked for beyond the cap, and the limit last told to the host.
    refused_shares: int = 0
    limit_kind: str = ""
    share_tokens: set[str] = field(default_factory=set)
    capabilities: dict[str, list[str]] = field(default_factory=dict)
    pending: dict[str, PendingHttp] = field(default_factory=dict)
    ws_streams: dict[str, GuestWsStream] = field(default_factory=dict)
    ws_stream_tokens: dict[str, str] = field(default_factory=dict)
    # Guest/HTTP → host frames. A dedicated pump task drains this so guest
    # handlers never await tunnel send_json directly (avoids TestClient nested
    # WebSocket deadlocks and keeps the tunnel receive loop responsive).
    to_host: WsFrameQueue[dict[str, Any]] = field(
        default_factory=lambda: WsFrameQueue(
            lambda frame: len(json.dumps(frame).encode("utf-8")),
            max_bytes=2 * relay_ws_max_size(),
        )
    )
    writer: SerializedWsWriter[dict[str, Any]] = field(init=False, repr=False)
    connected_at: float = field(default_factory=time.time)

    def __post_init__(self) -> None:
        async def write(payload: dict[str, Any]) -> None:
            await self.websocket.send_json(payload)

        async def close(code: int, reason: str) -> None:
            await self.websocket.close(code=code, reason=reason)

        self.writer = SerializedWsWriter(write, close)

    async def enqueue_to_host(self, payload: dict[str, Any]) -> None:
        try:
            self.to_host.put_nowait(payload)
        except asyncio.QueueFull:
            await self.writer.close(1013, "tunnel backlog full")
            raise

    async def send(self, payload: dict[str, Any]) -> None:
        await self.writer.send(payload)


class RelayState:
    def __init__(
        self,
        host_tokens: set[str],
        *,
        allow_open_tunnel: bool = False,
        host_secrets: dict[str, str] | None = None,
        policy: RelayPolicy | None = None,
        meter: RelayMeter | None = None,
    ) -> None:
        self.policy = policy
        self.meter = meter
        self.host_tokens = host_tokens
        self.host_secrets = dict(host_secrets or {})
        self.allow_open_tunnel = allow_open_tunnel
        self._lock = asyncio.Lock()
        self.tunnels: dict[str, TunnelSession] = {}
        # Live routing only (cleared on unregister).
        self.token_to_host: dict[str, str] = {}
        # Durable ownership across disconnect (cleared when owner omits token).
        self.token_bindings: dict[str, str] = {}

    def token_ok(self, token: str, *, host_id: str) -> bool:
        """True if *token* authenticates a tunnel presenting *host_id*.

        Shared secrets authenticate any host_id; a ``host_id:secret`` entry
        authenticates only the host presenting that exact host_id.
        """
        if not token:
            return False
        if not self.host_tokens and not self.host_secrets:
            return self.allow_open_tunnel
        from podcast_mcp.util.relay_protocol.share_claims import resolve_tunnel_secret

        return (
            resolve_tunnel_secret(
                token,
                shared_secrets=self.host_tokens,
                host_secrets=self.host_secrets,
                host_id=host_id,
            )
            is not None
        )

    def secret_for_session(self, session: TunnelSession) -> str | None:
        from podcast_mcp.util.relay_protocol.share_claims import resolve_tunnel_secret

        if session.install_id and self.policy is not None:
            return self.policy.claim_key(session.install_id)
        if self.allow_open_tunnel and not self.host_tokens and not self.host_secrets:
            # Dev open tunnel: sign/verify with the presented token (may be empty → skip claims).
            return session.host_token or "open-tunnel-dev"
        return resolve_tunnel_secret(
            session.host_token,
            shared_secrets=self.host_tokens,
            host_secrets=self.host_secrets,
            host_id=session.host_id,
        )

    @staticmethod
    def limit_kind(session: TunnelSession) -> str:
        """Why this host is limited now: ``shares``, ``bandwidth`` or empty."""
        if session.refused_shares:
            return "shares"
        if session.meter is not None and session.meter.exhausted():
            return "bandwidth"
        return ""

    @staticmethod
    def unverified(session: TunnelSession) -> bool:
        """True for a host the relay cannot vouch for: a legacy host token on a signing relay."""
        return session.meter is not None and session.meter.tier is Tier.LEGACY

    async def notify_limit(self, session: TunnelSession) -> None:
        """Tell the host once each time its limit changes, so its status can say so."""
        kind = self.limit_kind(session)
        if kind == session.limit_kind:
            return
        session.limit_kind = kind
        with contextlib.suppress(Exception):
            await session.enqueue_to_host(msg("limit", kind=kind))

    def legacy_tunnels_full(self, session: TunnelSession) -> bool:
        """True when *session* would be a legacy tunnel past its host token's concurrent limit."""
        meter = session.meter
        if meter is None or meter.tier is not Tier.LEGACY or not meter.max_tunnels:
            return False
        others = sum(
            1
            for live in self.tunnels.values()
            if live.host_id != session.host_id and live.meter and live.meter.group == meter.group
        )
        return others >= meter.max_tunnels

    async def close_denied(self, install_ids: frozenset[str]) -> None:
        """Close the live tunnel of every denied install; the tunnel route then tears it down."""
        for session in list(self.tunnels.values()):
            if session.host_id in install_ids:
                with contextlib.suppress(Exception):
                    await session.writer.close(4403, "install denied")

    async def register_tunnel(self, session: TunnelSession) -> None:
        async with self._lock:
            # Checked under the lock, after the deny list may have reloaded since the hello.
            if self.policy is not None and session.host_id in self.policy.deny:
                raise TunnelRefused(f"lease_refused:{LeaseRefusal.DENIED.value}", code=4403)
            if self.legacy_tunnels_full(session):
                raise TunnelRefused(
                    "rate limit exceeded: too many tunnels for this host token",
                    code=4429,
                    bucket="legacy_tunnels",
                    retry_after_sec=30,
                )
            old = self.tunnels.get(session.host_id)
            if old is not None:
                for t in list(old.share_tokens):
                    if self.token_to_host.get(t) == session.host_id:
                        self.token_to_host.pop(t, None)
            self.tunnels[session.host_id] = session
            for t in session.share_tokens:
                self.token_to_host[t] = session.host_id
            if old is not None and old is not session:
                for stream_id, stream in list(old.ws_streams.items()):
                    close_relay_guest_stream(
                        stream,
                        "relay.host_tunnel_replaced",
                        1013,
                        "host tunnel replaced",
                        share_token=old.ws_stream_tokens.get(stream_id, ""),
                        stream_id=stream_id,
                        discard=True,
                    )
                old.ws_streams.clear()
                old.ws_stream_tokens.clear()
                old.to_host.close(discard=True)
        if old is not None and old is not session:
            with contextlib.suppress(Exception):
                await old.writer.close(1013, "host tunnel replaced")

    async def unregister_tunnel(
        self, host_id: str, *, expected_session: TunnelSession | None = None
    ) -> None:
        async with self._lock:
            session = self.tunnels.get(host_id)
            if session is None or (
                expected_session is not None and session is not expected_session
            ):
                return
            self.tunnels.pop(host_id)
            for t in list(session.share_tokens):
                if self.token_to_host.get(t) == host_id:
                    self.token_to_host.pop(t, None)
            # Keep token_bindings so another host cannot steal after disconnect.
            for stream_id, stream in list(session.ws_streams.items()):
                close_relay_guest_stream(
                    stream,
                    "relay.host_offline",
                    1013,
                    "host offline",
                    share_token=session.ws_stream_tokens.get(stream_id, ""),
                    stream_id=stream_id,
                    discard=True,
                )
            session.ws_streams.clear()
            session.ws_stream_tokens.clear()
            session.to_host.close(discard=True)

    async def update_shares(
        self,
        host_id: str,
        shares: list[dict[str, Any]],
        *,
        expected_session: TunnelSession | None = None,
    ) -> None:
        from podcast_mcp.util.relay_protocol.share_claims import verify_share_claim

        async with self._lock:
            session = self.tunnels.get(host_id)
            if session is None or (
                expected_session is not None and session is not expected_session
            ):
                return
            secret = self.secret_for_session(session)
            open_dev = self.allow_open_tunnel and not self.host_tokens and not self.host_secrets
            # Clear live routing for this host's previous advertisement.
            for t in list(session.share_tokens):
                if self.token_to_host.get(t) == host_id:
                    self.token_to_host.pop(t, None)
            previous = set(session.share_tokens)
            session.share_tokens.clear()
            session.capabilities.clear()
            accepted: set[str] = set()
            cap = session.meter.max_shares if session.meter is not None else 0
            session.refused_shares = 0
            # Shares already live keep their place, so a new one is what the cap turns away.
            ordered = sorted(
                (row for row in shares if isinstance(row, dict)),
                key=lambda row: str(row.get("token") or "") not in previous,
            )
            for row in ordered:
                token = str(row.get("token") or "")
                if not token:
                    continue
                caps = [str(c) for c in (row.get("capabilities") or [])]
                claim = str(row.get("claim") or "")
                claim_host = str(row.get("host_id") or host_id)
                if claim_host != host_id:
                    continue
                if not open_dev and (
                    secret is None
                    or not verify_share_claim(
                        secret,
                        host_id=host_id,
                        token=token,
                        capabilities=caps,
                        claim=claim,
                    )
                ):
                    continue
                bound = self.token_bindings.get(token)
                if bound is not None and bound != host_id:
                    continue
                live = self.token_to_host.get(token)
                if live is not None and live != host_id:
                    continue
                if cap and len(accepted) >= cap:
                    session.refused_shares += 1
                    continue
                session.share_tokens.add(token)
                session.capabilities[token] = caps
                self.token_to_host[token] = host_id
                self.token_bindings[token] = host_id
                accepted.add(token)
            # Owner omitted a previously advertised token → release binding.
            for t in previous - accepted:
                if self.token_bindings.get(t) == host_id:
                    self.token_bindings.pop(t, None)

    def tunnel_for_token(self, token: str) -> TunnelSession | None:
        host_id = self.token_to_host.get(token)
        if not host_id:
            return None
        return self.tunnels.get(host_id)
