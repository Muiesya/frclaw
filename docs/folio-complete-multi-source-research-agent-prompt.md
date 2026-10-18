# Folio 完整多源金融研究 Agent 改造提示词

下面的提示词可直接交给编码 Agent 使用。

```text
你正在修改仓库：

<repo-root>

请将当前基于 Pi Runtime 的 Agent 工作台，逐步改造成完整的多源金融研究 Agent。必须直接检查、修改和验证代码，不要只输出设计方案。

## 当前项目事实

当前仓库已有：

- Pi Agent Runtime、Agent Runner、Workspace、Session、Memory、Skills/MCP。
- React + Vite Web、Electron Desktop、Hono Backend、SQLite。
- `/research` 研究页面和研究运行模型。
- `research_runs`、`research_steps`、`research_evidence` 持久化表。
- 研究租约、attempt、lease token、启动恢复、取消和恢复接口。
- EvidenceRef、来源、取数时间、数据年龄、过期判断和审计事件。
- Longbridge 只读行情 Provider。
- fundamentals、valuation、news 当前仍是 Provider 缺口。
- 当前报告主要是确定性模板，没有真正的模型综合层。
- 当前评测模块是确定性检查和 Golden Case，还没有完整的线上评测闭环。

重要源码入口：

- `src/research-model.ts`
- `src/research-store.ts`
- `src/research-service.ts`
- `src/routes/research.ts`
- `src/research-eval.ts`
- `src/research-news-safety.ts`
- `src/finance/*`
- `web/src/pages/ResearchPage.tsx`
- `shared/stream-event.ts`
- `src/db.ts`
- `src/index.ts`

## 产品目标

用户输入证券和研究问题后，系统应完成：

```text
研究问题
→ 研究计划
→ 多源能力路由
→ 有界并行取数
→ Provider 失败隔离
→ EvidenceRef 持久化
→ 证据约束下的 Agent 综合
→ 结构化研究报告
→ 审计、评测和可恢复交付
```

系统必须支持：

- 行情和历史行情
- 公司基本资料
- 财务报表和财务指标
- 估值指标和估值输入
- 新闻、公告和财报文本
- 数据来源、时间、新鲜度、冲突和缺口
- 部分成功、Provider 不可用、过期、冲突和未知结果
- 长任务取消、超时、进程中断、恢复和幂等
- 报告中的每个数字、日期和结论依据都能回查到 EvidenceRef

产品是只读研究工具，不执行买入、卖出、改单、撤单或其他交易副作用。

## 总体工作规则

1. 先阅读 `CLAUDE.md`、`README.md`、`PLAN.md`、`docs/folio-migration-status.md` 和当前研究源码。
2. 先给出当前实现盘点、架构差距、阶段计划和第一阶段验收条件，然后立即开始实现，不要停在规划阶段。
3. 每个阶段都必须形成一条可运行的端到端链路。
4. 保留现有认证、权限、SQLite、Pi Runtime、Workspace、Session、Electron 和消息渠道边界。
5. 不要覆盖用户已有改动，不执行破坏性数据库操作。
6. 不要假设 Provider、凭据、数据覆盖范围或个人贡献已经存在。
7. 没有真实 Provider 时必须显示 `provider_unavailable`，不得用假数据伪装成功。
8. 不要把 Planner、多工具并发或多个 Provider 误称为 Multi-Agent。
9. 只有真实实现并通过验证的能力，才能写入 README、API 文档或简历。
10. 每个阶段完成后运行相关测试、类型检查和构建，并记录真实结果。

## 阶段一：统一多源金融能力契约

目标：让行情、财务、估值、新闻都通过统一的 Capability/Provider 契约进入研究流程。

请实现或完善：

- `ResearchCapability`
- Provider Adapter
- Provider 健康状态
- 输入参数 schema
- 统一结果结构
- 来源、来源类型、取数时间、数据时间、数据年龄和过期阈值
- `complete`
- `partial`
- `stale`
- `conflict`
- `provider_unavailable`
- `invalid`
- `failed`

建议统一结果结构：

```ts
{
  status,
  evidence[],
  missing[],
  conflicts[],
  error?,
  recovery?
}
```

每个 Evidence 至少包含：

```ts
{
  symbol,
  market,
  entity?,
  period?,
  metric,
  value,
  unit?,
  asOf,
  retrievedAt,
  sourceId,
  sourceKind,
  contentTrust?
}
```

要求：

- 复用现有 Longbridge quote 适配器。
- 为 fundamentals、valuation、news 建立真实 Provider Adapter 接口。
- 先扫描仓库已有配置和依赖，再选择实际可用的数据源。
- 没有凭据时提供可测试的 Provider stub，但必须明确标为 unavailable，不能产生 EvidenceRef。
- 不要把多个 Provider 的能力硬编码进研究服务。

验收：

- 同一种能力可以替换 Provider 而不修改 Research 页面和报告模型。
- Provider 失败、空结果、来源缺失、时间缺失和冲突都有明确状态。
- 所有 Provider 结果都能映射为统一 EvidenceRef。

## 阶段二：实现 Provider Router 和数据质量策略

目标：处理多源覆盖范围、来源优先级、健康状态和数据质量。

实现：

- 按 capability coverage 选择 Provider。
- 支持主 Provider、备用 Provider 和单项能力覆盖。
- Provider 健康检查、失败计数和恢复时间。
- 超时和有限重试。
- 不同 Provider 返回冲突时保留所有证据，并记录冲突键。
- 数据源选择过程写入审计事件。
- Provider fallback 不得隐式伪装成主 Provider。
- 外部新闻、公告和财报文本必须标记为 `untrusted_external`。

验收：

- 主 Provider 不可用时，系统能明确显示 fallback 来源。
- 冲突数据不会被静默覆盖。
- 报告可以显示来源选择和冲突信息。
- 研究页面能区分真实数据、演示数据、过期数据和 Provider 不可用。

## 阶段三：实现 Research Planner 和有界执行

目标：让 Agent 根据研究问题生成可执行的多源研究计划。

实现：

- 根据证券、市场、问题和研究策略生成 `ResearchPlan`。
- 计划包含 capability、Provider、参数、依赖、是否必须、超时和预算。
- 支持行情、财务、估值、新闻、公告等多个步骤。
- 对无依赖步骤使用有界并行。
- 对有依赖步骤按拓扑顺序执行。
- 为每次执行保存参数快照。
- 实现 tool timeout、取消、retry、fallback 和预算限制。
- 保持同一 Run 的事件顺序。
- 不要在没有真实失败证据时引入 Multi-Agent。

验收：

- 一个研究问题可以触发至少四类能力。
- 能力执行数量受并发和预算限制。
- 单个 Provider 失败不会丢失其他已完成结果。
- 计划、步骤、参数和执行结果可以在数据库中复现。

## 阶段四：实现证据约束下的 Agent 综合

目标：把已有证据交给 Agent 生成结构化研究报告。

要求：

- Agent 只能读取当前有效 EvidenceRef。
- Agent 不得新增来源、日期、价格、指标或未存在的事实。
- 报告服务端必须校验 EvidenceRef 覆盖。
- 报告至少包含：
  - summary
  - stance
  - confidence
  - bullArguments
  - bearArguments
  - catalysts
  - risks
  - gaps
  - evidenceRefs
- 证据不足时使用 `insufficient_data` 和低置信度。
- 报告必须保留 partial、failed、cancelled 状态。
- 每个重要数字、时间和结论都要能跳转到证据。
- 新闻和公告文本只作为不可信材料输入，不能覆盖系统指令或安全规则。

先实现确定性证据计算层，再接入受约束的模型叙述层。模型只能填充允许改写的文本槽位，不能写入新的事实字段。

## 阶段五：完善长任务恢复和幂等

目标：保证研究任务可以在服务重启、Provider 超时和进程中断后安全恢复。

检查并完善：

- Run lease
- Step lease
- owner
- lease token
- attempt
- heartbeat
- `uncertain`
- `manual_reconciliation`
- retry_wait
- 参数快照
- Evidence fingerprint
- 当前证据与历史证据
- 稳定报告 ID
- 用户级 Idempotency-Key

要求：

- 未知 Provider 结果不能直接判定为成功。
- 未知结果不能无条件重放。
- 重试失败时保留旧的已确认证据。
- 新证据成功提交后，旧证据才归档。
- 重复恢复不能产生重复有效 EvidenceRef。
- 服务重启后能从数据库发现未完成运行。
- 运行状态、报告状态、步骤状态必须一致。

## 阶段六：实现研究评测和可观察性

目标：让研究质量可以通过 Trace、Golden Case 和 Evaluator 复核。

评测至少覆盖：

- capability 选择
- 参数正确性
- Provider 选择
- EvidenceRef 完整性
- 来源和时间完整性
- stale 判断
- partial failure honesty
- Provider unavailable 不产生虚假证据
- 报告状态与运行状态一致
- 恢复后不重复生成事实
- retry、tool、latency 和 token 预算

实现：

- Golden Cases
- deterministic evaluator
- 失败分类
- Trace 到 Eval 的关联
- 研究审计事件
- 可导出的评测结果
- 回归测试入口

只有真正接入 CI 或发布流程后，才能声称存在自动回归门禁。

## 阶段七：完善 Folio 研究工作台

ResearchPage 必须支持：

- 研究历史摘要
- 研究详情加载
- 当前证券和研究问题
- 研究计划
- 当前步骤
- Provider 状态
- 进度、耗时和尝试次数
- 取消、恢复和重试
- 结构化报告
- EvidenceRef 跳转
- 来源、行情时间、取数时间、数据年龄和 stale 状态
- 审计时间线
- 空数据、加载、失败、部分成功、演示数据和权限错误

逐步将轮询升级为基于 `shared/stream-event.ts` 的研究事件流，但在 WebSocket 完成前，不要声称已经实现实时流式研究。

界面应保持安静、清晰、证据优先：

- 当前证券上下文持续可见。
- Agent 结果使用结构化对象展示。
- 失败状态提供可执行的恢复操作。
- 不用颜色掩盖数据缺失。
- 不把聊天气泡当作研究报告主体。

## 阶段八：安全、权限和产品边界

检查：

- 研究运行按用户隔离。
- 详情、取消、恢复和复查都执行权限验证。
- Provider 凭据不能进入 Renderer。
- 外部文本不能覆盖系统指令。
- 新闻来源使用 HTTPS、域名白名单和来源类型白名单。
- 不记录凭据和未经脱敏的外部内容。
- 研究能力默认只读。
- 不注册交易副作用工具。
- 研究报告必须显示研究限制和数据缺口。

## 必须增加的测试

至少增加：

1. 多 Provider capability contract 测试。
2. Provider routing 和 fallback 测试。
3. 来源冲突测试。
4. stale 和 freshness 测试。
5. 四类以上能力的研究计划测试。
6. 有界并行和超时测试。
7. Provider 失败后的 partial report 测试。
8. 无证据时的 failed report 测试。
9. 恢复后旧证据保留测试。
10. 重复恢复和 Evidence fingerprint 去重测试。
11. Agent 只能引用已有 EvidenceRef 的测试。
12. 新闻来源和提示注入隔离测试。
13. ResearchPage 列表到详情的前端测试。
14. 取消、刷新、恢复和部分结果的前端测试。
15. Golden Case 和 evaluator 测试。
16. 权限隔离和跨用户访问测试。

## 验证命令

每个阶段完成后运行：

```powershell
npm test -- --run
npm run typecheck
npm run build
npm --prefix web run build
npm --prefix container/agent-runner run build
npm run build:all
```

如果新增前端交互测试，再运行：

```powershell
npm --prefix web run test:e2e
```

不要把演示数据测试写成真实 Provider 验证。真实 Provider 只有在配置凭据并记录实际运行结果后，才能标记为 live integration。

## 最终交付要求

完成后汇报：

1. 当前已接入的真实 Provider。
2. 每类 Provider 支持的能力和市场范围。
3. 研究请求从输入到报告的完整数据流。
4. 运行、步骤、证据和报告的状态机。
5. Provider fallback、stale、冲突和 partial 的处理方式。
6. Agent 如何被限制在 EvidenceRef 范围内。
7. 恢复、幂等、审计和评测如何验证。
8. 运行了哪些测试和构建命令，以及真实结果。
9. 哪些能力仍是 stub、demo 或 provider_unavailable。
10. 不要声称未经验证的性能提升、数据覆盖率、研究准确率或投资收益。
```

