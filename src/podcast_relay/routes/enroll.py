"""Enrollment: ``POST /api/relay/enroll`` mints a lease, ``POST /api/relay/enroll/renew`` swaps a live one for a fresh one.

Mounted only when the relay has a signing key, so a relay without one answers 404 and a host
falls back to its host token.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from podcast_mcp.util.rate_limit import RateLimitDecision, rate_limit_detail
from podcast_mcp.util.relay_protocol.enroll import (
    ENROLL_PATH,
    RENEW_PATH,
    SEED_RE,
    EnrollGrant,
    EnrollProof,
    pow_is_valid,
)
from podcast_mcp.util.relay_protocol.lease import LeaseError, LeaseRefusal
from podcast_relay import policy as policy_module
from podcast_relay.limits import check_enroll, check_renew
from podcast_relay.policy import RelayPolicy

MAX_BODY_BYTES = 4096


class _Proof(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ts: int
    nonce: str = Field(min_length=1, max_length=32)


class EnrollBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    seed: str = Field(pattern=SEED_RE.pattern)
    platform: str = Field(min_length=1, max_length=32)
    build: str = Field(min_length=1, max_length=32)
    proof: _Proof
    # A lease this relay signed earlier: the install keeps its id when it must enroll again.
    previous: str | None = Field(default=None, min_length=1, max_length=2048)


class RenewBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lease: str = Field(min_length=1, max_length=2048)
    # The build now running, so an updated app moves its lease past a raised min_build.
    build: str | None = Field(default=None, min_length=1, max_length=32)


async def _read_json(request: Request) -> Any:
    """The request body as JSON, refusing a body past ``MAX_BODY_BYTES`` before it is all read."""
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_BODY_BYTES:
            raise ValueError("body too large")
        chunks.append(chunk)
    return json.loads(b"".join(chunks))


def _refuse(status: int, detail: str, **extra: Any) -> JSONResponse:
    return JSONResponse({"detail": detail, **extra}, status_code=status)


def _rate_limited(decision: RateLimitDecision) -> JSONResponse:
    return JSONResponse(
        rate_limit_detail(decision),
        status_code=429,
        headers={"Retry-After": decision.retry_after_header},
    )


def _grant_body(grant: EnrollGrant) -> dict[str, Any]:
    return {
        "now": grant.server_time,
        "install_id": grant.install_id,
        "lease": grant.lease,
        "claim_key": grant.claim_key,
        "exp": grant.exp,
        "renew_at": grant.renew_at,
    }


def build_enroll_router(policy: RelayPolicy) -> APIRouter:
    router = APIRouter()

    @router.get(ENROLL_PATH)
    def enroll_info() -> dict[str, Any]:
        return {
            "enroll": True,
            "pow_bits": policy.pow_bits,
            "epoch": policy.epoch,
            "now": policy.now(),
        }

    @router.post(ENROLL_PATH)
    async def enroll(request: Request) -> JSONResponse:
        try:
            body = EnrollBody.model_validate(await _read_json(request))
        except (ValidationError, ValueError):
            return _refuse(400, "invalid_enrollment")
        proof = EnrollProof(body.proof.ts, body.proof.nonce)
        valid = pow_is_valid(body.seed, proof, bits=policy.pow_bits, now=policy.now())
        if not valid or policy.seed_spent(body.seed):
            return _refuse(400, "proof_invalid", pow_bits=policy.pow_bits)
        if not policy.build_allowed(body.build):
            return _refuse(426, "build_too_old")
        decision = check_enroll(request.client.host if request.client else None)
        if not decision.allowed:
            return _rate_limited(decision)
        install_id = policy.previous_install(body.previous) if body.previous else None
        if install_id is not None and install_id in policy.deny:
            return _refuse(403, "install_denied")
        policy.spend_seed(body.seed)
        grant = policy.issue(
            install_id or policy_module.new_install_id(), platform=body.platform, build=body.build
        )
        return JSONResponse(_grant_body(grant))

    @router.post(RENEW_PATH)
    async def renew(request: Request) -> JSONResponse:
        try:
            body = RenewBody.model_validate(await _read_json(request))
            lease = policy.check(body.lease, enforce_build=False, renewing=True)
        except (ValidationError, ValueError) as exc:
            refusal = exc.refusal if isinstance(exc, LeaseError) else LeaseRefusal.MALFORMED
            return _refuse(401, f"lease_refused:{refusal.value}")
        build = body.build or lease.build
        if not policy.build_allowed(build):
            return _refuse(426, "build_too_old")
        decision = check_renew(lease.install_id)
        if not decision.allowed:
            return _rate_limited(decision)
        grant = policy.issue(lease.install_id, platform=lease.platform, build=build)
        return JSONResponse(_grant_body(grant))

    return router


__all__ = ["EnrollBody", "RenewBody", "build_enroll_router"]
