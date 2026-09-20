"""Server-rendered share SPA head: episode title + Open Graph audio for link previews."""

from __future__ import annotations

import html
import logging
import re
from typing import Any

from podcast_mcp.edits.review_versions import get_version
from podcast_mcp.edits.share_capabilities import CAP_PLAY, has_capability
from podcast_mcp.runtime_config import load_relay_config

log = logging.getLogger(__name__)

_TITLE_RE = re.compile(r"<title>[^<]*</title>", re.IGNORECASE)
_HEAD_OPEN_RE = re.compile(r"<head[^>]*>", re.IGNORECASE)


def share_public_origin(request_base: str | None = None) -> str:
    """Prefer relay ``public_base_url`` so og:url/audio are crawlable on the public origin."""
    try:
        origin = (load_relay_config().public_base_url or "").strip().rstrip("/")
        if origin:
            return origin
    except Exception:
        log.debug("Could not load relay public_base_url", exc_info=True)
    if request_base:
        return str(request_base).rstrip("/")
    return "http://127.0.0.1:8765"


def _meta_property(prop: str, content: str) -> str:
    return (
        f'<meta property="{html.escape(prop, quote=True)}" '
        f'content="{html.escape(content, quote=True)}" />'
    )


def _meta_name(name: str, content: str) -> str:
    return (
        f'<meta name="{html.escape(name, quote=True)}" '
        f'content="{html.escape(content, quote=True)}" />'
    )


def build_share_head_tags(
    *,
    title: str,
    description: str,
    page_url: str,
    audio_url: str | None = None,
    audio_type: str = "audio/mpeg",
    image_url: str | None = None,
) -> str:
    """Return ``<title>`` + Open Graph / Twitter tags for a review share document."""
    safe_title = title.strip() or "Podcast review"
    parts = [
        f"<title>{html.escape(safe_title)}</title>",
        _meta_name("description", description),
        _meta_property("og:title", safe_title),
        _meta_property("og:description", description),
        _meta_property("og:url", page_url),
        _meta_property("og:type", "music.song" if audio_url else "website"),
        _meta_name("twitter:title", safe_title),
        _meta_name("twitter:description", description),
    ]
    if image_url:
        parts.append(_meta_property("og:image", image_url))
        parts.append(_meta_name("twitter:image", image_url))
    if audio_url:
        parts.extend(
            [
                _meta_property("og:audio", audio_url),
                _meta_property("og:audio:secure_url", audio_url),
                _meta_property("og:audio:type", audio_type),
                _meta_name("twitter:card", "player"),
                _meta_name("twitter:player", page_url),
                _meta_name("twitter:player:stream", audio_url),
                _meta_name(
                    "twitter:player:stream:content_type",
                    audio_type,
                ),
            ]
        )
    else:
        parts.append(_meta_name("twitter:card", "summary"))
    return "\n    ".join(parts)


def inject_share_document_head(index_html: str, head_inner: str) -> str:
    """Replace ``<title>…</title>`` and insert remaining tags before ``</head>``.

    Injects ``<base href="/">`` immediately after ``<head>`` so Vite's relative
    ``./assets/…`` URLs resolve from the origin root when the SPA is served under
    ``/r/{token}``. The base must precede script/link tags or the browser still
    fetches ``/r/assets/…`` at parse time.
    """
    # Drop the placeholder Vite title; head_inner already includes <title>.
    without_title = _TITLE_RE.sub("", index_html, count=1)
    base = '<base href="/" />'
    needs_base = 'href="/"' not in without_title and "href='/'" not in without_title
    head_open = _HEAD_OPEN_RE.search(without_title)
    if needs_base and head_open is not None:
        insert_at = head_open.end()
        without_title = without_title[:insert_at] + "\n    " + base + without_title[insert_at:]
    elif needs_base:
        head_inner = base + "\n    " + head_inner
    marker = "</head>"
    lower = without_title.lower()
    idx = lower.rfind(marker)
    if idx < 0:
        return without_title + "\n" + head_inner
    return without_title[:idx] + "    " + head_inner + "\n  " + without_title[idx:]


