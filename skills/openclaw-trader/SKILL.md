---
name: openclaw-trader
description: Autonomous Base chain crypto trading bot with AI-powered analysis. Scans DexScreener, executes swaps via 0x, manages positions with tiered trailing stop-loss, and sends Telegram alerts.
version: 1.0.0
homepage: https://github.com/openclaw/openclaw-trader
user-invocable: true
metadata: { "openclaw": { "emoji": "📈", "requires": { "env": ["PRIVATE_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "ZEROX_API_KEY"], "bins": ["node"] }, "primaryEnv": "ANTHROPIC_API_KEY", "homepage": "https://github.com/openclaw/openclaw-trader" } }
---

# OpenClaw Trader — Autonomous Base Chain Trading Bot

An AI-powered autonomous trading agent for the Base chain (L2 Ethereum). It scans DexScreener for high-momentum tokens, uses Claude to analyze and filter candidates, executes swaps via the 0x aggregator, and manages positions with an adaptive tiered trailing stop-loss.

## What It Does

1. **Scans DexScreener** every 15 minutes for trending Base chain tokens
2. **Claude AI Analysis**: Each candidate is evaluated by Claude for risk, authenticity, and potential before buying
3. **Executes swaps** via the 0x aggregator (best price across all Base DEXes) using USDC as the base currency
4. **Tiered trailing stop-loss**: 20% trail at 0-50% profit → 10% at 50-100% → 5% at >100% profit
5. **Telegram notifications**: Trade alerts, stop-loss triggers, low ETH warnings, and portfolio summaries
6. **AI portfolio review**: Claude reviews open positions each cycle and can recommend sells

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PRIVATE_KEY` | ✅ | Wallet private key for executing trades on Base |
| `TELEGRAM_BOT_TOKEN` | ✅ | Telegram bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | ✅ | Your Telegram chat ID for notifications |
| `ZEROX_API_KEY` | ✅ | 0x Swap API key (free at dashboard.0x.org) |
| `ANTHROPIC_API_KEY` | Recommended | Claude API key for AI-powered trade analysis |
| `BASE_RPC_URL` | Optional | Base chain RPC (default: https://mainnet.base.org) |
| `DRY_RUN` | Optional | Set `true` to simulate trades without executing |
| `SCAN_INTERVAL_MIN` | Optional | Scan interval in minutes (default: 15) |
| `MAX_POSITIONS` | Optional | Max concurrent positions (default: 5) |
| `TRADE_PERCENT` | Optional | % of USDC balance per trade (default: 10) |
| `ETH_WARN_THRESHOLD` | Optional | ETH balance warning level (default: 0.001) |
| `SLIPPAGE_BPS` | Optional | Slippage tolerance in bps (default: 100 = 1%) |

## Telegram Commands

- `/status` — Overview of balances and positions
- `/portfolio` — Detailed position list with P&L and stop-loss levels
- `/balance` — ETH + USDC balances with wallet address
- `/history` — Last 10 trades
- `/pause` — Pause autonomous trading
- `/resume` — Resume trading
- `/sell <address>` — Force-sell a position
- `/blacklist <address>` — Blacklist a token from future buys

## How To Run

```bash
# Install dependencies
cd {baseDir}
npm install

# Build
npm run build

# Run (with .env file or exported env vars)
npm start

# Or development mode
npm run dev
```

## Deployment

Designed for **Railway** deployment:
- Dockerfile included (multi-stage Node 20 build)
- `railway.toml` pre-configured
- Set all required env vars in Railway dashboard
- Uses Telegram long-polling (no exposed port needed)

## Safety Features

- AI filters reject suspicious tokens (wash trading, rug pull patterns)
- Max 5 concurrent positions (hardcoded limit)
- Min $0.01 USDC floor — won't trade below this
- 1% slippage tolerance (configurable)
- DRY_RUN mode for safe testing
- Token blacklist persists across restarts
- Low ETH balance warnings via Telegram
