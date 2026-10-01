from typing import TYPE_CHECKING

from podcast_mcp.util.lazy_exports import resolve_export

if TYPE_CHECKING:
    from podcast_mcp.services.share_auth.access import (
        GENERAL_ACCESS_LINK,
        GENERAL_ACCESS_RESTRICTED,
        access_required,
        normalize_general_access,
    )
    from podcast_mcp.services.share_auth.oauth_credentials import oauth_providers_available
    from podcast_mcp.services.share_auth.oauth_flow import (
        authorization_url,
        exchange_code,
        make_pkce_pair,
    )
    from podcast_mcp.services.share_auth.passkeys import (
        begin_authentication,
        begin_registration,
        finish_authentication,
        finish_registration,
    )
    from podcast_mcp.services.share_auth.policy import (
        SESSION_COOKIE,
        require_share_access,
        resolve_principal_from_headers,
    )
    from podcast_mcp.services.share_auth.store import (
        ShareIdentityStore,
        get_identity_store,
    )

__all__ = [
    "GENERAL_ACCESS_LINK",
    "GENERAL_ACCESS_RESTRICTED",
    "SESSION_COOKIE",
    "ShareIdentityStore",
    "access_required",
    "authorization_url",
    "begin_authentication",
    "begin_registration",
    "exchange_code",
    "finish_authentication",
    "finish_registration",
    "get_identity_store",
    "make_pkce_pair",
    "normalize_general_access",
    "oauth_providers_available",
    "require_share_access",
    "resolve_principal_from_headers",
]

_MODULE_BY_NAME = {
    "GENERAL_ACCESS_LINK": "access",
    "GENERAL_ACCESS_RESTRICTED": "access",
    "SESSION_COOKIE": "policy",
    "ShareIdentityStore": "store",
    "access_required": "access",
    "authorization_url": "oauth_flow",
    "begin_authentication": "passkeys",
    "begin_registration": "passkeys",
    "exchange_code": "oauth_flow",
    "finish_authentication": "passkeys",
    "finish_registration": "passkeys",
    "get_identity_store": "store",
    "make_pkce_pair": "oauth_flow",
    "normalize_general_access": "access",
    "oauth_providers_available": "oauth_credentials",
    "require_share_access": "policy",
    "resolve_principal_from_headers": "policy",
}


def __getattr__(name: str) -> object:
    return resolve_export(name, package=__name__, namespace=globals(), modules=_MODULE_BY_NAME)
