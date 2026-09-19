# TUI Token 用量与吞吐率可行性分析

> 状态：调研完成，待实施
> 范围：`apps/kimi-code`（CLI / TUI）
> 关联：subagent tool count running/total 改造（已合入当前分支）

## 背景

当前 TUI 在以下位置展示 token 相关指标：

- footer 第二行：`context: N% (已用 / 上限)` —— 上下文窗口占用率
- 单 Agent / Agent 组卡片：subagent 卡片 header 的 `... · 8.4k tok` —— 子代理累计 token
- 步骤完成时（仅 `KIMI_CODE_DEBUG=1`）：`[Debug] TTFT: ... | TPS: 47.0 tok/s (200 tokens in 4.3s)` —— 单步 TPS 调试行

尚未暴露给用户的两类指标：

1. **session 累计 token 用量**（`AppState.cumulativeTokens` 数据已采，未渲染）
2. **稳定 TPS**（step 完成后那个快照，调试代码已写，未常驻显示）
3. **实时 streaming TPS**（step 进行中的滚动平均，未实现）

## 数据基础

| 指标 | 数据源 | 已就位 |
|---|---|---|
| Session 累计 tokens | `AppState.cumulativeTokens: number`（`apps/kimi-code/src/tui/types.ts:65`）<br>由 `session-event-handler.ts:750-752` 在每个 `AgentStatusUpdatedEvent` 里更新：`patch.cumulativeTokens = sumTokenUsage(event.usage.total)` | ✅ 数据流已通 |
| Step 级 TPS（已完成） | `TurnStepCompletedEvent.usage.output` + `event.llmStreamDurationMs`（`packages/agent-core-v2/src/agent/loop/turnEvents.ts:118-121`）<br>已有纯函数 `formatStepDebugTiming`（`apps/kimi-code/src/utils/usage/debug-timing.ts:39-78`），含 50ms 防抖门槛 | ✅ 函数已存在，仅 `KIMI_CODE_DEBUG=1` 时显示 |
| 实时 streaming TPS | 需订阅 `AssistantDeltaEvent` / `ThinkingDeltaEvent` 计数 delta，结合 `streamingStartTime`（`types.ts:69`） | ⚠️ 需新建小型 controller |

`sumTokenUsage` 已在 `types.ts:99-101` 实现：

```ts
export function sumTokenUsage(total: TokenUsage): number {
  return total.inputOther + total.output + total.inputCacheRead + total.inputCacheCreation;
}
```

## 改造方案（按优先级）

### ① footer 显示累计 tokens（约 0.5h）

只改 footer，加一个 `tokens` slot。

```ts
// types.ts（已有 cumulativeTokens，无需新增）
// 新增 helper：formatCumulativeTokens(state.cumulativeTokens)

// footer.ts buildSlots：新增分支
if (state.cumulativeTokens !== undefined && state.cumulativeTokens > 0) {
  slots['tokens'] = [chalk.hex(colors.textDim)(`tokens ${formatTokenCount(state.cumulativeTokens)}`)];
}
```

- 位置：line 1 的可配置 slots
- 配置项：加入 `DEFAULT_STATUS_LINE_ITEMS`
- 用户可通过 `status_line.items = [...]` 自定义

### ② 显示"最近一个已完成 step 的稳定 TPS"（约 1h）

把 `formatStepDebugTiming` 里的 TPS 计算抽成纯函数 `formatStepTps(usage, streamMs)`：

- 步骤完成时（`handleStepCompleted`），把 `(lastTps, lastOutputTokens, lastStreamMs)` 写入 `AppState.stepTiming?: { tps, output, streamMs }`
- footer 新增 `tps` slot，渲染 `47 tok/s`（沿用 `MIN_STREAM_MS_FOR_TPS = 50` 防抖）
- step 未完成或过短时显示空（不要显示"万 tok/s"的伪值）

### ③ 实时 streaming TPS（可选，约 2h）

需要新写 `StreamingTpsCounter` controller：

- 订阅 `AssistantDeltaEvent` / `ThinkingDeltaEvent`，累加字符/字节量
- 配合 1Hz timer（`ui.requestRender` 驱动）输出过去 N 秒平均速率
- footer 显示 `live: 47 tok/s` slot；step 完成时切到 ② 的稳定值

注意事项：delta event 通常按 byte 计数，需对齐 provider tokenizer。当前 `debug-timing.ts` 只在 step 完成后用 `usage.output`（provider 报告的真实 token 数），是更准的；streaming 实时值只能算"字符/秒"近似。

## 设计决策（待对齐）

### 1. 显示粒度

候选格式：

- `tokens 12.3k`（最简，只显示累计）
- `in 10k out 2.3k`（拆 input / output）
- `12.3k tokens · 47 tok/s`（累计 + TPS 一行）

### 2. 位置

候选位置：

- footer line 1：与 `mode` / `model` / `cwd` / `git` 同级（可配置开关）
- footer line 2：与 `context: N%` 同级（右侧挤入）
- 两者都加

### 3. 重置时机

`cumulativeTokens` 当前是 session 级（survive across turns）。可选项：

- 仅 session 累计（现状）
- session 累计 + 当前 turn 独立（turn 开始时清零）

### 4. 配置接入

`status_line.items` 已经支持用户自定义 slot 顺序和启停（`apps/kimi-code/src/tui/components/chrome/footer.ts:43`），新增 `tokens` / `tps` slot 与既有 `usage` / `tasks` 一致即可。

## 风险评估

| 风险 | 等级 | 缓解 |
|---|---|---|
| 公开 SDK 协议变更 | 无 | `cumulativeTokens` 已是 `AppState` 字段，不外暴露；新增 `stepTiming?` 可选字段，**非破坏性** |
| LLM loop 行为变更 | 无 | 改动只在 footer 渲染层 + `handleStepCompleted` 写状态，不动 loop 主体 |
| 大数格式化 | 无 | `formatTokenCount`（`apps/kimi-code/src/utils/usage/usage-format.ts`）已处理 1024-based 简写 |
| TPS 短窗口抖动 | 低 | 沿用 `MIN_STREAM_MS_FOR_TPS = 50` 防抖门槛，过短显示原始计数 |
| 实时 TPS 字符/token 偏差 | 中 | 标注为"字符/秒"近似而非"token/秒"；或仅作为实验性开关 |

## 实施路线建议

**两步走**：

1. **第一步（必做，~1.5h）**：①+② 同时实施。两者共用 `formatTokenCount`、复用既有数据源。
2. **第二步（评估后决定，~2h）**：③ 实时 streaming TPS。作为 `KIMI_CODE_EXPERIMENTAL_TPS_LIVE` 灰度开关，默认关闭。

## 参考资料

- `apps/kimi-code/src/tui/types.ts` — `AppState`、`sumTokenUsage`
- `apps/kimi-code/src/tui/controllers/session-event-handler.ts:750-752` — `cumulativeTokens` 更新点
- `apps/kimi-code/src/utils/usage/debug-timing.ts:39-78` — 既有 TPS 计算
- `packages/agent-core-v2/src/agent/loop/turnEvents.ts:113-129` — `TurnStepCompletedPayload`
- `apps/kimi-code/src/tui/components/chrome/footer.ts:43, 477-491` — 既有 footer slot 机制