import assert from "node:assert/strict";
import test from "node:test";

import { allocationConstraintsMet, optimizeAllocation } from "../lib/portfolio.mjs";
import { DEFAULT_ASSETS, inferSleeve, STRATEGY_POLICY } from "../lib/strategy.mjs";

test("default research plan matches the 2m funding envelope and fixed-income-first structure", () => {
  const total = DEFAULT_ASSETS.reduce((sum, asset) => sum + asset.amount, 0);
  const cash = DEFAULT_ASSETS.filter((asset) => asset.category === "现金");
  const fixed = DEFAULT_ASSETS.filter((asset) => asset.category === "固收");
  const domesticBroad = DEFAULT_ASSETS.filter((asset) => asset.category === "A股宽基");
  const gold = DEFAULT_ASSETS.filter((asset) => asset.category === "黄金");
  const us = DEFAULT_ASSETS.filter((asset) => asset.category === "美股");

  assert.equal(total, 2_000_000);
  assert.equal(cash.reduce((sum, asset) => sum + asset.amount, 0), 100_000);
  assert.equal(us.reduce((sum, asset) => sum + asset.amount, 0), 0);
  assert.equal(fixed.reduce((sum, asset) => sum + asset.amount, 0), 1_100_000);
  assert.equal(domesticBroad.reduce((sum, asset) => sum + asset.amount, 0), 800_000);
  assert.equal(gold.reduce((sum, asset) => sum + asset.amount, 0), 0);
  assert.equal(fixed.length, 4);
  assert.equal(new Set(fixed.map((asset) => asset.sleeve)).size, 4);
  assert.equal(new Set(fixed.map((asset) => asset.manager)).size, 4);
  assert.ok(Math.max(...fixed.map((asset) => asset.amount)) <= 350_000);
  assert.deepEqual(fixed.map((asset) => asset.code).sort(), ["000128", "000191", "161119", "270048"]);
  assert.ok(fixed.every((asset) => asset.type === "债券基金"));
  assert.ok(fixed.every((asset) => !/城投/.test(`${asset.name}${asset.sleeve}`)));
  assert.ok(DEFAULT_ASSETS.every((asset) => !["511010", "511220", "511880"].includes(asset.code)));
  assert.ok(DEFAULT_ASSETS.every((asset) => !["518880", "SPY"].includes(asset.code)));
  assert.deepEqual(domesticBroad.map((asset) => asset.code).sort(), ["510300", "510500"]);
  assert.deepEqual(STRATEGY_POLICY.buckets.map((bucket) => bucket.weight), [0.55, 0.40, 0.05]);
  assert.equal(STRATEGY_POLICY.buckets.reduce((sum, bucket) => sum + bucket.amount, 0), 2_000_000);
  assert.deepEqual(STRATEGY_POLICY.targetReturn, [0.07, 0.10]);
  assert.equal(STRATEGY_POLICY.maxDrawdown, 0.15);
});

test("allocation policy rejects concentrated fixed-income and broad-index sleeves", () => {
  const categories = DEFAULT_ASSETS.map((asset) => asset.category);
  const defaultWeights = DEFAULT_ASSETS.map((asset) => asset.amount / 2_000_000);
  assert.equal(allocationConstraintsMet(defaultWeights, categories), true);

  const fixedConcentrated = [...defaultWeights];
  const fixedPositions = categories.map((category, index) => category === "固收" ? index : -1).filter((index) => index >= 0);
  const fixedTotal = fixedPositions.reduce((sum, index) => sum + fixedConcentrated[index], 0);
  fixedPositions.forEach((index) => { fixedConcentrated[index] = 0; });
  fixedConcentrated[fixedPositions[0]] = fixedTotal;
  assert.equal(allocationConstraintsMet(fixedConcentrated, categories), false);

  const broadConcentrated = [...defaultWeights];
  const broadPositions = categories.map((category, index) => category === "A股宽基" ? index : -1).filter((index) => index >= 0);
  const broadTotal = broadPositions.reduce((sum, index) => sum + broadConcentrated[index], 0);
  broadPositions.forEach((index) => { broadConcentrated[index] = 0; });
  broadConcentrated[broadPositions[0]] = broadTotal;
  assert.equal(allocationConstraintsMet(broadConcentrated, categories), false);
  assert.equal(allocationConstraintsMet(defaultWeights.map((weight) => weight * 0.9), categories), false);
});

test("fixed-income role is reclassified from the resolved fund name", () => {
  assert.equal(inferSleeve("固收", "国泰上证5年期国债ETF"), "利率债");
  assert.equal(inferSleeve("固收", "海富通上证城投债ETF"), "城投债");
  assert.equal(inferSleeve("固收", "易方达中债新综指发起式(LOF)A"), "综合债券指数");
  assert.equal(inferSleeve("固收", "易方达信用债债券A"), "信用债");
  assert.equal(inferSleeve("固收", "广发纯债债券A"), "纯债");
  assert.equal(inferSleeve("固收", "银华日利ETF"), "货币与短久期");
  assert.equal(inferSleeve("A股宽基", "沪深300ETF"), "A股宽基");
});

test("optimizer samples the diversified policy directly instead of discarding most candidates", () => {
  const dates = [];
  const values = Object.fromEntries(DEFAULT_ASSETS.map((asset) => [asset.code, []]));
  const start = Date.UTC(2020, 0, 2);
  for (let day = 0; day < 780; day += 1) {
    const date = new Date(start + day * 86_400_000);
    if ([0, 6].includes(date.getUTCDay())) continue;
    dates.push(date.toISOString().slice(0, 10));
    const index = dates.length;
    DEFAULT_ASSETS.forEach((asset, assetIndex) => {
      const risk = asset.category === "固收" || asset.category === "现金" ? 0.002 : 0.02;
      values[asset.code].push(1 + index * (0.00008 + assetIndex * 0.00001) + Math.sin(index / (11 + assetIndex)) * risk);
    });
  }
  const result = optimizeAllocation({ dates, values }, DEFAULT_ASSETS, { samples: 500, seed: 9 });

  assert.ok(result.sampleCount > 350);
  assert.equal(result.allocationConstraintsMet, true);
});
