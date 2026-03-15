import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { RedisMock } from './helpers/redis-mock.js';
import { KEYS } from '../store/keys.js';

const redisMock = new RedisMock();

vi.mock('../store/redis.js', () => ({
  redis: redisMock,
}));

const mockConfig = {
  FEES_ENABLED: true,
  FEE_RATE_TAKER: '0.00035',
  FEE_RATE_MAKER: '0.0001',
  LOG_LEVEL: 'silent',
};

vi.mock('../config.js', () => ({
  config: mockConfig,
}));

vi.mock('../utils/l2-cache.js', () => ({
  getL2Book: vi.fn().mockResolvedValue(null),
}));

let tidCounter = 0;
vi.mock('../utils/id.js', () => ({
  nextOid: vi.fn(async () => ++tidCounter),
  nextTid: vi.fn(async () => ++tidCounter),
}));

const { OrderMatcher } = await import('../worker/order-matcher.js');

describe('Fees', () => {
  let eventBus: EventEmitter;
  let matcher: InstanceType<typeof OrderMatcher>;
  let fillEvents: Array<{ userId: string; fill: any }>;

  const USER = '0xfeetest';
  const COIN = 'BTC';
  const ASSET = 0;

  beforeEach(() => {
    redisMock.flushall();
    tidCounter = 200;
    mockConfig.FEES_ENABLED = true;
    mockConfig.FEE_RATE_TAKER = '0.00035';
    mockConfig.FEE_RATE_MAKER = '0.0001';

    eventBus = new EventEmitter();
    matcher = new OrderMatcher(eventBus);

    fillEvents = [];
    eventBus.on('fill', (e) => fillEvents.push(e));
  });

  async function seedUser(balance: string) {
    await redisMock.hset(KEYS.USER_ACCOUNT(USER), 'userId', USER, 'balance', balance);
  }

  async function seedMidPrice(coin: string, price: string) {
    await redisMock.hset(KEYS.MARKET_MIDS, coin, price);
  }

  async function createOpenOrder(opts: {
    oid: number;
    isBuy: boolean;
    sz: string;
    limitPx: string;
  }) {
    const { oid, isBuy, sz, limitPx } = opts;
    await redisMock.hset(
      KEYS.ORDER(oid),
      'oid', oid.toString(),
      'userId', USER,
      'asset', ASSET.toString(),
      'coin', COIN,
      'isBuy', isBuy.toString(),
      'sz', sz,
      'limitPx', limitPx,
      'orderType', 'limit',
      'tif', 'Gtc',
      'reduceOnly', 'false',
      'grouping', 'na',
      'status', 'open',
      'filledSz', '0',
      'avgPx', '0',
      'createdAt', '1000',
      'updatedAt', '1000',
    );
    await redisMock.sadd(KEYS.ORDERS_OPEN, oid.toString());
  }

  function buildOrder(overrides: Partial<any> = {}) {
    return {
      oid: 1,
      userId: USER,
      asset: ASSET,
      coin: COIN,
      isBuy: true,
      sz: '1',
      limitPx: '50000',
      orderType: 'limit' as const,
      tif: 'Ioc' as const,
      reduceOnly: false,
      grouping: 'na' as const,
      status: 'open' as const,
      filledSz: '0',
      avgPx: '0',
      createdAt: 1000,
      updatedAt: 1000,
      ...overrides,
    };
  }

  it('calculates taker fee on direct executeFill (IOC)', async () => {
    await seedUser('100000');
    const order = buildOrder({ sz: '1', limitPx: '50000' });

    await matcher.executeFill(order, '50000', true);

    expect(fillEvents).toHaveLength(1);
    const fill = fillEvents[0].fill;
    // fee = 1 * 50000 * 0.00035 = 17.5
    expect(fill.fee).toBe('17.5');
    expect(fill.crossed).toBe(true);

    // Balance should be reduced by fee
    const account = await redisMock.hgetall(KEYS.USER_ACCOUNT(USER));
    expect(parseFloat(account.balance)).toBeCloseTo(100000 - 17.5, 2);
  });

  it('calculates maker fee on rested order fill via matchAll', async () => {
    await seedUser('100000');
    await seedMidPrice(COIN, '49000');
    await createOpenOrder({ oid: 1, isBuy: true, sz: '1', limitPx: '50000' });

    await matcher.matchAll();

    expect(fillEvents).toHaveLength(1);
    const fill = fillEvents[0].fill;
    // fee = 1 * 49000 * 0.0001 = 4.9 (uses midPx fallback when no L2)
    expect(fill.fee).toBe('4.9');
    expect(fill.crossed).toBe(false);

    const account = await redisMock.hgetall(KEYS.USER_ACCOUNT(USER));
    expect(parseFloat(account.balance)).toBeCloseTo(100000 - 4.9, 2);
  });

  it('deducts fee from balance correctly alongside PnL', async () => {
    await seedUser('100000');
    // Set up a long position, then close it with profit
    await redisMock.hset(
      KEYS.USER_POS(USER, ASSET),
      'userId', USER, 'asset', '0', 'coin', COIN,
      'szi', '1', 'entryPx', '50000',
      'cumFunding', '0', 'cumFundingSinceOpen', '0', 'cumFundingSinceChange', '0',
    );
    await redisMock.sadd(KEYS.USER_POSITIONS(USER), '0');

    const order = buildOrder({ isBuy: false, sz: '1', limitPx: '52000' });
    await matcher.executeFill(order, '52000', true);

    // closedPnl = (52000 - 50000) * 1 = 2000
    // fee = 1 * 52000 * 0.00035 = 18.2
    // balance = 100000 + 2000 - 18.2 = 101981.8
    const account = await redisMock.hgetall(KEYS.USER_ACCOUNT(USER));
    expect(parseFloat(account.balance)).toBeCloseTo(101981.8, 1);
  });

  it('sets fee to 0 when FEES_ENABLED is false', async () => {
    mockConfig.FEES_ENABLED = false;
    await seedUser('100000');

    const order = buildOrder({ sz: '1', limitPx: '50000' });
    await matcher.executeFill(order, '50000', true);

    expect(fillEvents).toHaveLength(1);
    expect(fillEvents[0].fill.fee).toBe('0');

    // Balance unchanged (no fee deducted, no PnL)
    const account = await redisMock.hgetall(KEYS.USER_ACCOUNT(USER));
    expect(account.balance).toBe('100000');
  });

  it('tracks user in USERS_ACTIVE on fill', async () => {
    await seedUser('100000');

    const order = buildOrder({ sz: '1', limitPx: '50000' });
    await matcher.executeFill(order, '50000', true);

    const activeUsers = await redisMock.smembers(KEYS.USERS_ACTIVE);
    expect(activeUsers).toContain(USER);
  });
});
