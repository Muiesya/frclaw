# Folio 后续改进计划（草案）

## Context

当前第一切片已经实现证券研究运行、能力步骤、EvidenceRef、部分成功/恢复接口和 `/research` 页面，但仍处于“可验证骨架”阶段：只有 Longbridge 行情真实接入，财务/估值/新闻能力是明确的 Provider 缺口；研究执行、报告质量和评测能力还不足以支持可靠的公开市场研究工作台。

已确认产品决策：

- 第一优先级是研究运行可靠性，而不是先扩展 Provider 数量。
- 第一批市场是港股，证券输入和 Provider 参数先围绕港股代码/交易日语义设计。
- 报告数据和引用必须来自 EvidenceRef；未来 LLM 只能改写已有证据，不能创建数据、来源或时间。

当前代码依据：

- 研究领域模型：`src/research-model.ts`
- 研究持久化：`src/research-store.ts`
- 执行器：`src/research-service.ts`
- API：`src/routes/research.ts`
- 页面：`web/src/pages/ResearchPage.tsx`
- 已有行情 Provider：`src/finance/longbridge-service.ts`、`src/finance/longbridge-agent-capability.ts`
- 数据库迁移入口：`src/db.ts`
- 现有运行时、权限、Workspace、Session、Memory、Skills/MCP 和 Scheduler 保持复用，不直接删除。

## 已识别的主要改进

### P0：可靠性和证据正确性

- 把当前 `activeControllers` 进程内执行升级为持久队列/租约模型；研究不直接伪装成 `task_runs`（后者依赖 `scheduled_tasks`），而是在 `research_runs`/`research_steps` 上实现同等的 claim、lease token、retry_wait 和过期处理。
- 为研究运行和每个能力步骤增加 owner、lease token、lease expiry、heartbeat、attempt、availableAt 和明确的 `uncertain`/`manual_reconciliation` 语义。
- 将外部 Provider 调用视为读取也可能处于未知状态：超时或进程崩溃后不盲目重复，先按幂等键复用已确认结果，无法确认时保留缺口并允许人工恢复。与现有 `failExpiredStartedTaskRuns()` 的“已开始即失败且不重试副作用”语义不同，研究要显式落到 `uncertain`，不能把未知结果伪装成 `failed` 或成功。
- 修复当前恢复路径可能保留旧 EvidenceRef 并追加重复证据的问题：以 capability attempt/证据版本建立唯一边界，报告只引用当前有效证据，同时保留历史尝试轨迹。当前 `resetIncompleteResearchSteps()` 只重置步骤、`addResearchEvidence()` 每次随机生成 ID，必须改为事务内的幂等写入与当前版本筛选。
- 为能力调用增加参数快照、开始/结束时间、超时、重试策略、错误分类和幂等键。
- 将报告状态、步骤状态、Provider 状态和研究缺口统一为可解释的终态。

### P1：数据能力和研究报告

- 先接入一个真实财务数据 Provider，再接入估值数据；每个 Provider 必须通过统一 Capability 契约。
- 新闻/公告接入前增加来源白名单、原文快照、发布时间、抓取时间、内容不可信标记和提示注入隔离。
- 将报告拆成“证据计算层”和“模型叙述层”：模型只能引用已有 EvidenceRef，不能自行创造数据、来源或时间。
- 报告增加可审计的观点依据、数据新鲜度门槛、证据不足时的置信度规则和结构化引用跳转。

### P1：前端工作台体验

- 复用 `shared/stream-event.ts` 作为唯一类型源，增加研究运行/步骤事件，并同步到 Backend、Runner 和 Web copies；由当前轮询逐步升级为 WebSocket/StreamEvent 进度。
- 展示当前步骤、尝试次数、耗时、取消/超时、租约丢失和恢复原因。
- 完整处理加载、空数据、真实数据、演示数据、部分结果、失败和权限错误。
- 增加研究计划、能力详情、报告段落到 EvidenceRef 的联动查看。
- 保留当前证券、研究问题、数据源状态和运行上下文；支持刷新页面后恢复当前运行。

