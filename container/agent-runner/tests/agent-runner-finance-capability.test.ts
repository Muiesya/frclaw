import { describe, expect, test } from 'vitest';

import { createMcpTools, type McpContext } from '../src/mcp-tools.js';
import {
  FINANCE_READ_ONLY_TOOL_NAMES,
  type LongbridgeReadOnlyCapability,
} from '../src/finance/finance-tools.js';
import type { FinanceToolResult } from '../src/finance/finance-evidence.js';

const completeResult: FinanceToolResult = {
  status: 'complete',
  evidence: [],
  missing: [],
  conflicts: [],
};

const capability: LongbridgeReadOnlyCapability = {
  getQuote: async () => completeResult,
  getSecurity: async () => completeResult,
  getPositions: async () => completeResult,
  getHistoricalOrders: async () => completeResult,
};

const baseContext: McpContext = {
  chatJid: 'home',
  groupFolder: 'test-group',
  isHome: true,
  isAdminHome: true,
  agentBuilderEnabled: false,
  ownerProfileEnabled: false,
  workspaceIpc: 'test-ipc',
  workspaceGroup: 'test-group',
};

function financeToolNames(context: McpContext): string[] {
  return createMcpTools(context)
    .map((tool) => tool.name)
    .filter((name) => name.startsWith('longbridge_'));
}

describe('Agent Runner finance capability boundary', () => {
  test('keeps finance tools absent from the default context', () => {
    expect(financeToolNames(baseContext)).toEqual([]);
  });

  test('adds only the read-only finance tools for an explicit capability', () => {
    expect(
      financeToolNames({ ...baseContext, financeReadOnly: capability }),
    ).toEqual([...FINANCE_READ_ONLY_TOOL_NAMES]);
  });
});
