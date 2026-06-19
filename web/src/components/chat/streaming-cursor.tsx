// StreamingCursor — blinking caret rendered at the tail of an
// assistant bubble while an SSE turn is still in flight.
//
// Pure CSS (no JS timers) so the cursor keeps up even when React is
// busy reconciling fresh token deltas. The actual @keyframes lives in
// markdown.css alongside the rest of the chat styling — that file is
// already imported wherever this component is used (MarkdownMessage).
//
// Caller contract: render iff `streaming && lastAssistantBubble`.

"use client";

import "./markdown.css";

export function StreamingCursor() {
  return <span aria-hidden className="vt-stream-cursor" />;
}
