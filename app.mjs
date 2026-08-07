import { analyzePortfolioData, normalizeAssets } from "./lib/analysis.mjs";
import { loadPortfolioPrices, resolveAssetName } from "./lib/market-data-browser.mjs";

const ASSET_TYPES = ["现金", "债券基金", "宽基基金", "其他场外基金", "ETF", "股票", "美股/美股ETF"];
const CATEGORIES = ["现金", "固收", "A股宽基", "黄金", "美股", "其他"];
const lookupTimers = new Map();

let assets = [
  { id: "cash", type: "现金", category: "现金", code: "CASH", name: "现金备用金", amount: 100000, cashRate: 0.015, source: "用户设定现金年化代理（非行情）" },
  { id: "bond1", type: "ETF", category: "固收", code: "511010", name: "国债ETF国泰", amount: 500000, source: "" },
  { id: "bond2", type: "ETF", category: "固收", code: "511220", name: "城投债ETF海富通", amount: 300000, source: "" },
  { id: "cn300", type: "ETF", category: "A股宽基", code: "510300", name: "沪深300ETF华泰柏瑞", amount: 300000, source: "" },
  { id: "dividend", type: "ETF", category: "A股宽基", code: "510880", name: "红利ETF华泰柏瑞", amount: 300000, source: "" },
  { id: "gold", type: "ETF", category: "黄金", code: "518880", name: "黄金ETF华安", amount: 300000, source: "" },
  { id: "us", type: "美股/美股ETF", category: "美股", code: "SPY", name: "SPDR S&P 500 ETF Trust", amount: 200000, source: "GitHub Actions日更真实行情快照" },
];

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
const money = (value) => `¥${Math.round(Number(value) || 0).toLocaleString("zh-CN")}`;
const pct = (value) => Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "—";
const number = (value, digits = 2) => Number.isFinite(value) ? Number(value).toFixed(digits) : "—";

function codeIsValid(asset) {
  if (asset.type === "现金") return true;
  if (asset.type === "美股/美股ETF") return /^[A-Z][A-Z0-9.-]{0,11}$/.test(asset.code);
  return /^\d{6}$/.test(asset.code);
}

function defaultCategory(type) {
  if (type === "现金") return "现金";
  if (type === "债券基金") return "固收";
  if (type === "美股/美股ETF") return "美股";
  return "A股宽基";
}

