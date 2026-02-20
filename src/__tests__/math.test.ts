import { describe, it, expect } from 'vitest';
import { D, add, sub, mul, div, gt, lt, gte, lte, isZero, abs, neg, min, max, roundToDecimals, roundPx } from '../utils/math.js';

describe('math utilities', () => {
  describe('D (Decimal constructor)', () => {
    it('creates a Decimal from string', () => {
      expect(D('100.5').toString()).toBe('100.5');
    });

    it('creates a Decimal from number', () => {
      expect(D(42).toString()).toBe('42');
    });

    it('handles very large numbers', () => {
      expect(D('99999999999999999999').toString()).toBe('99999999999999999999');
    });

    it('handles very small decimals', () => {
      expect(D('0.000000000000001').toString()).toBe('1e-15');
    });
  });

  describe('add', () => {
    it('adds two positive numbers', () => {
      expect(add('100', '200')).toBe('300');
    });

    it('adds decimals without floating-point drift', () => {
      // 0.1 + 0.2 === 0.3 (not 0.30000000000000004)
      expect(add('0.1', '0.2')).toBe('0.3');
    });

    it('adds negative numbers', () => {
      expect(add('-50', '100')).toBe('50');
    });

    it('adds zero', () => {
      expect(add('100', '0')).toBe('100');
    });

    it('handles large trading values', () => {
      expect(add('50000.12345', '49999.87655')).toBe('100000');
    });
  });

  describe('sub', () => {
    it('subtracts two numbers', () => {
      expect(sub('300', '100')).toBe('200');
    });

    it('returns negative when b > a', () => {
      expect(sub('100', '300')).toBe('-200');
    });

    it('subtracts decimals precisely', () => {
      expect(sub('0.3', '0.1')).toBe('0.2');
    });

    it('computes PnL correctly: (fillPx - entryPx) * size', () => {
      // Long PnL: (51000 - 50000) * 1 = 1000
      const pnl = mul(sub('51000', '50000'), '1');
      expect(pnl).toBe('1000');
    });
  });

  describe('mul', () => {
    it('multiplies two numbers', () => {
      expect(mul('100', '50')).toBe('5000');
    });

    it('multiplies decimals', () => {
      expect(mul('0.01', '50000')).toBe('500');
    });

    it('handles position notional: size * price', () => {
      expect(mul('1.5', '50000')).toBe('75000');
    });

    it('multiplies by zero', () => {
      expect(mul('50000', '0')).toBe('0');
    });

    it('handles negative * positive', () => {
      expect(mul('-1.5', '50000')).toBe('-75000');
    });
  });

  describe('div', () => {
    it('divides two numbers', () => {
      expect(div('100', '4')).toBe('25');
    });

    it('computes margin: notional / leverage', () => {
      // 75000 / 20 = 3750
      expect(div('75000', '20')).toBe('3750');
    });

    it('handles repeating decimals with precision', () => {
      const result = div('100', '3');
      expect(result).toMatch(/^33\.333/);
    });
  });

  describe('comparisons', () => {
    it('gt: greater than', () => {
      expect(gt('100', '50')).toBe(true);
      expect(gt('50', '100')).toBe(false);
      expect(gt('100', '100')).toBe(false);
    });

    it('lt: less than', () => {
      expect(lt('50', '100')).toBe(true);
      expect(lt('100', '50')).toBe(false);
      expect(lt('100', '100')).toBe(false);
    });

    it('gte: greater than or equal', () => {
      expect(gte('100', '100')).toBe(true);
      expect(gte('101', '100')).toBe(true);
      expect(gte('99', '100')).toBe(false);
    });

    it('lte: less than or equal', () => {
      expect(lte('100', '100')).toBe(true);
      expect(lte('99', '100')).toBe(true);
      expect(lte('101', '100')).toBe(false);
    });

    it('compares string decimals correctly (not lexicographic)', () => {
      expect(gt('9', '10')).toBe(false);
      expect(lt('9', '10')).toBe(true);
      expect(gt('50000.5', '50000.49999')).toBe(true);
    });

    it('limit buy fill condition: midPx <= limitPx', () => {
      // Buy should fill when market is at or below limit
      expect(lte('49000', '50000')).toBe(true);
      expect(lte('50000', '50000')).toBe(true);
      expect(lte('51000', '50000')).toBe(false);
    });

    it('limit sell fill condition: midPx >= limitPx', () => {
      // Sell should fill when market is at or above limit
      expect(gte('51000', '50000')).toBe(true);
      expect(gte('50000', '50000')).toBe(true);
      expect(gte('49000', '50000')).toBe(false);
    });
  });

  describe('isZero', () => {
    it('detects zero', () => {
      expect(isZero('0')).toBe(true);
      expect(isZero('0.0')).toBe(true);
      expect(isZero('0.00000')).toBe(true);
    });

    it('rejects non-zero', () => {
      expect(isZero('1')).toBe(false);
      expect(isZero('-1')).toBe(false);
      expect(isZero('0.0001')).toBe(false);
    });
  });

  describe('abs', () => {
    it('returns absolute value of positive', () => {
      expect(abs('100')).toBe('100');
    });

    it('returns absolute value of negative', () => {
      expect(abs('-100')).toBe('100');
    });

    it('handles short position size', () => {
      expect(abs('-1.5')).toBe('1.5');
    });
  });

  describe('neg', () => {
    it('negates positive', () => {
      expect(neg('100')).toBe('-100');
    });

    it('negates negative', () => {
      expect(neg('-100')).toBe('100');
    });

    it('negates zero', () => {
      expect(neg('0')).toBe('0');
    });
  });

  describe('min', () => {
    it('returns the smaller value', () => {
      expect(min('100', '200')).toBe('100');
      expect(min('200', '100')).toBe('100');
    });

    it('handles equal values', () => {
      expect(min('100', '100')).toBe('100');
    });

    it('handles negatives', () => {
      expect(min('-100', '100')).toBe('-100');
    });
  });

  describe('max', () => {
    it('returns the larger value', () => {
      expect(max('100', '200')).toBe('200');
    });
  });

  describe('roundToDecimals', () => {
    it('rounds down to specified decimals', () => {
      expect(roundToDecimals('1.23456', 2)).toBe('1.23');
    });

    it('rounds size to asset decimals', () => {
      expect(roundToDecimals('0.01234', 3)).toBe('0.012');
    });

    it('handles whole numbers', () => {
      expect(roundToDecimals('100', 2)).toBe('100');
    });
  });

  describe('roundPx', () => {
    it('rounds to 5 significant digits', () => {
      expect(roundPx('50123.456')).toBe('50123');
    });

    it('handles small prices', () => {
      expect(roundPx('0.12345678')).toBe('0.12346');
    });
  });
});