### P2：评测、审计和产品化

- 增加工具选择/参数、来源时效、证据支撑、部分失败、恢复和报告结构评测集。
- 记录研究运行审计事件和 Provider 健康指标，但不记录凭据或未经脱敏的外部内容。
- 将 Scheduler 和消息渠道定位为可选的定时复查/通知入口，不把消息渠道当作研究事实来源。
- 完善 Folio 产品命名、API 文档、权限矩阵和部署/Provider 配置说明。

## Approach

采用连续垂直切片，按以下顺序推进：

1. 先修复研究运行的持久执行与恢复语义，再扩展 Provider。
2. 每接入一个 Provider，同时完成 Capability 适配器、EvidenceRef 映射、失败测试、页面状态和报告引用。
3. 报告生成严格使用已持久化证据；先做确定性结构化报告，再接入受约束的模型叙述。
4. 复用现有 SQLite 迁移、权限中间件、WebSocket/StreamEvent、Scheduler 和测试工具，不重新建设平行运行时。

### 第一阶段执行语义

- `research_runs` 是用户可见的持久任务；`research_steps` 是可独立领取、续租、重试和提交的能力调用。队列 worker 在启动时恢复可安全状态，并通过短轮询继续 claim。
- 运行/步骤写入统一使用 `owner + leaseToken` fencing；续租只延长当前 token，完成、取消、重试和证据提交必须带 token，旧 worker 的迟到写入返回未提交而不改变数据库。
- `queued`/`retry_wait` 可自动 claim；`running` 租约过期前由 owner 续租，过期后不得直接判断成功。未跨越 Provider 调用边界的步骤可重试；已进入调用但结果未知的步骤转 `uncertain`，由恢复接口或人工确认转为 `retry_wait` 或 `manual_reconciliation`。
- 仅对可分类的瞬时错误做有限指数退避；取消、权限、参数、Provider 未配置、冲突和未知结果不自动重放。所有尝试保留参数快照、错误分类、耗时和结束原因。
- EvidenceRef 采用稳定的 `run + step + attempt/version + evidence fingerprint` 幂等边界；成功提交与证据写入同一事务。报告只读取当前有效版本，历史尝试作为审计记录，不成为报告事实。
- 研究报告第一阶段保持确定性模板。所有数值、日期、来源名称和引用 ID 必须从当前有效 EvidenceRef 投影；未来 LLM 只能接收这些 EvidenceRef 和允许改写的文本槽位，并由服务端校验引用覆盖，不能写入新的事实字段。

## 第一阶段范围与验收

第一阶段只做“可恢复的港股研究运行”可靠性切片：保留 Longbridge 只读行情能力，暂不扩大到 A 股或更多 Provider，也不引入能自行生成事实的 LLM 报告。阶段完成必须满足：

- 服务重启后能从持久状态发现未完成运行，并由唯一租约持有者继续或安全转入 `uncertain`/`manual_reconciliation`；不能依赖 `activeControllers` 作为恢复依据。
- 同一用户、同一研究请求和同一能力 attempt 的重复提交、重复恢复、租约过期接管不会产生重复有效 EvidenceRef 或重复报告事实；幂等键至少绑定用户、规范化港股代码、问题/参数快照和研究计划版本。
- 每个有效报告数值和引用都能反查到持久化 EvidenceRef；Provider 缺失、超时、空结果或冲突只能形成明确缺口，不能以零值、Demo 或臆测补齐。
- 取消、超时、重试、进程中断和权限边界均有 API、数据库和测试覆盖；只有真实跑通的检查才写入验证记录。

状态机初稿：`queued -> running -> retry_wait -> running`；能力调用无法确认外部结果时进入 `uncertain -> manual_reconciliation`，明确完成后进入 `completed`，有已确认缺口则进入 `partial`，用户取消进入 `cancelled`，不可恢复错误进入 `failed`。租约失效不能直接宣称成功，也不能无条件重放未知 Provider 调用。

