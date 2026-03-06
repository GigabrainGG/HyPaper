import { EventEmitter } from 'node:events';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { logger } from '../utils/logger.js';
import { D, sub, mul, add, isZero, gt, lt, gte, lte, abs, neg, min } from '../utils/math.js';
import { nextTid } from '../utils/id.js';
import { computeFillPrice } from '../utils/slippage.js';
import type { PaperOrder, PaperFill } from '../types/order.js';

export class OrderMatcher {
  private isRunning = false;
  private eventBus: EventEmitter;

  constructor(eventBus: EventEmitter) {
    this.eventBus = eventBus;
  }

  async matchAll(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      await this.matchOpenOrders();
      await this.matchTriggerOrders();
    } catch (err) {
      logger.error({ err }, 'Order matcher error');
    } finally {
      this.isRunning = false;
    }
  }

  private async matchOpenOrders(): Promise<void> {
    const oids = await redis.smembers(KEYS.ORDERS_OPEN);
    if (oids.length === 0) return;

    const mids = await redis.hgetall(KEYS.MARKET_MIDS);
    if (Object.keys(mids).length === 0) return;

    for (const oidStr of oids) {
      const oid = parseInt(oidStr, 10);
      const orderData = await redis.hgetall(KEYS.ORDER(oid));
      if (!orderData || !orderData.coin) continue;

      const order = this.parseOrder(orderData);
      if (order.status !== 'open') {
        await redis.srem(KEYS.ORDERS_OPEN, oidStr);
        continue;
      }

      const midPx = mids[order.coin];
      if (!midPx) continue;

      // Limit buy fills when midPx <= limitPx
      // Limit sell fills when midPx >= limitPx
      const shouldFill = order.isBuy
        ? lte(midPx, order.limitPx)
        : gte(midPx, order.limitPx);

      if (shouldFill) {
        const fillPx = await computeFillPrice(order, order.limitPx);
        await this.executeFill(order, fillPx);
      }
    }
  }

  private async matchTriggerOrders(): Promise<void> {
    const oids = await redis.smembers(KEYS.ORDERS_TRIGGERS);
    if (oids.length === 0) return;

    const mids = await redis.hgetall(KEYS.MARKET_MIDS);
    if (Object.keys(mids).length === 0) return;

    for (const oidStr of oids) {
      const oid = parseInt(oidStr, 10);
      const orderData = await redis.hgetall(KEYS.ORDER(oid));
      if (!orderData || !orderData.coin) continue;

      const order = this.parseOrder(orderData);
      if (order.status !== 'open') {
        await redis.srem(KEYS.ORDERS_TRIGGERS, oidStr);
        continue;
      }

      const midPx = mids[order.coin];
      if (!midPx || !order.triggerPx || !order.tpsl) continue;

      const triggered = this.checkTrigger(order, midPx);
      if (triggered) {
        // Fill at mid price for market trigger orders, or at limit price for limit
        const basePx = order.isMarket ? midPx : order.limitPx;
        const limitClamp = order.isMarket ? null : order.limitPx;
        const fillPx = await computeFillPrice(order, basePx, limitClamp);
        await this.executeFill(order, fillPx);
        await redis.srem(KEYS.ORDERS_TRIGGERS, oidStr);
      }
    }
  }

  private checkTrigger(order: PaperOrder, midPx: string): boolean {
    const triggerPx = order.triggerPx!;
    const tpsl = order.tpsl!;

    if (tpsl === 'sl') {
      // sl + sell (close long) → midPx <= triggerPx
      // sl + buy (close short) → midPx >= triggerPx
      return order.isBuy ? gte(midPx, triggerPx) : lte(midPx, triggerPx);
    } else {
      // tp + sell (close long) → midPx >= triggerPx
      // tp + buy (close short) → midPx <= triggerPx
      return order.isBuy ? lte(midPx, triggerPx) : gte(midPx, triggerPx);
    }
  }

  async executeFill(order: PaperOrder, fillPx: string): Promise<void> {
    const userId = order.userId;
    const asset = order.asset;
    const fillSz = sub(order.sz, order.filledSz);

    if (isZero(fillSz)) return;

    // Read current position
    const posData = await redis.hgetall(KEYS.USER_POS(userId, asset));
    const currentSzi = posData.szi ?? '0';
    const currentEntryPx = posData.entryPx ?? '0';

    // Calculate signed fill size
    const signedFillSz = order.isBuy ? fillSz : neg(fillSz);

    // Handle reduceOnly
    if (order.reduceOnly) {
      if (isZero(currentSzi)) return; // no position to reduce

      // Can't increase position with reduceOnly
      const isLong = gt(currentSzi, '0');
      if ((isLong && order.isBuy) || (!isLong && !order.isBuy)) return;

      // Clamp fill size to position size
      const posAbs = abs(currentSzi);
      if (gt(fillSz, posAbs)) {
        // Reduce fill to exactly close the position
        return this.executeFillWithSize(order, fillPx, posAbs, currentSzi, currentEntryPx);
      }
    }

    await this.executeFillWithSize(order, fillPx, fillSz, currentSzi, currentEntryPx);
  }

  private async executeFillWithSize(
    order: PaperOrder,
    fillPx: string,
    fillSz: string,
    currentSzi: string,
    currentEntryPx: string,
  ): Promise<void> {
    const userId = order.userId;
    const asset = order.asset;
    const signedFillSz = order.isBuy ? fillSz : neg(fillSz);
    const newSzi = add(currentSzi, signedFillSz);

    // Calculate new entry price (weighted average)
    let newEntryPx: string;
    let closedPnl = '0';

    const isCurrentLong = gt(currentSzi, '0');
    const isCurrentShort = lt(currentSzi, '0');
    const isIncreasing =
      (isCurrentLong && order.isBuy) ||
      (isCurrentShort && !order.isBuy) ||
      isZero(currentSzi);

    if (isIncreasing) {
      // Increasing position: weighted average entry
      if (isZero(currentSzi)) {
        newEntryPx = fillPx;
      } else {
        const currentNotional = mul(abs(currentSzi), currentEntryPx);
        const fillNotional = mul(fillSz, fillPx);
        const totalSz = add(abs(currentSzi), fillSz);
        newEntryPx = D(add(currentNotional, fillNotional)).div(D(totalSz)).toString();
      }
    } else {
      // Reducing/closing/flipping position
      const closingSz = min(fillSz, abs(currentSzi));

      // PnL on closed portion
      if (isCurrentLong) {
        closedPnl = mul(sub(fillPx, currentEntryPx), closingSz);
      } else {
        closedPnl = mul(sub(currentEntryPx, fillPx), closingSz);
      }

      // If flipping, new entry is fill price for the remainder
      if (gt(fillSz, abs(currentSzi))) {
        newEntryPx = fillPx;
      } else {
        newEntryPx = currentEntryPx;
      }
    }

    const tid = await nextTid();
    const now = Date.now();

    // Determine fill direction string
    const dir = this.getFillDir(currentSzi, signedFillSz);

    const fill: PaperFill = {
      coin: order.coin,
      px: fillPx,
      sz: fillSz,
      side: order.isBuy ? 'B' : 'A',
      time: now,
      startPosition: currentSzi,
      dir,
      closedPnl,
      hash: `0x${tid.toString(16).padStart(64, '0')}`,
      oid: order.oid,
      crossed: true,
      fee: '0',
      tid,
      cloid: order.cloid,
      feeToken: 'USDC',
    };

    // Pre-read funding fields before pipeline
    let cumFunding = '0';
    let cumFundingSinceOpen = '0';
    if (!isZero(newSzi)) {
      const posKey = KEYS.USER_POS(userId, asset);
      cumFunding = (await redis.hget(posKey, 'cumFunding')) ?? '0';
      if (!isZero(currentSzi)) {
        cumFundingSinceOpen = (await redis.hget(posKey, 'cumFundingSinceOpen')) ?? '0';
      }
    }

    // Atomic pipeline
    const pipeline = redis.pipeline();

    // Update position
    if (isZero(newSzi)) {
      // Position fully closed
      pipeline.del(KEYS.USER_POS(userId, asset));
      pipeline.srem(KEYS.USER_POSITIONS(userId), asset.toString());
    } else {
      pipeline.hset(KEYS.USER_POS(userId, asset),
        'userId', userId,
        'asset', asset.toString(),
        'coin', order.coin,
        'szi', newSzi,
        'entryPx', newEntryPx,
        'cumFunding', cumFunding,
        'cumFundingSinceOpen', cumFundingSinceOpen,
        'cumFundingSinceChange', '0',
      );
      pipeline.sadd(KEYS.USER_POSITIONS(userId), asset.toString());
    }

    // Credit closed PnL to balance
    if (!isZero(closedPnl)) {
      pipeline.hincrbyfloat(KEYS.USER_ACCOUNT(userId), 'balance', closedPnl);
    }

    // Mark order as filled
    pipeline.hset(KEYS.ORDER(order.oid),
      'status', 'filled',
      'filledSz', order.sz,
      'avgPx', fillPx,
      'updatedAt', now.toString(),
    );

    // Remove from open/trigger sets
    pipeline.srem(KEYS.ORDERS_OPEN, order.oid.toString());
    pipeline.srem(KEYS.ORDERS_TRIGGERS, order.oid.toString());

    // Push fill
    pipeline.lpush(KEYS.USER_FILLS(userId), JSON.stringify(fill));

    await pipeline.exec();

    logger.info({
      oid: order.oid,
      coin: order.coin,
      side: order.isBuy ? 'buy' : 'sell',
      sz: fillSz,
      px: fillPx,
      closedPnl,
      newSzi,
    }, 'Order filled');

    this.eventBus.emit('orderUpdate', {
      userId,
      order: { ...order, status: 'filled' as const, filledSz: order.sz, avgPx: fillPx, updatedAt: now },
      status: 'filled',
    });
    this.eventBus.emit('fill', { userId, fill });
  }

  private getFillDir(startPosition: string, signedFillSz: string): string {
    const newPos = add(startPosition, signedFillSz);
    if (isZero(startPosition)) {
      return gt(signedFillSz, '0') ? 'Open Long' : 'Open Short';
    }
    if (isZero(newPos)) {
      return gt(startPosition, '0') ? 'Close Long' : 'Close Short';
    }
    const wasLong = gt(startPosition, '0');
    const isBuy = gt(signedFillSz, '0');
    if (wasLong && isBuy) return 'Buy';
    if (wasLong && !isBuy) return 'Sell';
    if (!wasLong && isBuy) return 'Buy';
    return 'Sell';
  }

  private parseOrder(data: Record<string, string>): PaperOrder {
    return {
      oid: parseInt(data.oid, 10),
      cloid: data.cloid || undefined,
      userId: data.userId,
      asset: parseInt(data.asset, 10),
      coin: data.coin,
      isBuy: data.isBuy === 'true',
      sz: data.sz,
      limitPx: data.limitPx,
      orderType: data.orderType as 'limit' | 'trigger',
      tif: data.tif as 'Gtc' | 'Ioc' | 'Alo',
      reduceOnly: data.reduceOnly === 'true',
      triggerPx: data.triggerPx || undefined,
      tpsl: (data.tpsl as 'tp' | 'sl') || undefined,
      isMarket: data.isMarket === 'true',
      grouping: data.grouping as 'na' | 'normalTpsl' | 'positionTpsl',
      status: data.status as PaperOrder['status'],
      filledSz: data.filledSz ?? '0',
      avgPx: data.avgPx ?? '0',
      createdAt: parseInt(data.createdAt, 10),
      updatedAt: parseInt(data.updatedAt, 10),
    };
  }
}
