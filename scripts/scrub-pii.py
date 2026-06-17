#!/usr/bin/env python3
"""Scrub PII from eval datasets before they're committed.

Purpose
-------
Eval golden datasets must NEVER contain real user PII (names, emails, phones,
addresses, resume contents). This script:
  1. Detects PII using regex (cheap) + Presidio (richer, optional).
  2. Replaces detected entities with deterministic fakes (so the same "John Doe"
     always maps to the same "Casey Lin" across the dataset — eval diffs stay
     stable).
  3. Writes scrubbed output and refuses to commit if any HIGH-confidence
     entity remains undetected.

Trigger
-------
- lefthook pre-commit (glob: eval/datasets/**/*.jsonl)
- CI gate before any merge that touches eval/datasets/

Status
------
TODO: full Presidio integration. Current skeleton implements basic regex
sweep and deterministic fake replacement. Mark this script as "implement
before P3 dataset expansion".

Implementation notes
--------------------
- Stable mapping via sha256(original) -> hex prefix.
- Atomic write: tmp file then os.replace.
- Exit 1 (with --strict) if any HIGH-confidence finding remaining after scrubbing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Iterator

EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
PHONE_RE = re.compile(r"\b(?:\+?\d{1,3}[-\s]?)?\(?\d{2,4}\)?[-\s]?\d{3,4}[-\s]?\d{4}\b")
# Loose: capitalized two-word sequences. Tighten with Presidio later.
NAME_RE = re.compile(r"\b[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}\b")


def stable_fake_name(original: str) -> str:
    h = hashlib.sha256(original.encode()).hexdigest()[:8]
    return f"Person_{h}"


def stable_fake_email(original: str) -> str:
    local, _, _domain = original.partition("@")
    h = hashlib.sha256(local.encode()).hexdigest()[:8]
    return f"user_{h}@example.test"


def stable_fake_phone(original: str) -> str:
    h = int(hashlib.sha256(original.encode()).hexdigest(), 16) % 10**10
    return f"+1-555-{h:04d}-{(h >> 4) % 10000:04d}"


def scrub(text: str) -> tuple[str, list[str]]:
    """Return (scrubbed_text, findings)."""
    findings: list[str] = []
    text = EMAIL_RE.sub(lambda m: (findings.append(f"email:{m.group()}"), stable_fake_email(m.group()))[1], text)
    text = PHONE_RE.sub(lambda m: (findings.append(f"phone:{m.group()}"), stable_fake_phone(m.group()))[1], text)
    text = NAME_RE.sub(lambda m: (findings.append(f"name:{m.group()}"), stable_fake_name(m.group()))[1], text)
    return text, findings


def iter_jsonl_records(path: Path) -> Iterator[dict]:
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                yield json.loads(line)


def process_file(path: Path, write: bool) -> int:
    out_lines: list[str] = []
    total_findings: list[str] = []
    for rec in iter_jsonl_records(path):
        as_json = json.dumps(rec, ensure_ascii=False)
        scrubbed, findings = scrub(as_json)
        total_findings.extend(findings)
        out_lines.append(scrubbed)
    if total_findings:
        print(f"{path}: {len(total_findings)} entities scrubbed", file=sys.stderr)
        for f in total_findings[:10]:
            print(f"  • {f}", file=sys.stderr)
        if write:
            tmp = path.with_suffix(path.suffix + ".tmp")
            tmp.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
            tmp.replace(path)
            print(f"  ↪ wrote scrubbed {path}", file=sys.stderr)
        else:
            print("  (dry-run; pass --write to apply)", file=sys.stderr)
    return len(total_findings)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="*", help="jsonl files to scrub")
    ap.add_argument("--write", action="store_true", help="write scrubbed output back to file")
    ap.add_argument("--strict", action="store_true", help="exit 1 if any PII found (use in CI)")
    args = ap.parse_args()

    files = [Path(f) for f in args.files] or list(Path("eval/datasets").rglob("*.jsonl"))
    total = 0
    for f in files:
        if f.exists():
            total += process_file(f, args.write)
    if args.strict and total:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
