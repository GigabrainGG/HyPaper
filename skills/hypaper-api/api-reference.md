# HyPaper API Reference

## POST /exchange

All trading actions. Body: `{ "wallet": "0x...", "action": { ... } }`

Response wrapper:
```json
{ "status": "ok", "response": { "type": "order"|"cancel"|"default", "data": { "statuses": [...] } } }
```

Error wrapper:
```json
{ "status": "err", "response": "Error message here" }
```

### action.type: "order"

```json
{
  "type": "order",
  "orders": [{
    "a": 0,            // asset index (from meta.universe)
    "b": true,         // isBuy
    "p": "50000",      // price (string, must be positive)
    "s": "1",          // size (string, must be positive)
    "r": false,        // reduceOnly
    "t": {
      "limit": { "tif": "Gtc" }
    },
    "c": "my-cloid"    // optional client order ID
  }],
  "grouping": "na"     // "na" | "normalTpsl" | "positionTpsl"
}
```

**All fields are required** except `c` (cloid). The `t.limit.tif` field must always be present, even for trigger orders.

**Trigger orders** — add `t.trigger` alongside `t.limit`:
```json
{
  "t": {
    "trigger": {
      "isMarket": true,
      "triggerPx": "49000",
      "tpsl": "tp"         // "tp" | "sl"
    },
    "limit": { "tif": "Gtc" }
  }
}
```

Trigger orders always return `{ "resting": { "oid": ... } }` and fill asynchronously when the trigger condition is met.

**TIF behavior:**

| TIF | Behavior |
|-----|----------|
| `Gtc` | Fills immediately if mid price crosses limit, otherwise rests on book |
| `Ioc` | Must fill immediately or rejects |
| `Alo` | Post-only — rejects if it would fill immediately |

**Validation:**
- Max **50 orders** per request
- `a` must be a valid asset index (check via `meta` endpoint)
- `p` and `s` must be positive number strings
- All of `a` (number), `b` (boolean), `p` (string), `s` (string), `r` (boolean), `t.limit.tif` (string) are required

**Status responses per order:**
```json
{ "resting": { "oid": 123 } }
{ "resting": { "oid": 123, "cloid": "my-cloid" } }
{ "filled": { "totalSz": "1", "avgPx": "50010.5", "oid": 123 } }
{ "filled": { "totalSz": "1", "avgPx": "50010.5", "oid": 123, "cloid": "my-cloid" } }
{ "error": "Insufficient margin" }
```

### action.type: "cancel"

```json
{ "type": "cancel", "cancels": [{ "a": 0, "o": 12345 }] }
```

`a` = asset index, `o` = order ID (number).

**Success response:** Status array contains the string `"success"` (not an object).

**Error responses:**
- `"Order {oid} not found"` — wrong OID or wrong wallet
- `"Order {oid} is not open (status: filled)"` — already filled/cancelled

### action.type: "cancelByCloid"

```json
{ "type": "cancelByCloid", "cancels": [{ "asset": 0, "cloid": "my-cloid" }] }
```

Note: uses `asset` (not `a`) and `cloid` (not `o`). Different field names from regular cancel.

Error: `"cloid {cloid} not found"`.

### action.type: "updateLeverage"

```json
{ "type": "updateLeverage", "asset": 0, "isCross": true, "leverage": 20 }
```

Leverage range: **1–200**. Default is **20x cross** for all assets.

Response: `{ "status": "ok", "response": { "type": "default" } }`.

---

## POST /info

Query market data and user state. Body: `{ "type": "...", ... }`

### type: "allMids"

```json
Request:  { "type": "allMids" }
Response: { "BTC": "50000.5", "ETH": "3000.25" }
```

### type: "clearinghouseState"

```json
Request:  { "type": "clearinghouseState", "user": "0x..." }
Response: {
  "assetPositions": [{
    "type": "oneWay",
    "position": {
      "coin": "BTC",
      "szi": "1.5",
      "entryPx": "50000",
      "positionValue": "75000",
      "unrealizedPnl": "1500",
      "returnOnEquity": "0.5",
      "liquidationPx": "49000",
      "leverage": { "type": "cross", "value": 20 },
      "cumFunding": { "allTime": "100", "sinceOpen": "50", "sinceChange": "10" },
      "maxLeverage": 50,
      "marginUsed": "3750"
    }
  }],
  "crossMarginSummary": {
    "accountValue": "101500",
    "totalNtlPos": "75000",
    "totalRawUsd": "100000",
    "totalMarginUsed": "3750"
  },
  "marginSummary": { /* same shape as crossMarginSummary */ },
  "crossMaintenanceMarginUsed": "1875",
  "withdrawable": "97750",
  "time": 1705000000000
}
```

Key fields: `crossMarginSummary.accountValue` (total value), `assetPositions[].position.szi` (signed size — positive = long, negative = short), `assetPositions[].position.unrealizedPnl`.

### type: "openOrders"

```json
Request:  { "type": "openOrders", "user": "0x..." }
Response: [{
  "coin": "BTC", "side": "B", "limitPx": "49000", "sz": "1",
  "oid": 123, "timestamp": 1705000000000, "origSz": "1", "cloid": "optional"
}]
```

