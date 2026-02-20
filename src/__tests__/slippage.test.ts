import { describe, it, expect, vi } from 'vitest';

// Mock l2-cache to avoid config/fetch dependency
vi.mock('../utils/l2-cache.js', () => ({
  getL2Book: vi.fn().mockResolvedValue(null),
}));

import { computeVwap } from '../utils/slippage.js';
import type { L2Level } from '../utils/l2-cache.js';

describe('computeVwap', () => {
  describe('fallback behavior', () => {
    it('returns fallback when levels are null', () => {
      const result = computeVwap(null, '1', true, '50000', '49500');
      expect(result).toEqual({ fillPx: '49500', source: 'fallback' });
    });

    it('returns fallback when levels are undefined', () => {
      const result = computeVwap(undefined, '1', true, '50000', '49500');
      expect(result).toEqual({ fillPx: '49500', source: 'fallback' });
    });

    it('returns fallback when levels are empty', () => {
      const result = computeVwap([], '1', true, '50000', '49500');
      expect(result).toEqual({ fillPx: '49500', source: 'fallback' });
    });
  });

  describe('buy orders (walking asks)', () => {
    const asks: L2Level[] = [
      { px: '50000', sz: '1', n: 1 },
      { px: '50010', sz: '2', n: 2 },
      { px: '50020', sz: '3', n: 3 },
    ];

    it('fills entirely from first level', () => {
      const result = computeVwap(asks, '0.5', true, '50100', '49500');
      expect(result.source).toBe('vwap');
      expect(result.fillPx).toBe('50000');
    });

    it('fills exactly at first level', () => {
      const result = computeVwap(asks, '1', true, '50100', '49500');
      expect(result.source).toBe('vwap');
      expect(result.fillPx).toBe('50000');
    });

    it('computes VWAP across two levels', () => {
      // 1 @ 50000 + 1 @ 50010 = 100010 / 2 = 50005
      const result = computeVwap(asks, '2', true, '50100', '49500');
      expect(result.source).toBe('vwap');
      expect(result.fillPx).toBe('50005');
    });

    it('computes VWAP across three levels', () => {
      // 1 @ 50000 + 2 @ 50010 + 1 @ 50020 = 200040 / 4 = 50010
      const result = computeVwap(asks, '4', true, '50100', '49500');
      expect(result.source).toBe('vwap');
      expect(result.fillPx).toBe('50010');
    });

    it('stops at limit price for buys', () => {
      // limit is 50005, so only first level (50000) is available
      // second level at 50010 is beyond limit
      const result = computeVwap(asks, '2', true, '50005', '49500');
      expect(result.source).toBe('vwap');
      // 1 from book at 50000, 1 remainder at worst=50020 clamped to limit=50005
      // VWAP: (1*50000 + 1*50005) / 2 = 50002.5
      expect(result.fillPx).toBe('50002.5');
    });

    it('handles book lacking depth — prices remainder at worst level clamped to limit', () => {
      // asking for 10, book only has 6 (1+2+3)
      // remainder 4 priced at worst level 50020
      const result = computeVwap(asks, '10', true, '51000', '49500');
      expect(result.source).toBe('vwap');
      // (1*50000 + 2*50010 + 3*50020 + 4*50020) / 10
      // = (50000 + 100020 + 150060 + 200080) / 10
      // = 500160 / 10 = 50016
      expect(result.fillPx).toBe('50016');
    });

    it('returns fallback when all levels are beyond limit', () => {
      // limit = 49000, all asks start at 50000
      const result = computeVwap(asks, '1', true, '49000', '48500');
      expect(result).toEqual({ fillPx: '48500', source: 'fallback' });
    });
  });

  describe('sell orders (walking bids)', () => {
    const bids: L2Level[] = [
      { px: '50000', sz: '1', n: 1 },
      { px: '49990', sz: '2', n: 2 },
      { px: '49980', sz: '3', n: 3 },
    ];

    it('fills entirely from first level', () => {
      const result = computeVwap(bids, '0.5', false, '49900', '50100');
      expect(result.source).toBe('vwap');
      expect(result.fillPx).toBe('50000');
    });

    it('computes VWAP for sell across two levels', () => {
      // 1 @ 50000 + 1 @ 49990 = 99990 / 2 = 49995
      const result = computeVwap(bids, '2', false, '49900', '50100');
      expect(result.source).toBe('vwap');
      expect(result.fillPx).toBe('49995');
    });

    it('stops at limit price for sells (skip levels below limit)', () => {
      // limit = 49995, bids: 50000, 49990 (below limit → skip)
      const result = computeVwap(bids, '2', false, '49995', '50100');
      expect(result.source).toBe('vwap');
      // 1 from 50000, remainder at worst=50000 (clamped to limit 49995)
      // (50000 + 49995) / 2 = 49997.5
      expect(result.fillPx).toBe('49997.5');
    });
  });

  describe('null limit price (market orders)', () => {
    const asks: L2Level[] = [
      { px: '50000', sz: '1', n: 1 },
      { px: '50100', sz: '1', n: 1 },
    ];

    it('walks all levels when limit is null', () => {
      const result = computeVwap(asks, '2', true, null, '49500');
      expect(result.source).toBe('vwap');
      expect(result.fillPx).toBe('50050');
    });
  });

  describe('safety clamp', () => {
    it('clamps buy VWAP to limit price', () => {
      // Edge case: book has enough depth but rounding puts VWAP above limit
      const asks: L2Level[] = [
        { px: '50000', sz: '1', n: 1 },
        { px: '50001', sz: '1', n: 1 },
      ];
      const result = computeVwap(asks, '2', true, '50000', '49500');
      // VWAP would be 50000.5 but limit is 50000
      expect(Number(result.fillPx)).toBeLessThanOrEqual(50000);
    });
  });
});
