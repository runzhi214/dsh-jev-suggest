# jev-suggest 设计定稿

一句话：每轮对话正常结束后，两步管线（LLM 生成候选 → systemone 打概率）产出
"下一步建议" chips，展示在输入框上方，点击预填草稿；任何失败该轮静默放弃。

背景与动机见仓库 README；本文只记录拍板决策与理由。日期：2026-10-12。

## 决策表

| # | 决策 | 定案 |
|---|---|---|
| S1 | 独立包还是并入 jev 工具路由插件 | **独立包** `jev-suggest`。jev 是"模型看到哪些工具"（模型侧关注点），本插件是"用户下一步可以做什么"（用户侧关注点）；触发时机、失败语义、发布通道全部不同，合并会让两个互不相干的生命周期共享一个 mode 开关。 |
| S2 | 候选生成与打概率由谁完成 | **两步**：先 `ctx.llm` one-shot 生成 3~5 个上下文定制候选，再 systemone choice 协议对候选集返回概率分布。systemone 只能在给定候选上分配概率，不能生成候选；聊天模型自己报的概率是主观估计未校准，混用会让"概率"一词在 UI 上有两种语义。 |
| S3 | 触发时机 | 仅 `turn/end` 且 `reason.kind === 'completed'`。`aborted/blocked/error/max-tokens` 的轮次没有可信的"对话落点"，建议会误导；`turn/start` 撤回已发布集并作废 in-flight 计算——chips 绝不越过它所描述的那轮。 |
| S4 | 展示面 | `conversation.input.dock`（输入卡片上方，list 槽，session scope）+ 点击 `inputActions.setDraft(label)` 预填草稿。不自动发送：预填让用户过目，权限/审批路径完全不动。 |
| S5 | Host↔浏览器通道 | `ctx.connection.fetch` 路由（`/api/jev-suggest/suggestions` GET + `/click` POST），浏览器侧文档相对路径 2s 轮询。第三方插件无 Typert Remote 入口，轮询是唯一合规通道；建议是幂等只读数据，轮询语义足够。 |
| S6 | 生成调用用哪个模型 | config `provider`/`model` 留空 = 该会话 `request/context` 观察到的 route；未观察到则跳过（`no_provider`）。默认跟随会话模型：建议的"口味"应与用户正在用的模型一致，且零配置可用。 |
| S7 | 概率语义 | systemone 在候选集上的归一化分布，按百分比展示；`minDisplayProbability`(0.05) 以下不发布。不移植 jev 的 pMin/family gate——那是"选择"判据，展示层要完整分布。 |
| S8 | 失败语义 | **fail-closed**：任何一步失败该轮无建议（宁可没有也不显示垃圾）；连续 `failureThreshold`(3) 次进 `failureCooldownMs`(60s) 冷却；401/缺 key 抛 AuthenticationError 单次 surface。与 jev 的 fail-open（工具路由宁可全给）相反——方向由错误的代价决定：工具缺了会卡死任务，chips 缺了只是少一行 UI。 |
| S9 | 去重 | stateKey = (goal, 最后一条 assistant 回复)，TTL `stateTtlMs`(5s) 内不重算。相同状态的两个 turn/end（例如流末尾与提交点重复触发）只算一次。 |
| S10 | shadow 模式 | 计算 + 落日志但不发布。先 shadow 看 `suggest_computed` 的分布质量，再开 `on`。 |
| S11 | 遥测 | JSONL（0600 best-effort），事件 `plugin_start`/`suggest_computed`/`suggest_skipped`/`suggest_error`/`suggest_click`。隐私边界：只落 id、概率、reason、延迟、短 hash sid——**不落 label 文本**（label 即任务内容）。click 带 `stale` 位：过期 generation 的点击照记但不冒充当前。 |
| S12 | 时代标记 | `apply()` 时落 `plugin_start`（version + mode + gate 参数）。调参会静默混合新旧数据，标记使日志分析可按参数世代分段。 |
| S13 | 状态存放 | 会话 facts 走 `WeakMap`（随会话消亡，不进持久 log）；已发布集走 session.id 键控 `Map`（路由查询需要它比会话对象活得久），`session/disposed` 清理。 |
| S14 | UI 文案 | v1 硬编码英文（aria-label），概率用 tabular-nums。i18n 登记延后（见遗留）。 |
| S15 | 客户端半架构 | 单包双半：tsdown 双 entry，client CJS `__ModuleLoader__` 闭包，无 class 私有字段。 |

## 模块布局

```
src/
├── index.ts     host 入口：Config/inject/apply，session 事件接线，路由注册
├── state.ts     SuggestTracker：facts 收集 + 发布集存储 + sid hash
├── generate.ts  候选生成：ctx.llm one-shot → JSON 解析（容错 markdown fence）
├── systemone.ts 打分：choice 协议最小客户端（无 family gate）
├── pipeline.ts  守卫矩阵 + 两步编排 + 失败冷却 + TTL 去重
├── routes.ts    GET suggestions / POST click 纯 handlers
├── jsonl.ts     observer log writer
├── types.ts     wire 类型（client bundle 内联）
└── client/
    ├── index.ts        槽位注册（conversation.input.dock）
    ├── suggest-api.ts  轮询 + click 上报（可注入 fetch，fake-timers 可测）
    └── JevSuggestBar.tsx  chips 渲染 + setDraft 预填
```

## 测试计划（66 用例，全绿）

- state：收集/截断/发布代际/撤回/dispose/sid hash/stateKey/extractText
- generate：正常/fence/畸形/字段过滤/重复 id/剪裁/finish error/abort/throw
- systemone：请求构造/概率映射/幻觉 id 忽略/401/缺 key/429/malformed/model mismatch/timeout/abort
- pipeline：mode off/非 completed/no_context/no_provider/固定 route/TTL 去重/stateKey 变化重算/过滤排序剪裁/shadow/低于阈值/generate 失败冷却/score 失败/成功后计数复位/turn start 撤回/dispose
- routes：GET 命中/miss/400；POST fresh/stale/withdrawn/400
- suggest-api：立即+间隔轮询/相对路径/无 session 静默/错误保持上次/发布 null/disposer/POST click body

## 遗留问题登记

| # | 事项 | 重开触发 |
|---|---|---|
| D1 | UI 文案硬编码英文，未接 locale | 出现第二个语言用户，或需要多语言支持时 |
| D2 | 轮询而非推送 | DSH 向第三方插件开放浏览器推送通道时 |
| D3 | 候选无"为什么"解释 | 用户调研表明需要理由；或生成模型可零成本附带 rationale |
| D4 | 只取最后一条 assistant 回复作上下文 | 建议质量评估显示单轮上下文不足；需要引入会话摘要（注意 token 成本） |
| D5 | 未做 shadow 基线评估 | 开 `on` 之前应先跑 shadow 日志分析 |
| D6 | `stateTtlMs` 与轮询间隔（2s）无耦合校验 | 出现"chips 闪现后立刻消失"类时序 bug 时 |
| D7 | 非 completed 轮次（error/max-tokens）不触发 | 用户反馈"失败后更需要建议"时再评估 |
