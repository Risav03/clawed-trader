import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "../config/index.js";
import {
  getPositions,
  getFullHistory,
  isTradingPaused,
  type Position,
  type TradeHistoryEntry,
} from "../positions/manager.js";
import {
  getEthBalanceFormatted,
  getUsdcBalanceFormatted,
  getWalletAddress,
} from "../chain/wallet.js";
import { isAIEnabled } from "../ai/analyst.js";
import { logger } from "../utils/logger.js";

// ── State (set once on startup) ────────────────────────────────────

let startedAt = 0;
let startingBalanceUsdc = 0;

export function setStartingBalance(usdc: number): void {
  startingBalanceUsdc = usdc;
  startedAt = Date.now();
}

// ── CORS helper ────────────────────────────────────────────────────

function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  setCors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ── Route handlers ─────────────────────────────────────────────────

async function handleStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const [ethBal, usdcBal] = await Promise.all([
    getEthBalanceFormatted(),
    getUsdcBalanceFormatted(),
  ]);

  const currentUsdc = parseFloat(usdcBal);
  const positions = getPositions();
  const totalInvested = positions.reduce(
    (sum, p) => sum + parseFloat(p.usdcInvested),
    0
  );
  const history = getFullHistory();
  const completedSells = history.filter((t) => t.type === "sell");
  const realizedPnl = completedSells.reduce((sum, t) => {
    const invested = history.find(
      (h) =>
        h.type === "buy" &&
        h.tokenAddress.toLowerCase() === t.tokenAddress.toLowerCase() &&
        h.timestamp < t.timestamp
    );
    if (invested) {
      return sum + (parseFloat(t.usdcAmount) - parseFloat(invested.usdcAmount));
    }
    return sum;
  }, 0);

  const pnlUsdc = currentUsdc + totalInvested - startingBalanceUsdc + realizedPnl;
  const pnlPercent = startingBalanceUsdc > 0 ? (pnlUsdc / startingBalanceUsdc) * 100 : 0;

  json(res, {
    startedAt: new Date(startedAt).toISOString(),
    uptimeMinutes: Math.round((Date.now() - startedAt) / 60_000),
    wallet: getWalletAddress(),
    startingBalanceUsdc: round(startingBalanceUsdc),
    currentBalanceUsdc: round(currentUsdc),
    currentBalanceEth: ethBal,
    totalInvestedUsdc: round(totalInvested),
    realizedPnlUsdc: round(realizedPnl),
    estimatedPnlUsdc: round(pnlUsdc),
    estimatedPnlPercent: round(pnlPercent),
    openPositions: positions.length,
    maxPositions: config.maxPositions,
    totalTrades: history.length,
    paused: isTradingPaused(),
    aiEnabled: isAIEnabled(),
    dryRun: config.dryRun,
  });
}

async function handleTrades(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const history = getFullHistory();

  // Enrich each trade with cumulative balance tracking
  let cumulativeBalance = startingBalanceUsdc;
  const enriched = history.map((trade) => {
    if (trade.type === "buy") {
      cumulativeBalance -= parseFloat(trade.usdcAmount);
    } else {
      cumulativeBalance += parseFloat(trade.usdcAmount);
    }
    return {
      ...trade,
      balanceAfterUsdc: round(cumulativeBalance),
      timestampISO: new Date(trade.timestamp).toISOString(),
    };
  });

  json(res, {
    startingBalanceUsdc: round(startingBalanceUsdc),
    trades: enriched,
  });
}

async function handlePositions(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const positions = getPositions();

  const enriched = positions.map((p) => {
    const profitPercent =
      p.entryPrice > 0
        ? ((p.currentPrice - p.entryPrice) / p.entryPrice) * 100
        : 0;
    return {
      ...p,
      profitPercent: round(profitPercent),
      unrealizedPnlUsdc: round(
        (p.currentPrice / p.entryPrice - 1) * parseFloat(p.usdcInvested)
      ),
    };
  });

  const totalInvested = positions.reduce(
    (s, p) => s + parseFloat(p.usdcInvested),
    0
  );
  const totalUnrealizedPnl = enriched.reduce(
    (s, p) => s + (p.unrealizedPnlUsdc || 0),
    0
  );

  json(res, {
    positions: enriched,
    totalInvestedUsdc: round(totalInvested),
    totalUnrealizedPnlUsdc: round(totalUnrealizedPnl),
  });
}

