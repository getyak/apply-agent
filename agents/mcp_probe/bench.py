"""Latency / cost bench for the MCP probe — answers § 4.4 third pass criterion.

Two modes:
  fake  — N=10, no LLM. Measures pure MCP stdio transport overhead.
  live  — N=3, ReAct loop driving search_jobs through MCP. Counts tokens
          and applies OpenRouter pricing from harness/llm.py.

Run:
    cd agents/
    uv run python -m agents.mcp_probe.bench fake
    OPENROUTER_API_KEY=… uv run python -m agents.mcp_probe.bench live

Output: stdout JSON + a Markdown table copy-pasteable into
docs/architecture/agent-marketplace-deferred.md § 6.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
import time
from typing import Any


async def _bench_fake(n: int) -> list[dict[str, Any]]:
    """Pure transport — no LLM, RELAY_MCP_PROBE_FAKE=1."""
    from mcp.client.session import ClientSession
    from mcp.client.stdio import StdioServerParameters, stdio_client

    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "agents.mcp_probe.server"],
        env={**os.environ, "RELAY_MCP_PROBE_FAKE": "1"},
    )

    samples: list[dict[str, Any]] = []
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            for i in range(n):
                t0 = time.perf_counter()
                result = await session.call_tool("search_jobs", {"query": "backend"})
                dt = (time.perf_counter() - t0) * 1000
                assert not result.isError
                samples.append({"i": i, "latency_ms": round(dt, 2)})
    return samples


async def _bench_live(n: int) -> list[dict[str, Any]]:
    """ReAct agent + OpenRouter + MCP stdio. Uses fast tier (DeepSeek V4 Flash)."""
    from langchain_mcp_adapters.client import MultiServerMCPClient
    from langgraph.prebuilt import create_react_agent

    from agents.harness.llm import cost_cents, pick_model

    client = MultiServerMCPClient(
        {
            "relay": {
                "command": sys.executable,
                "args": ["-m", "agents.mcp_probe.server"],
                "transport": "stdio",
                "env": {**os.environ, "RELAY_MCP_PROBE_FAKE": "1"},
            }
        }
    )
    tools = await client.get_tools()
    model = pick_model("fast", temperature=0.0, max_tokens=512)
    agent = create_react_agent(
        model=model,
        tools=tools,
        prompt=(
            "You are a job-search assistant. When the user asks about jobs, "
            "call the search_jobs tool. Reply in one short sentence."
        ),
    )

    samples: list[dict[str, Any]] = []
    for i in range(n):
        t0 = time.perf_counter()
        result = await agent.ainvoke({"messages": [("user", "Find me backend engineering jobs.")]})
        dt = (time.perf_counter() - t0) * 1000

        tokens_in, tokens_out = 0, 0
        for m in result["messages"]:
            usage = getattr(m, "usage_metadata", None) or {}
            tokens_in += int(usage.get("input_tokens", 0))
            tokens_out += int(usage.get("output_tokens", 0))
        cents = cost_cents("fast", tokens_in, tokens_out)
        samples.append(
            {
                "i": i,
                "latency_ms": round(dt, 2),
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
                "cost_cents": cents,
                "cost_usd": round(cents / 100, 5),
            }
        )
    return samples


def _p(values: list[float], pct: int) -> float:
    """Linear-interpolation percentile. For N=3, p95 ≈ max."""
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * pct / 100
    f = int(k)
    c = min(f + 1, len(s) - 1)
    return s[f] + (s[c] - s[f]) * (k - f)


def _summarize(samples: list[dict[str, Any]], mode: str) -> dict[str, Any]:
    latencies = [s["latency_ms"] for s in samples]
    summary: dict[str, Any] = {
        "mode": mode,
        "n": len(samples),
        "latency_ms_p50": round(statistics.median(latencies), 2),
        "latency_ms_p95": round(_p(latencies, 95), 2),
        "latency_ms_min": round(min(latencies), 2),
        "latency_ms_max": round(max(latencies), 2),
        "samples": samples,
    }
    if mode == "live":
        costs = [s["cost_cents"] for s in samples]
        tokens_in = [s["tokens_in"] for s in samples]
        tokens_out = [s["tokens_out"] for s in samples]
        summary["cost_cents_avg"] = round(statistics.mean(costs), 4)
        summary["cost_usd_avg"] = round(statistics.mean(costs) / 100, 5)
        summary["tokens_in_avg"] = round(statistics.mean(tokens_in), 1)
        summary["tokens_out_avg"] = round(statistics.mean(tokens_out), 1)
    return summary


def _markdown_row(s: dict[str, Any]) -> str:
    if s["mode"] == "fake":
        return (
            f"| {s['mode']} | N={s['n']} | "
            f"p50={s['latency_ms_p50']}ms / p95={s['latency_ms_p95']}ms | — | — |"
        )
    return (
        f"| {s['mode']} | N={s['n']} | "
        f"p50={s['latency_ms_p50']}ms / p95={s['latency_ms_p95']}ms | "
        f"in={s['tokens_in_avg']:.0f} out={s['tokens_out_avg']:.0f} | "
        f"${s['cost_usd_avg']:.5f} ({s['cost_cents_avg']:.4f}¢) |"
    )


def _verdict(s: dict[str, Any]) -> str:
    """Apply deferred-doc § 4.4 pass criteria: p50 < 3s, cost < $0.005."""
    p50_ok = s["latency_ms_p50"] < 3000
    cost_ok = s.get("cost_usd_avg", 0) < 0.005
    if s["mode"] == "fake":
        return "PASS (transport only)" if p50_ok else "FAIL (p50 too high)"
    if p50_ok and cost_ok:
        return "PASS"
    fails = []
    if not p50_ok:
        fails.append(f"p50={s['latency_ms_p50']}ms ≥ 3000ms")
    if not cost_ok:
        fails.append(f"cost=${s.get('cost_usd_avg', 0):.5f} ≥ $0.005")
    return f"FAIL ({', '.join(fails)})"


async def _main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["fake", "live", "both"])
    parser.add_argument("--n", type=int, default=None, help="sample count override")
    parser.add_argument("--json", action="store_true", help="emit raw JSON only")
    args = parser.parse_args()

    summaries: list[dict[str, Any]] = []
    if args.mode in ("fake", "both"):
        n = args.n or 10
        summaries.append(_summarize(await _bench_fake(n), "fake"))
    if args.mode in ("live", "both"):
        if not os.environ.get("OPENROUTER_API_KEY"):
            print("OPENROUTER_API_KEY not set — skip live mode", file=sys.stderr)
        else:
            n = args.n or 3
            summaries.append(_summarize(await _bench_live(n), "live"))

    if args.json:
        print(json.dumps(summaries, indent=2))
        return

    print("# MCP probe bench results\n")
    print("| mode | N | latency | tokens | cost/call |")
    print("|---|---|---|---|---|")
    for s in summaries:
        print(_markdown_row(s))
    print()
    for s in summaries:
        print(f"- **{s['mode']}**: {_verdict(s)}")


if __name__ == "__main__":
    asyncio.run(_main())
