"""Regression: a server whose two metadata documents disagree only by a trailing slash.

zernio advertises ``authorization_servers: ["https://zernio.com/"]`` in its protected-resource
metadata and ``issuer: "https://zernio.com"`` in its own authorization-server metadata. The SDK
compares those two by plain string equality (SEP-2468), so the assertion could never hold and every
login failed. Only that origin is reconciled; every other server keeps the strict rule.
"""

import asyncio
from types import SimpleNamespace

import pytest

_mcp_auth_utils = pytest.importorskip(
    "mcp.client.auth.utils", reason="mcp 2.x SDK not installed"
)
if not hasattr(_mcp_auth_utils, "validate_metadata_issuer"):
    pytest.skip(
        "mcp 2.x SDK not installed (older mcp distribution present)",
        allow_module_level=True,
    )

from mcp.client.auth.exceptions import OAuthFlowError  # noqa: E402
from mcp.client.auth.utils import validate_metadata_issuer  # noqa: E402
from mcp.shared.auth import OAuthMetadata  # noqa: E402

from tools.mcp_oauth_provider import HermesProviderMixin  # noqa: E402

_ASM_URL = "https://zernio.com/.well-known/oauth-authorization-server"


class _Response:
    """Minimal stand-in for the SDK's httpx response: the hook reads status, json and url.

    ``is_stream_consumed`` defaults to True (already-read body, like the test's original shape).
    Pass False to model the real SDK transport, which hands over an UNREAD streaming response.
    """

    def __init__(self, url: str, payload: dict, status_code: int = 200, is_stream_consumed: bool = True):
        self.status_code = status_code
        self._payload = payload
        self.is_stream_consumed = is_stream_consumed
        self.request = SimpleNamespace(url=url)
        self.reads = 0

    def read(self) -> None:
        self.reads += 1
        self.is_stream_consumed = True

    def json(self) -> dict:
        if not self.is_stream_consumed:
            raise AssertionError("body read without read() first")
        return self._payload


def _provider(auth_server_url: str | None) -> HermesProviderMixin:
    provider = HermesProviderMixin.__new__(HermesProviderMixin)
    provider.context = SimpleNamespace(auth_server_url=auth_server_url, oauth_metadata=None)
    return provider


def _metadata(issuer: str) -> OAuthMetadata:
    return OAuthMetadata(
        issuer=issuer,
        authorization_endpoint="https://zernio.com/oauth/authorize",
        token_endpoint="https://zernio.com/api/oauth/token",
    )


def _reconcile_and_check(auth_server_url: str | None, document_issuer: str) -> bool:
    """Reconcile a metadata response, then run the SDK's own SEP-2468 comparison."""
    provider = _provider(auth_server_url)
    asyncio.run(provider._reconcile_issuer_from_metadata_response(
        _Response(_ASM_URL, {"issuer": document_issuer})
    ))
    try:
        validate_metadata_issuer(_metadata(document_issuer), provider.context.auth_server_url)
    except OAuthFlowError:
        return False
    return True


@pytest.mark.parametrize("auth_server_url, expected", [
    ("https://zernio.com/", True),   # the live conflict: PRM says "/", the document says ""
    ("https://zernio.com", True),    # already consistent, nothing to do
    (None, False),                   # legacy no-PRM path: nothing to reconcile against
])
def test_trailing_slash_conflict_is_reconciled(auth_server_url, expected):
    assert _reconcile_and_check(auth_server_url, "https://zernio.com") is expected


def test_only_the_allowlisted_origin_is_reconciled():
    """The rstrip-equality check above it already rejects a host/path/scheme difference, so those
    cases cannot tell a missing allowlist from a present one. This one can: an UNRELATED origin
    with the very same trailing-slash bug must stay unreconciled, which is exactly what the
    allowlist exists to enforce. Without it, every such server would be auto-reconciled."""
    assert _reconcile_and_check("https://other.example/", "https://other.example") is False


def test_unread_streaming_response_is_buffered_before_reading_it():
    """The live SDK transport hands over an UNREAD streaming response, so `.json()` raises
    ResponseNotRead and the issuer was never seen -- the hook silently no-opped and login failed
    with the very mismatch this feature exists to absorb. The fake asserts on that ordering."""
    provider = _provider("https://zernio.com/")
    response = _Response(_ASM_URL, {"issuer": "https://zernio.com"}, is_stream_consumed=False)

    asyncio.run(provider._reconcile_issuer_from_metadata_response(response))

    assert response.reads == 1, "expected exactly one read() to buffer the stream"
    assert provider.context.auth_server_url == "https://zernio.com"
    assert validate_metadata_issuer(
        _metadata("https://zernio.com"), provider.context.auth_server_url
    ) is None


@pytest.mark.parametrize("document_issuer, auth_server_url", [
    ("https://evil.example", "https://zernio.com/"),        # a different host is never reconciled
    ("https://zernio.com/tenant", "https://zernio.com/"),  # nor a real path difference
    ("http://zernio.com", "https://zernio.com/"),         # nor a scheme downgrade
])
def test_real_issuer_differences_stay_rejected(document_issuer, auth_server_url):
    """Absorbing a trailing slash must not become a general issuer-matching relaxation."""
    provider = _provider(auth_server_url)
    asyncio.run(provider._reconcile_issuer_from_metadata_response(
        _Response(_ASM_URL, {"issuer": document_issuer})
    ))
    assert provider.context.auth_server_url == auth_server_url
    with pytest.raises(OAuthFlowError):
        validate_metadata_issuer(_metadata(document_issuer), provider.context.auth_server_url)


def test_unrelated_response_is_ignored():
    """A token/registration response on another path must not rewrite the expected issuer."""
    provider = _provider("https://zernio.com/")
    asyncio.run(provider._reconcile_issuer_from_metadata_response(
        _Response("https://zernio.com/api/oauth/token", {"issuer": "https://zernio.com"})
    ))
    assert provider.context.auth_server_url == "https://zernio.com/"


def test_failed_metadata_response_is_ignored():
    """A non-2xx metadata fetch carries no issuer to reconcile from."""
    provider = _provider("https://zernio.com/")
    asyncio.run(provider._reconcile_issuer_from_metadata_response(
        _Response(_ASM_URL, {"issuer": "https://zernio.com"}, status_code=404)
    ))
    assert provider.context.auth_server_url == "https://zernio.com/"


def test_unparseable_metadata_body_is_ignored():
    """A body the SDK's own parsers reject is left to the SDK to report, not reconciled here."""
    provider = _provider("https://zernio.com/")
    response = _Response(_ASM_URL, {})
    response.json = lambda: (_ for _ in ()).throw(ValueError("not json"))
    asyncio.run(provider._reconcile_issuer_from_metadata_response(response))
    assert provider.context.auth_server_url == "https://zernio.com/"
