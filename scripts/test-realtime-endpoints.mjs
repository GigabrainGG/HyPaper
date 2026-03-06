#!/usr/bin/env node
import WebSocket from 'ws';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = 'true';
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/test-realtime-endpoints.mjs [options]

Options:
  --base-url <url>     API base URL (default: http://localhost:3000)
  --wallet <id>        Paper wallet/user id to use
  --coin <symbol>      Force a coin instead of auto-selecting one
  --balance <amount>   Starting paper balance (default: 100000)
  --timeout-ms <ms>    HTTP/WS timeout (default: 15000)
  --strict-proxy       Fail if proxied HL market-data checks fail
  --verbose            Print HTTP and WS payloads
  --keep-account       Skip final account reset
  --help               Show this message

Examples:
  npm run test:realtime
  npm run test:realtime -- --base-url https://your-server.example --wallet 0xpaperbot
`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatPrice(value) {
  const numeric = typeof value === 'number' ? value : Number(value);
  assert(Number.isFinite(numeric) && numeric > 0, `Invalid price: ${value}`);
  if (numeric >= 1000) return numeric.toFixed(2);
  if (numeric >= 1) return numeric.toFixed(4);
  return numeric.toFixed(6);
}

function formatSize(szDecimals) {
  const decimals = Math.max(0, Math.min(toNumber(szDecimals, 3), 6));
  if (decimals === 0) return '1';
  return `0.${'0'.repeat(decimals - 1)}1`;
}

function normalizeBaseUrl(input) {
  return input.endsWith('/') ? input : `${input}/`;
}

function httpUrl(baseUrl, path) {
  return new URL(path.replace(/^\//, ''), normalizeBaseUrl(baseUrl));
}

function wsUrl(baseUrl) {
  const url = httpUrl(baseUrl, '/ws');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

async function getJson(baseUrl, path, timeoutMs, verbose) {
  const url = httpUrl(baseUrl, path);
  if (verbose) {
    console.log(`HTTP GET ${url}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const data = await response.json();
    if (verbose) {
      console.log(JSON.stringify(data, null, 2));
    }
    if (!response.ok) {
      throw new Error(`GET ${path} failed with ${response.status}: ${JSON.stringify(data)}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(baseUrl, path, body, timeoutMs, verbose) {
  const url = httpUrl(baseUrl, path);
  if (verbose) {
    console.log(`HTTP POST ${url}`);
    console.log(JSON.stringify(body, null, 2));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const data = await response.json();
    if (verbose) {
      console.log(JSON.stringify(data, null, 2));
    }
    if (!response.ok) {
      throw new Error(`POST ${path} failed with ${response.status}: ${JSON.stringify(data)}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(check, label, timeoutMs, intervalMs = 250) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value) {
      return value;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function extractStatuses(response) {
  return response?.response?.data?.statuses ?? [];
}

function extractOid(status) {
  if (status?.resting?.oid) return status.resting.oid;
  if (status?.filled?.oid) return status.filled.oid;
  throw new Error(`Missing oid in status payload: ${JSON.stringify(status)}`);
}

class WsInbox {
  constructor(url, timeoutMs, verbose) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.verbose = verbose;
    this.messages = [];
    this.waiters = [];
    this.socket = null;
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;

      const timer = setTimeout(() => {
        reject(new Error(`Timed out connecting to ${this.url}`));
      }, this.timeoutMs);

      socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });

      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });

      socket.on('message', (raw) => {
        const text = raw.toString();
        const message = JSON.parse(text);
        this.messages.push(message);
        if (this.verbose) {
          console.log(`WS <= ${text}`);
        }

        const pending = [];
        for (const waiter of this.waiters) {
          if (waiter.predicate(message)) {
            clearTimeout(waiter.timer);
            waiter.resolve(message);
          } else {
            pending.push(waiter);
          }
        }
        this.waiters = pending;
      });
    });
  }

  mark() {
    return this.messages.length;
  }

  send(payload) {
    const serialized = JSON.stringify(payload);
    if (this.verbose) {
      console.log(`WS => ${serialized}`);
    }
    this.socket.send(serialized);
  }

  waitFor(predicate, label, since = 0, timeoutMs = this.timeoutMs) {
    for (let index = since; index < this.messages.length; index += 1) {
      const message = this.messages[index];
      if (predicate(message)) {
        return Promise.resolve(message);
      }
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((entry) => entry !== waiter);
          reject(new Error(`Timed out waiting for ${label}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async close() {
    if (!this.socket) return;
    const socket = this.socket;
    if (socket.readyState === WebSocket.CLOSED) return;

    await new Promise((resolve) => {
      socket.once('close', resolve);
      socket.close();
      setTimeout(resolve, 1000);
    });
  }
}

async function runStep(name, action) {
  process.stdout.write(`• ${name} ... `);
  try {
    const value = await action();
    console.log('ok');
    return value;
  } catch (error) {
    console.log(`failed (${error.message})`);
    throw error;
  }
}

async function runOptionalStep(name, action, warnings, strictProxy) {
  process.stdout.write(`• ${name} ... `);
  try {
    const value = await action();
    console.log('ok');
    return value;
  } catch (error) {
    if (strictProxy) {
      console.log(`failed (${error.message})`);
      throw error;
    }
    console.log(`warn (${error.message})`);
    warnings.push(`${name}: ${error.message}`);
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === 'true') {
    printHelp();
    return;
  }

  const verbose = args.verbose === 'true';
  const baseUrl = args['base-url'] ?? process.env.HYPAPER_BASE_URL ?? `http://localhost:${process.env.PORT ?? '3000'}`;
  const wallet = (args.wallet ?? process.env.HYPAPER_TEST_WALLET ?? `0xpaper${Date.now().toString(16)}`).toLowerCase();
  const balance = toNumber(args.balance ?? process.env.HYPAPER_TEST_BALANCE, 100000);
  const timeoutMs = toNumber(args['timeout-ms'] ?? process.env.HYPAPER_TEST_TIMEOUT_MS, 15000);
  const keepAccount = args['keep-account'] === 'true';
  const strictProxy = args['strict-proxy'] === 'true';
  const warnings = [];

  console.log(`Base URL: ${baseUrl}`);
  console.log(`Wallet:   ${wallet}`);

  const summary = {
    coin: null,
    asset: null,
    aloOid: null,
    cloidOid: null,
    fillOid: null,
    fillTid: null,
  };

  let ws;

  try {
    const health = await runStep('GET /health', async () => {
      const data = await getJson(baseUrl, '/health', timeoutMs, verbose);
      assert(data.status === 'ok', 'Unexpected /health response');
      return data;
    });

    const meta = await runStep('POST /info {type:"meta"}', async () => {
      const data = await postJson(baseUrl, '/info', { type: 'meta' }, timeoutMs, verbose);
      assert(Array.isArray(data.universe) && data.universe.length > 0, 'Meta response has no universe');
      return data;
    });

    await runStep('POST /info {type:"metaAndAssetCtxs"}', async () => {
      const data = await postJson(baseUrl, '/info', { type: 'metaAndAssetCtxs' }, timeoutMs, verbose);
      const assetCtxs = Array.isArray(data) ? data[1] : data.assetCtxs;
      assert(Array.isArray(assetCtxs) && assetCtxs.length > 0, 'metaAndAssetCtxs has no asset contexts');
      return { raw: data, assetCtxs };
    });

    const allMids = await runStep('POST /info {type:"allMids"}', async () => {
      const data = await postJson(baseUrl, '/info', { type: 'allMids' }, timeoutMs, verbose);
      assert(Object.keys(data).length > 0, 'allMids is empty; worker may not be seeded');
      return data;
    });

    const preferredCoins = [args.coin ?? process.env.HYPAPER_TEST_COIN, 'BTC', 'ETH', 'SOL'].filter(Boolean);
    const selectedIndex = meta.universe.findIndex((asset) => {
      if (preferredCoins.includes(asset.name) && allMids[asset.name]) return true;
      return false;
    });
    const fallbackIndex = meta.universe.findIndex((asset) => allMids[asset.name]);
    const assetIndex = selectedIndex >= 0 ? selectedIndex : fallbackIndex;
    assert(assetIndex >= 0, 'Could not find an asset with a live mid price');

    const asset = meta.universe[assetIndex];
    const coin = asset.name;
    const midPrice = allMids[coin];
    const size = formatSize(asset.szDecimals);
    const lowPrice = formatPrice(Number(midPrice) * 0.5);
    const highPrice = formatPrice(Number(midPrice) * 1.05);
    const now = Date.now();

    summary.coin = coin;
    summary.asset = assetIndex;

    console.log(`Coin:     ${coin} (asset ${assetIndex}, mid ${midPrice}, size ${size})`);

    await runStep('POST /info {type:"activeAssetCtx"}', async () => {
      const data = await postJson(baseUrl, '/info', { type: 'activeAssetCtx', coin }, timeoutMs, verbose);
      assert(data.coin === coin, 'activeAssetCtx returned wrong coin');
      assert(data.ctx && Object.keys(data.ctx).length > 0, 'activeAssetCtx is empty');
      return data;
    });

    await runStep('POST /info {type:"l2Book"}', async () => {
      const data = await postJson(baseUrl, '/info', { type: 'l2Book', coin }, timeoutMs, verbose);
      assert(data.coin === coin, 'l2Book returned wrong coin');
      assert(Array.isArray(data.levels), 'l2Book levels missing');
      return data;
    });

    ws = new WsInbox(wsUrl(baseUrl), timeoutMs, verbose);
    await runStep('Connect WebSocket /ws', () => ws.connect());

    await runStep('Subscribe WS allMids', async () => {
      const marker = ws.mark();
      ws.send({ method: 'subscribe', subscription: { type: 'allMids' } });
      await ws.waitFor((message) => message.channel === 'subscriptionResponse' && message.data?.subscription?.type === 'allMids', 'allMids subscribe ack', marker);
      await ws.waitFor((message) => message.channel === 'allMids' && message.data?.mids?.[coin], 'allMids snapshot', marker);
    });

    await runStep('Subscribe WS l2Book', async () => {
      const marker = ws.mark();
      ws.send({ method: 'subscribe', subscription: { type: 'l2Book', coin } });
      await ws.waitFor((message) => message.channel === 'subscriptionResponse' && message.data?.subscription?.type === 'l2Book' && message.data?.subscription?.coin === coin, 'l2Book subscribe ack', marker);
    });

    process.stdout.write('• Receive WS l2Book snapshot (best-effort) ... ');
    try {
      const marker = ws.mark();
      await Promise.race([
        ws.waitFor((message) => message.channel === 'l2Book' && message.data?.coin === coin, 'l2Book snapshot', marker, Math.min(timeoutMs, 4000)),
        sleep(Math.min(timeoutMs, 4000)),
      ]);
      const sawSnapshot = ws.messages.slice(marker).some((message) => message.channel === 'l2Book' && message.data?.coin === coin);
      if (sawSnapshot) {
        console.log('ok');
      } else {
        console.log('warn (server acknowledged subscription but did not publish an l2Book snapshot)');
        warnings.push('Receive WS l2Book snapshot: server acknowledged subscription but did not publish an l2Book snapshot');
      }
    } catch (error) {
      console.log(`warn (${error.message})`);
      warnings.push(`Receive WS l2Book snapshot: ${error.message}`);
    }

    await runStep('Subscribe WS orderUpdates', async () => {
      const marker = ws.mark();
      ws.send({ method: 'subscribe', subscription: { type: 'orderUpdates', user: wallet } });
      await ws.waitFor((message) => message.channel === 'subscriptionResponse' && message.data?.subscription?.type === 'orderUpdates' && message.data?.subscription?.user === wallet, 'orderUpdates subscribe ack', marker);
    });

    await runStep('Subscribe WS userFills', async () => {
      const marker = ws.mark();
      ws.send({ method: 'subscribe', subscription: { type: 'userFills', user: wallet } });
      await ws.waitFor((message) => message.channel === 'subscriptionResponse' && message.data?.subscription?.type === 'userFills' && message.data?.subscription?.user === wallet, 'userFills subscribe ack', marker);
    });

    await runStep('POST /hypaper resetAccount', async () => {
      const data = await postJson(baseUrl, '/hypaper', { type: 'resetAccount', user: wallet }, timeoutMs, verbose);
      assert(data.status === 'ok', 'resetAccount failed');
      return data;
    });

    await runStep('POST /hypaper setBalance', async () => {
      const data = await postJson(baseUrl, '/hypaper', { type: 'setBalance', user: wallet, balance }, timeoutMs, verbose);
      assert(data.status === 'ok', 'setBalance failed');
      return data;
    });

    await runStep('POST /hypaper getAccountInfo', async () => {
      const data = await postJson(baseUrl, '/hypaper', { type: 'getAccountInfo', user: wallet }, timeoutMs, verbose);
      assert(data.userId === wallet, 'getAccountInfo returned wrong user');
      assert(String(data.balance) === String(balance), 'Unexpected account balance');
      return data;
    });

    await runStep('POST /exchange updateLeverage', async () => {
      const data = await postJson(baseUrl, '/exchange', {
        wallet,
        action: {
          type: 'updateLeverage',
          asset: assetIndex,
          isCross: true,
          leverage: Math.min(asset.maxLeverage ?? 20, 5),
        },
      }, timeoutMs, verbose);
      assert(data.status === 'ok', 'updateLeverage failed');
      return data;
    });

    const restingCloid = `cloid-rest-${Date.now()}`;
    const restingMarker = ws.mark();
    const restingOrder = await runStep('POST /exchange order (ALO resting)', async () => {
      const data = await postJson(baseUrl, '/exchange', {
        wallet,
        action: {
          type: 'order',
          grouping: 'na',
          orders: [{
            a: assetIndex,
            b: true,
            p: lowPrice,
            s: size,
            r: false,
            t: { limit: { tif: 'Alo' } },
            c: restingCloid,
          }],
        },
      }, timeoutMs, verbose);
      const statuses = extractStatuses(data);
      assert(statuses.length === 1 && statuses[0].resting?.oid, 'ALO order did not rest');
      return statuses[0];
    });
    const aloOid = extractOid(restingOrder);
    summary.aloOid = aloOid;

    await runStep('Receive WS orderUpdates for resting order', async () => {
      await ws.waitFor((message) => message.channel === 'orderUpdates' && Array.isArray(message.data) && message.data.some((entry) => entry.order?.oid === aloOid && entry.status === 'open'), 'open order update', restingMarker);
    });

    await runStep('POST /info openOrders', async () => {
      const data = await postJson(baseUrl, '/info', { type: 'openOrders', user: wallet }, timeoutMs, verbose);
      assert(Array.isArray(data) && data.some((entry) => entry.oid === aloOid), 'openOrders missing resting order');
      return data;
    });

    await runStep('POST /info frontendOpenOrders', async () => {
      const data = await postJson(baseUrl, '/info', { type: 'frontendOpenOrders', user: wallet }, timeoutMs, verbose);
      assert(Array.isArray(data) && data.some((entry) => entry.oid === aloOid && entry.cloid === restingCloid), 'frontendOpenOrders missing resting order');
      return data;
    });

    await runStep('POST /info orderStatus (open)', async () => {
      const data = await postJson(baseUrl, '/info', { type: 'orderStatus', oid: aloOid }, timeoutMs, verbose);
      assert(data.status === 'order' && data.order?.status === 'open', 'orderStatus did not report open');
      return data;
    });

    const cancelMarker = ws.mark();
    await runStep('POST /exchange cancel', async () => {
      const data = await postJson(baseUrl, '/exchange', {
        wallet,
        action: {
          type: 'cancel',
          cancels: [{ a: assetIndex, o: aloOid }],
        },
      }, timeoutMs, verbose);
      const statuses = extractStatuses(data);
      assert(statuses.length === 1 && statuses[0] === 'success', 'cancel failed');
      return data;
    });

    await runStep('Receive WS orderUpdates for cancel', async () => {
      await ws.waitFor((message) => message.channel === 'orderUpdates' && Array.isArray(message.data) && message.data.some((entry) => entry.order?.oid === aloOid && entry.status === 'cancelled'), 'cancel order update', cancelMarker);
    });

    await runStep('POST /info orderStatus (cancelled)', async () => {
      const data = await postJson(baseUrl, '/info', { type: 'orderStatus', oid: aloOid }, timeoutMs, verbose);
      assert(data.status === 'order' && data.order?.status === 'cancelled', 'orderStatus did not report cancelled');
      return data;
    });

    const cloidValue = `cloid-cancel-${Date.now()}`;
    await runStep('POST /exchange order (cancelByCloid setup)', async () => {
      const data = await postJson(baseUrl, '/exchange', {
        wallet,
        action: {
          type: 'order',
          grouping: 'na',
          orders: [{
            a: assetIndex,
            b: true,
            p: lowPrice,
            s: size,
            r: false,
            t: { limit: { tif: 'Alo' } },
            c: cloidValue,
          }],
        },
      }, timeoutMs, verbose);
      const status = extractStatuses(data)[0];
      summary.cloidOid = extractOid(status);
      return data;
    });

    await runStep('POST /exchange cancelByCloid', async () => {
      const data = await postJson(baseUrl, '/exchange', {
        wallet,
        action: {
          type: 'cancelByCloid',
          cancels: [{ asset: assetIndex, cloid: cloidValue }],
        },
      }, timeoutMs, verbose);
      const statuses = extractStatuses(data);
      assert(statuses.length === 1 && statuses[0] === 'success', 'cancelByCloid failed');
      return data;
    });

    const fillWindowStart = Date.now();
    const fillMarker = ws.mark();
    const filledOrder = await runStep('POST /exchange order (IOC fill)', async () => {
      const data = await postJson(baseUrl, '/exchange', {
        wallet,
        action: {
          type: 'order',
          grouping: 'na',
          orders: [{
            a: assetIndex,
            b: true,
            p: highPrice,
            s: size,
            r: false,
            t: { limit: { tif: 'Ioc' } },
            c: `cloid-fill-${Date.now()}`,
          }],
        },
      }, timeoutMs, verbose);
      const statuses = extractStatuses(data);
      assert(statuses.length === 1 && statuses[0].filled?.oid, 'IOC order did not fill');
      return statuses[0];
    });
    const fillOid = extractOid(filledOrder);
    summary.fillOid = fillOid;

    const fillEvent = await runStep('Receive WS userFills', async () => {
      const message = await ws.waitFor((entry) => entry.channel === 'userFills' && entry.data?.user === wallet && Array.isArray(entry.data?.fills) && entry.data.fills.some((fill) => fill.oid === fillOid), 'user fill event', fillMarker);
      const fill = message.data.fills.find((entry) => entry.oid === fillOid);
      assert(fill, 'Missing fill payload');
      summary.fillTid = fill.tid;
      return fill;
    });

    await runStep('Receive WS orderUpdates for fill', async () => {
      await ws.waitFor((message) => message.channel === 'orderUpdates' && Array.isArray(message.data) && message.data.some((entry) => entry.order?.oid === fillOid && entry.status === 'filled'), 'filled order update', fillMarker);
    });

    await runStep('POST /info orderStatus (filled)', async () => {
      const data = await postJson(baseUrl, '/info', { type: 'orderStatus', oid: fillOid }, timeoutMs, verbose);
      assert(data.status === 'order' && data.order?.status === 'filled', 'orderStatus did not report filled');
      return data;
    });

    await runStep('POST /info clearinghouseState', async () => {
      const data = await postJson(baseUrl, '/info', { type: 'clearinghouseState', user: wallet }, timeoutMs, verbose);
      assert(Array.isArray(data.assetPositions), 'clearinghouseState missing assetPositions');
      assert(data.assetPositions.some((entry) => entry.position?.coin === coin), 'clearinghouseState missing filled position');
      return data;
    });

    await runStep('POST /info userFills', async () => {
      const data = await waitFor(async () => {
        const fills = await postJson(baseUrl, '/info', { type: 'userFills', user: wallet }, timeoutMs, verbose);
        return Array.isArray(fills) && fills.some((entry) => entry.oid === fillOid) ? fills : null;
      }, 'userFills in Postgres', timeoutMs, 500);
      return data;
    });

    await runStep('POST /info userFillsByTime', async () => {
      const data = await waitFor(async () => {
        const fills = await postJson(baseUrl, '/info', {
          type: 'userFillsByTime',
          user: wallet,
          startTime: fillWindowStart - 1000,
          endTime: Date.now() + 1000,
        }, timeoutMs, verbose);
        return Array.isArray(fills) && fills.some((entry) => entry.oid === fillOid) ? fills : null;
      }, 'userFillsByTime in Postgres', timeoutMs, 500);
      return data;
    });

    await runOptionalStep('POST /info {type:"candleSnapshot"}', async () => {
      const data = await postJson(baseUrl, '/info', {
        type: 'candleSnapshot',
        req: {
          coin,
          interval: '1m',
          startTime: now - (60 * 60 * 1000),
          endTime: now,
        },
      }, timeoutMs, verbose);
      assert(Array.isArray(data), 'candleSnapshot did not return an array');
      return data;
    }, warnings, strictProxy);

    await runOptionalStep('POST /info {type:"fundingHistory"}', async () => {
      const data = await postJson(baseUrl, '/info', {
        type: 'fundingHistory',
        coin,
        startTime: now - (7 * 24 * 60 * 60 * 1000),
        endTime: now,
      }, timeoutMs, verbose);
      assert(Array.isArray(data), 'fundingHistory did not return an array');
      return data;
    }, warnings, strictProxy);

    await runStep('Unsubscribe WS channels', async () => {
      for (const subscription of [
        { type: 'allMids' },
        { type: 'l2Book', coin },
        { type: 'orderUpdates', user: wallet },
        { type: 'userFills', user: wallet },
      ]) {
        const marker = ws.mark();
        ws.send({ method: 'unsubscribe', subscription });
        await ws.waitFor((message) => message.channel === 'subscriptionResponse' && message.data?.method === 'unsubscribe' && JSON.stringify(message.data?.subscription) === JSON.stringify(subscription), `unsubscribe ack for ${subscription.type}`, marker);
      }
    });

    console.log('\nSummary');
    console.log(`- health:        ${health.status}`);
    console.log(`- coin:          ${summary.coin} (asset ${summary.asset})`);
    console.log(`- resting oid:   ${summary.aloOid}`);
    console.log(`- cloid oid:     ${summary.cloidOid}`);
    console.log(`- filled oid:    ${summary.fillOid}`);
    console.log(`- fill tid:      ${summary.fillTid}`);
    console.log(`- websocket:     snapshots + order/fill events verified`);
    if (warnings.length > 0) {
      console.log(`- warnings:      ${warnings.length} non-fatal market-data check(s) skipped`);
      for (const warning of warnings) {
        console.log(`  - ${warning}`);
      }
    }
    console.log('\nPaper-trading routes, realtime channels, order placement, and fills passed.');
  } finally {
    if (ws) {
      await ws.close();
    }

    if (!keepAccount) {
      try {
        await postJson(baseUrl, '/hypaper', { type: 'resetAccount', user: wallet }, timeoutMs, false);
      } catch (error) {
        console.error(`Cleanup resetAccount failed: ${error.message}`);
      }
    }
  }
}

main().catch((error) => {
  console.error(`\nRealtime endpoint test failed: ${error.message}`);
  process.exitCode = 1;
});