`side`: `"B"` = buy, `"A"` = sell (ask).

### type: "frontendOpenOrders"

Same as `openOrders` plus: `tif`, `orderType` ("Limit"|"Stop"), `triggerPx`, `triggerCondition`, `isPositionTpsl`, `reduceOnly`.

### type: "userFills"

```json
Request:  { "type": "userFills", "user": "0x..." }
Response: [{
  "coin": "BTC", "px": "50010", "sz": "1", "side": "B",
  "time": 1705000000000, "startPosition": "0",
  "dir": "Open Long",
  "closedPnl": "0", "hash": "0x...", "oid": 123,
  "crossed": true, "fee": "0", "tid": 1000, "feeToken": "USDC"
}]
```

Returns up to **100** most recent fills.

**`dir` values:** `"Open Long"`, `"Close Long"`, `"Open Short"`, `"Close Short"`, `"Buy"` (adding to long), `"Sell"` (adding to short).

### type: "userFillsByTime"

```json
{ "type": "userFillsByTime", "user": "0x...", "startTime": 1704900000000, "endTime": 1705000000000 }
```
`endTime` is optional. Same response shape as `userFills`.

### type: "orderStatus"

```json
Request:  { "type": "orderStatus", "oid": 12345 }
Response: {
  "status": "order",
  "order": {
    "coin": "BTC", "side": "B", "limitPx": "49000", "sz": "1",
    "oid": 12345, "timestamp": 1705000000000, "origSz": "1",
    "tif": "Gtc", "orderType": "Limit",
    "status": "open",
    "statusTimestamp": 1705000000000,
    "reduceOnly": false, "isPositionTpsl": false
  }
}
```

Order statuses: `"open"`, `"filled"`, `"cancelled"`, `"triggered"`, `"rejected"`.

If OID doesn't exist: `{ "status": "unknownOid" }`.

### type: "activeAssetCtx"

```json
Request:  { "type": "activeAssetCtx", "coin": "BTC" }
Response: {
  "coin": "BTC",
  "ctx": {
    "funding": "0.0001", "openInterest": "1000000", "prevDayPx": "49000",
    "dayNtlVlm": "500000000", "premium": "0.0005", "oraclePx": "50000",
    "markPx": "50010", "midPx": "50005.5", "impactPxs": ["50000", "50020"]
  }
}
```

### Proxied types (forwarded to real HyperLiquid with caching)

| Type | Cache TTL | Notes |
|------|-----------|-------|
| `meta` | 60s | **Call this first** to get asset indices |
| `metaAndAssetCtxs` | 2s | Meta + all asset contexts |
| `l2Book` | 1s | Order book depth |
| `candleSnapshot` | 5s | OHLCV candles |
| `fundingHistory` | 30s | Historical funding rates |
| `perpsAtOpenInterest` | 10s | OI data |
| `predictedFundings` | 10s | Predicted funding |
| Other unknown types | 5s | Any unrecognized type is proxied |

---

## POST /hypaper

Paper-trading-specific account management. Body: `{ "type": "...", "user": "0x..." }`

### type: "resetAccount"

Clears all positions, orders, fills. Resets balance to default ($100,000).
```json
Request:  { "type": "resetAccount", "user": "0x..." }
Response: { "status": "ok", "message": "Account reset" }
```

### type: "setBalance"

```json
Request:  { "type": "setBalance", "user": "0x...", "balance": 500000 }
Response: { "status": "ok", "balance": "500000" }
```

`balance` must be a number (not a string).

### type: "getAccountInfo"

```json
Request:  { "type": "getAccountInfo", "user": "0x..." }
Response: { "userId": "0x...", "balance": "100000", "createdAt": 1705000000000 }
```

---

## WebSocket — /ws

Connect to `ws://localhost:3000/ws`. JSON messages only. 30s ping/pong heartbeat.

### Subscribe / Unsubscribe

```json
{ "method": "subscribe", "subscription": { "type": "allMids" } }
{ "method": "subscribe", "subscription": { "type": "l2Book", "coin": "BTC" } }
{ "method": "subscribe", "subscription": { "type": "orderUpdates", "user": "0x..." } }
{ "method": "subscribe", "subscription": { "type": "userFills", "user": "0x..." } }
{ "method": "unsubscribe", "subscription": { "type": "allMids" } }
```

Server confirms with:
```json
{ "channel": "subscriptionResponse", "data": { "method": "subscribe", "subscription": { "type": "allMids" } } }
```

**Snapshots on subscribe:** `allMids` and `l2Book` send an initial snapshot immediately. `orderUpdates` and `userFills` do not — they only push new events.

### Channel: allMids

```json
{ "channel": "allMids", "data": { "mids": { "BTC": "50000.5", "ETH": "3000.25" } } }
```

### Channel: l2Book

```json
{ "channel": "l2Book", "data": {
  "coin": "BTC",
  "levels": [
    [{ "px": "49999", "sz": "1.5", "n": 3 }],
    [{ "px": "50001", "sz": "2", "n": 4 }]
  ],
  "time": 1705000000000
}}
```

