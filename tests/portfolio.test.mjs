import assert from "node:assert/strict";
import test from "node:test";

import {
  backtestPortfolio,
  calculateMetrics,
  mergePriceSeries,
  optimizeAllocation,
  selectWindow,
} from "../lib/portfolio.mjs";

function point(date, value) {
  return { date, value };
}

test("mergePriceSeries keeps only the common real-data interval and forward-fills holidays", () => {
  const merged = mergePriceSeries([
    { code: "A", points: [point("2024-01-01", 10), point("2024-01-02", 11), point("2024-01-04", 12)] },
    { code: "B", points: [point("2024-01-02", 20), point("2024-01-03", 18), point("2024-01-04", 21)] },
  ]);

  assert.deepEqual(merged.dates, ["2024-01-02", "2024-01-03", "2024-01-04"]);
  assert.deepEqual(merged.values.A, [11, 11, 12]);
  assert.deepEqual(merged.values.B, [20, 18, 21]);
  assert.equal(merged.quality[0].forwardFilled, 1);
  assert.equal(merged.quality[1].forwardFilled, 0);
});

test("backtestPortfolio includes every asset and annual rebalancing cost", () => {
  const prices = {
    dates: ["2023-12-29", "2024-01-02", "2024-12-31", "2025-01-02"],
    values: {
      A: [100, 110, 121, 133.1],
      B: [100, 100, 100, 100],
    },
  };
  const noCost = backtestPortfolio(prices, ["A", "B"], [0.5, 0.5], "每年", 0);
  const withCost = backtestPortfolio(prices, ["A", "B"], [0.5, 0.5], "每年", 10);

  assert.equal(noCost.nav.length, prices.dates.length);
  assert.ok(noCost.nav.at(-1) > 1);
  assert.ok(withCost.nav.at(-1) < noCost.nav.at(-1));
  assert.equal(withCost.rebalanceCount, 2);
  assert.ok(withCost.totalCost > 0);
});

test("calculateMetrics reports compound annual return and negative max drawdown", () => {
  const result = calculateMetrics(
    ["2023-01-01", "2024-01-01", "2025-01-01"],
    [1, 0.8, 1.21],
  );

  assert.ok(Math.abs(result.annualReturn - 0.1) < 0.002);
  assert.ok(Math.abs(result.maxDrawdown + 0.2) < 1e-12);
  assert.ok(result.volatility > 0);
});

test("selectWindow never labels a short history as a full 10-year result", () => {
  const dates = [];
  for (let month = 0; month <= 48; month += 1) {
    const date = new Date(Date.UTC(2022 + Math.floor(month / 12), month % 12, 3));
    dates.push(date.toISOString().slice(0, 10));
  }
  assert.equal(selectWindow(dates, 10), null);
  assert.deepEqual(selectWindow(dates, 3), { startIndex: 12, actualYears: 3 });
});

test("optimizer fixes cash at 5% and US assets at 10%", () => {
  const dates = [];
  const values = { CASH: [], BOND: [], CN: [], GOLD: [], SPY: [] };
  const start = Date.UTC(2020, 0, 1);
  for (let i = 0; i < 520; i += 1) {
    dates.push(new Date(start + i * 86_400_000).toISOString().slice(0, 10));
    values.CASH.push(1 + i * 0.00005);
    values.BOND.push(1 + i * 0.00012);
    values.CN.push(1 + i * 0.0002 + Math.sin(i / 13) * 0.02);
    values.GOLD.push(1 + i * 0.00016 + Math.cos(i / 17) * 0.015);
    values.SPY.push(1 + i * 0.00025 + Math.sin(i / 11) * 0.025);
  }
  const assets = [
    { code: "CASH", category: "现金" },
    { code: "BOND", category: "固收" },
    { code: "CN", category: "A股宽基" },
    { code: "GOLD", category: "黄金" },
    { code: "SPY", category: "美股" },
  ];
  const optimized = optimizeAllocation({ dates, values }, assets, { samples: 400, seed: 7 });
  const weightByCode = Object.fromEntries(optimized.weights.map((weight, i) => [assets[i].code, weight]));

  assert.ok(Math.abs(weightByCode.CASH - 0.05) < 1e-9);
  assert.ok(Math.abs(weightByCode.SPY - 0.1) < 1e-9);
  assert.ok(Math.abs(optimized.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

