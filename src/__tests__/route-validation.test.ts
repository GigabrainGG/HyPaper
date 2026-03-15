import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { RedisMock } from './helpers/redis-mock.js';
import { KEYS } from '../store/keys.js';

const redisMock = new RedisMock();

vi.mock('../store/redis.js', () => ({
  redis: redisMock,
}));

vi.mock('../api/middleware/auth.js', () => ({
  ensureAccount: vi.fn(async () => {}),
}));

vi.mock('../engine/order.js', () => ({
  placeOrders: vi.fn(async () => []),
  cancelOrders: vi.fn(async () => []),
  cancelByCloid: vi.fn(async () => []),
  updateLeverage: vi.fn(async () => {}),
}));

vi.mock('../store/pg-sink.js', () => ({
  upsertUser: vi.fn(async () => {}),
  updateUserBalance: vi.fn(async () => {}),
}));

vi.mock('../config.js', () => ({
  config: {
    DEFAULT_BALANCE: '10000',
    LOG_LEVEL: 'silent',
  },
}));

const { exchangeRouter } = await import('../api/routes/exchange.js');
const { hypaperRouter } = await import('../api/routes/hypaper.js');

describe('route validation', () => {
  beforeEach(() => {
    redisMock.flushall();
  });

  it('rejects NaN order sizes on /exchange', async () => {
    const app = new Hono();
    app.route('/exchange', exchangeRouter);

    const res = await app.request('/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        wallet: '0xabc',
        action: {
          type: 'order',
          orders: [
            {
              a: 0,
              b: true,
              p: '50000',
              s: 'NaN',
              r: false,
              t: { limit: { tif: 'Gtc' } },
            },
          ],
          grouping: 'na',
        },
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      status: 'err',
      response: 'Size and price must be finite positive numbers',
    });
  });

  it('rejects Infinity order prices on /exchange', async () => {
    const app = new Hono();
    app.route('/exchange', exchangeRouter);

    const res = await app.request('/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        wallet: '0xabc',
        action: {
          type: 'order',
          orders: [
            {
              a: 0,
              b: true,
              p: 'Infinity',
              s: '1',
              r: false,
              t: { limit: { tif: 'Gtc' } },
            },
          ],
          grouping: 'na',
        },
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      status: 'err',
      response: 'Size and price must be finite positive numbers',
    });
  });

  it('rejects NaN balances on /hypaper setBalance', async () => {
    const app = new Hono();
    app.route('/hypaper', hypaperRouter);

    const res = await app.request('/hypaper', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'setBalance',
        user: '0xabc',
        balance: Number.NaN,
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'Missing or invalid balance (must be a finite non-negative number)',
    });
  });

  it('rejects negative balances on /hypaper setBalance', async () => {
    const app = new Hono();
    app.route('/hypaper', hypaperRouter);

    const res = await app.request('/hypaper', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'setBalance',
        user: '0xabc',
        balance: -1,
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'Missing or invalid balance (must be a finite non-negative number)',
    });
  });

  it('accepts valid finite non-negative balances on /hypaper setBalance', async () => {
    const app = new Hono();
    app.route('/hypaper', hypaperRouter);

    const res = await app.request('/hypaper', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'setBalance',
        user: '0xabc',
        balance: 123.45,
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'ok',
      balance: '123.45',
    });
    await expect(redisMock.hget(KEYS.USER_ACCOUNT('0xabc'), 'balance')).resolves.toBe('123.45');
  });
});
