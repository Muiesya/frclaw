# Longbridge Read-only Finance Tool Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a credential-free, provider-neutral Longbridge read-only finance tool slice with provenance-aware evidence results and a default-closed MCP capability boundary.

**Architecture:** Keep finance domain contracts and normalization in focused Agent Runner modules. Inject a `LongbridgeReadOnlyCapability` port into `McpContext`; the existing MCP factory adds four read-only tools only when that capability is explicitly present. Provider credentials, transport, and live API mapping remain outside the Runner and are not implemented in this slice.

**Tech Stack:** TypeScript 5.9, Node.js >=20, Zod 4, Vitest 4, existing FrClaw Agent Runner MCP definitions.

**Spec:** `docs/superpowers/specs/2026-09-16-longbridge-readonly-design.md`

## Global Constraints

- The Runner boundary is credential-free; never add API keys, access tokens, account passwords, or provider clients to `McpContext` or tool results.
- Research tools are read-only; no order submission, cancellation, amendment, or other trade-side-effect tool may be registered.
- Missing provenance is `status: invalid`; do not synthesize missing timestamps or source identifiers.
- Stale observations remain visible as historical evidence and must not be presented as current data.
- Conflicting observations are retained with both source/value pairs; no implicit winner.
- Use injected ports and clocks so the slice is testable without network access or Longbridge credentials.
- Preserve the existing MCP tool contract and Pi runtime loop; do not introduce a second Agent runtime.

### Task 1: Define and test the finance evidence contract

**Files:**

- Create: `container/agent-runner/src/finance/finance-evidence.ts`
- Create: `container/agent-runner/tests/finance-evidence.test.ts`

**Interfaces:**

- Produces `FinanceEvidence`, `FinanceResultStatus`, `FinanceToolResult`, `FinanceFreshnessPolicy`, `normalizeFinanceResult()` and `financeEvidenceConflictKey()` for later tasks.

- [ ] **Step 1: Write the failing tests**

Add tests for a valid result preserving `symbol`, `market`, `asOf`, `retrievedAt`, `sourceId`, and `value`; missing `retrievedAt` returning `invalid` with `retrievedAt` in `missing`; an injected clock marking an old quote `stale`; and two same-key observations from different sources being retained in `conflicts`.

```ts
const now = Date.parse('2026-09-16T08:00:00.000Z');
const evidence = {
  symbol: '0700',
  market: 'HK',
  entity: 'Tencent',
  asOf: '2026-09-16T07:59:00.000Z',
  retrievedAt: '2026-09-16T08:00:00.000Z',
  sourceId: 'longbridge:quote:0700:HK',
  sourceKind: 'longbridge',
  metric: 'last_price',
  value: 512.5,
  unit: 'HKD',
};

expect(
  normalizeFinanceResult(
    { status: 'complete', evidence: [evidence] },
    {
      now: () => now,
      maxAgeMs: 5 * 60_000,
    },
  ),
).toMatchObject({ status: 'complete', evidence: [evidence] });
```

- [ ] **Step 2: Run the focused test and verify it fails for the missing contract**

Run: `npx vitest run container/agent-runner/tests/finance-evidence.test.ts`

Expected: FAIL because `container/agent-runner/src/finance/finance-evidence.ts` and its exported normalization function do not exist.

- [ ] **Step 3: Implement the minimal contract and normalization**

Use const objects instead of enums. Validate required string fields and ISO timestamps with a type guard. Return a provider-neutral result with `missing`, `conflicts`, and an optional safe `recovery` message. Compute staleness from `asOf` and the injected `FinanceFreshnessPolicy`; do not replace malformed or missing timestamps.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `npx vitest run container/agent-runner/tests/finance-evidence.test.ts`

Expected: PASS with all evidence, stale, invalid, and conflict assertions green.

### Task 2: Add the typed Longbridge read-only capability and tool factory

**Files:**

- Create: `container/agent-runner/src/finance/longbridge-readonly.ts`
- Create: `container/agent-runner/src/finance/finance-tools.ts`
- Create: `container/agent-runner/tests/finance-tools.test.ts`

**Interfaces:**

- Consumes the Task 1 finance result contract.
- Produces `LongbridgeReadOnlyCapability`, `FinanceQuery` input types, `FINANCE_READ_ONLY_TOOL_NAMES`, and `createLongbridgeReadOnlyTools()`.

- [ ] **Step 1: Write the failing tests**

