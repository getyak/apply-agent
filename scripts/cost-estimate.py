#!/usr/bin/env python3
"""Dev-time tool: estimate LLM cost for a given Python file or agent module.

Purpose
-------
Static analysis only. Given a Python file that builds a LangGraph or makes
LLM calls, scan for create_react_agent / ChatOpenAI usage and estimate cost
per invocation using OpenRouter pricing.

Trigger
-------
Manual:  `make cost-estimate FILE=agents/nodes/interview_agent.py`
         `uv run python scripts/cost-estimate.py agents/nodes/*.py`

Status
------
TODO: replace stub prompt-token count with real tiktoken on each prompt
template once `agents/prompts/` exists. Current skeleton outputs a table
based on detected model strings only.

Pricing source
--------------
Mirrored from docs/architecture/agent-harness.md ($/M tokens).
"""

from __future__ import annotations

import argparse
import ast
import sys
from pathlib import Path

# Mirror of agent-harness.md pricing table (USD per 1M tokens, in / out).
PRICING: dict[str, tuple[float, float]] = {
    "deepseek/deepseek-v4-pro": (0.435, 0.87),
    "z-ai/glm-4.7": (0.40, 1.75),
    "deepseek/deepseek-v4-flash": (0.098, 0.196),
}

# Heuristic default token estimates per call until tiktoken integration.
DEFAULT_TOKENS_IN = 3000
DEFAULT_TOKENS_OUT = 800
HARD_WARN_USD = 0.05  # Per-call hard warn — likely missing context compression.


def estimate(model: str, tin: int = DEFAULT_TOKENS_IN, tout: int = DEFAULT_TOKENS_OUT) -> float:
    if model not in PRICING:
        return 0.0
    in_price, out_price = PRICING[model]
    return (tin * in_price + tout * out_price) / 1_000_000


def scan_file(path: Path) -> list[tuple[int, str, float]]:
    """Return [(line_no, model_id, est_usd_per_call)]."""
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except SyntaxError as e:
        print(f"✗ {path}: {e}", file=sys.stderr)
        return []
    findings: list[tuple[int, str, float]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            for kw in node.keywords:
                if kw.arg == "model" and isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str):
                    m = kw.value.value
                    if m in PRICING:
                        findings.append((node.lineno, m, estimate(m)))
            for arg in node.args:
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str) and arg.value in PRICING:
                    findings.append((node.lineno, arg.value, estimate(arg.value)))
    return findings


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    args = ap.parse_args()
    rows: list[tuple[str, int, str, float]] = []
    for f in args.files:
        p = Path(f)
        if not p.exists():
            continue
        for lineno, model, cost in scan_file(p):
            rows.append((str(p), lineno, model, cost))
    if not rows:
        print("(no LLM calls detected)")
        return 0
    print(f"{'file':50}  {'line':>5}  {'model':30}  {'$/call':>10}  {'$/1k':>10}")
    print("-" * 115)
    total = 0.0
    for f, ln, m, c in rows:
        flag = "  <-- HIGH" if c > HARD_WARN_USD else ""
        print(f"{f:50}  {ln:>5}  {m:30}  ${c:>9.4f}  ${c * 1000:>9.2f}{flag}")
        total += c
    print(f"\nTotal per round-trip:    ${total:.4f}")
    print(f"Total per 1k round-trips: ${total * 1000:.2f}")
    if any(c > HARD_WARN_USD for _, _, _, c in rows):
        print("\n⚠ One or more calls exceed $0.05 — investigate context compression / cache.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
