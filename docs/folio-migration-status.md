# Folio 改造状态

本文记录 Miniclaw 到 Folio 的第一阶段实现边界。当前代码仍以仓库已有接口和模块为准；本文不是 Provider 能力清单。

## 现状盘点

### 保留

- Backend、认证、用户/权限和 SQLite 持久化。
- Agent Profile、Workspace、持久 Session、Memory、Skills/MCP/Plugins。
- Pi Agent Runner、Host/Container 执行、Web 和 Electron Desktop。
- 多渠道消息和 Scheduler。它们暂不删除，后续可作为研究触发、通知和定时复查入口，但不改变研究运行的证据边界。

### 改造

- 现有 Longbridge 只读行情接入继续作为 `quote` 能力和数据源。
- 原 `/finance` 页面继续用于数据源连接和行情查询；新增 `/research` 作为研究运行工作台。
- 研究运行与持久对话 Session 分开建模；研究运行拥有独立计划、能力步骤、证据和报告状态。

### 新增

- `research_runs`：用户、证券、问题、状态、计划、结构化报告、幂等键和持久租约。
- `research_steps`：能力、Provider、参数快照、attempt/token、租约、耗时、错误分类和执行状态。
- `research_evidence`：EvidenceRef、attempt fingerprint、当前版本、来源标识、取数时间、行情时间和时效秒数。
- `/api/research/runs` 创建、列表、详情、取消和恢复接口。
- `/research` 页面：计划执行状态、部分成功/缺口、报告和证据轨迹。

### 暂缓

- 财务、估值、新闻/公告 Provider 尚未在当前仓库中配置，因此当前只规划它们并记录 `provider_unavailable`，不生成占位数据。Longbridge 是当前唯一可用的真实 Provider，需配置用户凭据才会产生 live EvidenceRef。
- 默认 LLM Provider、外部真实 Provider 凭据、渠道通知和定时复查仍需后续配置；当前已提供可插拔综合契约、HTTPS Provider Adapter、新闻白名单链路和 `research:eval` 门禁。

## 第一切片验收边界

1. 输入港股代码（如 `0700.HK`）与研究问题；第一阶段不接受其他市场。
2. 后端持久化一条独立研究运行和四个能力步骤。
3. `quote` 复用现有 Longbridge 只读适配器；研究运行无凭据时为 `provider_unavailable` 且不产生 EvidenceRef。行情页只有显式请求 `demo=1` 时才返回演示数据。
4. 其他未配置能力作为研究缺口显示，不使用零值、虚构来源或虚构时间。
5. 证据写入 `research_evidence`，报告只引用 EvidenceRef ID。
6. 可取消执行；失败、部分成功或进程中断后可通过恢复接口重试未完成步骤，同时保留已完成证据。

## 后续阶段建议

1. 为财务/估值接入明确 Provider 契约和时效策略，并为每个 Provider 增加失败与参数测试。
2. 接入新闻/公告时先做来源白名单、内容不可信标记和提示注入隔离，再允许报告引用。
3. 将报告生成拆为证据计算层和模型叙述层，模型只能消费 EvidenceRef，不能创建来源。
4. 研究运行已通过认证 WebSocket 推送研究 StreamEvent，详情接口仍作为断线恢复来源；Scheduler/渠道通知不把渠道消息当作研究事实。
5. 已增加 `npm run research:eval` 确定性评测命令并接入 CI；真实 Provider 和 live model 评测需配置凭据后单独执行。
