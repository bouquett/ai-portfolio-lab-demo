import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const DAY_MS = 86_400_000;
const SYMBOLS = ["SPY"];
const execFileAsync = promisify(execFile);

function isoDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function addDays(date, days) {
  return isoDate(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS);
}

async function fetchJson(url, init = {}) {
  const headers = { "user-agent": "Mozilla/5.0 GitHubPagesPortfolioData/1.0", ...(init.headers ?? {}) };
  try {
    const response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(8_000), headers });
    if (!response.ok) throw new Error(`${new URL(url).hostname}: HTTP ${response.status}`);
    return await response.json();
  } catch (fetchError) {
    const args = ["-fsSL", "--max-time", "30"];
    for (const [key, value] of Object.entries(headers)) args.push("-H", `${key}: ${value}`);
    args.push(url);
    try {
      const { stdout } = await execFileAsync("curl", args, { maxBuffer: 64 * 1024 * 1024 });
      return JSON.parse(stdout);
    } catch {
      throw fetchError;
    }
  }
}

function clean(points) {
  const rows = new Map();
  for (const point of points) {
    const value = Number(point.value);
    if (point.date && Number.isFinite(value) && value > 0) rows.set(point.date, value);
  }
  return [...rows.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, value]) => ({ date, value }));
}

async function yahooHistory(symbol, start, end) {
  const params = new URLSearchParams({
    period1: String(Math.floor(Date.parse(`${start}T00:00:00Z`) / 1000)),
    period2: String(Math.floor((Date.parse(`${end}T00:00:00Z`) + DAY_MS) / 1000)),
    interval: "1d",
    events: "div,splits",
    includeAdjustedClose: "true",
  });
  let lastError;
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const payload = await fetchJson(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`);
      const result = payload?.chart?.result?.[0];
      if (!result) throw new Error(payload?.chart?.error?.description ?? "Yahoo result missing");
      const values = result.indicators?.adjclose?.[0]?.adjclose ?? result.indicators?.quote?.[0]?.close ?? [];
      const points = clean((result.timestamp ?? []).map((stamp, index) => ({ date: isoDate(Number(stamp) * 1000), value: values[index] })));
      if (!points.length) throw new Error("Yahoo history empty");
      return { name: result.meta?.longName || result.meta?.shortName || symbol, points, source: "Yahoo Finance复权日线" };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function nasdaqHistory(symbol, start, end) {
  let lastError;
  const headers = { accept: "application/json, text/plain, */*", origin: "https://www.nasdaq.com", referer: "https://www.nasdaq.com/" };
  for (const assetclass of ["etf", "stocks"]) {
    try {
      const params = new URLSearchParams({ assetclass, fromdate: start, todate: end, limit: "5000" });
      const [history, info] = await Promise.all([
        fetchJson(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/historical?${params}`, { headers }),
        fetchJson(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/info?assetclass=${assetclass}`, { headers }),
      ]);
      const points = clean((history?.data?.tradesTable?.rows ?? []).map((row) => {
        const match = String(row?.date ?? "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        return {
          date: match ? `${match[3]}-${match[1]}-${match[2]}` : "",
          value: Number(String(row?.close ?? "").replace(/[$,]/g, "")),
        };
      }));
      if (!points.length) throw new Error("Nasdaq history empty");
      return { name: info?.data?.companyName || symbol, points, source: "Nasdaq历史收盘价（未计现金分红）" };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function assetHistory(symbol, start, end) {
  try {
    return await yahooHistory(symbol, start, end);
  } catch {
    return nasdaqHistory(symbol, start, end);
  }
}

async function fxHistory(start, end) {
  try {
    const result = await yahooHistory("CNY=X", start, end);
    return { ...result, source: "Yahoo Finance USD/CNY" };
  } catch {
    const payload = await fetchJson(`https://api.frankfurter.dev/v1/${start}..${end}?from=USD&to=CNY`);
    const points = clean(Object.entries(payload.rates ?? {}).map(([date, row]) => ({ date, value: row?.CNY })));
    if (!points.length) throw new Error("USD/CNY history empty");
    return { name: "美元兑人民币", points, source: "Frankfurter（ECB参考汇率）" };
  }
}

function combine(asset, fx) {
  const points = [];
  let fxIndex = 0;
  let latestFx;
  for (const assetPoint of asset.points) {
    while (fxIndex < fx.points.length && fx.points[fxIndex].date <= assetPoint.date) {
      latestFx = fx.points[fxIndex].value;
      fxIndex += 1;
    }
    if (Number.isFinite(latestFx)) points.push({ date: assetPoint.date, value: assetPoint.value * latestFx });
  }
  return points;
}

const end = isoDate(Date.now());
const start = addDays(end, -Math.ceil(11 * 365.25));
const fx = await fxHistory(start, end);
await mkdir(new URL("../data/us/", import.meta.url), { recursive: true });

for (const symbol of SYMBOLS) {
  const asset = await assetHistory(symbol, start, end);
  const points = combine(asset, fx);
  if (points.length < 250) throw new Error(`${symbol} output has only ${points.length} points`);
  const output = {
    code: symbol,
    name: asset.name,
    source: `${asset.source} × ${fx.source}（GitHub Actions日更快照）`,
    generatedAt: new Date().toISOString(),
    startDate: points[0].date,
    endDate: points.at(-1).date,
    points,
  };
  await writeFile(new URL(`../data/us/${symbol}.json`, import.meta.url), `${JSON.stringify(output)}\n`, "utf8");
  console.log(`${symbol}: ${points.length} points through ${output.endDate}`);
}
