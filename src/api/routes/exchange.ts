import { Hono } from 'hono';
import { placeOrders, cancelOrders, cancelByCloid, updateLeverage } from '../../engine/order.js';
import { ensureAccount } from '../middleware/auth.js';
import { logger } from '../../utils/logger.js';
import type { HlExchangeAction } from '../../types/hl.js';

export const exchangeRouter = new Hono();

exchangeRouter.post('/', async (c) => {
  const body = await c.req.json();

  const rawWallet: string | undefined = body.wallet;
  if (!rawWallet || typeof rawWallet !== 'string') {
    return c.json({ status: 'err', response: 'Missing wallet address' }, 400);
  }
  const wallet = rawWallet.toLowerCase();

  await ensureAccount(wallet);

  const action: HlExchangeAction = body.action;
  if (!action || typeof action !== 'object' || !action.type) {
    return c.json({ status: 'err', response: 'Missing or invalid action' }, 400);
  }

  try {
    switch (action.type) {
      case 'order': {
        if (!Array.isArray(action.orders) || action.orders.length === 0) {
          return c.json({ status: 'err', response: 'Missing orders array' }, 400);
        }
        if (action.orders.length > 50) {
          return c.json({ status: 'err', response: 'Max 50 orders per request' }, 400);
        }
        for (const o of action.orders) {
          if (typeof o.a !== 'number' || typeof o.b !== 'boolean' ||
              typeof o.p !== 'string' || typeof o.s !== 'string' ||
              typeof o.r !== 'boolean' || !o.t?.limit?.tif) {
            return c.json({ status: 'err', response: 'Invalid order wire format' }, 400);
          }
          const size = Number(o.s);
          const price = Number(o.p);
          if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(price) || price <= 0) {
            return c.json({ status: 'err', response: 'Size and price must be finite positive numbers' }, 400);
          }
        }

        const statuses = await placeOrders(wallet, action.orders, action.grouping);
        return c.json({
          status: 'ok',
          response: {
            type: 'order',
            data: { statuses },
          },
        });
      }

      case 'cancel': {
        if (!Array.isArray(action.cancels) || action.cancels.length === 0) {
          return c.json({ status: 'err', response: 'Missing cancels array' }, 400);
        }
        for (const cancel of action.cancels) {
          if (typeof cancel.a !== 'number' || typeof cancel.o !== 'number') {
            return c.json({ status: 'err', response: 'Invalid cancel format: need a (asset) and o (oid)' }, 400);
          }
        }

        const statuses = await cancelOrders(wallet, action.cancels);
        return c.json({
          status: 'ok',
          response: {
            type: 'cancel',
            data: { statuses },
          },
        });
      }

      case 'cancelByCloid': {
        if (!Array.isArray(action.cancels) || action.cancels.length === 0) {
          return c.json({ status: 'err', response: 'Missing cancels array' }, 400);
        }
        for (const cancel of action.cancels) {
          if (typeof cancel.asset !== 'number' || typeof cancel.cloid !== 'string') {
            return c.json({ status: 'err', response: 'Invalid cancelByCloid format: need asset and cloid' }, 400);
          }
        }

        const statuses = await cancelByCloid(wallet, action.cancels);
        return c.json({
          status: 'ok',
          response: {
            type: 'cancel',
            data: { statuses },
          },
        });
      }

      case 'updateLeverage': {
        if (typeof action.asset !== 'number' || typeof action.leverage !== 'number' || typeof action.isCross !== 'boolean') {
          return c.json({ status: 'err', response: 'updateLeverage requires asset (number), leverage (number), isCross (boolean)' }, 400);
        }
        if (action.leverage < 1 || action.leverage > 200) {
          return c.json({ status: 'err', response: 'Leverage must be between 1 and 200' }, 400);
        }

        await updateLeverage(wallet, action.asset, action.isCross, action.leverage);
        return c.json({
          status: 'ok',
          response: { type: 'default' },
        });
      }

      default: {
        return c.json({
          status: 'err',
          response: `Unsupported action type: ${(action as { type: string }).type}`,
        }, 400);
      }
    }
  } catch (err) {
    logger.error({ err, action: action.type }, 'Exchange error');
    return c.json({ status: 'err', response: String(err) }, 500);
  }
});