function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  json(res, { status: "ok", uptime: process.uptime() });
}

// ── Dashboard HTML ─────────────────────────────────────────────────

function handleDashboard(_req: IncomingMessage, res: ServerResponse): void {
  setCors(res);
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(DASHBOARD_HTML);
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>OpenClaw Trader Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
    h1 { color: #58a6ff; margin-bottom: 8px; font-size: 24px; }
    h2 { color: #8b949e; margin: 24px 0 12px; font-size: 18px; }
    .subtitle { color: #8b949e; font-size: 14px; margin-bottom: 24px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .stat { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
    .stat-label { font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-value { font-size: 22px; font-weight: 600; margin-top: 4px; }
    .positive { color: #3fb950; }
    .negative { color: #f85149; }
    .neutral { color: #c9d1d9; }
    .chart-container { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 24px; }
    canvas { max-height: 350px; }
    table { width: 100%; border-collapse: collapse; background: #161b22; border-radius: 8px; overflow: hidden; }
    th { background: #21262d; text-align: left; padding: 10px 12px; font-size: 12px; color: #8b949e; text-transform: uppercase; }
    td { padding: 10px 12px; border-top: 1px solid #21262d; font-size: 13px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .badge-buy { background: #1f3d2a; color: #3fb950; }
    .badge-sell { background: #3d1f1f; color: #f85149; }
    .refresh-btn { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; }
    .refresh-btn:hover { background: #30363d; }
    .header { display: flex; justify-content: space-between; align-items: center; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>🐾 OpenClaw Trader</h1>
      <p class="subtitle">Autonomous Base Chain Trading Bot</p>
    </div>
    <button class="refresh-btn" onclick="loadAll()">↻ Refresh</button>
  </div>
  <div class="stats" id="stats"></div>
  <div class="chart-container">
    <h2>Balance Over Time</h2>
    <canvas id="balanceChart"></canvas>
  </div>
  <h2>Open Positions</h2>
  <table id="positionsTable"><thead><tr><th>Token</th><th>Entry Price</th><th>Current Price</th><th>Invested</th><th>P&L %</th></tr></thead><tbody></tbody></table>
  <h2 style="margin-top:24px">Trade History</h2>
  <table id="tradesTable"><thead><tr><th>Time</th><th>Type</th><th>Token</th><th>USDC Amount</th><th>Price</th><th>P&L %</th><th>Balance After</th></tr></thead><tbody></tbody></table>
  <script>
    let chart = null;
    const API = window.location.origin;

    async function loadAll() {
      const [status, trades, positions] = await Promise.all([
        fetch(API + '/api/status').then(r => r.json()),
        fetch(API + '/api/trades').then(r => r.json()),
        fetch(API + '/api/positions').then(r => r.json()),
      ]);
      renderStats(status);
      renderChart(trades);
      renderPositions(positions);
      renderTrades(trades);
    }

    function renderStats(s) {
      const cls = s.estimatedPnlPercent >= 0 ? 'positive' : 'negative';
      document.getElementById('stats').innerHTML = [
        stat('Starting Balance', '$' + s.startingBalanceUsdc.toFixed(2)),
        stat('Current USDC', '$' + s.currentBalanceUsdc.toFixed(2)),
        stat('ETH Balance', s.currentBalanceEth),
        stat('Est. P&L', (s.estimatedPnlPercent >= 0 ? '+' : '') + s.estimatedPnlPercent.toFixed(2) + '%', cls),
        stat('Realized P&L', '$' + s.realizedPnlUsdc.toFixed(2), s.realizedPnlUsdc >= 0 ? 'positive' : 'negative'),
        stat('Open Positions', s.openPositions + '/' + s.maxPositions),
        stat('Total Trades', s.totalTrades),
        stat('Status', s.paused ? 'PAUSED' : (s.dryRun ? 'DRY RUN' : 'LIVE'), s.paused ? 'negative' : 'neutral'),
      ].join('');
    }

    function stat(label, value, cls = 'neutral') {
      return '<div class="stat"><div class="stat-label">' + label + '</div><div class="stat-value ' + cls + '">' + value + '</div></div>';
    }

    function renderChart(data) {
      const labels = [new Date(Date.now() - 1000).toLocaleString()];
      const values = [data.startingBalanceUsdc];
      for (const t of data.trades) {
        labels.push(new Date(t.timestamp).toLocaleString());
        values.push(t.balanceAfterUsdc);
      }
      if (chart) chart.destroy();
      chart = new Chart(document.getElementById('balanceChart'), {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'USDC Balance',
            data: values,
            borderColor: '#58a6ff',
            backgroundColor: 'rgba(88,166,255,0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 3,
          }]
        },
        options: {
          responsive: true,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: '#8b949e', maxTicksLimit: 10 }, grid: { color: '#21262d' } },
            y: { ticks: { color: '#8b949e', callback: v => '$' + v }, grid: { color: '#21262d' } }
          }
        }
      });
    }

    function renderPositions(data) {
      const tbody = document.querySelector('#positionsTable tbody');
      if (data.positions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#8b949e">No open positions</td></tr>';
        return;
      }
      tbody.innerHTML = data.positions.map(p => {
        const cls = p.profitPercent >= 0 ? 'positive' : 'negative';
        return '<tr><td><b>' + p.tokenSymbol + '</b></td><td>$' + p.entryPrice.toFixed(6) + '</td><td>$' + p.currentPrice.toFixed(6) + '</td><td>$' + parseFloat(p.usdcInvested).toFixed(2) + '</td><td class="' + cls + '">' + (p.profitPercent >= 0 ? '+' : '') + p.profitPercent.toFixed(2) + '%</td></tr>';
      }).join('');
    }

    function renderTrades(data) {
      const tbody = document.querySelector('#tradesTable tbody');
      if (data.trades.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#8b949e">No trades yet</td></tr>';
        return;
      }
      tbody.innerHTML = data.trades.slice().reverse().map(t => {
        const pnl = t.profitPercent != null ? ((t.profitPercent >= 0 ? '+' : '') + t.profitPercent.toFixed(2) + '%') : '—';
        const pnlCls = t.profitPercent != null ? (t.profitPercent >= 0 ? 'positive' : 'negative') : '';
        return '<tr><td>' + new Date(t.timestamp).toLocaleString() + '</td><td><span class="badge badge-' + t.type + '">' + t.type.toUpperCase() + '</span></td><td>' + t.tokenSymbol + '</td><td>$' + parseFloat(t.usdcAmount).toFixed(2) + '</td><td>$' + t.price.toFixed(6) + '</td><td class="' + pnlCls + '">' + pnl + '</td><td>$' + t.balanceAfterUsdc.toFixed(2) + '</td></tr>';
      }).join('');
    }

    loadAll();
    setInterval(loadAll, 30000);
  </script>
</body>
</html>`;

// ── Router ─────────────────────────────────────────────────────────

async function router(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    switch (path) {
      case "/":
        return handleDashboard(req, res);
      case "/api/status":
        return await handleStatus(req, res);
      case "/api/trades":
        return await handleTrades(req, res);
      case "/api/positions":
        return await handlePositions(req, res);
      case "/health":
        return handleHealth(req, res);
      default:
        json(res, { error: "Not found" }, 404);
    }
  } catch (err) {
    logger.error({ err, path }, "API request failed");
    json(res, { error: "Internal server error" }, 500);
  }
}

// ── Server startup ─────────────────────────────────────────────────

let server: ReturnType<typeof createServer> | null = null;

export function startApiServer(port: number): void {
  server = createServer((req, res) => {
    router(req, res).catch((err) => {
      logger.error({ err }, "Unhandled API error");
      res.writeHead(500);
      res.end("Internal server error");
    });
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      logger.warn({ port }, "Port in use — API server disabled (bot continues running)");
    } else {
      logger.error({ err }, "API server error");
    }
  });

  server.listen(port, "0.0.0.0", () => {
    logger.info({ port }, "API server listening");
  });
}

export function stopApiServer(): void {
  if (server) {
    server.close();
    server = null;
    logger.info("API server stopped");
  }
}

// ── Utility ────────────────────────────────────────────────────────

function round(n: number, decimals = 2): number {
  return Math.round(n * 10 ** decimals) / 10 ** decimals;
}