## Files to modify

预计按切片调整，非一次性全部修改：

- `src/research-model.ts`
- `src/research-store.ts`
- `src/research-service.ts`
- `src/research-worker.ts`（或在现有服务中新增持久 worker/pump；以单一实现为准）
- `src/routes/research.ts`（创建请求幂等键、状态/恢复/人工确认语义）
- `src/db.ts`（研究队列/租约/尝试/证据版本迁移与事务）
- `shared/stream-event.ts` 或现有 StreamEvent 类型实现
- `web/src/pages/ResearchPage.tsx`
- `web/src/api/client.ts` 或新增研究 store
- `src/finance/*` 及新增 Provider 适配器
- `tests/`、`web/src/**/*.test.tsx`
- `docs/API.md`、`docs/ACL-MATRIX.md`、`docs/folio-migration-status.md`

## Reuse

- 复用 `src/finance/longbridge-agent-capability.ts` 的只读能力适配模式。
- 复用 `src/db.ts` 的 schema 版本、迁移备份和 SQLite 事务机制。
- 复用 `src/task-scheduler.ts`、`task_runs` 的租约/重试/幂等思路：参考 `claimNextTaskRun()`、`markTaskRunExecutionStarted()`、`renewTaskRunLease()`、`releaseTaskRunForRetry()`、`completeTaskRun()` 的 owner/token fencing；不直接把研究运行伪装成普通聊天 Session。
- 复用 `shared/stream-event.ts` 的 canonical source 和构建复制链路；研究事件应从该文件扩展，再同步到 `src/stream-event.types.ts`、`web/src/stream-event.types.ts` 和 Runner copy，不直接编辑生成副本。
- 复用 `authMiddleware`、现有用户隔离和权限检查。
- 复用现有 Finance 页面中的来源、演示数据和更新时间展示模式。

## Steps

- [x] 根据产品优先级确认第一阶段先做可靠性、首批覆盖港股，且模型只能改写已有 EvidenceRef。
- [x] 在 `src/db.ts` 增加研究队列/租约/尝试/证据版本字段或附属表及必要唯一索引；实现状态机迁移，启动时扫描 `queued/running/retry_wait/uncertain/manual_reconciliation`，只恢复可安全恢复的状态。
- [x] 将能力调用记录补齐参数快照、耗时、重试和错误分类；使用 attempt/version 唯一约束保证 EvidenceRef 不重复且可追溯。研究结果提交必须同时校验 run/step owner、lease token、attempt 和参数快照，旧 worker 的迟到写入必须被拒绝。
- [x] 在 `src/index.ts` 接入研究 worker 的启动、停止和重启扫描；避免只在 HTTP 请求进程内 `void executeResearchRun()`。
- [x] 第一阶段暂不扩大 Provider；保留 Longbridge 港股只读行情和明确的未配置能力缺口。可靠性切片通过后，再接入第一批真实财务/估值数据，补齐来源、时效、空数据、冲突和 Provider 失败处理。
- [x] 接入新闻/公告安全边界和原文证据快照。
- [x] 将报告生成约束为 EvidenceRef 驱动，增加引用覆盖和证据不足测试。
- [x] 将研究页面升级为实时进度和证据联动界面。
- [x] 增加评测、审计和 Scheduler/渠道复查入口。

## Verification

每个切片至少验证：

- Backend `npm run typecheck`、`npm run build`。
- Web `npm --prefix web run build`。
- 相关 Vitest 单元、迁移、路由和前端 DOM 测试。
- Provider 真实失败、演示数据、空结果、超时、取消、租约过期、进程中断、未知状态、重复恢复和 EvidenceRef 去重场景。
- 页面手工检查登录、创建研究、刷新、取消、恢复、部分结果和 EvidenceRef 跳转。
- 只把当前环境真实通过的命令写入 CI/回归门禁。
