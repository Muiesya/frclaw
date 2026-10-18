# Longbridge Read-only Finance Tool Slice Design

> Status: offline contract slice implemented; no live Longbridge credentials or production connector are claimed.

## Goal

Given a finance question and a provider result, the Agent can request Longbridge-backed read-only data and receive a structured, provenance-bearing result that makes missing, stale, partial, unavailable, and conflicting evidence explicit.

## Context and constraints

- FrClaw already provides the Pi Agent Runtime, in-process MCP tools, effective MCP policy, PromptPlan, Workspace Memory, and durable Turn/Outbox reliability primitives.
- The repository currently has no Longbridge Connector or finance-specific evidence schema.
- The Runner boundary is credential-free. Longbridge credentials and provider clients must remain outside the Runner and be injected only as an explicit capability in a future host adapter.
- This slice does not claim Longbridge API/CLI authorization or live integration.
- Research tools are read-only. Order submission, cancellation, amendment, and any other side-effecting trade operation are excluded and must not appear in the default tool set.

## User stories

1. As a Research Agent, I can call quote, security-profile, positions, and historical-order query tools using only typed read-only inputs.
2. As a reviewer, I can see the symbol, market, entity, period, metric, observation time, retrieval time, and source identity attached to each returned fact.
3. As a reviewer, I can distinguish complete, partial, stale, provider-unavailable, invalid, and conflicting results without the Agent inventing missing facts.
4. As a platform operator, I can expose the finance tools only when the host explicitly grants a read-only finance capability; default Runner contexts expose none.

## Architecture

```text
MCP tool input
  → LongbridgeReadOnlyCapability
  → provider-neutral FinanceEvidence result
  → MCP JSON result
```

The Agent Runner owns the tool schemas and provider-neutral result normalization. A `LongbridgeReadOnlyCapability` is an injected port; it owns provider-specific credentials and transport outside the Runner. The in-process MCP factory appends the finance tools only when that capability is present. This preserves the existing credential-free Runner boundary and keeps the SDK/runtime adapter replaceable.

## Domain contract

The finance module will define:

- `FinanceQuery`: a discriminated union for `quote`, `security`, `positions`, and `historical_orders`.
- `FinanceEvidence`: one fact with `symbol`, `market`, optional `entity`, `period`, and `metric`, plus ISO `asOf`, ISO `retrievedAt`, `sourceId`, `sourceKind`, `value`, and optional `unit`.
- `FinanceResultStatus`: `complete | partial | stale | conflict | provider_unavailable | invalid`.
- `FinanceToolResult`: status, evidence, missing fields, conflicts, and a provider-neutral error/recovery message when applicable.
- `LongbridgeReadOnlyCapability`: four typed read-only methods receiving an `AbortSignal` and returning `FinanceToolResult`.

Normalization is strict: a provider result missing required provenance is invalid rather than silently repaired with the current time. Conflicts preserve all competing evidence and identify the shared comparison key; no source wins implicitly. Staleness is computed from `asOf` against an injected clock and an explicit max-age policy.

## MCP surface and permission boundary

The only finance tool names in this slice are:

- `longbridge_get_quote`
- `longbridge_get_security`
- `longbridge_get_positions`
- `longbridge_get_historical_orders`

The tool schemas accept identifiers and query filters only. They never accept or return API keys, access tokens, account passwords, or provider client objects. No tool with a trade side effect is registered. `createMcpTools()` includes these definitions only when `McpContext.financeReadOnly` is explicitly present.

## Error and recovery behavior

- Invalid inputs are rejected by Zod before the capability is called.
- Missing evidence metadata returns `status: invalid` and lists the missing fields.
- Old observations return `status: stale` and remain visible as historical evidence; they are not presented as current data.
- Provider/network failures return `status: provider_unavailable` with a safe recovery message; raw credentials and provider exception objects are not serialized.
- Partial provider results return `status: partial` with `missing` fields.
- Conflicting observations return `status: conflict` and retain each source/value pair.

## Testing and acceptance

Vitest tests must prove:

1. Every exposed finance tool is in the read-only allowlist, and trade-shaped names are absent.
2. A valid quote result carries all required provenance fields unchanged.
3. Missing provenance is rejected as `invalid`.
4. Staleness is deterministic under an injected clock and max-age policy.
5. Conflicting evidence is preserved rather than overwritten.
6. Provider failures and partial results produce explicit statuses and recovery data.
7. A default `McpContext` without `financeReadOnly` exposes no finance tools.

The repository-wide TypeScript check, targeted finance tests, Agent Runner build, and the existing relevant MCP tests must pass. No live provider claim is accepted without a separate credentialed integration test and recorded evidence.

## Non-goals

- Real Longbridge OAuth/API-key setup or network calls.
- Trade execution, order mutation, approval UI, or order reconciliation.
- Automatic Research Memo generation and reviewer workflow.
- Persisting finance evidence into Workspace Memory; the schema is designed so that a later Memory adapter can store it without changing tool semantics.
- Introducing multi-agent orchestration or changing the existing Pi Runtime loop.
