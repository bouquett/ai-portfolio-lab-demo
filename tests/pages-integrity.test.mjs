import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("GitHub Pages entrypoint is the real-data app and no longer redirects", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  assert.match(html, /运行真实行情回测/);
  assert.match(html, /data source|数据源/i);
  assert.doesNotMatch(html, /http-equiv="refresh"/i);
  assert.doesNotMatch(html, /real-portfolio-lab-cn\.fhvwtbfbvg\.chatgpt\.site/);
  assert.match(html, /id="assetList"/);
});

test("client loader fails closed instead of manufacturing market history", async () => {
  const source = await readFile(new URL("lib/market-data-browser.mjs", root), "utf8");
  assert.match(source, /取数失败/);
  assert.match(source, /东方财富基金完整累计净值/);
  assert.match(source, /腾讯证券前复权日线/);
  assert.doesNotMatch(source, /Math\.sin|Math\.cos|randomWalk/);
});

test("bundled SPY RMB snapshot contains a long, traceable real history", async () => {
  const payload = JSON.parse(await readFile(new URL("data/us/SPY.json", root), "utf8"));
  assert.equal(payload.code, "SPY");
  assert.match(payload.source, /(Yahoo Finance|Nasdaq)/);
  assert.match(payload.source, /(USD\/CNY|Frankfurter)/);
  assert.ok(payload.points.length > 2500);
  assert.equal(payload.startDate, payload.points[0].date);
  assert.equal(payload.endDate, payload.points.at(-1).date);
  assert.ok(payload.points.every((point) => /^\d{4}-\d{2}-\d{2}$/.test(point.date) && point.value > 0));
});
