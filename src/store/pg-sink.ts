import type { EventEmitter } from 'node:events';
import { eq } from 'drizzle-orm';
import { db } from './db.js';
import { users, orders, fills } from './schema.js';
import { logger } from '../utils/logger.js';
import type { PaperOrder, PaperFill } from '../types/order.js';

let writeQueue: Promise<void> = Promise.resolve();

function enqueueWrite(task: () => Promise<void>): void {
  writeQueue = writeQueue
    .then(task)
    .catch((err) => {
      logger.error({ err }, 'pg-sink: queued write failed');
    });
}

export function startPgSink(eventBus: EventEmitter): void {
  eventBus.on('fill', (event: { userId: string; fill: PaperFill }) => {
    enqueueWrite(async () => {
      await db.insert(fills)
        .values({
          tid: event.fill.tid,
          userId: event.userId,
          oid: event.fill.oid,
          coin: event.fill.coin,
          px: event.fill.px,
          sz: event.fill.sz,
          side: event.fill.side,
          time: event.fill.time,
          startPosition: event.fill.startPosition,
          dir: event.fill.dir,
          closedPnl: event.fill.closedPnl,
          hash: event.fill.hash,
          crossed: event.fill.crossed,
          fee: event.fill.fee,
          cloid: event.fill.cloid ?? null,
          feeToken: event.fill.feeToken,
        })
        .onConflictDoNothing({ target: fills.tid });
    });
  });

  eventBus.on('orderUpdate', (event: { userId: string; order: PaperOrder; status: string }) => {
    const o = event.order;
    enqueueWrite(async () => {
      await db.insert(orders)
        .values({
          oid: o.oid,
          cloid: o.cloid ?? null,
          userId: o.userId,
          asset: o.asset,
          coin: o.coin,
          isBuy: o.isBuy,
          sz: o.sz,
          limitPx: o.limitPx,
          orderType: o.orderType,
          tif: o.tif,
          reduceOnly: o.reduceOnly,
          triggerPx: o.triggerPx ?? null,
          tpsl: o.tpsl ?? null,
          isMarket: o.isMarket ?? null,
          grouping: o.grouping,
          status: o.status,
          filledSz: o.filledSz,
          avgPx: o.avgPx,
          createdAt: o.createdAt,
          updatedAt: o.updatedAt,
        })
        .onConflictDoUpdate({
          target: orders.oid,
          set: {
            status: o.status,
            filledSz: o.filledSz,
            avgPx: o.avgPx,
            updatedAt: o.updatedAt,
          },
        });
    });
  });

  logger.info('pg-sink listeners attached');
}

export function upsertUser(userId: string, balance: string): void {
  enqueueWrite(async () => {
    await db.insert(users)
      .values({ userId, balance, createdAt: Date.now() })
      .onConflictDoUpdate({
        target: users.userId,
        set: { balance },
      });
  });
}

export function updateUserBalance(userId: string, balance: string): void {
  enqueueWrite(async () => {
    await db.update(users)
      .set({ balance })
      .where(eq(users.userId, userId));
  });
}