def share_audio_url_for_preview(
    token: str,
    *,
    public_origin: str,
    row: dict[str, Any],
    project: Any,
) -> str | None:
    """HTTPS audio URL for crawlers (object storage when uploaded, else public share API)."""
    if not has_capability(row.get("capabilities"), CAP_PLAY):
        return None
    origin = public_origin.rstrip("/")
    api_url = f"{origin}/api/review/{token}/audio"
    vid = str(row.get("review_version_id") or "")
    if not vid:
        return api_url
    try:
        from podcast_mcp.services.review_media import presigned_review_audio_url

        signed = presigned_review_audio_url(
            project,
            vid,
            expires_at=row.get("expires_at"),
        )
        if signed and signed.startswith("https://"):
            return signed
    except Exception:
        log.debug("Share preview audio URL fallback to API", exc_info=True)
    return api_url


def render_share_spa_html(
    token: str,
    *,
    index_html: str,
    public_origin: str,
) -> str:
    """Inject episode title + OG/Twitter meta into the built SPA shell."""
    title = "Podcast review"
    description = "Shared podcast review"
    page_url = f"{public_origin.rstrip('/')}/r/{token}"
    audio_url: str | None = None
    audio_type = "audio/mpeg"
    image_url: str | None = None

    try:
        from podcast_mcp.services.share import open_share_workspace
        from podcast_mcp.services.share_auth.access import access_required

        row, ws = open_share_workspace(token)
        if access_required(row):
            # Restricted leftovers: never embed object storage/presigned URLs in OG HTML.
            audio_url = None
            description = "Shared podcast review"
            title = "Podcast review"
        else:
            name = (ws.project.meta.name or "").strip()
            if name:
                title = name
            try:
                ver = get_version(ws.project, str(row["review_version_id"]))
                label = (ver.label or "").strip()
                description = f"Review mix: {label}" if label else f"Review of {title}"
            except Exception:
                description = f"Review of {title}"
            audio_url = share_audio_url_for_preview(
                token,
                public_origin=public_origin,
                row=row,
                project=ws.project,
            )
        if audio_url:
            try:
                from podcast_mcp.services.review_media import (
                    media_type_for_path,
                    review_guest_audio_path,
                )

                audio_type = media_type_for_path(
                    review_guest_audio_path(ws.project, str(row["review_version_id"]))
                )
            except Exception:
                audio_type = "audio/mpeg"
    except Exception:
        log.debug("Share SPA meta fallback for token %s", token[:8], exc_info=True)

    head = build_share_head_tags(
        title=title,
        description=description,
        page_url=page_url,
        audio_url=audio_url,
        audio_type=audio_type,
        image_url=image_url,
    )
    return inject_share_document_head(index_html, head)


def render_record_spa_html(
    token: str,
    *,
    index_html: str,
    public_origin: str,
) -> str:
    """Inject record-lobby title + website OG tags (no audio)."""
    title = "Join the recording"
    description = "You have been invited to record with Sharecut Studio. Use headphones."
    page_url = f"{public_origin.rstrip('/')}/rec/{token}"
    try:
        from podcast_mcp.edits.share_registry import SHARE_KIND_RECORD
        from podcast_mcp.services.share import open_share_workspace

        row, ws = open_share_workspace(token, kind=SHARE_KIND_RECORD)
        producer = str(row.get("role") or "") == "producer"
        heading = "Producer — not recorded" if producer else "Join the recording"
        name = (ws.project.meta.name or "").strip()
        title = f"{heading} — {name}" if name else heading
        if producer:
            description = "Silent producer link. You are not recorded in this stub."
    except Exception:
        log.debug("Record SPA meta fallback for token %s", token[:8], exc_info=True)

    head = build_share_head_tags(
        title=title,
        description=description,
        page_url=page_url,
        audio_url=None,
        image_url=None,
    )
    return inject_share_document_head(index_html, head)
