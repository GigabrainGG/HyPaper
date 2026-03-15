import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { RedisMock } from './helpers/redis-mock.js';
import { KEYS } from '../store/keys.js';

// --- Mock redis before importing OrderMatcher ---
const redisMock = new RedisMock();

vi.mock('../store/redis.js', () => ({
  redis: redisMock,
}));

// Mock config with fees disabled for existing tests (fee tests are separate)
vi.mock('../config.js', () => ({
  config: {
    FEES_ENABLED: false,
    FEE_RATE_TAKER: '0.00035',
    FEE_RATE_MAKER: '0.0001',
    LOG_LEVEL: 'silent',
  },
}));

// Mock L2 cache to return null (falls back to mid price)
vi.mock('../utils/l2-cache.js', () => ({
  getL2Book: vi.fn().mockResolvedValue(null),
}));

// Mock id generation to be deterministic
let tidCounter = 0;
vi.mock('../utils/id.js', () => ({
  nextOid: vi.fn(async () => ++tidCounter),
  nextTid: vi.fn(async () => ++tidCounter),
}));

// Now import after mocks are set up
const { OrderMatcher } = await import('../worker/order-matcher.js');

describe('OrderMatcher', () => {
  let eventBus: EventEmitter;
  let matcher: InstanceType<typeof OrderMatcher>;
  let fillEvents: Array<{ userId: string; fill: any }>;
  let orderEvents: Array<{ userId: string; order: any; status: string }>;

  const USER = '0xtest';
  const COIN = 'BTC';
  const ASSET = 0;

  beforeEach(() => {
    redisMock.flushall();
    tidCounter = 100;

    eventBus = new EventEmitter();
    matcher = new OrderMatcher(eventBus);

    fillEvents = [];
    orderEvents = [];
    eventBus.on('fill', (e) => fillEvents.push(e));
    eventBus.on('orderUpdate', (e) => orderEvents.push(e));
  });

  async function seedUser(balance: string) {
    await redisMock.hset(KEYS.USER_ACCOUNT(USER), 'userId', USER, 'balance', balance);
  }

  async function seedMidPrice(coin: string, price: string) {
    await redisMock.hset(KEYS.MARKET_MIDS, coin, price);
  }

  async function createOpenOrder(opts: {
    oid: number;
    coin?: string;
    isBuy: boolean;
    sz: string;
    limitPx: string;
    reduceOnly?: boolean;
    asset?: number;
  }) {
    const {
      oid,
      coin = COIN,
      isBuy,
      sz,
      limitPx,
      reduceOnly = false,
      asset = ASSET,
    } = opts;

    await redisMock.hset(
      KEYS.ORDER(oid),
      'oid', oid.toString(),
      'userId', USER,
      'asset', asset.toString(),
      'coin', coin,
      'isBuy', isBuy.toString(),
      'sz', sz,
      'limitPx', limitPx,
      'orderType', 'limit',
      'tif', 'Gtc',
      'reduceOnly', reduceOnly.toString(),
      'grouping', 'na',
      'status', 'open',
      'filledSz', '0',
      'avgPx', '0',
      'createdAt', '1000',
      'updatedAt', '1000',
    );

    await redisMock.sadd(KEYS.ORDERS_OPEN, oid.toString());
    await redisMock.zadd(KEYS.USER_ORDERS(USER), 1000, oid.toString());
  }

  async function createTriggerOrder(opts: {
    oid: number;
    isBuy: boolean;
    sz: string;
    limitPx: string;
    triggerPx: string;
    tpsl: 'tp' | 'sl';
    isMarket?: boolean;
  }) {
    const { oid, isBuy, sz, limitPx, triggerPx, tpsl, isMarket = false } = opts;

    await redisMock.hset(
      KEYS.ORDER(oid),
      'oid', oid.toString(),
      'userId', USER,
      'asset', ASSET.toString(),
      'coin', COIN,
      'isBuy', isBuy.toString(),
      'sz', sz,
      'limitPx', limitPx,
      'orderType', 'trigger',
      'tif', 'Gtc',
      'reduceOnly', 'true',
      'triggerPx', triggerPx,
      'tpsl', tpsl,
      'isMarket', isMarket.toString(),
      'grouping', 'na',
      'status', 'open',
      'filledSz', '0',
      'avgPx', '0',
      'createdAt', '1000',
      'updatedAt', '1000',
    );

    await redisMock.sadd(KEYS.ORDERS_TRIGGERS, oid.toString());
  }

  async function setPosition(szi: string, entryPx: string) {
    await redisMock.hset(
      KEYS.USER_POS(USER, ASSET),
      'userId', USER,
      'asset', ASSET.toString(),
      'coin', COIN,
      'szi', szi,
      'entryPx', entryPx,
      'cumFunding', '0',
      'cumFundingSinceOpen', '0',
      'cumFundingSinceChange', '0',
    );
    await redisMock.sadd(KEYS.USER_POSITIONS(USER), ASSET.toString());
  }

  // =================================================================
  // Open Order Matching
  // =================================================================

  describe('matchOpenOrders', () => {
    it('fills a limit buy when midPx <= limitPx', async () => {
      await seedUser('100000');
      await seedMidPrice(COIN, '49000');
      await createOpenOrder({ oid: 1, isBuy: true, sz: '1', limitPx: '50000' });

      await matcher.matchAll();

      // Should have emitted a fill event
      expect(fillEvents).toHaveLength(1);
      expect(fillEvents[0].fill.side).toBe('B');
      expect(fillEvents[0].fill.coin).toBe('BTC');

      // Order should be marked as filled
      const order = await redisMock.hgetall(KEYS.ORDER(1));
      expect(order.status).toBe('filled');
    });

    it('fills a limit sell when midPx >= limitPx', async () => {
      await seedUser('100000');
      await seedMidPrice(COIN, '51000');
      await setPosition('1', '50000'); // have a long to sell
      await createOpenOrder({ oid: 1, isBuy: false, sz: '1', limitPx: '50000' });

      await matcher.matchAll();

      expect(fillEvents).toHaveLength(1);
      expect(fillEvents[0].fill.side).toBe('A');
    });

    it('does NOT fill a limit buy when midPx > limitPx', async () => {
      await seedUser('100000');
      await seedMidPrice(COIN, '51000');
      await createOpenOrder({ oid: 1, isBuy: true, sz: '1', limitPx: '50000' });

      await matcher.matchAll();

      expect(fillEvents).toHaveLength(0);
      const order = await redisMock.hgetall(KEYS.ORDER(1));
      expect(order.status).toBe('open');
    });

    it('does NOT fill a limit sell when midPx < limitPx', async () => {
      await seedUser('100000');
      await seedMidPrice(COIN, '49000');
      await setPosition('1', '50000');
      await createOpenOrder({ oid: 1, isBuy: false, sz: '1', limitPx: '50000' });

      await matcher.matchAll();

      expect(fillEvents).toHaveLength(0);
    });

    it('fills rested orders at the current mid price when L2 is unavailable', async () => {
      await seedUser('100000');
      await seedMidPrice(COIN, '49000');
      await createOpenOrder({ oid: 1, isBuy: true, sz: '1', limitPx: '50000' });

      await matcher.matchAll();

      expect(fillEvents).toHaveLength(1);
      expect(fillEvents[0].fill.px).toBe('49000');
    });

    it('matches multiple orders in one pass', async () => {
      await seedUser('100000');
      await seedMidPrice(COIN, '49000');
      await seedMidPrice('ETH', '2900');

      await createOpenOrder({ oid: 1, isBuy: true, sz: '1', limitPx: '50000' });
      await createOpenOrder({ oid: 2, isBuy: true, sz: '10', limitPx: '3000', coin: 'ETH', asset: 1 });

      // Need to also set ETH mid separately
      await redisMock.hset(KEYS.ORDER(2), 'coin', 'ETH', 'asset', '1');

      await matcher.matchAll();

      expect(fillEvents).toHaveLength(2);
    });

    it('skips orders with non-open status', async () => {
      await seedUser('100000');
      await seedMidPrice(COIN, '49000');
      await createOpenOrder({ oid: 1, isBuy: true, sz: '1', limitPx: '50000' });

      // Manually mark as cancelled
      await redisMock.hset(KEYS.ORDER(1), 'status', 'cancelled');

      await matcher.matchAll();

      expect(fillEvents).toHaveLength(0);
      // Should be removed from open set
      const openOrders = await redisMock.smembers(KEYS.ORDERS_OPEN);
      expect(openOrders).not.toContain('1');
    });

    it('removes order from open set after fill', async () => {
      await seedUser('100000');
      await seedMidPrice(COIN, '49000');
      await createOpenOrder({ oid: 1, isBuy: true, sz: '1', limitPx: '50000' });

      await matcher.matchAll();

      const openOrders = await redisMock.smembers(KEYS.ORDERS_OPEN);
      expect(openOrders).not.toContain('1');
    });
  });

  // =================================================================
  // Trigger Order Matching
  // =================================================================

  describe('matchTriggerOrders', () => {
    it('triggers stop-loss sell when midPx <= triggerPx (close long)', async () => {
      await seedUser('100000');
      await setPosition('1', '50000'); // long position
      await seedMidPrice(COIN, '48000');
      await createTriggerOrder({
        oid: 1, isBuy: false, sz: '1', limitPx: '47000',
        triggerPx: '49000', tpsl: 'sl', isMarket: true,
      });

      await matcher.matchAll();

      expect(fillEvents).toHaveLength(1);
      expect(fillEvents[0].fill.side).toBe('A'); // sell
    });

    it('triggers stop-loss buy when midPx >= triggerPx (close short)', async () => {
      await seedUser('100000');
      await setPosition('-1', '50000'); // short position
      await seedMidPrice(COIN, '52000');
      await createTriggerOrder({
        oid: 1, isBuy: true, sz: '1', limitPx: '53000',
        triggerPx: '51000', tpsl: 'sl', isMarket: true,
      });

      await matcher.matchAll();

      expect(fillEvents).toHaveLength(1);
      expect(fillEvents[0].fill.side).toBe('B'); // buy
    });

    it('triggers take-profit sell when midPx >= triggerPx (close long)', async () => {
      await seedUser('100000');
      await setPosition('1', '50000');
      await seedMidPrice(COIN, '55000');
      await createTriggerOrder({
        oid: 1, isBuy: false, sz: '1', limitPx: '54000',
        triggerPx: '54000', tpsl: 'tp', isMarket: true,
      });

      await matcher.matchAll();

      expect(fillEvents).toHaveLength(1);
    });

    it('triggers take-profit buy when midPx <= triggerPx (close short)', async () => {
      await seedUser('100000');
      await setPosition('-1', '50000');
      await seedMidPrice(COIN, '45000');
      await createTriggerOrder({
        oid: 1, isBuy: true, sz: '1', limitPx: '46000',
        triggerPx: '46000', tpsl: 'tp', isMarket: true,
      });

      await matcher.matchAll();

      expect(fillEvents).toHaveLength(1);
    });

    it('does NOT trigger SL sell when price is above triggerPx', async () => {
      await seedUser('100000');
      await setPosition('1', '50000');
      await seedMidPrice(COIN, '51000');
      await createTriggerOrder({
        oid: 1, isBuy: false, sz: '1', limitPx: '49000',
        triggerPx: '49000', tpsl: 'sl', isMarket: true,
      });

      await matcher.matchAll();

      expect(fillEvents).toHaveLength(0);
    });

    it('removes triggered order from triggers set', async () => {
      await seedUser('100000');
      await setPosition('1', '50000');
      await seedMidPrice(COIN, '48000');
      await createTriggerOrder({
        oid: 1, isBuy: false, sz: '1', limitPx: '47000',
        triggerPx: '49000', tpsl: 'sl', isMarket: true,
      });

      await matcher.matchAll();

      const triggers = await redisMock.smembers(KEYS.ORDERS_TRIGGERS);
      expect(triggers).not.toContain('1');
    });
  });

  // =================================================================
  // Fill Execution & Position Updates
  // =================================================================

  describe('executeFill', () => {
    it('opens a new long position', async () => {
      await seedUser('100000');
      await seedMidPrice(COIN, '50000');
      await createOpenOrder({ oid: 1, isBuy: true, sz: '1', limitPx: '50000' });

      await matcher.matchAll();

      const pos = await redisMock.hgetall(KEYS.USER_POS(USER, ASSET));
      expect(pos.szi).toBe('1');
      expect(pos.entryPx).toBe('50000');
    });

    it('opens a new short position', async () => {
      await seedUser('100000');
      await seedMidPrice(COIN, '50000');
      await createOpenOrder({ oid: 1, isBuy: false, sz: '1', limitPx: '50000' });

      await matcher.matchAll();

      const pos = await redisMock.hgetall(KEYS.USER_POS(USER, ASSET));
      expect(pos.szi).toBe('-1');
      expect(pos.entryPx).toBe('50000');
    });

    it('increases a long position with weighted average entry', async () => {
      await seedUser('100000');
      await setPosition('1', '50000');
      await seedMidPrice(COIN, '52000');
      await createOpenOrder({ oid: 1, isBuy: true, sz: '1', limitPx: '52000' });

      await matcher.matchAll();

      const pos = await redisMock.hgetall(KEYS.USER_POS(USER, ASSET));
      expect(pos.szi).toBe('2');
      // Weighted avg: (1*50000 + 1*52000) / 2 = 51000
      expect(pos.entryPx).toBe('51000');
    });

    it('closes a long position and calculates PnL', async () => {
      await seedUser('100000');
      await setPosition('1', '50000');
      await seedMidPrice(COIN, '52000');
      await createOpenOrder({ oid: 1, isBuy: false, sz: '1', limitPx: '52000' });

      await matcher.matchAll();

      // Position should be deleted
      const pos = await redisMock.hgetall(KEYS.USER_POS(USER, ASSET));
      expect(pos.szi).toBeUndefined();

      // Closed PnL: (52000 - 50000) * 1 = 2000
      expect(fillEvents[0].fill.closedPnl).toBe('2000');

      // Balance should increase by PnL
      const account = await redisMock.hgetall(KEYS.USER_ACCOUNT(USER));
      expect(account.balance).toBe('102000');
    });

    it('closes a short position and calculates PnL', async () => {
      await seedUser('100000');
      await setPosition('-1', '50000');
      await seedMidPrice(COIN, '48000');
      await createOpenOrder({ oid: 1, isBuy: true, sz: '1', limitPx: '48000' });

      await matcher.matchAll();

      // Position should be deleted
      const pos = await redisMock.hgetall(KEYS.USER_POS(USER, ASSET));
      expect(pos.szi).toBeUndefined();

      // Closed PnL: (50000 - 48000) * 1 = 2000
      expect(fillEvents[0].fill.closedPnl).toBe('2000');
    });

    it('partially closes a long position', async () => {
      await seedUser('100000');
      await setPosition('2', '50000');
      await seedMidPrice(COIN, '52000');
      await createOpenOrder({ oid: 1, isBuy: false, sz: '1', limitPx: '52000' });

      await matcher.matchAll();

      const pos = await redisMock.hgetall(KEYS.USER_POS(USER, ASSET));
      expect(pos.szi).toBe('1');
      expect(pos.entryPx).toBe('50000'); // entry unchanged on partial close

      // PnL on closed portion: (52000 - 50000) * 1 = 2000
      expect(fillEvents[0].fill.closedPnl).toBe('2000');
    });

    it('flips from long to short', async () => {
      await seedUser('100000');
      await setPosition('1', '50000');
      await seedMidPrice(COIN, '52000');
      await createOpenOrder({ oid: 1, isBuy: false, sz: '3', limitPx: '52000' });

      await matcher.matchAll();

      const pos = await redisMock.hgetall(KEYS.USER_POS(USER, ASSET));
      // Was long 1, sold 3, now short 2
      expect(pos.szi).toBe('-2');
      // New entry is fill price for flipped portion
      expect(pos.entryPx).toBe('52000');
    });

    it('records closed PnL as negative for losing trade', async () => {
      await seedUser('100000');
      await setPosition('1', '50000');
      await seedMidPrice(COIN, '48000');
      await createOpenOrder({ oid: 1, isBuy: false, sz: '1', limitPx: '48000' });

      await matcher.matchAll();

      // PnL: (48000 - 50000) * 1 = -2000
      expect(fillEvents[0].fill.closedPnl).toBe('-2000');

      const account = await redisMock.hgetall(KEYS.USER_ACCOUNT(USER));
      expect(account.balance).toBe('98000');
    });
  });

  // =================================================================
  // Fill Direction Labels
  // =================================================================

  describe('fill direction', () => {
    it('labels "Open Long" when opening fresh long', async () => {
      await seedUser('100000');
      await seedMidPrice(COIN, '50000');
      await createOpenOrder({ oid: 1, isBuy: true, sz: '1', limitPx: '50000' });

      await matcher.matchAll();

      expect(fillEvents[0].fill.dir).toBe('Open Long');
    });

    it('labels "Open Short" when opening fresh short', async () => {
      await seedUser('100000');
      await seedMidPrice(COIN, '50000');
      await createOpenOrder({ oid: 1, isBuy: false, sz: '1', limitPx: '50000' });

      await matcher.matchAll();

      expect(fillEvents[0].fill.dir).toBe('Open Short');
    });

    it('labels "Close Long" when fully closing a long', async () => {
      await seedUser('100000');
      await setPosition('1', '50000');
      await seedMidPrice(COIN, '52000');
      await createOpenOrder({ oid: 1, isBuy: false, sz: '1', limitPx: '52000' });

      await matcher.matchAll();

      expect(fillEvents[0].fill.dir).toBe('Close Long');
    });

    it('labels "Close Short" when fully closing a short', async () => {
      await seedUser('100000');
      await setPosition('-1', '50000');
      await seedMidPrice(COIN, '48000');
      await createOpenOrder({ oid: 1, isBuy: true, sz: '1', limitPx: '48000' });

      await matcher.matchAll();

      expect(fillEvents[0].fill.dir).toBe('Close Short');
    });

    it('labels "Buy" when increasing a long', async () => {
      await seedUser('100000');
      await setPosition('1', '50000');
      await seedMidPrice(COIN, '50000');
      await createOpenOrder({ oid: 1, isBuy: true, sz: '1', limitPx: '50000' });

      await matcher.matchAll();

      expect(fillEvents[0].fill.dir).toBe('Buy');
    });

    it('labels "Sell" when partially closing a long', async () => {
      await seedUser('100000');
      await setPosition('2', '50000');
      await seedMidPrice(COIN, '52000');
      await createOpenOrder({ oid: 1, isBuy: false, sz: '1', limitPx: '52000' });

      await matcher.matchAll();

      expect(fillEvents[0].fill.dir).toBe('Sell');
    });
  });

  // =================================================================
  // Reduce Only
  // =================================================================

  describe('reduceOnly', () => {
    it('skips reduceOnly fill when no position exists', async () => {
      await seedUser('100000');
      await seedMidPrice(COIN, '50000');
      await createOpenOrder({ oid: 1, isBuy: false, sz: '1', limitPx: '50000', reduceOnly: true });

      await matcher.matchAll();

      // Should not fill — no position to reduce
      expect(fillEvents).toHaveLength(0);
    });

    it('skips reduceOnly buy on an existing long (would increase)', async () => {
      await seedUser('100000');
      await setPosition('1', '50000');
      await seedMidPrice(COIN, '50000');
      await createOpenOrder({ oid: 1, isBuy: true, sz: '1', limitPx: '50000', reduceOnly: true });

      await matcher.matchAll();

      expect(fillEvents).toHaveLength(0);
    });

    it('clamps reduceOnly fill size to position size', async () => {
      await seedUser('100000');
      await setPosition('0.5', '50000'); // only 0.5 BTC long
      await seedMidPrice(COIN, '52000');
      await createOpenOrder({ oid: 1, isBuy: false, sz: '1', limitPx: '52000', reduceOnly: true });

      await matcher.matchAll();

      expect(fillEvents).toHaveLength(1);
      expect(fillEvents[0].fill.sz).toBe('0.5'); // clamped to position size

      // Position should be fully closed
      const pos = await redisMock.hgetall(KEYS.USER_POS(USER, ASSET));
      expect(pos.szi).toBeUndefined();
    });
  });

  // =================================================================
  // Fill Metadata
  // =================================================================

  describe('fill metadata', () => {
    it('records correct fill fields', async () => {
      await seedUser('100000');
      await seedMidPrice(COIN, '50000');
      await createOpenOrder({ oid: 1, isBuy: true, sz: '0.5', limitPx: '50000' });

      await matcher.matchAll();

      const fill = fillEvents[0].fill;
      expect(fill.coin).toBe('BTC');
      expect(fill.sz).toBe('0.5');
      expect(fill.side).toBe('B');
      expect(fill.oid).toBe(1);
      expect(fill.crossed).toBe(false); // rested orders matched via matchAll are maker
      expect(fill.fee).toBe('0'); // fees disabled in test config
      expect(fill.feeToken).toBe('USDC');
      expect(fill.startPosition).toBe('0');
      expect(fill.hash).toMatch(/^0x/);
      expect(fill.tid).toBeGreaterThan(0);
    });

    it('records startPosition as the position before fill', async () => {
      await seedUser('100000');
      await setPosition('2', '50000');
      await seedMidPrice(COIN, '52000');
      await createOpenOrder({ oid: 1, isBuy: false, sz: '1', limitPx: '52000' });

      await matcher.matchAll();

      expect(fillEvents[0].fill.startPosition).toBe('2');
    });
  });

  // =================================================================
  // Concurrency Guard
  // =================================================================

  describe('concurrency', () => {
    it('prevents concurrent matchAll runs', async () => {
      await seedUser('100000');
      await seedMidPrice(COIN, '50000');
      await createOpenOrder({ oid: 1, isBuy: true, sz: '1', limitPx: '50000' });

      // Fire two matchAll calls simultaneously
      const [r1, r2] = await Promise.all([
        matcher.matchAll(),
        matcher.matchAll(),
      ]);

      // Only one should have actually run (the other returns early)
      expect(fillEvents.length).toBeLessThanOrEqual(1);
    });
  });

  // =================================================================
  // Event Emissions
  // =================================================================

  describe('events', () => {
    it('emits fill event with userId and fill data', async () => {
      await seedUser('100000');
      await seedMidPrice(COIN, '50000');
      await createOpenOrder({ oid: 1, isBuy: true, sz: '1', limitPx: '50000' });

      await matcher.matchAll();

      expect(fillEvents).toHaveLength(1);
      expect(fillEvents[0].userId).toBe(USER);
      expect(fillEvents[0].fill).toBeDefined();
    });

    it('emits orderUpdate event with filled status', async () => {
      await seedUser('100000');
      await seedMidPrice(COIN, '50000');
      await createOpenOrder({ oid: 1, isBuy: true, sz: '1', limitPx: '50000' });

      await matcher.matchAll();

      expect(orderEvents).toHaveLength(1);
      expect(orderEvents[0].status).toBe('filled');
      expect(orderEvents[0].userId).toBe(USER);
    });
  });
});
