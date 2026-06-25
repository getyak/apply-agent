"""Locale handling for agent replies.

Single source of truth for turning a UI locale (forwarded by the gateway as
``X-Relay-Locale``) into a system-prompt language directive. Replaces the old
per-call charset heuristic scattered in ``coordinator/router.py``: the explicit
locale now wins, and charset detection is only a fallback when no locale was
provided (older clients, raw curl).

Two-dimensional language model (docs/architecture/vantage-ui-mapping.md):

  - ui_locale     — the language the assistant *talks* in (dock chat, button
                    text, status). This is what X-Relay-Locale carries.
  - artifact_locale — the language of generated documents (résumé bullets,
                    cover letters). These follow the *target role*, not the
                    UI: a Chinese-speaking user applying to an English-only
                    role still gets an English résumé. Structured agents pass
                    this separately; it defaults to the UI locale only when the
                    role language is unknown.

Keep ``SUPPORTED`` in sync with web/src/i18n/config.ts LOCALES and the
``LOCALES`` enum in api/src/routes/ask.ts.
"""

from __future__ import annotations

import re

SUPPORTED = ("en", "zh")
DEFAULT_LOCALE = "en"

# Matches Hiragana, Katakana, and CJK Unified Ideographs — enough to tell a
# Chinese/Japanese message from a Latin-script one for the fallback path.
_CJK_RE = re.compile(r"[぀-ヿ㐀-鿿]")


def normalize_locale(value: str | None) -> str | None:
    """Coerce an arbitrary tag to a supported locale, or None if unrecognized.

    Accepts bare codes ("en", "zh") and BCP-47-ish tags ("zh-CN", "en-US").
    Returns None (not the default) so callers can decide whether to fall back
    to charset detection vs. force the default.
    """
    if not value:
        return None
    lower = value.strip().lower()
    if lower.startswith("zh"):
        return "zh"
    if lower.startswith("en"):
        return "en"
    return None


def detect_locale_from_text(message: str) -> str:
    """Fallback charset heuristic: CJK characters → zh, else en."""
    return "zh" if _CJK_RE.search(message or "") else DEFAULT_LOCALE


def resolve_locale(locale: str | None, message: str = "") -> str:
    """Resolve the effective reply locale.

    Order: explicit locale (normalized) → charset of the message → default.
    """
    normalized = normalize_locale(locale)
    if normalized:
        return normalized
    return detect_locale_from_text(message)


# Human-facing language names used inside the directive so the model gets an
# unambiguous instruction ("reply in Chinese") rather than a code.
_LANGUAGE_NAME = {
    "en": "English",
    "zh": "Chinese (Simplified, 简体中文)",
}


def language_directive(locale: str | None, message: str = "") -> str:
    """Build the system-prompt language directive for the chat/UI reply.

    ``locale`` is the UI locale (X-Relay-Locale). When absent we fall back to
    detecting the message's script so behaviour matches the legacy heuristic.
    """
    effective = resolve_locale(locale, message)
    name = _LANGUAGE_NAME.get(effective, _LANGUAGE_NAME[DEFAULT_LOCALE])
    return (
        f"Reply in {name}. The user's interface language is set to "
        f"'{effective}', so respond in that language regardless of the script "
        "of any pasted content (a Chinese-UI user may paste an English job "
        "description — still reply in Chinese). Never mix two languages in a "
        "single reply. Do not translate technical terms, product names, or "
        "company/brand names that should stay in their original form "
        "(e.g. Stripe, Greenhouse, TypeScript)."
    )


def artifact_language_directive(artifact_locale: str | None, ui_locale: str | None = None) -> str:
    """Build the directive for *generated documents* (résumé, cover letter).

    Artifact language follows the target role's language. When unknown, fall
    back to the UI locale. This is intentionally separate from
    ``language_directive`` so a Chinese-UI user applying to an English role
    gets an English résumé.
    """
    effective = normalize_locale(artifact_locale) or normalize_locale(ui_locale) or DEFAULT_LOCALE
    name = _LANGUAGE_NAME.get(effective, _LANGUAGE_NAME[DEFAULT_LOCALE])
    return (
        f"Write the document in {name}. Match the language of the target role "
        "and job description — do not switch to the user's interface language "
        "if the role is in a different language. Keep proper nouns (company "
        "names, product names, technologies) in their original form."
    )
