/**
 * Domain-scoped ToolRegistry builders. Verifies that tools are registered
 * with the correct names + schemas, and that execute() runs.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createBacktestRegistry,
  createDomainRegistries,
  createMarketDataRegistry,
  toSdkTool,
} from '../../../src/system-one-harness/registries.js';

describe('registries', () => {
  describe('createMarketDataRegistry', () => {
    it('registers fetch_binance_klines with the right schema', () => {
      const registry = createMarketDataRegistry();
      const defs = registry.definitions();
      const klines = defs.find((d) => d.function.name === 'fetch_binance_klines');
      expect(klines).toBeDefined();
      expect(klines?.function.description).toContain('Binance');
      const params = klines?.function.parameters as Record<string, unknown>;
      expect(params?.type).toBe('object');
      expect((params?.required as string[]) ?? []).toEqual(['symbol', 'interval', 'limit']);
    });

    it('accepts extra tools via the extras argument', () => {
      const extra = {
        name: 'fetch_funding_rate',
        description: 'Fetch the funding rate for a symbol.',
        schema: z.object({ symbol: z.string() }),
        execute: async () => ({ rate: 0.0001 }),
      };
      const registry = createMarketDataRegistry([extra]);
      const defs = registry.definitions();
      expect(defs.some((d) => d.function.name === 'fetch_funding_rate')).toBe(true);
      expect(defs.some((d) => d.function.name === 'fetch_binance_klines')).toBe(true);
    });
  });

  describe('createBacktestRegistry', () => {
    it('registers run_backtest and returns a stub result', async () => {
      const registry = createBacktestRegistry();
      const defs = registry.definitions();
      expect(defs.some((d) => d.function.name === 'run_backtest')).toBe(true);

      // Execute the backtest tool directly to verify the stub runs.
      const tool = registry.get('run_backtest');
      expect(tool).toBeDefined();
      const result = await registry.executeToolCall({
        id: 'tc-1',
        function: {
          name: 'run_backtest',
          arguments: { strategyId: 'sma-cross', window: 'in_sample' },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toMatchObject({
          strategyId: 'sma-cross',
          window: 'in_sample',
          profitFactor: 1.74,
        });
      }
    });
  });

  describe('createDomainRegistries', () => {
    it('returns a map with market_data + backtest registries', () => {
      const map = createDomainRegistries();
      expect(Object.keys(map).sort()).toEqual(['backtest', 'market_data']);
      expect(map.market_data.definitions().length).toBeGreaterThan(0);
      expect(map.backtest.definitions().length).toBeGreaterThan(0);
    });
  });

  describe('toSdkTool', () => {
    it('converts a HarnessTool into an SDK AnyTool with the right name', () => {
      const tool = toSdkTool({
        name: 'echo',
        description: 'Echo back the input.',
        schema: z.object({ text: z.string() }),
        execute: async ({ text }) => ({ echoed: text }),
      });
      expect(tool.name).toBe('echo');
      expect(tool.description).toBe('Echo back the input.');
    });
  });
});
