import { calculateMetrics, selectWindow } from "./portfolio.mjs";

export const ASSET_BACKTEST_PERIODS = Object.freeze([1, 3, 5, 10]);

function cleanHistoryPoints(history) {
  const code = String(history?.code ?? "资产");
  const byDate = new Map();
  for (const point of history?.points ?? []) {
    const value = Number(point?.value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(point?.date) && Number.isFinite(value) && value > 0) {
      byDate.set(point.date, value);
    }
  }
  const points = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ date, value }));
  if (points.length < 2) throw new Error(`${code} 没有足够的真实历史数据`);
  return points;
}

function sampleTrend(dates, values, maxPoints = 240) {
  const step = Math.max(1, Math.ceil((dates.length - 1) / Math.max(1, maxPoints - 1)));
  const trend = [];
  for (let index = 0; index < dates.length; index += step) {
    trend.push({ date: dates[index], value: values[index] });
  }
  if (trend.at(-1)?.date !== dates.at(-1)) trend.push({ date: dates.at(-1), value: values.at(-1) });
  return trend;
}

function maxDrawdownPeriod(dates, values) {
  let runningPeakIndex = 0;
  let drawdownPeakIndex = 0;
  let troughIndex = 0;
  let maxDrawdown = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] > values[runningPeakIndex]) runningPeakIndex = index;
    const drawdown = values[index] / values[runningPeakIndex] - 1;
    if (drawdown < maxDrawdown) {
      maxDrawdown = drawdown;
      drawdownPeakIndex = runningPeakIndex;
      troughIndex = index;
    }
  }
  return {
    value: maxDrawdown,
    peakDate: dates[drawdownPeakIndex],
    troughDate: dates[troughIndex],
    peakValue: values[drawdownPeakIndex],
    troughValue: values[troughIndex],
  };
}

function analyzeWindow(points, years) {
  const dates = points.map((point) => point.date);
  const window = selectWindow(dates, years);
  if (!window || window.actualYears < Number(years) - 0.15) return null;
  const selected = points.slice(window.startIndex);
  const windowDates = selected.map((point) => point.date);
  const startValue = selected[0].value;
  const normalized = selected.map((point) => point.value / startValue);
  const metrics = calculateMetrics(windowDates, normalized);
  return {
    years,
    actualYears: metrics.actualYears,
    startDate: windowDates[0],
    endDate: windowDates.at(-1),
    points: selected.length,
    metrics,
    drawdown: maxDrawdownPeriod(windowDates, normalized),
    trend: sampleTrend(windowDates, normalized),
  };
}

export function analyzeAssetHistory(history, periods = ASSET_BACKTEST_PERIODS) {
  const points = cleanHistoryPoints(history);
  const windows = {};
  for (const years of periods) {
    if (!ASSET_BACKTEST_PERIODS.includes(Number(years))) throw new Error(`不支持 ${years} 年回溯`);
    windows[years] = analyzeWindow(points, Number(years));
  }
  const availableYears = ASSET_BACKTEST_PERIODS.filter((years) => windows[years]);
  return {
    code: String(history?.code ?? "资产"),
    name: String(history?.name ?? history?.code ?? "资产"),
    source: String(history?.source ?? ""),
    originalStart: points[0].date,
    originalEnd: points.at(-1).date,
    originalPoints: points.length,
    windows,
    availableYears,
  };
}
