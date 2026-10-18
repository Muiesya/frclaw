import { z } from 'zod';

import { defineMcpTool, type McpToolResult } from '../mcp-tool-types.js';
import {
  FINANCE_RESULT_STATUS,
  normalizeFinanceResult,
  type FinanceFreshnessPolicy,
  type FinanceToolResult,
} from './finance-evidence.js';
import {
  FINANCE_READ_ONLY_TOOL_NAMES,
  type FinanceHistoricalOrdersQuery,
  type FinancePositionsQuery,
  type FinanceSymbolQuery,
  type LongbridgeReadOnlyCapability,
} from './longbridge-readonly.js';

export { FINANCE_READ_ONLY_TOOL_NAMES } from './longbridge-readonly.js';
export type { LongbridgeReadOnlyCapability } from './longbridge-readonly.js';

const DEFAULT_FRESHNESS: FinanceFreshnessPolicy = {
  now: () => Date.now(),
  maxAgeMs: 5 * 60_000,
};

const symbolSchema = z.string().trim().min(1).max(32);
const marketSchema = z.string().trim().min(1).max(16);
const dateSchema = z.string().datetime();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function signalFromExtra(extra: unknown): AbortSignal {
  if (
    isRecord(extra) &&
    typeof AbortSignal !== 'undefined' &&
    extra.signal instanceof AbortSignal
  ) {
    return extra.signal;
  }
  return new AbortController().signal;
}

function providerUnavailableResult(): FinanceToolResult {
  return {
    status: FINANCE_RESULT_STATUS.providerUnavailable,
    evidence: [],
    missing: [],
    conflicts: [],
    error: {
      code: FINANCE_RESULT_STATUS.providerUnavailable,
      message: 'Longbridge read-only provider unavailable.',
    },
    recovery: '检查 Longbridge 连接配置和网络后重试。',
  };
}

function toMcpResult(payload: FinanceToolResult): McpToolResult {
  const result: McpToolResult = {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
  if (
    payload.status === FINANCE_RESULT_STATUS.invalid ||
    payload.status === FINANCE_RESULT_STATUS.providerUnavailable
  ) {
    result.isError = true;
  }
  return result;
}

async function invokeFinanceCapability(
  extra: unknown,
  call: (signal: AbortSignal) => Promise<FinanceToolResult>,
  freshness: FinanceFreshnessPolicy,
): Promise<McpToolResult> {
  try {
    return toMcpResult(
      normalizeFinanceResult(await call(signalFromExtra(extra)), freshness),
    );
  } catch {
    return toMcpResult(providerUnavailableResult());
  }
}

export function createLongbridgeReadOnlyTools(
  capability: LongbridgeReadOnlyCapability,
  freshness: FinanceFreshnessPolicy = DEFAULT_FRESHNESS,
) {
  const quoteInput = {
    symbol: symbolSchema.describe('证券代码，例如 0700'),
    market: marketSchema.describe('市场代码，例如 HK'),
  };
  const historicalInput = {
    symbol: symbolSchema.optional().describe('可选证券代码'),
    market: marketSchema.optional().describe('可选市场代码'),
    from: dateSchema.optional().describe('可选起始时间'),
    to: dateSchema.optional().describe('可选结束时间'),
    limit: z.number().int().min(1).max(100).default(50),
  };

  return [
    defineMcpTool(
      FINANCE_READ_ONLY_TOOL_NAMES[0],
      'Read-only Longbridge quote lookup. Returns provenance-bearing finance evidence; never submits an order.',
      quoteInput,
      async (args, extra) => {
        const input: FinanceSymbolQuery = {
          symbol: args.symbol.trim(),
          market: args.market.trim(),
        };
        return invokeFinanceCapability(
          extra,
          (signal) => capability.getQuote(input, signal),
          freshness,
        );
      },
    ),
    defineMcpTool(
      FINANCE_READ_ONLY_TOOL_NAMES[1],
      'Read-only Longbridge security profile lookup. Returns provenance-bearing finance evidence; never changes an account.',
      quoteInput,
      async (args, extra) => {
        const input: FinanceSymbolQuery = {
          symbol: args.symbol.trim(),
          market: args.market.trim(),
        };
        return invokeFinanceCapability(
          extra,
          (signal) => capability.getSecurity(input, signal),
          freshness,
        );
      },
    ),
    defineMcpTool(
      FINANCE_READ_ONLY_TOOL_NAMES[2],
      'Read-only Longbridge positions lookup for the host-authorized account. Account credentials are never accepted as tool input.',
      { market: marketSchema.optional().describe('可选市场代码') },
      async (args, extra) => {
        const input: FinancePositionsQuery = {
          market: args.market?.trim(),
        };
        return invokeFinanceCapability(
          extra,
          (signal) => capability.getPositions(input, signal),
          freshness,
        );
      },
    ),
    defineMcpTool(
      FINANCE_READ_ONLY_TOOL_NAMES[3],
      'Read-only Longbridge historical order lookup. Results are historical evidence and this tool cannot submit, cancel, or amend orders.',
      historicalInput,
      async (args, extra) => {
        const input: FinanceHistoricalOrdersQuery = {
          symbol: args.symbol?.trim(),
          market: args.market?.trim(),
          from: args.from,
          to: args.to,
          limit: args.limit,
        };
        return invokeFinanceCapability(
          extra,
          (signal) => capability.getHistoricalOrders(input, signal),
          freshness,
        );
      },
    ),
  ];
}
