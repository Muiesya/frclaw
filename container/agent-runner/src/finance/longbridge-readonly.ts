import type { FinanceToolResult } from './finance-evidence.js';

export interface FinanceSymbolQuery {
  symbol: string;
  market: string;
}

export interface FinancePositionsQuery {
  market?: string;
}

export interface FinanceHistoricalOrdersQuery {
  symbol?: string;
  market?: string;
  from?: string;
  to?: string;
  limit: number;
}

export type FinanceQuery =
  | { kind: 'quote'; input: FinanceSymbolQuery }
  | { kind: 'security'; input: FinanceSymbolQuery }
  | { kind: 'positions'; input: FinancePositionsQuery }
  | { kind: 'historical_orders'; input: FinanceHistoricalOrdersQuery };

/**
 * Credential-free port for the finance capability. A host-side adapter owns
 * the Longbridge client, credentials, and provider-specific response mapping.
 */
export interface LongbridgeReadOnlyCapability {
  getQuote(
    input: FinanceSymbolQuery,
    signal: AbortSignal,
  ): Promise<FinanceToolResult>;
  getSecurity(
    input: FinanceSymbolQuery,
    signal: AbortSignal,
  ): Promise<FinanceToolResult>;
  getPositions(
    input: FinancePositionsQuery,
    signal: AbortSignal,
  ): Promise<FinanceToolResult>;
  getHistoricalOrders(
    input: FinanceHistoricalOrdersQuery,
    signal: AbortSignal,
  ): Promise<FinanceToolResult>;
}

export const FINANCE_READ_ONLY_TOOL_NAMES = [
  'longbridge_get_quote',
  'longbridge_get_security',
  'longbridge_get_positions',
  'longbridge_get_historical_orders',
] as const;

export type FinanceReadOnlyToolName =
  (typeof FINANCE_READ_ONLY_TOOL_NAMES)[number];
