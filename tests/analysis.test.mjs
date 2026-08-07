import assert from "node:assert/strict";
import test from "node:test";

import { analyzePortfolioData, normalizeAssets } from "../lib/analysis.mjs";

test("normalizeAssets enforces real codes, unique assets, and positive amounts", () => {
  assert.throws(() => normalizeAssets([{ type: "ETF", category: "固收", code: "5110", amount: 1 }]), /6 位数字/);
  assert.throws(() => normalizeAssets([
    { type: "ETF", category: "固收", code: "511010", amount: 1 },
    { type: "ETF", category: "固收", code: "511010", amount: 2 },
  ]), /重复/);
  assert.throws(() => normalizeAssets([{ type: "现金", category: "现金", code: "CASH", amount: 0 }]), /大于 0/);
});

test("normalizeAssets preserves the role of each fixed-income sleeve", () => {
  const [asset] = normalizeAssets([{
    type: "债券基金", category: "固收", code: "000032", name: "易方达信用债债券A",
    amount: 250_000, sleeve: "高等级信用", manager: "易方达基金",
  }]);
  assert.equal(asset.sleeve, "高等级信用");
  assert.equal(asset.manager, "易方达基金");
});

test("analyzePortfolioData reports only fully covered windows and exact 2m constraints", () => {
  const assets = normalizeAssets([
    { type: "现金", category: "现金", code: "CASH", name: "现金", amount: 100_000, cashRate: 0.015 },
    { type: "ETF", category: "固收", code: "511010", name: "国债ETF", amount: 800_000 },
    { type: "ETF", category: "A股宽基", code: "510300", name: "沪深300ETF", amount: 600_000 },
    { type: "ETF", category: "黄金", code: "518880", name: "黄金ETF", amount: 300_000 },
    { type: "美股/美股ETF", category: "美股", code: "SPY", name: "SPY", amount: 200_000 },
  ]);
  const dates = [];
  const values = Object.fromEntries(assets.map((asset) => [asset.code, []]));
  const start = Date.UTC(2022, 0, 3);
  for (let day = 0; day < 4 * 365; day += 1) {
    const date = new Date(start + day * 86_400_000);
    if ([0, 6].includes(date.getUTCDay())) continue;
    dates.push(date.toISOString().slice(0, 10));
    const i = dates.length;
    values.CASH.push(1 + i * 0.00004);
    values["511010"].push(1 + i * 0.0001);
    values["510300"].push(1 + i * 0.00019 + Math.sin(i / 15) * 0.025);
    values["518880"].push(1 + i * 0.00015 + Math.cos(i / 19) * 0.018);
    values.SPY.push(1 + i * 0.00022 + Math.sin(i / 11) * 0.03);
  }
  const prices = {
    dates,
    values,
    quality: assets.map((asset) => ({
      code: asset.code, source: asset.type === "现金" ? "用户设定现金年化代理（非行情）" : "测试真实源",
      originalStart: dates[0], originalEnd: dates.at(-1), originalPoints: dates.length,
      commonStart: dates[0], commonEnd: dates.at(-1), commonPoints: dates.length,
      coverage: 1, forwardFilled: 0,
    })),
    histories: assets.map((asset) => ({ code: asset.code, name: asset.name, source: "测试真实源", points: [] })),
  };
  const result = analyzePortfolioData(assets, prices, { samples: 300, transactionCostBps: 5 });

  assert.equal(result.dataIntegrity.usesSyntheticMarketData, false);
  assert.equal(result.portfolioChecks.totalAmount, 2_000_000);
  assert.equal(result.portfolioChecks.usAmount, 200_000);
  assert.equal(result.portfolioChecks.cashAmount, 100_000);
  assert.ok(result.windows[1]);
  assert.ok(result.windows[3]);
  assert.equal(result.windows[5], null);
  assert.equal(result.windows[10], null);
  assert.ok(Math.abs(result.optimized.metrics.annualReturn - result.optimizedWindows[result.selectedYears].metrics.annualReturn) < 1e-12);
  assert.ok(Math.abs(result.optimized.metrics.maxDrawdown - result.optimizedWindows[result.selectedYears].metrics.maxDrawdown) < 1e-12);
  assert.ok(result.warnings.some((warning) => /样本内优化/.test(warning)));
});