### Channel: orderUpdates

```json
{ "channel": "orderUpdates", "data": [{
  "order": { "coin": "BTC", "side": "B", "limitPx": "49000", "sz": "1", "oid": 123, "timestamp": 1705000000000 },
  "status": "open",
  "statusTimestamp": 1705000000000
}]}
```

Status values: `"open"`, `"filled"`, `"cancelled"`.

### Channel: userFills

```json
{ "channel": "userFills", "data": {
  "isSnapshot": false, "user": "0x...",
  "fills": [{ "coin": "BTC", "px": "50010", "sz": "1", "side": "B", "dir": "Open Long", ... }]
}}
```

---

## Common Agent Patterns

### Pattern: Market buy (IOC at high price)

IOC at a price above market ensures immediate fill:
```json
{
  "wallet": "0xagent",
  "action": {
    "type": "order",
    "grouping": "na",
    "orders": [{ "a": 0, "b": true, "p": "999999", "s": "0.01", "r": false, "t": {"limit": {"tif": "Ioc"}} }]
  }
}
```

Fill price will be VWAP from the L2 book, not your limit price.

### Pattern: Open long + set stop-loss + take-profit

```json
{
  "wallet": "0xagent",
  "action": {
    "type": "order",
    "grouping": "na",
    "orders": [
      { "a": 0, "b": true, "p": "50000", "s": "0.1", "r": false,
        "t": {"limit": {"tif": "Gtc"}} },
      { "a": 0, "b": false, "p": "48000", "s": "0.1", "r": true,
        "t": {"trigger": {"isMarket": true, "triggerPx": "48000", "tpsl": "sl"}, "limit": {"tif": "Gtc"}} },
      { "a": 0, "b": false, "p": "55000", "s": "0.1", "r": true,
        "t": {"trigger": {"isMarket": true, "triggerPx": "55000", "tpsl": "tp"}, "limit": {"tif": "Gtc"}} }
    ]
  }
}
```

### Pattern: Check PnL and close if profitable

1. `POST /info` with `{"type": "clearinghouseState", "user": "0xagent"}`
2. Read `assetPositions[].position.unrealizedPnl`
3. If positive, close with a reduce-only sell: `"r": true, "b": false`

### Pattern: Cancel all open orders

1. `POST /info` with `{"type": "openOrders", "user": "0xagent"}`
2. For each order, `POST /exchange` with cancel action

### Pattern: Reset and start fresh

```json
POST /hypaper: { "type": "resetAccount", "user": "0xagent" }
```

---

## Complete Error Reference

### /exchange errors

| Error | Cause |
|-------|-------|
| `"Missing wallet address"` | No `wallet` field in body or not a string |
| `"Missing or invalid action"` | No `action` field, not an object, or missing `action.type` |
| `"Missing orders array"` | `action.orders` is missing or empty |
| `"Max 50 orders per request"` | More than 50 orders in one request |
| `"Invalid order wire format"` | Missing or wrong types for `a`, `b`, `p`, `s`, `r`, or `t.limit.tif` |
| `"Size and price must be positive"` | `p` or `s` parses to <= 0 |
| `"Unknown asset {n}"` | Asset index not in `meta.universe` |
| `"No market price available"` | No mid price in Redis yet (server just started) |
| `"IOC order could not be filled"` | IOC can't fill at current mid price |
| `"ALO order would have crossed"` | ALO (post-only) would match immediately |
| `"Insufficient margin"` | Not enough available margin for this order |
| `"Missing cancels array"` | `action.cancels` is missing or empty |
| `"Order {oid} not found"` | Bad OID or belongs to different wallet |
| `"cloid {cloid} not found"` | Client order ID doesn't exist for this wallet |
| `"Leverage must be between 1 and 200"` | Out of range |
| `"Unsupported action type: {type}"` | Unknown action type |

### /info errors

| Error | Cause |
|-------|-------|
| `"Missing type"` | No `type` field in body |
| `"Missing user"` | User-specific query without `user` field |
| `"Missing coin"` | `activeAssetCtx` without `coin` field |

### /hypaper errors

| Error | Cause |
|-------|-------|
| `"Missing type"` | No `type` field in body |
| `"Missing user"` | No `user` field or not a string |
| `"Missing or invalid balance"` | `setBalance` without numeric `balance` field |
| `"Unknown hypaper type: {type}"` | Unrecognized type |

### Rate Limiting

Default: **120 requests / 60 seconds** per IP. Returns HTTP **429** with `X-RateLimit-Remaining` header.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | (required) | PostgreSQL connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `HL_WS_URL` | `wss://api.hyperliquid.xyz/ws` | HyperLiquid WebSocket URL |
| `HL_API_URL` | `https://api.hyperliquid.xyz` | HyperLiquid REST API URL |
| `PORT` | `3000` | HTTP server port |
| `DEFAULT_BALANCE` | `100000` | Starting USDC balance for new accounts |
| `LOG_LEVEL` | `info` | Pino log level |
| `RATE_LIMIT_MAX` | `120` | Max requests per window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window in ms |
