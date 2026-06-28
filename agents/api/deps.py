"""FastAPI dependency providers."""

from __future__ import annotations

import os
from typing import Annotated
from uuid import UUID

from fastapi import Depends, Header, HTTPException


async def current_user(
    x_relay_user_id: Annotated[str | None, Header()] = None,
    x_user_id: Annotated[str | None, Header()] = None,
) -> UUID:
    """Resolve the user. v0 trusts a user-id header from the Bun gateway.

    The gateway (api/src/routes/ask.ts) forwards the verified user id as
    ``X-Relay-User-Id`` — that's the intended contract and takes precedence.
    ``X-User-Id`` is kept for back-compat with local curl scripts.

    Production: gateway validates Supabase JWT and forwards the user id here.
    Local dev: hit endpoints with `-H "X-Relay-User-Id: <uuid>"`.
    """
    raw = x_relay_user_id or x_user_id
    if not raw:
        # Dev fallback: a fixed demo user, only when LOCAL_DEV=1.
        if os.environ.get("LOCAL_DEV") == "1":
            return UUID("00000000-0000-0000-0000-000000000001")
        raise HTTPException(status_code=401, detail="missing X-Relay-User-Id")
    try:
        return UUID(raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="invalid X-Relay-User-Id") from exc


UserDep = Annotated[UUID, Depends(current_user)]
