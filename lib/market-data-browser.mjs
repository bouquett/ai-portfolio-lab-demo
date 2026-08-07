import { mergePriceSeries } from "./portfolio.mjs";

const FUND_TYPES = new Set(["债券基金", "宽基基金", "其他场外基金"]);
const DOMESTIC_TYPES = new Set(["ETF", "股票"]);
const DAY_MS = 86_400_000;
let fundScriptQueue = Promise.resolve();

function isoDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function addDays(date, days) {
  return isoDate(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS);
}

function securitySymbol(code) {
  if (!/^\d{6}$/.test(code)) throw new Error("境内证券代码必须是 6 位数字");
  return `${["5", "6", "9"].includes(code[0]) ? "sh" : "sz"}${code}`;
}

async function fetchJson(url, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("真实行情接口请求失败");
}

function uniqueSortedPoints(points) {
  const values = new Map();
  for (const point of points) {
    const value = Number(point.value);
    if (point.date && Number.isFinite(value) && value > 0) values.set(point.date, value);
  }
  return [...values.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, value]) => ({ date, value }));
}

function parseTencentKline(payload, symbol, code) {
  const data = payload?.data?.[symbol] ?? {};
  const rows = data.qfqday ?? data.day ?? [];
  const points = uniqueSortedPoints(rows.map((row) => ({ date: row?.[0], value: row?.[2] })));
  const quote = data.qt?.[symbol] ?? [];
  if (!points.length) throw new Error(`${code} 没有可用的腾讯真实行情`);
  return { code, name: quote[1] || code, points, source: "腾讯证券前复权日线" };
}

function loadFundScriptNow(code) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const timer = setTimeout(() => {
      script.remove();
      reject(new Error(`${code} 基金净值请求超时`));
    }, 20_000);
    script.async = true;
    script.src = `https://fund.eastmoney.com/pingzhongdata/${encodeURIComponent(code)}.js?v=${Date.now()}`;
    script.onload = () => {
      clearTimeout(timer);
      script.remove();
      const rows = Array.isArray(globalThis.Data_ACWorthTrend) ? globalThis.Data_ACWorthTrend : [];
      const points = uniqueSortedPoints(rows.map((row) => ({
        date: isoDate(Number(row?.[0]) + 8 * 60 * 60 * 1000),
        value: row?.[1],
      })));
      const name = String(globalThis.fS_name ?? code).trim() || code;
      if (!points.length) reject(new Error(`${code} 没有可用的真实基金累计净值`));
      else resolve({ code, name, points, source: "东方财富基金完整累计净值" });
    };
    script.onerror = () => {
      clearTimeout(timer);
      script.remove();
      reject(new Error(`${code} 东方财富真实基金净值请求失败`));
    };
    document.head.append(script);
  });
}

function fetchFundFullHistory(code) {
  const task = fundScriptQueue.then(() => loadFundScriptNow(code));
  fundScriptQueue = task.catch(() => undefined);
  return task;
}

async function fetchFundHistory(code, start, end) {
  const parsed = await fetchFundFullHistory(code);
  parsed.points = parsed.points.filter((point) => point.date >= start && point.date <= end);
  if (parsed.points.length < 2) throw new Error(`${code} 在所选区间没有足够基金净值`);
  return parsed;
}

async function fetchDomesticHistory(code, start, end) {
  const symbol = securitySymbol(code);
  const chunks = [];
  let cursor = start;
  while (cursor <= end) {
    const remaining = Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${cursor}T00:00:00Z`)) / DAY_MS);
    const chunkEnd = addDays(cursor, Math.min(620, remaining));
    chunks.push([cursor, chunkEnd]);
    cursor = addDays(chunkEnd, 1);
  }
  const parsed = [];
  for (const [chunkStart, chunkEnd] of chunks) {
    const param = `${symbol},day,${chunkStart},${chunkEnd},640,qfq`;
    parsed.push(parseTencentKline(await fetchJson(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${encodeURIComponent(param)}`), symbol, code));
  }
  return {
    code,
    name: parsed.find((item) => item.name !== code)?.name ?? code,
    source: "腾讯证券前复权日线",
    points: uniqueSortedPoints(parsed.flatMap((item) => item.points)),
  };
}

