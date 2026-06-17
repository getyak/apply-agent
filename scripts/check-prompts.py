#!/usr/bin/env python3
"""Validate prompt frontmatter for files under agents/prompts/.

Purpose
-------
Every prompt file MUST have YAML frontmatter declaring version/model/owner/last_eval.
Without these we can't replay or detect drift — prompts ARE code.

Trigger
-------
- lefthook pre-commit (glob: agents/prompts/**/*.md)
- CI fallback in eval workflow

Required frontmatter
--------------------
    ---
    version: 1.3.0                         # semver
    model: z-ai/glm-4.7                    # one of the known OpenRouter IDs
    owner: cubxxw                          # github handle
    last_eval: 2026-06-10                  # ISO date; soft-warn if > 30d old
    ---

Exit
----
0 if all checks pass, 1 if any file is missing required keys or has bad format.
"""

from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

# Soft dep: install python-frontmatter via uv add --dev python-frontmatter
try:
    import frontmatter  # type: ignore[import-not-found]
except ImportError:
    print("✗ python-frontmatter not installed (uv add --dev python-frontmatter)", file=sys.stderr)
    sys.exit(1)

REQUIRED_KEYS = {"version", "model", "owner", "last_eval"}
KNOWN_MODELS = {
    "deepseek/deepseek-v4-pro",
    "z-ai/glm-4.7",
    "deepseek/deepseek-v4-flash",
}
STALE_DAYS = 30


def check_file(path: Path) -> list[str]:
    """Return list of error messages; empty if OK."""
    errs: list[str] = []
    try:
        post = frontmatter.load(str(path))
    except Exception as e:  # noqa: BLE001
        return [f"{path}: cannot parse frontmatter: {e}"]

    missing = REQUIRED_KEYS - set(post.metadata)
    if missing:
        errs.append(f"{path}: missing keys {sorted(missing)}")

    model = post.metadata.get("model")
    if model and model not in KNOWN_MODELS:
        errs.append(f"{path}: unknown model '{model}' (allowed: {sorted(KNOWN_MODELS)})")

    last_eval = post.metadata.get("last_eval")
    if isinstance(last_eval, date):
        stale = date.today() - last_eval > timedelta(days=STALE_DAYS)
        if stale:
            print(
                f"⚠ {path}: last_eval is {last_eval} (> {STALE_DAYS}d ago) — consider re-running eval",
                file=sys.stderr,
            )
    elif last_eval is not None:
        errs.append(f"{path}: last_eval must be an ISO date (got: {last_eval!r})")

    return errs


def main(argv: list[str]) -> int:
    files = [Path(a) for a in argv[1:]] or list(Path("agents/prompts").rglob("*.md"))
    all_errs: list[str] = []
    for f in files:
        if not f.exists() or "/prompts/" not in str(f):
            continue
        all_errs.extend(check_file(f))
    if all_errs:
        print("\n".join(all_errs), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
