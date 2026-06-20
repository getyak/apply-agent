"""[MOVED] Probe tests now live in agents/tests/mcp_probe/.

Kept as a redirect-only file so anyone reading this path follows the move
instead of editing here. pytest does not auto-collect this directory
(testpaths = ["tests"] in agents/pyproject.toml).

If you're looking for:
- import smoke      → agents/tests/mcp_probe/test_smoke.py
- tool unit tests   → agents/tests/mcp_probe/test_tools.py
- stdio e2e tests   → agents/tests/mcp_probe/test_e2e.py
"""