async function fetchUsHistoryRmb(symbol, start, end) {
  const code = symbol.toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(code)) throw new Error("美股代码格式无效");
  let payload;
  try {
    payload = await fetchJson(`./data/us/${encodeURIComponent(code)}.json?v=${Date.now()}`, 1);
  } catch {
    throw new Error(`稳定在线版暂未收录 ${code}；当前支持 SPY，其他美股请使用本地完整版`);
  }
  const points = uniqueSortedPoints((payload.points ?? []).filter((point) => point.date >= start && point.date <= end));
  if (points.length < 2) throw new Error(`${code} 在所选区间没有足够美股人民币行情`);
  return {
    code,
    name: payload.name || code,
    points,
    source: payload.source || "Nasdaq真实收盘价 × Frankfurter汇率（静态日更）",
  };
}

function buildCashSeries(dates, annualRate, code = "CASH", name = "现金备用金") {
  if (!dates.length) throw new Error("现金序列需要真实交易日历");
  const start = Date.parse(`${dates[0]}T00:00:00Z`);
  return {
    code,
    name,
    source: "用户设定现金年化代理（非行情）",
    points: dates.map((date) => ({
      date,
      value: (1 + Number(annualRate)) ** ((Date.parse(`${date}T00:00:00Z`) - start) / DAY_MS / 365.25),
    })),
  };
}

export async function resolveAssetName(assetType, rawCode) {
  const code = String(rawCode ?? "").trim().toUpperCase();
  if (assetType === "现金") return { code: "CASH", name: "现金备用金", source: "用户设定现金年化代理（非行情）" };
  const end = isoDate(Date.now());
  const start = addDays(end, -45);
  if (FUND_TYPES.has(assetType)) {
    const result = await fetchFundFullHistory(code);
    return { code, name: result.name, source: result.source };
  }
  if (DOMESTIC_TYPES.has(assetType)) {
    try {
      const result = await fetchDomesticHistory(code, start, end);
      return { code, name: result.name, source: result.source };
    } catch (error) {
      if (assetType !== "ETF") throw error;
      const result = await fetchFundFullHistory(code);
      return { code, name: result.name, source: "东方财富 ETF 累计净值（腾讯行情备用源）" };
    }
  }
  if (assetType === "美股/美股ETF") {
    const result = await fetchUsHistoryRmb(code, addDays(end, -45), end);
    return { code, name: result.name, source: result.source };
  }
  throw new Error(`不支持的资产类型：${assetType}`);
}

async function fetchAssetHistory(asset, start, end) {
  if (FUND_TYPES.has(asset.type)) return fetchFundHistory(asset.code, start, end);
  if (DOMESTIC_TYPES.has(asset.type)) {
    try {
      return await fetchDomesticHistory(asset.code, start, end);
    } catch (error) {
      if (asset.type !== "ETF") throw error;
      const result = await fetchFundHistory(asset.code, start, end);
      result.source = "东方财富 ETF 累计净值（腾讯行情备用源）";
      return result;
    }
  }
  if (asset.type === "美股/美股ETF") return fetchUsHistoryRmb(asset.code, start, end);
  throw new Error(`${asset.type} 不需要或不支持市场行情`);
}

export async function loadPortfolioPrices(assets, years = 10) {
  const end = isoDate(Date.now());
  const start = addDays(end, -Math.ceil(Number(years) * 365.25) - 45);
  const nonCash = assets.filter((asset) => asset.type !== "现金");
  if (!nonCash.length) throw new Error("至少需要一项真实市场资产");
  const histories = [];
  for (const asset of nonCash) {
    try {
      histories.push(await fetchAssetHistory(asset, start, end));
    } catch (error) {
      throw new Error(`${asset.code} 取数失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const calendar = [...new Set(histories.flatMap((item) => item.points.map((point) => point.date)))].sort();
  for (const asset of assets.filter((item) => item.type === "现金")) {
    histories.push(buildCashSeries(calendar, asset.cashRate ?? 0.015, asset.code, asset.name));
  }
  const merged = mergePriceSeries(histories);
  if (merged.dates.length < 20) throw new Error("共同历史区间少于 20 个数据点");
  return { ...merged, histories };
}