Define a fake capability with quote, security, positions, and historical-orders methods. Assert that the factory exposes exactly the four named read-only tools, never exposes `submit_order`, `cancel_order`, or `amend_order`, maps a quote input to the capability, preserves structured evidence JSON, and converts a thrown provider error into `provider_unavailable` with a recovery message.

```ts
expect(tools.map((item) => item.name)).toEqual([
  'longbridge_get_quote',
  'longbridge_get_security',
  'longbridge_get_positions',
  'longbridge_get_historical_orders',
]);
expect(tools.map((item) => item.name)).not.toContain('submit_order');
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npx vitest run container/agent-runner/tests/finance-tools.test.ts`

Expected: FAIL because the capability types and tool factory do not exist.

- [ ] **Step 3: Implement the minimal typed port and tool factory**

Define discriminated request types for quote, security, positions, and historical orders. Use Zod schemas for tool arguments: non-empty bounded `symbol`/`market`, optional bounded query filters, and bounded order result limits. Each handler calls only its corresponding capability method, normalizes the result, serializes only provider-neutral data, and catches errors without serializing the exception object. Extract an `AbortSignal` from the MCP extra value when present and otherwise use a fresh signal.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `npx vitest run container/agent-runner/tests/finance-tools.test.ts`

Expected: PASS with read-only allowlist, input mapping, evidence serialization, and provider failure assertions green.

### Task 3: Gate finance tools behind an explicit Runner capability

**Files:**

- Modify: `container/agent-runner/src/mcp-tools.ts` — add the optional `financeReadOnly` field and append the tool factory only when it is present.
- Create: `container/agent-runner/tests/agent-runner-finance-capability.test.ts`

**Interfaces:**

- Consumes `LongbridgeReadOnlyCapability` and `createLongbridgeReadOnlyTools()` from Task 2.
- Produces the default-closed integration through `McpContext.financeReadOnly?: LongbridgeReadOnlyCapability`.

- [ ] **Step 1: Write the failing integration tests**

Build the smallest valid existing `McpContext` fixture. Assert a context without `financeReadOnly` has no `longbridge_` tools, while the same fixture with a fake read-only capability has exactly the four finance tools. Assert the tool names remain absent from the default context even if the fake capability is defined elsewhere in the test.

- [ ] **Step 2: Run the focused integration test and verify it fails**

Run: `npx vitest run container/agent-runner/tests/agent-runner-finance-capability.test.ts`

Expected: FAIL because `McpContext` has no finance capability field and `createMcpTools()` does not append finance tools.

- [ ] **Step 3: Implement the capability gate**

Import the finance factory, add `financeReadOnly?: LongbridgeReadOnlyCapability` to `McpContext`, and append `createLongbridgeReadOnlyTools(ctx.financeReadOnly)` in `createMcpTools()` only when the field is defined. Do not populate the field in the existing host or standalone Runner context constructors; this keeps the production default closed until a host-side credentialed adapter is added.

- [ ] **Step 4: Run the focused integration test and verify it passes**

Run: `npx vitest run container/agent-runner/tests/agent-runner-finance-capability.test.ts`

Expected: PASS for both the default-closed and explicit-capability cases.

### Task 4: Verify the slice against the repository contracts

**Files:**

- Modify: none unless a test or type error requires a focused correction in the files above.

- [ ] **Step 1: Run all finance tests**

Run: `npx vitest run container/agent-runner/tests/finance-evidence.test.ts container/agent-runner/tests/finance-tools.test.ts container/agent-runner/tests/agent-runner-finance-capability.test.ts`

Expected: PASS with no provider network calls.

- [ ] **Step 2: Run the Agent Runner build and repository typecheck**

Run: `npm --prefix container/agent-runner run build` and `npm run typecheck`

Expected: both commands exit 0.

- [ ] **Step 3: Run the relevant existing MCP contract tests**

Run: `npx vitest run tests/agent-runner-tool-init.integration.test.ts tests/agent-runner-runtime-policy.test.ts tests/effective-mcp-manifest.test.ts`

Expected: PASS, proving the new optional capability does not alter existing MCP policy or manifest behavior.

- [ ] **Step 4: Review the final diff and runtime boundary**

Run: `git -C . status --short` (expected to report the current workspace status) and inspect the changed files. Confirm no secrets, live network calls, trade tools, unrelated refactors, or debug output were added.


