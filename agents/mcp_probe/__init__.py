"""Experimental MCP probe — see docs/architecture/agent-marketplace-deferred.md § 4.

Hidden surface that exposes Relay's existing jobmatch / resume_tailor as MCP
tools. Used ONLY to validate whether external MCP clients (Claude Desktop,
Cursor, etc.) can call Relay capabilities. NOT part of any shipped product.

Importing this package does not register any tools — server.py wires them up
only when invoked as a stdio MCP server. Safe to import for type checking.
"""
