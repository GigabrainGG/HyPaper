import { describe, it, expect, vi } from 'vitest';

// Mock redis to prevent real connection during import
vi.mock('../store/redis.js', () => ({
  redis: {},
}));

import { calculatePositionUnrealizedPnl, calculateLiquidationPrice } from '../engine/margin.js';

describe('margin calculations', () => {
  describe('calculatePositionUnrealizedPnl', () => {
    it('returns 0 for zero position', () => {
      expect(calculatePositionUnrealizedPnl('0', '50000', '51000')).toBe('0');
    });

    describe('long positions (szi > 0)', () => {
      it('calculates profit when price goes up', () => {
        // Long 1 BTC @ 50000, mark at 51000 → PnL = (51000-50000)*1 = 1000
        expect(calculatePositionUnrealizedPnl('1', '50000', '51000')).toBe('1000');
      });

      it('calculates loss when price goes down', () => {
        // Long 1 BTC @ 50000, mark at 49000 → PnL = (49000-50000)*1 = -1000
        expect(calculatePositionUnrealizedPnl('1', '50000', '49000')).toBe('-1000');
      });

      it('handles fractional sizes', () => {
        // Long 0.5 BTC @ 50000, mark at 52000 → PnL = (52000-50000)*0.5 = 1000
        expect(calculatePositionUnrealizedPnl('0.5', '50000', '52000')).toBe('1000');
      });

      it('returns 0 when mark equals entry', () => {
        expect(calculatePositionUnrealizedPnl('1', '50000', '50000')).toBe('0');
      });
    });

    describe('short positions (szi < 0)', () => {
      it('calculates profit when price goes down', () => {
        // Short 1 BTC @ 50000, mark at 49000 → PnL = (50000-49000)*1 = 1000
        expect(calculatePositionUnrealizedPnl('-1', '50000', '49000')).toBe('1000');
      });

      it('calculates loss when price goes up', () => {
        // Short 1 BTC @ 50000, mark at 51000 → PnL = (50000-51000)*1 = -1000
        expect(calculatePositionUnrealizedPnl('-1', '50000', '51000')).toBe('-1000');
      });

      it('handles fractional short sizes', () => {
        // Short 2.5 ETH @ 3000, mark at 2800 → PnL = (3000-2800)*2.5 = 500
        expect(calculatePositionUnrealizedPnl('-2.5', '3000', '2800')).toBe('500');
      });
    });

    describe('realistic trading scenarios', () => {
      it('large BTC long with small price movement', () => {
        // Long 10 BTC @ 97500, mark at 97510
        const pnl = calculatePositionUnrealizedPnl('10', '97500', '97510');
        expect(pnl).toBe('100');
      });

      it('small ETH short with big price drop', () => {
        // Short 0.1 ETH @ 3500, mark at 3000
        const pnl = calculatePositionUnrealizedPnl('-0.1', '3500', '3000');
        expect(pnl).toBe('50');
      });
    });
  });

  describe('calculateLiquidationPrice', () => {
    it('returns null for zero position', () => {
      expect(calculateLiquidationPrice('0', '50000', '100000', 20)).toBeNull();
    });

    describe('long positions', () => {
      it('calculates liquidation price for a long', () => {
        // Long 1 BTC @ 50000, 20x leverage
        // liqPx = entryPx * (1 - 1/lev + 1/(2*lev))
        // = 50000 * (1 - 0.05 + 0.025) = 50000 * 0.975 = 48750
        const liqPx = calculateLiquidationPrice('1', '50000', '100000', 20);
        expect(liqPx).toBe('48750');
      });

      it('liquidation is closer to entry with higher leverage', () => {
        const liq10x = calculateLiquidationPrice('1', '50000', '100000', 10);
        const liq50x = calculateLiquidationPrice('1', '50000', '100000', 50);
        // Higher leverage = closer liquidation
        expect(Number(liq50x)).toBeGreaterThan(Number(liq10x!));
      });

      it('does not return negative liquidation price', () => {
        const liqPx = calculateLiquidationPrice('1', '100', '100000', 1);
        expect(Number(liqPx)).toBeGreaterThanOrEqual(0);
      });
    });

    describe('short positions', () => {
      it('calculates liquidation price for a short', () => {
        // Short 1 BTC @ 50000, 20x leverage
        // liqPx = entryPx * (1 + 1/lev - 1/(2*lev))
        // = 50000 * (1 + 0.05 - 0.025) = 50000 * 1.025 = 51250
        const liqPx = calculateLiquidationPrice('-1', '50000', '100000', 20);
        expect(liqPx).toBe('51250');
      });

      it('liquidation is closer to entry with higher leverage', () => {
        const liq10x = calculateLiquidationPrice('-1', '50000', '100000', 10);
        const liq50x = calculateLiquidationPrice('-1', '50000', '100000', 50);
        // Higher leverage for shorts = lower liq price (closer to entry)
        expect(Number(liq50x)).toBeLessThan(Number(liq10x!));
      });
    });

    describe('leverage edge cases', () => {
      it('1x leverage: wide liquidation distance', () => {
        const liqPx = calculateLiquidationPrice('1', '50000', '100000', 1);
        // 50000 * (1 - 1 + 0.5) = 25000
        expect(liqPx).toBe('25000');
      });

      it('200x leverage: very tight liquidation', () => {
        const liqPx = calculateLiquidationPrice('1', '50000', '100000', 200);
        // Very close to entry
        expect(Number(liqPx)).toBeGreaterThan(49800);
        expect(Number(liqPx)).toBeLessThan(50000);
      });
    });
  });
});
