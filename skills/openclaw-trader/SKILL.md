```skill
---
name: openclaw-trader
description: Base chain stop-loss monitor bot. You buy manually, send the bot a contract address + stop-loss price, and it monitors every 30s — auto-sells on stop-loss and notifies on every 25% price increase.
version: 2.0.0
homepage: https://github.com/openclaw/openclaw-trader
user-invocable: true
metadata: { "openclaw": { "emoji": "📈", "requires": { "env": ["PRIVATE_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "ZEROX_API_KEY"], "bins": ["node"] }, "homepage": "https://github.com/openclaw/openclaw-trader" } }
---

# OpenClaw Trader — Base Chain Stop-Loss Monitor

A Telegram-controlled stop-loss monitor for the Base chain (L2 Ethereum). You buy tokens manually, then tell the bot what to watch. It monitors prices every 30 seconds, auto-sells when your stop-loss is hit, and sends milestone notifications as the price rises.

## How It Works

1. **You buy a token** manually from your wallet
2. **Send the bot**: `<contract_address> <stop_loss_price>` (e.g. `0x1234...abcd 0.005`)
3. **Bot monitors** the price every 30 seconds via DexScreener
4. **Stop-loss hit?** → Bot sells all your holdings of that token automatically
5. **Price going up?** → Bot sends a Telegram alert every +25% from your entry price

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PRIVATE_KEY` | ✅ | Wallet private key for executing sells on Base |
| `TELEGRAM_BOT_TOKEN` | ✅ | Telegram bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | ✅ | Your Telegram chat ID for notifications |
| `ZEROX_API_KEY` | ✅ | 0x Swap API key (free at dashboard.0x.org) |
| `BASE_RPC_URL` | Optional | Base chain RPC (default: https://mainnet.base.org) |
| `DRY_RUN` | Optional | Set `true` to simulate sells without executing |
| `MAX_POSITIONS` | Optional | Max concurrent monitors (default: 10) |
| `ETH_WARN_THRESHOLD` | Optional | ETH balance warning level (default: 0.001) |
| `SLIPPAGE_BPS` | Optional | Slippage tolerance in bps (default: 100 = 1%) |
| `MONITOR_INTERVAL_SEC` | Optional | Price check interval (default: 30) |

## Telegram Commands

- `/start` — Show help and usage format
- `/status` — Overview of balances and active monitors
- `/monitors` — Detailed list of all active monitors
- `/balance` — ETH + USDC balances with wallet address
- `/history` — Last 10 trades
- `/sell <address>` — Force-sell all holdings of a token
- `/stop <address>` — Stop monitoring a specific token
- `/stopall` — Stop all monitors
- `/pause` — Pause all monitoring
- `/resume` — Resume monitoring

## Message Format

To start monitoring a token, send a plain text message:

```
<contract_address> <stop_loss_price>
```

**Examples:**
- `0x1234abcd5678ef901234abcd5678ef9012345678 0.005`
- `0xABCDEF1234567890ABCDEF1234567890ABCDEF12 1.50`

The bot will look up the token, confirm the current price, and start monitoring.

## How To Run

```bash
cd {baseDir}
npm install
npm run build
npm start
```

## Deployment

Designed for **Railway** deployment:
- Dockerfile included (multi-stage Node 20 build)
- `railway.toml` pre-configured
- Set all required env vars in Railway dashboard
```
