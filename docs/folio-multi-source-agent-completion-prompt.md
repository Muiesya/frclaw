# Folio 多源金融研究 Agent 完整化提示词

下面的提示词可直接交给编码 Agent 使用。

```text
你正在修改仓库：

<repo-root>

当前项目已经有港股研究运行、Longbridge quote、EvidenceRef、持久租约、恢复、审计时间线和 ResearchPage。请继续实现以下缺失能力，把第一阶段骨架推进成可运行的多源金融研究 Agent。

不要只写方案。请先检查源码，然后按阶段直接实现、测试和验证。

## 必须完成的目标

1. 接入真实的行情、财务、估值、新闻/公告数据源。
2. 实现 Provider Router、健康检查、fallback 和有界并行。
3. 实现基于已有 EvidenceRef 的 LLM 投研综合。
4. 将研究进度从轮询升级为 StreamEvent/WebSocket。
5. 将 evaluator 接入自动回归门禁。
6. 将新闻 Provider 与提示注入防护接入真实研究链路。

产品保持只读，不得执行买入、卖出、改单、撤单或其他交易副作用。

## 当前源码入口

重点检查：

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
- `.github/workflows/*`
- `package.json`

## 总体约束

- 先阅读 `CLAUDE.md`、`README.md`、`PLAN.md` 和 `docs/folio-migration-status.md`。
- 保留现有认证、权限、SQLite、Pi Runtime、Agent Runner、Workspace、Session、Electron 和消息渠道边界。
- 不覆盖用户已有改动，不执行破坏性数据库操作。
- 不把演示数据、测试 fixture 或占位 Provider 写成真实数据源。
- 所有 Provider 凭据必须来自现有安全配置、环境变量或安全存储，不能写入源码、日志或前端。
- 没有凭据时必须显示明确的配置缺口，不能生成假 EvidenceRef。
- 不要把 Planner、多工具并行或多个 Provider 叫作 Multi-Agent。
- 只有真实实现并通过验证的能力，才能写入文档或简历。

## 阶段一：接入真实多源 Provider

目标：让一次研究至少覆盖四类真实能力：

- quote：实时或最新行情
- fundamentals：公司资料、资产负债表、利润表、现金流或关键财务指标
- valuation：市盈率、市净率、估值区间或可复核估值输入
- news：新闻、公告或财报文本

实现要求：

1. 定义统一的 Provider-neutral Capability Contract。
2. 每个 Provider Adapter 返回统一结果：

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

3. 每条 Evidence 至少包含：

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

4. Provider 必须明确区分 `complete`、`partial`、`stale`、`conflict`、`provider_unavailable`、`invalid` 和 `failed`。
5. 先检查项目现有依赖、Provider 配置和凭据机制，再选择真实数据源。
6. 如果当前环境没有 Provider 凭据，完成 Adapter、配置入口、错误状态和离线契约测试；研究运行显示 `provider_unavailable`，不产生 EvidenceRef，并在最终报告中标注 live integration 被凭据阻塞。

验收：

- quote、fundamentals、valuation、news 都有统一能力接口。
- 至少一个研究请求能获得四类 Provider 的真实或明确失败结果。
- 每条事实都包含来源和时间。
- Provider 失败不会生成 EvidenceRef。
- 研究页面能显示每类数据源的状态和恢复建议。

## 阶段二：实现 Provider Router、fallback 和有界并行

目标：研究服务不能把 Provider 写死在 `createCapabilityRegistry()` 中，也不能顺序执行所有步骤。

实现：

- `ProviderRegistry`
- `ProviderRouter`
- `ProviderHealthStore`
- `ResearchExecutor`
- `ConcurrencyLimiter`

要求：

1. 按 capability coverage 选择 Provider。
2. 支持主 Provider 和备用 Provider。
3. 记录实际使用的 Provider。
4. 实现 Provider 健康检查、失败计数和恢复时间。
5. 仅对可分类的瞬时错误有限重试。
6. 认证失败、参数错误、Provider 未配置、冲突和未知结果不得无限重放。
7. 无依赖能力使用有界并行，有依赖能力按计划顺序执行。
8. 使用 `Promise.allSettled()` 或显式 semaphore，避免一个失败中断全部研究。
9. 每一步保留参数快照、Provider、attempt、耗时和错误分类。
10. fallback 不能伪装成主 Provider。
11. 多源冲突必须保留所有证据并显示冲突键。

验收：

- 一次研究能并行执行至少三类互不依赖能力。
- 并发数有明确上限。
- 一个 Provider 超时不会丢失其他已完成结果。
- Provider fallback 会在 EvidenceRef 和审计日志中留下实际来源。
- 测试覆盖主 Provider 成功、主 Provider 失败、fallback 成功、全部 Provider 失败和来源冲突。

## 阶段三：实现 EvidenceRef 约束下的 LLM 综合

目标：将当前确定性报告升级为真实 Agent 综合，但模型只能使用系统已经确认的证据。

实现：

1. 复用仓库已有 Pi Runtime、Agent Runner 和 Provider 配置。
2. 新增 `ResearchSynthesisService` 或等价模块。
3. LLM 输入只能包含研究问题、证券和市场上下文、当前有效 EvidenceRef、研究缺口、Provider 状态和报告字段说明。
4. LLM 输出必须使用严格 JSON Schema。
5. 服务端校验 JSON 结构、stance、confidence、evidenceRefs、关键事实引用和报告状态。
6. 模型不能创建新的 sourceId、retrievedAt、asOf、metric、numeric value、Provider result 或 EvidenceRef。
7. 没有足够证据时使用 `stance: insufficient_data` 和 `confidence: low`。
8. LLM Provider 不可用时保留确定性证据报告，并明确标记 `synthesis_unavailable`。

报告至少包含：

```ts
{
  summary,
  stance,
  confidence,
  bullArguments,
  bearArguments,
  catalysts,
  risks,
  gaps,
  evidenceRefs
}
```

验收：

- 配置模型后可以完成一次真实的证据约束综合。
- 报告中的每个 EvidenceRef 都能回查数据库。
- 恶意模型输出不存在的来源时，服务端拒绝报告。
- Provider 数据不足时，模型不会自行补充事实。
- 测试覆盖正常输出、非法 JSON、伪造 EvidenceRef、缺证据结论和模型 Provider 失败。

## 阶段四：将研究进度接入 StreamEvent/WebSocket

目标：将 ResearchPage 当前的轮询升级为研究运行事件流。

要求：

1. 以 `shared/stream-event.ts` 为唯一类型源。
2. 增加 `research_run_queued`、`research_run_started`、`research_step_started`、`research_step_progress`、`research_step_completed`、`research_step_failed`、`research_evidence_committed`、`research_run_partial`、`research_run_completed`、`research_run_cancelled` 和 `research_run_recovered` 等事件。
3. 事件至少包含：

```ts
{
  eventId,
  runId,
  stepId?,
  sequence,
  createdAt,
  capability?,
  provider?,
  status?,
  attempt?,
  summary?
}
```

4. 复用现有 WebSocket、认证和事件广播边界。
5. 事件必须按用户和研究运行隔离。
6. 页面断线后通过详情接口重新同步。
7. 数据库仍是最终状态来源，事件只用于进度投影。
8. 保留详情刷新作为断线恢复兜底。

验收：

- ResearchPage 实时显示当前步骤和 Provider 状态。
- 取消、失败、恢复和完成都能在页面看到对应事件。
- 事件序列不会倒退或重复应用。
- 刷新页面后能从数据库恢复当前运行。
- 未认证用户不能订阅其他用户的研究事件。

## 阶段五：将 evaluator 接入自动回归门禁

目标：把 `src/research-eval.ts` 从测试辅助模块升级为可运行的研究回归门禁。

至少覆盖：

- 四类 Provider 全部成功
- quote 成功加其他 Provider 缺口
- 全部 Provider 不可用
- stale 数据
- 多源冲突
- 部分失败
- 恢复后证据保留
- 重复恢复
- 报告伪造 EvidenceRef
- LLM Provider 不可用
- 新闻提示注入文本
- 超过 retry、tool、latency 预算

实现：

1. 保留 deterministic evaluator 和 Golden Cases。
2. 新增可执行命令，例如 `npm run research:eval`。
3. 输出 case id、passed/failed、每项检查、失败原因、版本信息、Provider 模式和是否使用 demo fixture。
4. 将命令接入 GitHub Actions 或仓库现有 CI。
5. 真实 Provider 测试与离线 deterministic 测试分离。
6. 没有凭据的 CI 不得伪造 live Provider 通过，应明确区分 contract pass 和 live integration blocked。
7. 失败时退出码必须非零。

验收：

- 本地命令可以独立运行。
- CI 会阻止研究契约、证据链和状态机回归。
- evaluator 检查运行轨迹、EvidenceRef、Provider 状态和失败处理。
- CI 日志不能输出凭据或完整外部新闻内容。

## 阶段六：完成新闻 Provider 和提示注入防护链路

目标：把已有 `research-news-safety.ts` 接入真实新闻/公告 Provider 和 LLM 综合流程。

要求：

1. Provider 只允许 HTTPS。
2. 来源类型使用白名单，包括 issuer announcement、exchange announcement、licensed news 和 filing。
3. 使用域名白名单。
4. 保存 sourceId、URL、title、content、publishedAt、retrievedAt、contentTrust 和 promptInstructionsAllowed。
5. 所有外部新闻统一标记：

```text
contentTrust: untrusted_external
promptInstructionsAllowed: false
```

6. 清理控制字符和危险内容。
7. 新闻进入 Agent 前必须包装为证据材料，不能作为系统指令。
8. 测试“忽略之前所有指令”、伪造系统消息、恶意工具建议、伪造财务数字、恶意 Markdown、超长文本、非 HTTPS URL、非白名单域名和未允许来源类型。
9. 新闻 Provider 失败、空结果和内容校验失败必须形成明确缺口。
10. 新闻内容不能覆盖系统 Prompt、Agent 权限或研究计划。

验收：

- 真实新闻 Provider 可以写入受信任的来源元数据和不可信正文。
- 恶意新闻文本不会改变 Agent 的系统指令。
- 报告引用新闻时可以回查 URL、发布时间和抓取时间。
- 未通过白名单和内容校验的新闻不会进入 EvidenceRef。
- 测试覆盖真实 Provider 适配、恶意文本、域名拒绝、协议拒绝和来源类型拒绝。

## 数据库、前端和安全要求

- 所有新增字段和表通过现有 SQLite 迁移完成，不删除研究历史。
- ResearchPage 显示当前证券、研究问题、多源计划、实际 Provider、当前步骤、并发和尝试次数、fallback、stale、冲突、LLM synthesis 状态、事件时间线、报告和 EvidenceRef 跳转。
- 页面区分 loading、empty、demo、live、partial、stale、conflict、provider_unavailable、synthesis_unavailable 和 error。
- 研究运行按用户隔离，详情、取消、恢复和复查都执行权限验证。
- Provider 凭据不能进入 Renderer。
- 研究能力默认只读，不注册交易副作用工具。
- 报告必须显示研究限制和数据缺口。

## 必须增加的测试

至少增加：

1. 四类 Capability Contract 测试。
2. Provider Router 和 fallback 测试。
3. 多源并行和并发上限测试。
4. Provider 冲突测试。
5. LLM 结构化输出测试。
6. 伪造 EvidenceRef 拒绝测试。
7. LLM Provider 失败降级测试。
8. Research StreamEvent 顺序测试。
9. WebSocket 用户隔离测试。
10. 断线重新同步测试。
11. `research:eval` 命令测试。
12. CI 失败退出码测试。
13. 新闻 Provider 白名单测试。
14. 新闻提示注入测试。
15. stale、partial、failed 和 conflict 报告测试。
16. 服务重启和重复恢复测试。

## 验证命令

每个阶段完成后运行：

```powershell
npm test -- --run
npm run typecheck
npm run build
npm --prefix web run build
npm --prefix container/agent-runner run build
npm run build:all
npm run research:eval
```

如果有前端端到端测试，再运行：

```powershell
npm --prefix web run test:e2e
```

验证必须记录真实输出。不要把 fixture 测试写成 live Provider 验证。

## 最终完成标准

只有同时满足以下条件，才能在文档中称为“完整多源金融研究 Agent”：

- quote、fundamentals、valuation、news 至少各有一个真实 Provider Adapter。
- Provider Router、健康状态、fallback 和冲突处理已经接入研究运行。
- 研究步骤支持有界并行、超时、取消和明确失败状态。
- Agent 综合只能使用 EvidenceRef，并通过服务端引用校验。
- ResearchPage 使用研究事件流显示实时进度，并支持断线恢复。
- evaluator 已接入命令和 CI 回归门禁。
- 新闻 Provider 已接入来源白名单和提示注入防护。
- 服务重启、重复恢复、Provider 失败和部分成功都有测试。
- 所有构建、类型检查、研究测试和评测门禁通过。

最终汇报必须说明：

1. 接入了哪些真实 Provider。
2. 每个 Provider 支持哪些市场和能力。
3. 哪些功能使用 live 数据，哪些仍是 demo 或 unavailable。
4. 多源研究从计划到报告的完整数据流。
5. Agent 如何被限制在 EvidenceRef 范围内。
6. WebSocket、评测门禁和新闻安全链路的验证结果。
7. 仍然存在的限制。
8. 不要声称未经验证的性能、准确率、数据覆盖率或投资收益。
```

