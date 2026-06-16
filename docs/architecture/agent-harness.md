# Agent Harness · 单 Agent 执行框架

> 可交互版本见 [`assets/agent-execution-deep-diagrams.html`](../assets/agent-execution-deep-diagrams.html)。

Harness 是所有 agent 共享的执行框架。**实现一次,所有 agent 自动获得**可观测性、成本控制、错误处理、缓存、审计。

## ReAct 执行循环

每个 agent 不是一次性 LLM 调用,而是受控的循环:

```
THINK → DECIDE → ACT → OBSERVE → 回 THINK
```

```
入口: agent.execute(input)
  │
  ├─ Auth & Budget Gate     user_id + cost_limit 检查
  ├─ Cache Check (Redis)     hash(input) → 命中则直接返回
  │
  ├─ ① THINK                 Claude 接收 system_prompt + task + history + tools
  │                          → 输出 text reasoning 或 tool_use
  ├─ DECIDE                  text only → done? / tool_use → ACT?
  ├─ ② ACT                   Tool Dispatcher 路由到执行器(bash/browser/api)
  ├─ ③ OBSERVE               tool_result 加入 history,成本累加 → 回 THINK
  │
  └─ 退出: Task Complete      result + cost report + trace
```

## Loop Guards(防失控)

| Guard | 默认值 | 触发后 |
|-------|--------|--------|
| max_iterations | 20 | 中止 + 总结 |
| token_budget | 80,000 | 超 60k 压缩旧历史 |
| cost_limit | $0.50 / session | 暂停 + 通知 |
| timeout | 300s | 中止 |
| error_count | 3 连续 | 中止 |

## Context Window 管理

- 跟踪每条消息 token 用量
- 超 60k:压缩旧 observation,保留 system + 最近 5 轮 + task
- 旧步骤摘要化:"步骤 1–8 摘要"

## HITL Checkpoint(人在回路)

**最重要的安全机制。** 某些操作需用户确认才执行:

触发条件:`submit_form` `send_email` `delete_*` `purchase_*` `enter_credentials` `cost > threshold`

```
agent 到达 checkpoint
  → 暂停 loop,保存状态到 Redis
  → WebSocket 通知用户
  → 显示待批操作:"Agent 想投递到 Google,批准?"
  → 用户 approve / reject
  → 恢复或中止(5 分钟超时 → 自动中止)
```

> 对求职 agent 尤其关键:投递不可逆,`submit` 永远需要用户确认。

## Tool 权限系统

四个风险等级:

| 级别 | 行为 | 示例 |
|------|------|------|
| **AUTO** | 静默执行 + 记录 | fetch_url, read_file, navigate |
| **NOTIFY** | 执行 + 通知 | write_file, fill_form, save_resume |
| **APPROVE** | 暂停等确认 | submit_form, send_email, bash_write |
| **BLOCK** | 永远拒绝 | enter_credentials, purchase, rm -rf |

## Sandbox 隔离(服务器端工具)

当 agent 需要跑 bash 或服务器端浏览器时,每个 session 跑在独立 Docker container:

- 独立 network namespace(用户间不互通)
- tmpfs ephemeral 文件系统(session 结束即清除)
- `--user nobody` 最低权限 + seccomp 过滤
- cgroup 资源限制(512MB / 0.5 CPU / 100MB disk / 300s)
- session 结束 `docker rm`

> 注:**客户端投递方案不需要服务器 sandbox**——投递在用户浏览器本地完成。Sandbox 主要用于服务器端的简历解析、JD 抓取等。

## 可观测性

每次 agent 调用记录:

```json
{
  "agent": "resume_agent", "version": 2, "action": "customize",
  "user_id": "...", "latency_ms": 3200, "cost_cents": 1.45,
  "tokens_in": 4000, "tokens_out": 1200, "cache_hit": false,
  "status": "success", "trace_id": "..."
}
```

Dashboard 监控:成功率、延迟分布、成本趋势、错误模式。
