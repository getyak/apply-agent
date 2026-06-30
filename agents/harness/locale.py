"""Locale handling for agent replies.

Single source of truth for turning a UI locale (forwarded by the gateway as
``X-Relay-Locale``) into a system-prompt language directive. Replaces the old
per-call charset heuristic scattered in ``coordinator/router.py``: the explicit
locale now wins, and charset detection is only a fallback when no locale was
provided (older clients, raw curl).

Three-dimensional language model:

  - ui_locale     — the language the assistant *talks* in for the UI surface
                    (status text, buttons). This is what X-Relay-Locale carries.
  - artifact_locale — the language of generated documents (résumé bullets,
                    cover letters). Follows the *target role*, not the UI.
  - reply_locale  — the language used for THIS turn's reply. Detected from the
                    latest user message via lingua-language-detector so a user
                    with a Chinese UI who asks "what is the time complexity of
                    quicksort?" gets an English answer. Falls back to ui_locale
                    on short / low-confidence text.

Keep ``SUPPORTED`` in sync with web/src/i18n/config.ts LOCALES and the
``LOCALES`` enum in api/src/routes/ask.ts.
"""

from __future__ import annotations

import re
from functools import lru_cache

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


# ── reply_locale: per-turn language detection ─────────────────────────────
#
# Why this exists, on top of the UI locale: a user whose UI is set to Chinese
# may post an English question and expect an English reply — and vice versa.
# Industry pattern (Linear AI / Notion AI / Cursor): detect the language of
# the LATEST user message, pin the reply to that, fall back to ui_locale on
# short / ambiguous text. Conversation history is deliberately not pooled
# because language can flip turn-by-turn.
#
# `lingua-language-detector` over `langdetect`: pure Python, calibrated
# confidence (returns a real probability), short-text mode is roughly 30 %
# more accurate on <60-char Chinese/English mix — exactly the regime the
# dock lives in. The detector is built lazily and cached process-wide.


# Lingua's Language enum → ISO 639-1 lowercase we use everywhere else.
# Only languages in SUPPORTED are loaded into the detector (smaller model
# = faster + more accurate at telling them apart).
_LINGUA_NAME_TO_ISO = {
    "ENGLISH": "en",
    "CHINESE": "zh",
}


@lru_cache(maxsize=1)
def _detector() -> Any:  # actually lingua.LanguageDetector | None at runtime
    """Build the lingua detector once, lazily.

    Lazy because lingua's import path triggers a ~250 ms language model build
    on first use; we don't want every server boot to pay that even when the
    request never hits a reply-language path. Returns None when lingua is
    not installed (keeps tests / minimal envs working — caller falls back
    to charset heuristic).
    """
    try:
        from lingua import Language, LanguageDetectorBuilder
    except ImportError:
        return None

    # Map each SUPPORTED ISO code → lingua's Language enum member. Adding a
    # new SUPPORTED code without listing it here will simply route it to the
    # charset fallback (safe) rather than crashing.
    iso_to_lingua = {
        "en": Language.ENGLISH,
        "zh": Language.CHINESE,
    }
    langs = [iso_to_lingua[code] for code in SUPPORTED if code in iso_to_lingua]
    if not langs:
        return None
    # ``with_low_accuracy_mode`` is faster + plenty for the 2-language case;
    # we still gate on a 0.65 confidence threshold so noisy short text falls
    # back to ui_locale rather than guessing wrong.
    return LanguageDetectorBuilder.from_languages(*langs).with_low_accuracy_mode().build()


# Minimum visible character count below which detection is untrustworthy
# and we fall back to ui_locale unconditionally. 20 chars is the empirical
# elbow: shorter than that, even lingua's short-text mode is < 70 % accurate
# on EN/ZH mix per our internal calibration set.
_MIN_DETECTION_CHARS = 20

# Confidence cut-off — lingua returns a real probability via
# compute_language_confidence_values. Below this we treat the call as
# undecided and prefer the UI locale (which the user explicitly set).
_MIN_DETECTION_CONFIDENCE = 0.65

# Strip whitespace, code fences, URLs, e-mails, and obvious code identifiers
# before counting characters / running detection. Without this a one-line
# question that pastes a 400-char stack trace gets classified by the trace
# language, not the question.
_SCRUB_PATTERNS = [
    (re.compile(r"```.*?```", re.DOTALL), " "),              # fenced code
    (re.compile(r"`[^`]+`"), " "),                            # inline code
    (re.compile(r"https?://\S+"), " "),                       # URLs
    (re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b"), " "),       # e-mails
]


def _scrub_for_detection(text: str) -> str:
    """Remove non-prose noise that biases the detector toward English."""
    out = text or ""
    for pattern, repl in _SCRUB_PATTERNS:
        out = pattern.sub(repl, out)
    return out.strip()


def detect_reply_locale(
    message: str,
    ui_locale_fallback: str | None,
    *,
    min_chars: int = _MIN_DETECTION_CHARS,
    min_confidence: float = _MIN_DETECTION_CONFIDENCE,
) -> str:
    """Return the ISO 639-1 lowercase locale this turn's reply should use.

    Order of preference:
      1. lingua detection on the scrubbed message if it's long enough and
         confidence ≥ ``min_confidence``
      2. CJK charset heuristic on the scrubbed message
      3. ``ui_locale_fallback`` (normalized)
      4. ``DEFAULT_LOCALE``
    """
    fallback = normalize_locale(ui_locale_fallback) or DEFAULT_LOCALE
    scrubbed = _scrub_for_detection(message)
    if len(scrubbed) < min_chars:
        return fallback

    detector = _detector()
    if detector is not None:
        try:
            ranked = detector.compute_language_confidence_values(scrubbed)
        except Exception:  # noqa: BLE001 — detector should never break the turn
            ranked = []
        if ranked:
            top = ranked[0]
            iso = _LINGUA_NAME_TO_ISO.get(top.language.name)
            if iso and top.value >= min_confidence:
                return iso
            # Detector ran but we don't trust the verdict → fall through to
            # the charset heuristic, which is deterministic and cheap.

    # Charset heuristic fallback: CJK present anywhere → zh, else fallback.
    if _CJK_RE.search(scrubbed):
        return "zh"
    # Latin-only and no high-confidence vote → trust the UI locale.
    return fallback


def reply_language_directive(reply_locale: str | None) -> str:
    """System-prompt clause pinning the reply to a specific language.

    Designed to be appended to (or prepended onto) the dock agent's system
    prompt so the model gets one unambiguous instruction. We deliberately
    repeat the directive content from ``language_directive`` because the
    coordinator may install only ONE of the two depending on the path
    (reply-locale-aware vs legacy UI-locale-only).
    """
    iso = normalize_locale(reply_locale) or DEFAULT_LOCALE
    name = _LANGUAGE_NAME.get(iso, _LANGUAGE_NAME[DEFAULT_LOCALE])
    return (
        f"[REPLY LANGUAGE]: Reply in {name}. Follow the language of the user's "
        "MOST RECENT turn, not the conversation history — if the user switched "
        "language this turn, switch with them. Never mix two languages in a "
        "single reply. Keep code blocks, file paths, command names, product "
        "names, and company / brand names in their original form."
    )
