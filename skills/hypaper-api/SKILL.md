---
name: hypaper-api
description: HyPaper paper trading API reference. Use when working with HyPaper endpoints, placing paper trades, querying positions, or integrating with the HyperLiquid-compatible paper trading backend.
---

# HyPaper — Agent Paper Trading Guide

Paper trading backend for HyperLiquid. Fake money, real prices, same wire format.

## Quick Start

1. **Discover assets:** `POST /info {"type": "meta"}` — response `universe[]` maps coin names to asset indices (`a`)
2. **Check balance:** `POST /hypaper {"type": "getAccountInfo", "user": "0xagent"}` — auto-created with $100k USDC
3. **Get prices:** `POST /info {"type": "allMids"}`
4. **Place order:** `POST /exchange {"wallet": "0xagent", "action": {"type": "order", "grouping": "na", "orders": [{"a": 0, "b": true, "p": "90000", "s": "0.01", "r": false, "t": {"limit": {"tif": "Gtc"}}}]}}`
5. **Monitor:** `POST /info {"type": "clearinghouseState", "user": "0xagent"}`
6. **Close:** Same as place order but `"b": false, "r": true`

## Base URL & Auth

- **Base URL**: `http://localhost:3000` (configurable via `PORT` env var)
- **Auth**: None. Wallet address passed in request body. Any string works.
- **Content-Type**: `application/json` for all endpoints.
- **Health check:** `GET /health`

## Endpoints Overview

| Endpoint | Purpose |
|----------|---------|
| `POST /exchange` | Place orders, cancel orders, update leverage |
| `POST /info` | Query prices, positions, orders, fills, market data |
| `POST /hypaper` | Reset account, set balance, get account info |
| `WS /ws` | Real-time allMids, l2Book, orderUpdates, userFills |

## Key Mechanics

- **Order matching** runs on every price tick from HyperLiquid
- **Fill price** is VWAP from real L2 order book, clamped to limit price
- **Margin**: `marginNeeded = (size * price) / leverage`, default 20x cross
- **TIF**: `Gtc` (rests on book), `Ioc` (fill or reject), `Alo` (post-only)
- **Position flipping**: excess size becomes opposite direction at fill price
- **reduceOnly** orders skip margin checks

## Wire Field Reference

| Wire | Meaning | Type |
|------|---------|------|
| `a` | asset index | number |
| `b` | isBuy | boolean |
| `p` | limit price | string |
| `s` | size | string |
| `r` | reduceOnly | boolean |
| `t` | order type (tif + trigger) | object |
| `c` | client order ID | string (optional) |
| `o` | order ID (for cancels) | number |

## Additional Resources

- For complete API reference with all request/response shapes, error codes, and examples, see [api-reference.md](api-reference.md)
