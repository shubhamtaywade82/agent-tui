/**
 * Domain-scoped ToolRegistry builders. Each domain gets its own registry
 * so System 1 routing can hand System 2 a tightly-scoped tool surface —
 * a market-data question never sees the backtest tools, and vice versa.
 *
 * Tools are built with the SDK's {@link defineTool} + Zod schemas, which
 * gives full type inference on `execute` and automatic JSON-schema
 * conversion for the wire.
 */

import { type AnyTool, defineTool, ToolRegistry } from '@nemesis-oss/ollama-sdk';
import { z } from 'zod';

import type { DomainRoute, HarnessTool } from './types.js';

/**
 * Convert a {@link HarnessTool} (schema-first, framework-agnostic) into an
 * SDK {@link AnyTool} via {@link defineTool}. Lets callers register tools
 * without importing the SDK's internal `Tool` type.
 */
export function toSdkTool(tool: HarnessTool): AnyTool {
  return defineTool({
    name: tool.name,
    description: tool.description,
    schema: tool.schema,
    execute: async (params) => tool.execute(params),
    ...(tool.timeoutMs !== undefined ? { timeoutMs: tool.timeoutMs } : {}),
  });
}

/**
 * Build the market-data registry. The reference implementation ships a
 * `fetch_binance_klines` tool; callers can {@link registry.register} more
 * market tools (orderbook, funding rate, etc.) on top.
 */
export function createMarketDataRegistry(extra: readonly HarnessTool[] = []): ToolRegistry {
  const klines = defineTool({
    name: 'fetch_binance_klines',
    description: 'Fetch OHLCV candles from Binance USD-M Futures REST API.',
    schema: z.object({
      symbol: z.string().describe('Trading pair, e.g. BTCUSDT'),
      interval: z.enum(['1m', '5m', '15m', '1h', '4h']),
      limit: z.number().int().min(1).max(1500).describe('Candle count (max 1500)'),
    }),
    execute: async ({ symbol, interval, limit }) => {
      const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`binance klines ${res.status}: ${await res.text()}`);
      return res.json();
    },
  });
  const registry = new ToolRegistry([klines, ...extra.map(toSdkTool)]);
  return registry;
}

/**
 * Build the backtest registry. The reference implementation ships a
 * `run_backtest` stub; production callers should register a real one.
 */
export function createBacktestRegistry(extra: readonly HarnessTool[] = []): ToolRegistry {
  const backtest = defineTool({
    name: 'run_backtest',
    description: 'Run a 1m-granularity in-sample/out-of-sample strategy simulation.',
    schema: z.object({
      strategyId: z.string().describe('Strategy identifier'),
      window: z.enum(['in_sample', 'out_of_sample']),
    }),
    execute: async ({ strategyId, window }) => {
      // Reference stub — replace with a real backtest engine in production.
      return { strategyId, window, profitFactor: 1.74, maxDrawdownPct: 4.2 };
    },
  });
  const registry = new ToolRegistry([backtest, ...extra.map(toSdkTool)]);
  return registry;
}

/**
 * Build the full domain→registry map. The `direct_reply` route needs no
 * registry (it bypasses the tool loop), so it is intentionally absent.
 */
export function createDomainRegistries(
  extras: Partial<Record<Exclude<DomainRoute, 'direct_reply'>, readonly HarnessTool[]>> = {},
): Record<string, ToolRegistry> {
  return {
    market_data: createMarketDataRegistry(extras.market_data),
    backtest: createBacktestRegistry(extras.backtest),
  };
}
