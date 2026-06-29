"""Screenshot offload to MinIO/S3.

Browser snapshots (agents/tools/browser.py) come back as base64 PNGs. Inlining
a large screenshot into an SSE CUSTOM event would blow the frame size and stall
the stream (plan §12 risk: "截图 base64 过大撑爆 SSE"). So: anything over
``SCREENSHOT_INLINE_LIMIT_BYTES`` (256 KiB) is uploaded to object storage and the
event carries ``screenshot_url`` instead of inline data.

Mirrors api/src/storage.ts (Bun S3Client) — same S3_* env vars
(S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY / S3_BUCKET / S3_REGION) and the
same graceful-degrade contract: when credentials are absent the store reports
``available == False`` and the caller keeps the inline base64 (smaller previews
still work; only the oversized-offload optimization is skipped).

Storage key layout follows infra/CLAUDE.md:
    {user_id}/browser/snapshots/{ulid}.png
"""

from __future__ import annotations

import base64
import binascii
import io
import os

import structlog
from ulid import ULID

log = structlog.get_logger("agents.harness.screenshot_store")

# CUSTOM browser_snapshot events carry inline base64 below this size; larger
# screenshots are offloaded to MinIO and the event carries a URL instead.
SCREENSHOT_INLINE_LIMIT_BYTES = 256 * 1024  # 256 KiB


def _bucket() -> str:
    return os.environ.get("S3_BUCKET", "relay-user-files")


def _client():  # -> minio.Minio | None
    """Build a MinIO client from S3_* env, or None when unconfigured.

    Returns None (not an exception) when credentials are missing so callers can
    fall back to inline base64 — matching the TS StorageClient.available contract.
    """
    access = os.environ.get("S3_ACCESS_KEY", "").strip()
    secret = os.environ.get("S3_SECRET_KEY", "").strip()
    if not access or not secret:
        return None
    endpoint = os.environ.get("S3_ENDPOINT", "http://localhost:9000")
    # minio.Minio wants host[:port] without scheme + a `secure` bool.
    secure = endpoint.startswith("https://")
    host = endpoint.removeprefix("https://").removeprefix("http://").rstrip("/")
    region = os.environ.get("S3_REGION", "us-east-1")
    try:
        from minio import Minio
    except ImportError:
        return None
    return Minio(host, access_key=access, secret_key=secret, secure=secure, region=region)


def store_available() -> bool:
    """True when object storage is configured and offload will be attempted."""
    return _client() is not None


def _decode(b64: str) -> bytes:
    # Tolerate a data: URL prefix the extension might prepend.
    if "," in b64 and b64.strip().startswith("data:"):
        b64 = b64.split(",", 1)[1]
    return base64.b64decode(b64)


def maybe_offload_screenshot(b64_png: str, *, user_id: str) -> dict[str, str | None]:
    """Decide inline-vs-offload for one base64 PNG.

    Returns a dict with exactly one of ``screenshot_b64`` / ``screenshot_url``
    populated (the other is None):
      - small screenshot, or storage unavailable, or any upload error
        → keep inline base64
      - large screenshot + storage available → upload, return URL

    Never raises: a failed upload degrades to inline rather than breaking the
    browser tool.
    """
    if not b64_png:
        return {"screenshot_b64": None, "screenshot_url": None}

    try:
        raw = _decode(b64_png)
    except (ValueError, binascii.Error):
        log.warning("screenshot.bad_base64")
        return {"screenshot_b64": b64_png, "screenshot_url": None}

    if len(raw) <= SCREENSHOT_INLINE_LIMIT_BYTES:
        return {"screenshot_b64": b64_png, "screenshot_url": None}

    client = _client()
    if client is None:
        # Oversized but no storage — keep inline (the caller / SSE layer may
        # still truncate, but we don't lose the image silently).
        log.info("screenshot.oversize_no_storage", bytes=len(raw))
        return {"screenshot_b64": b64_png, "screenshot_url": None}

    key = f"{user_id}/browser/snapshots/{ULID()}.png"
    try:
        client.put_object(
            _bucket(),
            key,
            io.BytesIO(raw),
            length=len(raw),
            content_type="image/png",
        )
        url = client.presigned_get_object(_bucket(), key)
        return {"screenshot_b64": None, "screenshot_url": url}
    except Exception as exc:  # noqa: BLE001 — boundary: never break the tool on upload failure
        log.error("screenshot.upload_failed", error=str(exc), bytes=len(raw))
        return {"screenshot_b64": b64_png, "screenshot_url": None}


__all__ = [
    "SCREENSHOT_INLINE_LIMIT_BYTES",
    "store_available",
    "maybe_offload_screenshot",
]
