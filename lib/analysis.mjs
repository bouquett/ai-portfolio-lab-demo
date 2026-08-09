import {
  backtestPortfolio,
  calculateMetrics,
  optimizeAllocation,
  selectWindow,
  slicePrices,
} from "./portfolio.mjs";

const ASSET_TYPES = new Set(["现金", "债券基金", "宽基基金", "其他场外基金", "ETF", "股票", "美股/美股ETF"]);
const CATEGORIES = new Set(["现金", "固收", "A股宽基", "黄金", "美股", "其他"]);

export function normalizeAssets(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("至少需要一项资产");
  if (rows.length > 12) throw new Error("单次回测最多支持 12 项资产");
  const seen = new Set();
  return rows.map((row, index) => {
    const type = String(row?.type ?? "").trim();
    if (!ASSET_TYPES.has(type)) throw new Error(`第 ${index + 1} 项资产类型无效`);
    let code = type === "现金" ? "CASH" : String(row?.code ?? "").trim().toUpperCase();
    if (type !== "现金" && type !== "美股/美股ETF" && !/^\d{6}$/.test(code)) {
      throw new Error(`${code || "空代码"} 必须是 6 位数字`);
    }
    if (type === "美股/美股ETF" && !/^[A-Z][A-Z0-9.-]{0,11}$/.test(code)) {
      throw new Error("美股代码格式无效，例如 SPY、QQQ 或 BRK-B");
    }
    if (seen.has(code)) throw new Error(`资产代码 ${code} 重复`);
    seen.add(code);
    const amount = Number(row?.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error(`${code} 的金额必须大于 0`);
    const category = type === "现金" ? "现金" : (type === "美股/美股ETF" ? "美股" : String(row?.category ?? "其他"));
    if (!CATEGORIES.has(category)) throw new Error(`${code} 的资产类别无效`);
    const cashRate = type === "现金" ? Number(row?.cashRate ?? 0.015) : 0;
    if (!Number.isFinite(cashRate) || cashRate < -0.05 || cashRate > 0.2) throw new Error("现金年化代理必须在 -5% 到 20% 之间");
    return {
      id: String(row?.id ?? `${code}-${index}`),
      type,
      category,
      code,
      name: String(row?.name ?? "").trim() || (type === "现金" ? "现金备用金" : code),
      amount,
      cashRate,
      sleeve: String(row?.sleeve ?? "").trim(),
      manager: String(row?.manager ?? "").trim(),
    };
  });
}

function sampledSeries(dates, values, maxPoints = 320) {
  const step = Math.max(1, Math.ceil(dates.length / maxPoints));
  const result = [];
  for (let index = 0; index < dates.length; index += step) result.push({ date: dates[index], value: values[index] });
  if (result.at(-1)?.date !== dates.at(-1)) result.push({ date: dates.at(-1), value: values.at(-1) });
  return result;
}

function annualReturns(dates, nav) {
  const years = new Map();
  dates.forEach((date, index) => {
    const year = date.slice(0, 4);
    if (!years.has(year)) years.set(year, { first: nav[index], last: nav[index] });
    else years.get(year).last = nav[index];
  });
  return [...years.entries()].map(([year, values], index, rows) => {
    const previous = index > 0 ? rows[index - 1][1].last : values.first;
    return { year, value: values.last / previous - 1, partial: index === 0 };
  });
}

function windowBacktest(prices, codes, weights, years, rebalance, transactionCostBps) {
  const window = selectWindow(prices.dates, years);
  if (!window) return null;
  const sliced = slicePrices(prices, window.startIndex);
  const result = backtestPortfolio(sliced, codes, weights, rebalance, transactionCostBps);
  const metrics = calculateMetrics(result.dates, result.nav);
  return {
    years,
    actualYears: metrics.actualYears,
    startDate: result.dates[0],
    endDate: result.dates.at(-1),
    points: result.dates.length,
    metrics,
    nav: sampledSeries(result.dates, result.nav),
    drawdown: sampledSeries(result.dates, result.drawdown),
    annualReturns: annualReturns(result.dates, result.nav),
    rebalanceCount: result.rebalanceCount,
    estimatedCostRatio: result.totalCost,
  };
}

export function analyzePortfolioData(rawAssets, prices, options = {}) {
  const assets = normalizeAssets(rawAssets);
  const totalAmount = assets.reduce((sum, asset) => sum + asset.amount, 0);
  const codes = assets.map((asset) => asset.code);
  for (const code of codes) {
    if (!prices.values?.[code]) throw new Error(`${code} 的金额与真实行情无法对账`);
  }
  const weights = assets.map((asset) => asset.amount / totalAmount);
  const rebalance = options.rebalance ?? "每年";
  const transactionCostBps = Number(options.transactionCostBps ?? 5);
  const windows = {};
  for (const years of [1, 3, 5, 10]) {
    windows[years] = windowBacktest(prices, codes, weights, years, rebalance, transactionCostBps);
  }
  const availableYears = [1, 3, 5, 10].filter((years) => windows[years]);
  if (!availableYears.length) throw new Error("共同真实历史不足，无法完成 1 年回测");
  const selectedYears = Math.max(...availableYears);
  const optimizationWindow = selectWindow(prices.dates, selectedYears);
  const optimizationPrices = slicePrices(prices, optimizationWindow.startIndex);

  const optimized = optimizeAllocation(optimizationPrices, assets, {
    samples: Number(options.samples ?? 2500),
    seed: Number(options.seed ?? 42),
    maxDrawdown: Number(options.maxDrawdown ?? 0.15),
    targetLow: Number(options.targetLow ?? 0.07),
    targetHigh: Number(options.targetHigh ?? 0.1),
    transactionCostBps,
  });
  const optimizedWindows = {};
  for (const years of [1, 3, 5, 10]) {
    optimizedWindows[years] = windowBacktest(prices, codes, optimized.weights, years, "每年", transactionCostBps);
  }

  const historyByCode = new Map((prices.histories ?? []).map((history) => [history.code, history]));
  const allocation = assets.map((asset, index) => ({
    ...asset,
    name: historyByCode.get(asset.code)?.name || asset.name,
    source: historyByCode.get(asset.code)?.source || prices.quality?.find((row) => row.code === asset.code)?.source || "",
    weight: weights[index],
    optimizedWeight: optimized.weights[index],
    optimizedAmount: optimized.weights[index] * totalAmount,
  }));

  const usAmount = assets.filter((asset) => asset.category === "美股").reduce((sum, asset) => sum + asset.amount, 0);
  const goldAmount = assets.filter((asset) => asset.category === "黄金").reduce((sum, asset) => sum + asset.amount, 0);
  const cashAmount = assets.filter((asset) => asset.category === "现金").reduce((sum, asset) => sum + asset.amount, 0);
  const rmbInvestedAmount = totalAmount - usAmount - cashAmount;
  const fixedIncomeAssets = assets.filter((asset) => asset.category === "固收");
  const fixedIncomeAmount = fixedIncomeAssets.reduce((sum, asset) => sum + asset.amount, 0);
  const fixedIncomeSleeves = new Set(fixedIncomeAssets.map((asset) => asset.sleeve).filter(Boolean));
  const fixedIncomeMaxShare = fixedIncomeAmount > 0
    ? Math.max(0, ...fixedIncomeAssets.map((asset) => asset.amount / fixedIncomeAmount))
    : 0;
  const fixedIncomeDiversified = fixedIncomeAssets.length >= 3
    && fixedIncomeSleeves.size >= 3
    && fixedIncomeMaxShare <= 0.45;
  const broadIndexAssets = assets.filter((asset) => asset.category === "A股宽基");
  const broadIndexAmount = broadIndexAssets.reduce((sum, asset) => sum + asset.amount, 0);
  const quality = (prices.quality ?? []).map((row) => ({ ...row }));
  const warnings = ["优化候选属于所选历史期限的样本内优化，存在过拟合风险；它用于压力测试和权重比较，不是未来收益承诺。"];
  if (Math.abs(totalAmount - 2_000_000) > 1) warnings.push(`当前总金额为 ¥${totalAmount.toLocaleString("zh-CN")}，不是目标 ¥2,000,000。`);
  if (usAmount > 1) warnings.push(`当前美股金额为 ¥${usAmount.toLocaleString("zh-CN")}；本轮默认方案按你的要求暂不配置标普500或其他美股。`);
  if (goldAmount > 1) warnings.push(`当前黄金金额为 ¥${goldAmount.toLocaleString("zh-CN")}；本轮默认方案按你的要求暂不配置黄金。`);
  if (Math.abs(cashAmount - 100_000) > 1) warnings.push(`当前现金为 ¥${cashAmount.toLocaleString("zh-CN")}，不是目标 ¥100,000。`);
  if (Math.abs(rmbInvestedAmount - 1_900_000) > 1) warnings.push(`当前人民币投资资产为 ¥${rmbInvestedAmount.toLocaleString("zh-CN")}，不是目标 ¥1,900,000。`);
  if (Math.abs(fixedIncomeAmount - 1_100_000) > 1) warnings.push(`当前固收金额为 ¥${fixedIncomeAmount.toLocaleString("zh-CN")}，不是目标 ¥1,100,000。`);
  if (Math.abs(broadIndexAmount - 800_000) > 1) warnings.push(`当前A股宽基金额为 ¥${broadIndexAmount.toLocaleString("zh-CN")}，不是目标 ¥800,000。`);
  if (!fixedIncomeDiversified) warnings.push("固收没有通过分散检查：至少需要 3 个不同固收子策略，且单一固收资产不得超过固收仓位的 45%。");
  if (!windows[10]) warnings.push("部分资产共同历史不足 10 年，因此不展示伪 10 年结果。返回空值是数据质量保护。 ");
  if (quality.some((row) => String(row.source).includes("未计现金分红"))) {
    warnings.push("Yahoo 不可用时，美股使用 Nasdaq 真实收盘价备用源；该口径不含现金分红，会低估派息资产总回报。界面已明确标注。 ");
  }
  const maxFillRatio = quality.reduce((max, row) => Math.max(max, row.commonPoints ? row.forwardFilled / row.commonPoints : 0), 0);
  if (maxFillRatio > 0.1) warnings.push(`跨市场交易日差异导致单项资产最多 ${(maxFillRatio * 100).toFixed(1)}% 的共同日期使用前值填充。`);
  const optimizedGoldWeight = assets.reduce((sum, asset, index) => sum + (asset.category === "黄金" ? optimized.weights[index] : 0), 0);
  if (optimizedGoldWeight > 0.001) warnings.push(`历史候选的黄金权重为 ${(optimizedGoldWeight * 100).toFixed(1)}%，偏离当前暂不配置黄金的默认假设；请把它视为自定义情景，而不是本轮推荐方案。`);

  return {
    generatedAt: new Date().toISOString(),
    dataCutoff: prices.dates.at(-1),
    commonStart: prices.dates[0],
    commonEnd: prices.dates.at(-1),
    commonPoints: prices.dates.length,
    allocation,
    windows,
    optimizedWindows,
    selectedYears,
    optimized: {
      feasible: optimized.feasible,
      allocationConstraintsMet: optimized.allocationConstraintsMet,
      sampleCount: optimized.sampleCount,
      metrics: optimized.metrics,
    },
    portfolioChecks: {
      totalAmount,
      usAmount,
      goldAmount,
      cashAmount,
      rmbInvestedAmount,
      fixedIncomeAmount,
      broadIndexAmount,
      fixedIncomeAssetCount: fixedIncomeAssets.length,
      fixedIncomeSleeveCount: fixedIncomeSleeves.size,
      fixedIncomeMaxShare,
      fixedIncomeDiversified,
      broadIndexAssetCount: broadIndexAssets.length,
      matchesTwoMillionPlan: Math.abs(totalAmount - 2_000_000) <= 1
        && usAmount <= 1
        && goldAmount <= 1
        && Math.abs(cashAmount - 100_000) <= 1
        && Math.abs(rmbInvestedAmount - 1_900_000) <= 1
        && Math.abs(fixedIncomeAmount - 1_100_000) <= 1
        && Math.abs(broadIndexAmount - 800_000) <= 1,
    },
    quality,
    warnings,
    dataIntegrity: {
      usesSyntheticMarketData: false,
      cashIsUserAssumption: true,
      realMarketAssetCount: assets.filter((asset) => asset.type !== "现金").length,
      rule: "任一市场资产取数失败即停止回测，不用合成行情填补。",
    },
    settings: {
      rebalance,
      transactionCostBps,
      targetReturn: [Number(options.targetLow ?? 0.07), Number(options.targetHigh ?? 0.1)],
      maxDrawdown: Number(options.maxDrawdown ?? 0.15),
    },
  };
}
