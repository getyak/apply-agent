# Agent 可靠执行：幂等、对账与分类回退

> 实现：`agents/harness/recovery.py` · 数据：migration 031 · API：`GET /api/operations/:id`

## 1. 不变量

Relay、Codex、Claude Code 共用同一恢复顺序：

```text
幂等登记 → 租约 claim → 单次执行 → 只读对账 → 错误分类 → 恢复指令
```

- PostgreSQL `agent_operations` 是执行事实源；Redis 只能用于唤醒。
- 相同用户、操作类型、幂等键只能对应一个 canonical request hash。
- write 在超时、断连或过期租约后先进入 `reconciling`，不能直接重放。
- `unknown` 默认停在 `waiting_user`，不推断为暂时性错误。
- 浏览器最终提交仍发生在用户浏览器；本机制不提供服务器代投能力。
- `submit_form`、`send_email`、`delete_*` 的 HITL 规则不变。

`agent_tasks` 继续记录节点、成本和模型审计，通过 `operation_id` 关联账本；它不负责调度。

## 2. 状态机

```text
pending ─claim─▶ running ─success─▶ succeeded
                   │
                   ├─ safe transient ─▶ waiting_retry ─claim─▶ running
                   ├─ write/unknown outcome ─▶ reconciling
                   └─ permanent/policy ─▶ failed | waiting_user

reconciling ─applied─▶ succeeded
            ├─ proven not applied local write─▶ waiting_retry
            └─ external write or inconclusive─▶ waiting_user
```

`running`/`reconciling` 使用有期限租约。read/compute 的过期租约可以重新执行；write 的过期租约只能被 reconciliation claim。状态提交还会校验 `lease_owner`，过期 executor 不能覆盖新 owner 已确认的结果。终态结果可安全重复读取。

## 3. 错误与回退策略

| 类别 | 行为 |
|---|---|
| `transient` | read/compute 可回退；write 先对账 |
| `throttled` | 同上，并完整遵守 `Retry-After` |
| `ambiguous_effect` | 只对账 |
| `conflict` / `stale_state` | 刷新事实，不做时间重试 |
| `auth` / `validation` | 等待登录或修正输入 |
| `captcha` / `policy` / `user_rejected` | 停止自动执行 |
| `budget` / `content_refused` / `fabrication_blocked` | 当前操作失败 |
| `unknown` | 人工确认 |

OpenRouter 的 HTTP 状态直接按官方契约分类：`402` 为预算耗尽，`429` 为限流，`500/502/503/504/524/529` 为暂时性上游失败；`429/503` 的 `Retry-After` 会完整进入统一回退预算。reconciliation 只对 `transient` / `throttled` 自动重试，未知错误立即停到人工确认。

Full-jitter 公式：

```text
delay = max(Retry-After, random(0, min(cap, base × 2^(attempt-1))))
```

- 网络/上游：500ms 起、8s cap、3 次。
- 限流：2s 起、60s cap、3 次。
- PG serialization/deadlock：100ms 起、2s cap、5 次。
- 对账：1s 起、30s cap、3 次，耗尽转人工。
- 单 operation 默认恢复窗口 120s。

OpenRouter SDK 的内部 retry 被设为 0。模型、节点和 MCP 客户端不得各自叠加预算。

## 4. 公共契约

新 MCP 客户端对 mutation 生成并持久化 16–200 字符的 `idempotency_key`；重试和恢复必须复用原键。未传键的旧客户端每次调用会得到隔离的兼容 operation，不能获得跨调用去重保证。

```json
{
  "operation_id": "uuid",
  "status": "reconciling",
  "result": null,
  "error": {
    "code": "UPSTREAM_TIMEOUT",
    "class": "transient",
    "message": "request timed out"
  },
  "recovery": {
    "action": "reconcile",
    "not_before": null,
    "attempt": 1,
    "max_attempts": 3,
    "reconcile_attempt": 0,
    "max_reconcile_attempts": 3
  }
}
```

MCP 暴露 `get_operation_status` 和 `reconcile_operation`。后者只运行 operation-type 注册的只读探针，绝不调用原副作用。浏览器关键路径的 `authorize_application_submission` 与 `record_application_progress` 已接入；prepare-application LangGraph workflow 也使用同一账本。

Codex/Claude Code 必须按 `recovery.action` 执行：

- `poll`：只查状态。
- `retry`：等到 `not_before`，用原键重试。
- `reconcile`：调用 reconciliation tool，不重复写。
- `reauth` / `fix_input` / `human_review` / `stop`：停止自动推进。

## 5. 浏览器提交

最终点击仍由现有 application-bound authorization receipt + 用户精确短语保护：

1. 点击前签发一次性 receipt，并通过 `operation_id` 绑定签发 operation；响应丢失时只读取回原 receipt。
2. 点击后只接受可见成功页作为 browser confirmation。
3. 记录进度中断时，对账 application projection 与 receipt 消费状态。
4. 不能证明成功时停在 `waiting_user`；绝不再次点击。

CAPTCHA、登录页、安全检查或职位语义漂移仍立即停止批处理。

## 6. 运维信号

以 `agent_operations.id` 作为跨 Agent/MCP/API join key。应监控：

- error class × operation type 的 retry rate；
- reconciliation 的 applied/not-applied/inconclusive 分布；
- `waiting_user` 数量与 age；
- 每 operation 的 attempt、token 和成本；
- 通过幂等 replay 避免的重复写数量。

SSE 的三次 cursor reconnect 仍是独立的传输恢复；它只能续传 frames，不能重新启动业务 operation。
