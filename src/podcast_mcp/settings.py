"""The one place that reads process environment variables.

Every ``PODCAST_*`` (and the few system) variables the package honours is declared once in
``VARIABLES`` with its group, default and what it does; ``docs/setup.md`` lists them from the
same table (``python -m podcast_mcp.settings --markdown``). Reads are live, not snapshotted:
a variable set after import (a test, ``studio_host`` handing its environment to a child, the
off-loopback bind exporting a session token) takes effect on the next call. Asking for a name
that is not declared raises, so a new variable cannot ship undocumented.

Nothing else under ``src/podcast_mcp`` may touch ``os.environ``; ``tests/test_settings.py``
asserts it. The ``environ`` parameters some loaders accept stay: they let a caller pass its own
mapping, and default to :func:`environ`.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass

ON_VALUES = frozenset({"1", "true", "yes", "on"})
_RELAY_DEFAULT_BIND = "0.0.0.0"  # nosec B104


@dataclass(frozen=True)
class Variable:
    name: str
    group: str
    doc: str
    default: str = ""


def _group(group: str, *rows: tuple[str, str] | tuple[str, str, str]) -> tuple[Variable, ...]:
    return tuple(Variable(r[0], group, r[1], r[2] if len(r) > 2 else "") for r in rows)


_RATE_FAMILIES: tuple[tuple[str, str, str, str], ...] = (
    ("PODCAST_RATE_LIMIT_READ", "host read requests", "300", "60"),
    ("PODCAST_RATE_LIMIT_MUTATE", "host mutating requests", "60", "20"),
    ("PODCAST_GUEST_WS_PRESENCE", "guest presence websocket messages", "900", "60"),
    ("PODCAST_GUEST_WS_PRESENCE_TOKEN", "guest presence messages per share token", "3600", "200"),
    ("PODCAST_WS_ROSTER_REQUEST", "roster requests", "60", "1"),
    ("PODCAST_GUEST_WS_RECORD", "recording websocket messages", "600", "10"),
    ("PODCAST_GUEST_WS_RECORD_TOKEN", "recording messages per share token", "3000", "50"),
    ("PODCAST_GUEST_WS_RECORD_SIGNAL", "recording signal messages", "1800", "80"),
    ("PODCAST_GUEST_WS_RECORD_SIGNAL_TOKEN", "recording signals per share token", "6000", "200"),
)

_RELAY_RATE_FAMILIES: tuple[tuple[str, str, str, str], ...] = (
    ("PODCAST_RELAY_TOKEN", "relay requests per share token", "600", "80"),
    ("PODCAST_RELAY_IP", "relay requests per client address", "1200", "120"),
    ("PODCAST_RELAY_WS_MSG", "relay websocket messages", "120", "30"),
    ("PODCAST_RELAY_WS_PRESENCE", "relay presence messages", "900", "60"),
    ("PODCAST_RELAY_REGISTER", "relay tunnel registrations", "60", "20"),
)

_RATE_ROWS: tuple[Variable, ...] = tuple(
    row
    for prefix, what, rpm, burst in (*_RATE_FAMILIES, *_RELAY_RATE_FAMILIES)
    for row in (
        Variable(f"{prefix}_RPM", "limits", f"Requests per minute allowed for {what}.", rpm),
        Variable(f"{prefix}_BURST", "limits", f"Burst allowance for {what}.", burst),
    )
)

VARIABLES: tuple[Variable, ...] = (
    *_group(
        "Paths and caches",
        (
            "PODCAST_MCP_CACHE",
            "Base for downloaded models, FFmpeg and caches.",
            "~/.cache/podcast_mcp",
        ),
        ("PODCAST_CONFIG_DIR", "Directory for the OAuth client files.", "~/.config/podcast_mcp"),
        ("PODCAST_MCP_PROJECT", "Project path the MCP tools use when none is passed."),
        ("PODCAST_MCP_PIPELINE_DEFAULTS", "Pipeline defaults YAML replacing the shipped one."),
        (
            "PODCAST_SHARE_REGISTRY",
            "Share registry database file.",
            "~/.podcast_mcp/share_registry.sqlite",
        ),
        (
            "PODCAST_SHARE_IDENTITY",
            "Share identity database file.",
            "~/.podcast_mcp/share_identity.sqlite",
        ),
        (
            "PODCAST_E2E_PROJECT",
            "Project the end-to-end fixture serves instead of the built-in one.",
        ),
        (
            "PODCAST_EXTENSIONS",
            "Comma-separated extension allowlist; set and blank loads none, unset loads all.",
        ),
        ("LOCALAPPDATA", "Windows per-user data root (sidecar log lookup)."),
        ("XDG_STATE_HOME", "XDG state root (sidecar log lookup)."),
        ("PATH", "Executable search path (FFmpeg lookup)."),
    ),
    *_group(
        "Models and engines",
        (
            "PODCAST_WHISPER_MODEL",
            "Whisper model name; overrides preferences and the pipeline default.",
        ),
        (
            "PODCAST_ACCELERATOR",
            "auto or cpu (support override). Speech-to-text uses an NVIDIA GPU that CTranslate2 and the CUDA libraries can use and that has enough memory, unless this is cpu; other steps do not use a GPU yet.",
            "auto",
        ),
        ("PODCAST_MCP_WORD_ALIGNER_MODEL", "Local word-aligner snapshot directory."),
        ("PODCAST_MCP_RNNOISE_MODEL", "RNNoise model file."),
        ("PODCAST_MCP_SPEAKER_ECAPA_MODEL", "Speaker-recognition ONNX model file."),
        (
            "PODCAST_MCP_FFMPEG",
            "Explicit ffmpeg executable (set together with PODCAST_MCP_FFPROBE).",
        ),
        ("PODCAST_MCP_FFPROBE", "Explicit ffprobe executable."),
        ("PODCAST_MCP_FFMPEG_BUNDLE", "Directory holding the desktop app's bundled FFmpeg pair."),
        ("PODCAST_BOOTSTRAP_CDN_BASE", "Public HTTPS mirror base for bootstrap assets."),
        ("WHISPER_CPP_BIN", "whisper-cli executable."),
        ("WHISPER_CPP_MODEL", "whisper.cpp model file."),
        ("WHISPER_CPP_MODEL_NAME", "whisper.cpp model name inside its cache.", "ggml-base.en.bin"),
    ),
    *_group(
        "Behavior flags",
        ("PODCAST_BATCH", "Treat the run as unattended (1, true, yes)."),
        ("PODCAST_DEBUG", "Show the original traceback for CLI errors (1, true, yes, on)."),
        ("PODCAST_PROGRESS", "Progress output; 0, false or no turns it off.", "1"),
        ("PODCAST_PROGRESS_COMPLIANCE", "Progress compliance checks (diagnostics only)."),
        (
            "PODCAST_SPEAKER_BACKEND",
            "Set to mock to opt in to the development speaker mock (tests, development).",
        ),
        (
            "PODCAST_NO_STUDIO_HANDOFF",
            "Run CLI commands directly instead of through the Studio serving the project.",
        ),
        ("PODCAST_PACKAGED_CLI", "Set to 1 by the installed app's CLI shim."),
        ("PODCAST_GUEST_RENDER", "Allow guest render previews (1, true, yes, on)."),
        ("PODCAST_SHARE_ACCOUNTS", "Enable restricted shares with sign-in (1, true, yes, on)."),
        (
            "PODCAST_VERDICT_CACHE",
            "Reuse the apply-time check of a cut whose neighbourhood was already checked (1, true, yes, on).",
        ),
        (
            "PODCAST_VERDICT_VERIFY",
            "On every verdict cache hit, run the full check too and fail if it differs (tests, lab).",
        ),
        (
            "PODCAST_EVIDENCE_VERIFY",
            "On every cache hit, rebuild the track evidence and fail if it differs from the cached copy (tests, lab).",
        ),
    ),
    *_group(
        "Studio server",
        ("PODCAST_GUI_DIST", "Built web UI directory (frozen sidecars point it at web-dist)."),
        ("PODCAST_GUI_OPENAPI", "Serve OpenAPI/Swagger; 0, false or no turns it off.", "1"),
        ("PODCAST_REVIEW_CORS_ORIGINS", "Extra exact CORS origins, comma-separated."),
        (
            "PODCAST_SESSION_AUTHZ",
            "Session authorization mode; 1, true or strict enforces the token.",
        ),
        (
            "PODCAST_SESSION_TOKEN",
            "Session token for remote clients (generated off-loopback when unset).",
        ),
        ("PODCAST_SIDECAR_BOOT_TOKEN", "Boot token the desktop host requires on health checks."),
        ("PODCAST_SIDECAR_EPHEMERAL", "Bind an ephemeral port (1, true, yes, on)."),
        ("PODCAST_SIDECAR_LISTEN_FILE", "File the bound port is written to."),
        ("PODCAST_PUBLIC_ORIGIN", "Public origin used for OAuth redirect URIs."),
        ("PODCAST_AUTH_COOKIE_SECURE", "Mark the sign-in cookie Secure (1, true, yes)."),
        ("PODCAST_MAGIC_LINK_PRINT", "Print magic sign-in links to the log; 1 prints.", "1"),
        ("PODCAST_WEBAUTHN_RP_ID", "Passkey relying-party id.", "localhost"),
        ("PODCAST_WEBAUTHN_TEST_MODE", "Skip WebAuthn signature checks; 1 skips them.", "1"),
        ("PODCAST_GOOGLE_OAUTH_CLIENT_ID", "Google OAuth client id."),
        ("PODCAST_GOOGLE_OAUTH_CLIENT_SECRET", "Google OAuth client secret."),
        ("PODCAST_GOOGLE_OAUTH_CLIENT_FILE", "Google OAuth client JSON file."),
        ("PODCAST_GOOGLE_OAUTH_REDIRECT_URI", "Google OAuth redirect URI."),
        ("PODCAST_GITHUB_OAUTH_CLIENT_ID", "GitHub OAuth client id."),
        ("PODCAST_GITHUB_OAUTH_CLIENT_SECRET", "GitHub OAuth client secret."),
        ("PODCAST_GITHUB_OAUTH_CLIENT_FILE", "GitHub OAuth client JSON file."),
        ("PODCAST_GITHUB_OAUTH_REDIRECT_URI", "GitHub OAuth redirect URI."),
    ),
    *_group(
        "Relay and object store",
        ("PODCAST_RELAY_CONFIG", "relay.yaml path.", "~/.config/podcast_mcp/relay.yaml"),
        ("PODCAST_RELAY_URL", "Relay tunnel URL."),
        ("PODCAST_RELAY_HOST_TOKEN", "Relay host token."),
        ("PODCAST_RELAY_HOST_ID", "Relay host id (persisted next to relay.yaml when unset)."),
        ("PODCAST_RELAY_PUBLIC_BASE_URL", "Public base URL guests open."),
        ("PODCAST_RELAY_LOCAL_GUI_URL", "Local Studio URL the tunnel forwards to."),
        ("PODCAST_REPORT_RELAY_URL", "Relay origin that accepts diagnostics reports."),
        ("PODCAST_OBJECT_STORE_ENDPOINT_URL", "Object store endpoint."),
        ("PODCAST_OBJECT_STORE_REGION", "Object store region."),
        ("PODCAST_OBJECT_STORE_BUCKET", "Object store bucket."),
        ("PODCAST_OBJECT_STORE_ACCESS_KEY_ID", "Object store access key id."),
        ("PODCAST_OBJECT_STORE_SECRET_ACCESS_KEY", "Object store secret key."),
        ("PODCAST_OBJECT_STORE_CDN_ENDPOINT", "Optional CDN endpoint for object-store media."),
        (
            "PODCAST_OBJECT_STORE_ADMIN_ACCESS_KEY_ID",
            "Admin key id for `podcast relay bucket-setup`.",
        ),
        (
            "PODCAST_OBJECT_STORE_ADMIN_SECRET_ACCESS_KEY",
            "Admin secret for `podcast relay bucket-setup`.",
        ),
        ("PODCAST_RELAY_HOST_TOKENS", "Relay-side map of host_id:secret entries (relay process)."),
        ("PODCAST_RELAY_RATE_LIMIT", "Relay-side rate limiting; 0 disables (relay process)."),
        (
            "PODCAST_RELAY_ALLOW_OPEN_TUNNEL",
            "Let the relay start with no host tokens, local/dev only (1, true, yes, on).",
        ),
        ("PODCAST_RELAY_HOST", "Interface the relay binds.", _RELAY_DEFAULT_BIND),
        ("PODCAST_RELAY_PORT", "Port the relay binds.", "8081"),
        (
            "PODCAST_RELAY_FORWARDED_ALLOW_IPS",
            "Proxy addresses whose forwarded headers the relay trusts.",
            "127.0.0.1",
        ),
        ("PODCAST_RELAY_VERSION", "Relay version baked into the Docker image."),
        ("PODCAST_RELAY_GIT_SHA", "Relay build commit baked into the Docker image."),
        (
            "PODCAST_REPORT_STORE",
            "Writable directory where the relay keeps submitted diagnostics reports.",
        ),
        (
            "PODCAST_REPORT_PUBLIC_BASE_URL",
            "The relay's public HTTPS origin, used in report links.",
        ),
        ("PODCAST_REPORT_GITHUB_TOKEN", "Server-only token that files report issues."),
    ),
    *_group(
        "Distribution metadata",
        ("PODCAST_DISTRIBUTION_SUPPORT_URL", "Support link injected by the desktop host."),
        ("PODCAST_DISTRIBUTION_PRIVACY_URL", "Privacy link injected by the desktop host."),
        ("PODCAST_DISTRIBUTION_REPOSITORY_URL", "Repository link injected by the desktop host."),
        (
            "PODCAST_DISTRIBUTION_RELEASE_MANIFEST_URL",
            "Release manifest URL injected by the desktop host.",
        ),
    ),
    *_group(
        "Limits",
        ("PODCAST_RATE_LIMIT", "Host rate limiting; 0, false, no or off disables.", "1"),
        ("PODCAST_RATE_LIMIT_AUDIO_CONCURRENT", "In-flight audio requests allowed.", "8"),
        ("PODCAST_GUEST_WS_CONCURRENT", "Concurrent guest websockets per share token.", "8"),
        ("PODCAST_RELAY_TOKEN_CONCURRENT", "Relay in-flight requests per share token.", "24"),
        ("PODCAST_RELAY_HOST_CONCURRENT", "Relay in-flight requests per host.", "96"),
        ("PODCAST_RELAY_AUDIO_CONCURRENT", "Relay in-flight audio requests.", "8"),
        ("PODCAST_RELAY_WS_CONCURRENT", "Relay concurrent websockets per share token.", "8"),
        ("PODCAST_GUI_MAX_BODY_BYTES", "Largest Studio request body."),
        ("PODCAST_GUI_MEDIA_MAX_BYTES", "Largest media upload."),
        ("PODCAST_GUI_MEDIA_CHUNK_MAX_BYTES", "Largest media upload chunk."),
        ("PODCAST_REMOTE_MCP_MAX_BODY_BYTES", "Largest remote MCP request body."),
        ("PODCAST_RECORD_UPLOAD_MAX_PART_BYTES", "Largest recording upload part."),
        ("PODCAST_RELAY_MAX_BODY_BYTES", "Largest relayed request body."),
        ("PODCAST_RELAY_WS_MAX_SIZE", "Largest relayed websocket frame."),
    ),
    *_RATE_ROWS,
)

_BY_NAME: dict[str, Variable] = {v.name: v for v in VARIABLES}
if len(_BY_NAME) != len(VARIABLES):  # pragma: no cover - guards the table at import
    raise RuntimeError("duplicate variable in podcast_mcp.settings.VARIABLES")


def _declared(name: str) -> str:
    if name not in _BY_NAME:
        raise KeyError(f"{name} is not declared in podcast_mcp.settings.VARIABLES")
    return name


def environ() -> Mapping[str, str]:
    """The live process environment, for callers that take a whole mapping."""
    return os.environ


def read(name: str) -> str | None:
    """Like :func:`raw` for names a limiter table builds from its prefix.

    Only the shared limiter helpers use it, since a table row supplies the name as data;
    ``tests/test_settings.py`` checks that every row of the host and relay tables is declared.
    """
    return os.environ.get(name)


def raw(name: str) -> str | None:
    """The unmodified value, or None when unset."""
    return os.environ.get(_declared(name))


def text(name: str, default: str = "") -> str:
    """The value stripped of surrounding whitespace; ``default`` when unset."""
    value = os.environ.get(_declared(name))
    return default if value is None else value.strip()


def value(name: str, default: str = "") -> str:
    """The unmodified value; ``default`` only when unset (a blank value stays blank)."""
    found = os.environ.get(_declared(name))
    return default if found is None else found


def is_set(name: str) -> bool:
    return _declared(name) in os.environ


def flag(name: str, *, default: bool = False, on: frozenset[str] = ON_VALUES) -> bool:
    """True when the stripped, lower-cased value is in ``on``; ``default`` when unset or blank."""
    value = text(name)
    if not value:
        return default
    return value.lower() in on


def number(name: str, default: float) -> float:
    """A float; ``default`` when unset, blank or not a number."""
    value = read(name)
    if value is None or not value.strip():
        return float(default)
    try:
        return float(value)
    except ValueError:
        return float(default)


def max_bytes(name: str, default: int) -> int:
    """A positive byte count; ``default`` when unset, blank or not an integer."""
    value = read(name)
    if value is None or not value.strip():
        return int(default)
    try:
        return max(1, int(value))
    except ValueError:
        return int(default)


def export(name: str, value: str) -> None:
    """Set a variable for this process and the children it spawns."""
    os.environ[_declared(name)] = value


def markdown_table() -> str:
    """The setup-doc table of every declared variable, grouped."""
    lines: list[str] = []
    groups = dict.fromkeys(v.group for v in VARIABLES)
    for group in groups:
        lines += [f"**{group}**", "", "| Variable | Default | Meaning |", "| --- | --- | --- |"]
        for v in VARIABLES:
            if v.group == group:
                default = f"`{v.default}`" if v.default else ""
                lines.append(f"| `{v.name}` | {default} | {v.doc} |")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


if __name__ == "__main__":
    sys.stdout.write(markdown_table())
