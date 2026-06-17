"""FastAPI dependency providers."""
from __future__ import annotations

import os
from typing import Annotated
from uuid import UUID

from fastapi import Depends, Header, HTTPException


async def current_user(x_user_id: Annotated[str | None, Header()] = None) -> UUID:
    """Resolve the user. v0 trusts X-User-Id header from the Bun gateway.

    Production: gateway validates Supabase JWT and forwards the user id here.
    Local dev: hit endpoints with `-H "X-User-Id: <uuid>"`.
    """
    if not x_user_id:
        # Dev fallback: a fixed demo user, only when LOCAL_DEV=1.
        if os.environ.get("LOCAL_DEV") == "1":
            return UUID("00000000-0000-0000-0000-000000000001")
        raise HTTPException(status_code=401, detail="missing X-User-Id")
    try:
        return UUID(x_user_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="invalid X-User-Id") from exc


UserDep = Annotated[UUID, Depends(current_user)]
