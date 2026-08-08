import assert from "node:assert/strict";
import test from "node:test";

import { analyzeAssetHistory, ASSET_BACKTEST_PERIODS } from "../lib/asset-backtest.mjs";
import { loadAssetHistory } from "../lib/market-data-browser.mjs";

function weeklyHistory(years) {
  const points = [];
  const start = Date.UTC(2015, 0, 1);
  let value = 1;
  for (let week = 0; week <= years * 52; week += 1) {
    const date = new Date(start + week * 7 * 86_400_000);
    value *= 1.0014;
    if (week === 300) value *= 0.72;
    if (week === 325) value *= 1.38;
    points.push({ date: date.toISOString().slice(0, 10), value });
  }
  return { code: "TEST", name: "测试资产", source: "测试真实源", points };
}

test("single-asset analysis produces exact metrics and chart-ready 1/3/5/10 year windows", () => {
  const result = analyzeAssetHistory(weeklyHistory(11));

  assert.deepEqual(ASSET_BACKTEST_PERIODS, [1, 3, 5, 10]);
  assert.deepEqual(result.availableYears, [1, 3, 5, 10]);
  assert.equal(result.source, "测试真实源");
  for (const years of ASSET_BACKTEST_PERIODS) {
    const window = result.windows[years];
    assert.ok(window);
    assert.equal(window.years, years);
    assert.equal(window.trend[0].value, 1);
    assert.equal(window.startDate, window.trend[0].date);
    assert.equal(window.endDate, window.trend.at(-1).date);
    assert.ok(window.trend.length <= 241);
    assert.ok(Number.isFinite(window.metrics.annualReturn));
    assert.ok(Number.isFinite(window.metrics.totalReturn));
    assert.ok(window.metrics.maxDrawdown <= 0);
  }
  assert.ok(result.windows[10].metrics.maxDrawdown < -0.2);
  assert.ok(result.windows[10].drawdown.peakDate < result.windows[10].drawdown.troughDate);
});

test("single-asset analysis keeps unavailable long periods empty instead of relabeling short history", () => {
  const result = analyzeAssetHistory(weeklyHistory(4));

  assert.deepEqual(result.availableYears, [1, 3]);
  assert.ok(result.windows[1]);
  assert.ok(result.windows[3]);
  assert.equal(result.windows[5], null);
  assert.equal(result.windows[10], null);
});

test("single-asset analysis rejects malformed or insufficient histories", () => {
  assert.throws(() => analyzeAssetHistory({ code: "EMPTY", points: [] }), /没有足够/);
  assert.throws(() => analyzeAssetHistory({ code: "BAD", points: [
    { date: "2026-01-01", value: 1 },
    { date: "2026-01-02", value: -1 },
  ] }), /没有足够/);
});

test("cash cards use the explicit user rate as a labeled calculation rather than market data", async () => {
  const history = await loadAssetHistory({
    type: "现金",
    code: "CASH",
    name: "现金备用金",
    cashRate: 0.015,
  }, 10);
  const result = analyzeAssetHistory(history);

  assert.match(result.source, /非行情/);
  assert.deepEqual(result.availableYears, [1, 3, 5, 10]);
  assert.ok(Math.abs(result.windows[3].metrics.annualReturn - 0.015) < 1e-8);
  assert.equal(result.windows[3].metrics.maxDrawdown, 0);
});
