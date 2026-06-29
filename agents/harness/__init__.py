"""agents.harness subpackage.

Public surface:
- RelayEmitter — AG-UI event emitter with envelope injection (events.py).
"""

from agents.harness.events import RELAY_PROTOCOL_VERSION, RelayEmitter

__all__ = ["RELAY_PROTOCOL_VERSION", "RelayEmitter"]