function newAsset(type) {
  return {
    id: `asset-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type,
    category: defaultCategory(type),
    code: type === "现金" ? "CASH" : "",
    name: type === "现金" ? "现金备用金" : "等待输入代码",
    amount: 0,
    cashRate: 0.015,
    source: type === "现金" ? "用户设定现金年化代理（非行情）" : "",
  };
}

function totals() {
  const total = assets.reduce((sum, asset) => sum + (Number(asset.amount) || 0), 0);
  const us = assets.filter((asset) => asset.category === "美股").reduce((sum, asset) => sum + (Number(asset.amount) || 0), 0);
  const cash = assets.filter((asset) => asset.category === "现金").reduce((sum, asset) => sum + (Number(asset.amount) || 0), 0);
  return { total, us, cash, rmb: total - us - cash };
}

function summaryCard(label, value, expected, ok) {
  return `<article class="summary-card ${ok ? "" : "bad"}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(expected)}</small></article>`;
}

function renderSummary() {
  const t = totals();
  $("#summaryGrid").innerHTML = [
    summaryCard("组合总金额", money(t.total), t.total === 2_000_000 ? "已对齐目标" : "目标 ¥2,000,000", t.total === 2_000_000),
    summaryCard("人民币投资资产", money(t.rmb), "目标 ¥1,700,000", t.rmb === 1_700_000),
    summaryCard("美股 / 美股基金", money(t.us), "目标 ¥200,000", t.us === 200_000),
    summaryCard("现金备用金", money(t.cash), "目标 ¥100,000", t.cash === 100_000),
  ].join("");
}

function resolvedText(asset) {
  if (asset.type === "现金") return { cls: "ok", text: `✓ ${asset.source}` };
  if (!codeIsValid(asset)) return { cls: "", text: asset.type === "美股/美股ETF" ? "请输入美股代码" : "请输入完整 6 位代码" };
  if (asset.lookup === "loading") return { cls: "loading", text: "正在查询真实名称…" };
  if (asset.lookup === "error") return { cls: "error", text: `查询失败：${asset.lookupMessage}` };
  if (asset.name && asset.name !== asset.code) return { cls: "ok", text: `✓ ${asset.source || "名称已识别；运行时核验行情"}` };
  return { cls: "", text: "输入完成后自动查询" };
}

function typeOptions(selected) {
  return ASSET_TYPES.map((type) => `<option value="${esc(type)}" ${type === selected ? "selected" : ""}>${esc(type)}</option>`).join("");
}

function categoryOptions(selected) {
  return CATEGORIES.map((category) => `<option value="${esc(category)}" ${category === selected ? "selected" : ""}>${esc(category)}</option>`).join("");
}

function assetCard(asset, index) {
  const status = resolvedText(asset);
  const cash = asset.type === "现金";
  return `<article class="asset-card" data-id="${esc(asset.id)}">
    <div class="asset-top">
      <div class="asset-title"><span class="asset-index">${String(index + 1).padStart(2, "0")}</span><div><strong class="asset-name">${esc(asset.name || asset.code || "未识别资产")}</strong><div class="resolved ${status.cls}">${esc(status.text)}</div></div></div>
      <button class="remove" data-action="remove" aria-label="移除资产">移除</button>
    </div>
    <div class="asset-fields ${cash ? "cash" : ""}">
      <div class="field"><label>资产类型<select data-field="type">${typeOptions(asset.type)}</select></label></div>
      ${cash ? "" : `<div class="field"><label>资产类别<select data-field="category" ${asset.type === "美股/美股ETF" ? "disabled" : ""}>${categoryOptions(asset.category)}</select></label></div>`}
      ${cash ? "" : `<div class="field"><label>资产代码<input data-field="code" value="${esc(asset.code)}" inputmode="${asset.type === "美股/美股ETF" ? "text" : "numeric"}" placeholder="${asset.type === "美股/美股ETF" ? "例如 SPY" : "6 位基金/证券代码"}"></label></div>`}
      <div class="field"><label>配置金额（元）<input data-field="amount" type="number" min="0" step="10000" value="${Number(asset.amount) || ""}" placeholder="0"></label></div>
      ${cash ? `<div class="field"><label>现金年化代理<input data-field="cashRate" type="number" min="-5" max="20" step="0.1" value="${(Number(asset.cashRate) * 100).toFixed(1)}"></label></div>` : ""}
    </div>
  </article>`;
}

function renderAssets() {
  $("#assetList").innerHTML = assets.map(assetCard).join("");
  $("#assetList").querySelectorAll(".asset-card").forEach((card) => {
    const id = card.dataset.id;
    card.querySelector('[data-action="remove"]').addEventListener("click", () => {
      lookupTimers.delete(id);
      assets = assets.filter((asset) => asset.id !== id);
      renderAssets();
      renderSummary();
      $("#results").hidden = true;
    });
    card.querySelector('[data-field="type"]').addEventListener("change", (event) => {
      const asset = assets.find((item) => item.id === id);
      asset.type = event.target.value;
      asset.category = defaultCategory(asset.type);
      asset.code = asset.type === "现金" ? "CASH" : "";
      asset.name = asset.type === "现金" ? "现金备用金" : "等待输入代码";
      asset.source = asset.type === "现金" ? "用户设定现金年化代理（非行情）" : "";
      asset.lookup = "idle";
      renderAssets();
      renderSummary();
    });
    const category = card.querySelector('[data-field="category"]');
    if (category) category.addEventListener("change", (event) => {
      assets.find((item) => item.id === id).category = event.target.value;
      renderSummary();
    });
    const code = card.querySelector('[data-field="code"]');
    if (code) code.addEventListener("input", (event) => {
      const asset = assets.find((item) => item.id === id);
      const next = asset.type === "美股/美股ETF"
        ? event.target.value.toUpperCase().replace(/[^A-Z0-9.-]/g, "").slice(0, 12)
        : event.target.value.replace(/\D/g, "").slice(0, 6);
      event.target.value = next;
      asset.code = next;
      asset.name = next || "等待输入代码";
      asset.source = "";
      asset.lookup = "idle";
      updateResolved(card, asset);
      clearTimeout(lookupTimers.get(id));
      if (codeIsValid(asset)) lookupTimers.set(id, setTimeout(() => lookupAsset(id), 450));
    });
    card.querySelector('[data-field="amount"]').addEventListener("input", (event) => {
      assets.find((item) => item.id === id).amount = Math.max(0, Number(event.target.value) || 0);
      renderSummary();
      $("#results").hidden = true;
    });
    const cashRate = card.querySelector('[data-field="cashRate"]');
    if (cashRate) cashRate.addEventListener("input", (event) => {
      assets.find((item) => item.id === id).cashRate = Number(event.target.value) / 100;
    });
  });
}

function updateResolved(card, asset) {
  const status = resolvedText(asset);
  const element = card.querySelector(".resolved");
  element.className = `resolved ${status.cls}`;
  element.textContent = status.text;
  card.querySelector(".asset-name").textContent = asset.name || asset.code || "未识别资产";
}

async function lookupAsset(id) {
  const asset = assets.find((item) => item.id === id);
  if (!asset || !codeIsValid(asset) || asset.type === "现金") return;
  const signature = `${asset.type}:${asset.code}`;
  asset.lookup = "loading";
  const card = document.querySelector(`.asset-card[data-id="${CSS.escape(id)}"]`);
  if (card) updateResolved(card, asset);
  try {
    const result = await resolveAssetName(asset.type, asset.code);
    const current = assets.find((item) => item.id === id);
    if (!current || `${current.type}:${current.code}` !== signature) return;
    current.name = result.name;
    current.source = result.source;
    current.lookup = "ok";
  } catch (error) {
    const current = assets.find((item) => item.id === id);
    if (!current || `${current.type}:${current.code}` !== signature) return;
    current.lookup = "error";
    current.lookupMessage = error instanceof Error ? error.message : String(error);
  }
  const currentCard = document.querySelector(`.asset-card[data-id="${CSS.escape(id)}"]`);
  const currentAsset = assets.find((item) => item.id === id);
  if (currentCard && currentAsset) updateResolved(currentCard, currentAsset);
}

function setStatus(kind, title, detail) {
  const status = $("#runStatus");
  status.className = `run-status ${kind}`;
  status.innerHTML = `<span class="status-dot"></span><div><strong>${esc(title)}</strong><p>${esc(detail)}</p></div>`;
}

function compactWindow(window) {
  if (!window) return "<span class=\"muted\">历史不足</span>";
  return `<span class="positive">${pct(window.metrics.annualReturn)}</span> / ${pct(window.metrics.totalReturn)} / <span class="negative">${pct(window.metrics.maxDrawdown)}</span>`;
}

function renderChart(current, optimized) {
  const svg = $("#navChart");
  if (!current?.nav?.length || !optimized?.nav?.length) {
    svg.innerHTML = "<text x=\"450\" y=\"140\" text-anchor=\"middle\" class=\"axis-label\">共同历史不足，无法绘图</text>";
    return;
  }
  const all = [...current.nav, ...optimized.nav].map((point) => point.value);
  const min = Math.min(...all);
  const max = Math.max(...all);
  const spread = Math.max(max - min, 0.05);
  const x = (index, length) => 50 + index / Math.max(1, length - 1) * 820;
  const y = (value) => 240 - (value - min) / spread * 200;
  const path = (series) => series.map((point, index) => `${index ? "L" : "M"}${x(index, series.length).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");
  const grid = Array.from({ length: 5 }, (_, index) => {
    const yy = 40 + index * 50;
    const value = max - index / 4 * spread;
    return `<line class="grid-line" x1="50" x2="870" y1="${yy}" y2="${yy}"></line><text class="axis-label" x="8" y="${yy + 4}">${number(value, 2)}</text>`;
  }).join("");
  const firstDate = current.nav[0].date;
  const lastDate = current.nav.at(-1).date;
  svg.innerHTML = `${grid}<path class="line-current" d="${path(current.nav)}"></path><path class="line-optimized" d="${path(optimized.nav)}"></path><text class="axis-label" x="50" y="268">${esc(firstDate)}</text><text class="axis-label" text-anchor="end" x="870" y="268">${esc(lastDate)}</text>`;
}

function resultSummaryCard(label, value, note, cls = "") {
  return `<article class="summary-card ${cls}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></article>`;
}

function renderResults(analysis) {
  const selectedYears = analysis.windows[10] ? 10 : analysis.windows[5] ? 5 : analysis.windows[3] ? 3 : 1;
  const current = analysis.windows[selectedYears];
  const optimized = analysis.optimizedWindows[selectedYears];
  $("#dataWindow").textContent = `${analysis.commonStart} 至 ${analysis.commonEnd} · ${analysis.commonPoints.toLocaleString("zh-CN")} 点`;
  $("#headlineMetrics").innerHTML = [
    resultSummaryCard(`${selectedYears}年当前年化`, pct(current.metrics.annualReturn), `累计 ${pct(current.metrics.totalReturn)}`),
    resultSummaryCard(`${selectedYears}年当前回撤`, pct(current.metrics.maxDrawdown), `年化波动 ${pct(current.metrics.volatility)}`),
    resultSummaryCard(`${selectedYears}年候选年化`, pct(optimized.metrics.annualReturn), `累计 ${pct(optimized.metrics.totalReturn)}`),
    resultSummaryCard("候选最大回撤", pct(optimized.metrics.maxDrawdown), `夏普 ${number(optimized.metrics.sharpe)}`),
  ].join("");
  $("#optimizerStatus").textContent = analysis.optimized.feasible
    ? `已找到满足 7%–10% / 回撤≤15% 的候选 · ${analysis.optimized.sampleCount} 个有效样本`
    : `未找到同时满足全部目标的候选 · 展示最佳风险调整样本`;
  $("#windowTable").innerHTML = `<thead><tr><th>期限</th><th>当前：年化 / 累计 / 回撤</th><th>候选：年化 / 累计 / 回撤</th><th>数据点</th></tr></thead><tbody>${[1,3,5,10].map((years) => `<tr><td>${years} 年</td><td>${compactWindow(analysis.windows[years])}</td><td>${compactWindow(analysis.optimizedWindows[years])}</td><td class="num">${analysis.windows[years]?.points?.toLocaleString("zh-CN") ?? "—"}</td></tr>`).join("")}</tbody>`;
  $("#allocationTable").innerHTML = `<thead><tr><th>代码 / 名称</th><th>当前</th><th>候选</th><th>候选金额</th></tr></thead><tbody>${analysis.allocation.map((row) => `<tr><td><strong>${esc(row.code)}</strong><br><small>${esc(row.name)}</small></td><td class="num">${pct(row.weight)}</td><td class="num">${pct(row.optimizedWeight)}</td><td class="num">${money(row.optimizedAmount)}</td></tr>`).join("")}</tbody>`;
  $("#qualityList").innerHTML = analysis.quality.map((row) => `<article class="quality-item"><strong><span>${esc(row.code)}</span><span>${pct(row.coverage)}</span></strong><p>${esc(row.source)}</p><div class="quality-meta"><span>${esc(row.originalStart)} → ${esc(row.originalEnd)}</span><span>${Number(row.originalPoints).toLocaleString("zh-CN")} 原始点</span><span>${Number(row.forwardFilled).toLocaleString("zh-CN")} 前值填充</span></div></article>`).join("");
  const warnings = [...analysis.warnings];
  if (!analysis.optimized.feasible) warnings.unshift("本轮没有找到同时满足年化 7%–10% 与最大回撤≤15%的优化候选；候选栏只是有效样本中的最佳风险调整结果，不应称为达标方案。");
  warnings.unshift(`数据截止 ${analysis.dataCutoff}；${analysis.dataIntegrity.rule}`);
  $("#warnings").innerHTML = warnings.map((warning) => `<div class="warning">${esc(warning)}</div>`).join("");
  renderChart(current, optimized);
  $("#results").hidden = false;
  $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function runBacktest() {
  const button = $("#runButton");
  button.disabled = true;
  $("#results").hidden = true;
  setStatus("loading", "正在获取真实行情", "逐项核验代码、名称、完整历史和共同日期，请稍候…");
  try {
    const normalized = normalizeAssets(assets);
    const prices = await loadPortfolioPrices(normalized, 10);
    const analysis = analyzePortfolioData(normalized, prices, {
      rebalance: $("#rebalance").value,
      transactionCostBps: Number($("#costBps").value || 5),
      maxDrawdown: 0.15,
      targetLow: 0.07,
      targetHigh: 0.10,
      samples: 2500,
      seed: 42,
    });
    assets = analysis.allocation.map((row) => ({ ...row, lookup: "ok" }));
    renderAssets();
    renderSummary();
    renderResults(analysis);
    setStatus("ok", "真实回测完成", `数据截止 ${analysis.dataCutoff}，共同区间 ${analysis.commonStart} 至 ${analysis.commonEnd}。`);
  } catch (error) {
    setStatus("error", "真实行情回测失败", error instanceof Error ? error.message : String(error));
  } finally {
    button.disabled = false;
  }
}

document.querySelectorAll("[data-add]").forEach((button) => button.addEventListener("click", () => {
  if (assets.length >= 12) return setStatus("error", "不能继续添加", "单次回测最多支持 12 项资产。");
  assets.push(newAsset(button.dataset.add));
  renderAssets();
  renderSummary();
  $("#results").hidden = true;
}));
$("#runButton").addEventListener("click", runBacktest);
renderAssets();
renderSummary();
