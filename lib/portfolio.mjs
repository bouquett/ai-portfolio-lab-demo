const DAY_MS = 86_400_000;
const YEAR_DAYS = 365.25;

function asTime(date) {
  const value = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(value)) throw new Error(`无效日期：${date}`);
  return value;
}

function cleanPoints(points, code) {
  const byDate = new Map();
  for (const point of points ?? []) {
    const value = Number(point.value);
    if (point.date && Number.isFinite(value) && value > 0) byDate.set(point.date, value);
  }
  const cleaned = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, value]) => ({ date, value }));
  if (cleaned.length < 2) throw new Error(`${code} 没有足够的真实历史数据`);
  return cleaned;
}

export function mergePriceSeries(series) {
  if (!Array.isArray(series) || series.length === 0) throw new Error("没有可合并的行情");
  const cleaned = series.map((item) => ({ ...item, points: cleanPoints(item.points, item.code) }));
  const commonStart = cleaned.map((item) => item.points[0].date).sort().at(-1);
  const commonEnd = cleaned.map((item) => item.points.at(-1).date).sort()[0];
  if (!commonStart || !commonEnd || commonStart >= commonEnd) throw new Error("资产之间没有共同历史区间");

  const calendar = new Set();
  for (const item of cleaned) {
    for (const point of item.points) {
      if (point.date >= commonStart && point.date <= commonEnd) calendar.add(point.date);
    }
  }
  const dates = [...calendar].sort();
  const values = {};
  const quality = [];

  for (const item of cleaned) {
    const raw = new Map(item.points.map((point) => [point.date, point.value]));
    let previous = null;
    let forwardFilled = 0;
    const aligned = dates.map((date) => {
      if (raw.has(date)) previous = raw.get(date);
      else if (previous != null) forwardFilled += 1;
      return previous;
    });
    if (aligned.some((value) => value == null)) throw new Error(`${item.code} 在共同起始日缺少行情`);
    values[item.code] = aligned;
    const present = dates.filter((date) => raw.has(date)).length;
    quality.push({
      code: item.code,
      source: item.source ?? "",
      originalStart: item.points[0].date,
      originalEnd: item.points.at(-1).date,
      originalPoints: item.points.length,
      commonStart,
      commonEnd,
      commonPoints: dates.length,
      coverage: present / dates.length,
      forwardFilled,
    });
  }
  return { dates, values, quality };
}

function periodKey(date, frequency) {
  if (frequency === "每月") return date.slice(0, 7);
  if (frequency === "每季度") {
    const month = Number(date.slice(5, 7));
    return `${date.slice(0, 4)}-Q${Math.floor((month - 1) / 3) + 1}`;
  }
  if (frequency === "每年") return date.slice(0, 4);
  return null;
}

export function backtestPortfolio(prices, codes, targetWeights, rebalance = "每年", transactionCostBps = 0) {
  const { dates, values } = prices;
  if (!Array.isArray(dates) || dates.length < 2) throw new Error("至少需要两个历史价格点");
  if (codes.length !== targetWeights.length || codes.length === 0) throw new Error("资产与权重数量不一致");
  const weights = targetWeights.map(Number);
  const weightSum = weights.reduce((sum, value) => sum + value, 0);
  if (weights.some((value) => !Number.isFinite(value) || value < 0) || Math.abs(weightSum - 1) > 1e-7) {
    throw new Error("目标权重无效");
  }
  for (const code of codes) {
    if (!values[code] || values[code].length !== dates.length) throw new Error(`${code} 行情长度不一致`);
  }

  let holdings = [...weights];
  const nav = [];
  let previousPeriod = periodKey(dates[0], rebalance);
  let rebalanceCount = 0;
  let totalCost = 0;

  for (let row = 0; row < dates.length; row += 1) {
    const currentPeriod = periodKey(dates[row], rebalance);
    if (row > 0 && currentPeriod != null && currentPeriod !== previousPeriod) {
      const valueBefore = holdings.reduce((sum, value) => sum + value, 0);
      const target = weights.map((weight) => weight * valueBefore);
      const turnover = target.reduce((sum, value, index) => sum + Math.abs(value - holdings[index]), 0);
      const cost = turnover * Number(transactionCostBps) / 10_000;
      const scale = valueBefore > 0 ? Math.max((valueBefore - cost) / valueBefore, 0) : 0;
      holdings = target.map((value) => value * scale);
      totalCost += cost;
      rebalanceCount += 1;
    }
    for (let column = 0; column < codes.length; column += 1) {
      const code = codes[column];
      const dailyReturn = row === 0 ? 0 : values[code][row] / values[code][row - 1] - 1;
      holdings[column] *= 1 + dailyReturn;
    }
    nav.push(holdings.reduce((sum, value) => sum + value, 0));
    previousPeriod = currentPeriod;
  }

  const drawdown = [];
  let peak = -Infinity;
  for (const value of nav) {
    peak = Math.max(peak, value);
    drawdown.push(value / peak - 1);
  }
  return { dates: [...dates], nav, drawdown, rebalanceCount, totalCost };
}

function sampleStd(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

export function calculateMetrics(dates, nav) {
  if (!Array.isArray(nav) || nav.length < 2 || nav[0] <= 0 || nav.length !== dates.length) {
    throw new Error("组合净值不足，无法计算指标");
  }
  const elapsedYears = Math.max((asTime(dates.at(-1)) - asTime(dates[0])) / DAY_MS / YEAR_DAYS, 1 / YEAR_DAYS);
  const totalReturn = nav.at(-1) / nav[0] - 1;
  const annualReturn = (nav.at(-1) / nav[0]) ** (1 / elapsedYears) - 1;
  const daily = nav.slice(1).map((value, index) => value / nav[index] - 1);
  const volatility = sampleStd(daily) * Math.sqrt(252);
  let peak = nav[0];
  let maxDrawdown = 0;
  for (const value of nav) {
    peak = Math.max(peak, value);
    maxDrawdown = Math.min(maxDrawdown, value / peak - 1);
  }
  const sharpe = volatility > 0 ? annualReturn / volatility : 0;
  const calmar = maxDrawdown < 0 ? annualReturn / Math.abs(maxDrawdown) : 0;
  return { totalReturn, annualReturn, maxDrawdown, volatility, sharpe, calmar, actualYears: elapsedYears };
}

export function selectWindow(dates, years) {
  if (!dates?.length) return null;
  const end = new Date(`${dates.at(-1)}T00:00:00Z`);
  const cutoff = new Date(end);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - Number(years));
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const startIndex = dates.findIndex((date) => date >= cutoffIso);
  if (startIndex < 0) return null;
  const actualYears = (asTime(dates.at(-1)) - asTime(dates[startIndex])) / DAY_MS / YEAR_DAYS;
  const required = Math.min(Number(years) * 0.8, Number(years) - 0.15);
  if (dates.length - startIndex < 20 || actualYears < required) return null;
  return { startIndex, actualYears: Number(actualYears.toFixed(2)) };
}

export function slicePrices(prices, startIndex) {
  const values = Object.fromEntries(Object.entries(prices.values).map(([code, rows]) => [code, rows.slice(startIndex)]));
  return { dates: prices.dates.slice(startIndex), values };
}

export function allocationConstraintsMet(weights, categories) {
  const tolerance = 1e-7;
  if (weights.length !== categories.length || weights.some((weight) => !Number.isFinite(weight) || weight < 0)) return false;
  if (Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - 1) > tolerance) return false;
  if (Math.max(...weights) > 0.35 + tolerance) return false;
  const totals = new Map();
  categories.forEach((category, index) => totals.set(category, (totals.get(category) ?? 0) + weights[index]));
  const positionsFor = (target) => categories.map((category, index) => category === target ? index : -1).filter((index) => index >= 0);
  const fixedPositions = positionsFor("固收");
  const broadPositions = positionsFor("A股宽基");
  if (totals.has("现金") && Math.abs(totals.get("现金") - 0.05) > tolerance) return false;
  if (totals.has("美股") && Math.abs(totals.get("美股") - 0.1) > tolerance) return false;
  if (totals.has("固收") && (totals.get("固收") < (fixedPositions.length >= 3 ? 0.35 : 0.25) - tolerance || totals.get("固收") > (fixedPositions.length >= 3 ? 0.55 : 0.6) + tolerance)) return false;
  if (fixedPositions.length >= 3 && fixedPositions.some((index) => weights[index] < 0.05 - tolerance || weights[index] > 0.2 + tolerance)) return false;
  if (fixedPositions.length >= 3 && fixedPositions.some((index) => weights[index] / totals.get("固收") > 0.45 + tolerance)) return false;
  if (totals.has("A股宽基") && (totals.get("A股宽基") < (broadPositions.length >= 2 ? 0.2 : 0.1) - tolerance || totals.get("A股宽基") > (broadPositions.length >= 2 ? 0.4 : 0.5) + tolerance)) return false;
  if (broadPositions.length >= 2 && broadPositions.some((index) => weights[index] < 0.05 - tolerance || weights[index] > 0.25 + tolerance)) return false;
  if (totals.has("黄金") && (totals.get("黄金") < 0.05 - tolerance || totals.get("黄金") > 0.2 + tolerance)) return false;
  if ((totals.get("其他") ?? 0) > 0.25 + tolerance) return false;
  return true;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function positionsForCategory(categories, target) {
  return categories.map((category, index) => category === target ? index : -1).filter((index) => index >= 0);
}

function boundedRandomSplit(total, count, minimum, maximum, random) {
  if (count <= 0 || total < count * minimum - 1e-9 || total > count * maximum + 1e-9) return null;
  if (count === 1) return [total];
  const remaining = total - count * minimum;
  for (let attempt = 0; attempt < 48; attempt += 1) {
    const draws = Array.from({ length: count }, () => -Math.log(Math.max(random(), 1e-12)));
    const drawSum = draws.reduce((sum, value) => sum + value, 0);
    const values = draws.map((value) => minimum + remaining * value / drawSum);
    if (values.every((value) => value <= maximum + 1e-9)) return values;
  }
  const equal = total / count;
  return equal >= minimum - 1e-9 && equal <= maximum + 1e-9 ? new Array(count).fill(equal) : null;
}

function structuredDiversifiedSample(categories, random) {
  const allowed = new Set(["现金", "固收", "A股宽基", "黄金", "美股"]);
  if (categories.some((category) => !allowed.has(category))) return null;
  const positions = Object.fromEntries([...allowed].map((category) => [category, positionsForCategory(categories, category)]));
  if (!positions["现金"].length || positions["固收"].length < 3 || positions["A股宽基"].length < 2) return null;

  if (!positions["美股"].length && !positions["黄金"].length) {
    const fixed = boundedRandomSplit(0.55, positions["固收"].length, 0.05, 0.20, random);
    const broad = boundedRandomSplit(0.40, positions["A股宽基"].length, 0.05, 0.25, random);
    if (!fixed || !broad) return null;
    const weights = new Array(categories.length).fill(0);
    positions["现金"].forEach((index) => { weights[index] = 0.05 / positions["现金"].length; });
    positions["固收"].forEach((index, splitIndex) => { weights[index] = fixed[splitIndex]; });
    positions["A股宽基"].forEach((index, splitIndex) => { weights[index] = broad[splitIndex]; });
    return weights;
  }

  if (!positions["美股"].length || !positions["黄金"].length) return null;

  for (let attempt = 0; attempt < 48; attempt += 1) {
    const fixedTotal = 0.35 + random() * 0.20;
    const broadTotal = 0.20 + random() * 0.20;
    const goldTotal = 0.85 - fixedTotal - broadTotal;
    if (goldTotal < 0.05 || goldTotal > 0.20) continue;
    const fixed = boundedRandomSplit(fixedTotal, positions["固收"].length, 0.05, 0.20, random);
    const broad = boundedRandomSplit(broadTotal, positions["A股宽基"].length, 0.05, 0.25, random);
    const gold = boundedRandomSplit(goldTotal, positions["黄金"].length, 0, 0.20, random);
    if (!fixed || !broad || !gold) continue;
    const weights = new Array(categories.length).fill(0);
    positions["现金"].forEach((index) => { weights[index] = 0.05 / positions["现金"].length; });
    positions["美股"].forEach((index) => { weights[index] = 0.10 / positions["美股"].length; });
    positions["固收"].forEach((index, splitIndex) => { weights[index] = fixed[splitIndex]; });
    positions["A股宽基"].forEach((index, splitIndex) => { weights[index] = broad[splitIndex]; });
    positions["黄金"].forEach((index, splitIndex) => { weights[index] = gold[splitIndex]; });
    return weights;
  }
  return null;
}

function approximateCandidate(prices, codes, weights) {
  let nav = 1;
  let peak = 1;
  let maxDrawdown = 0;
  const returns = [];
  for (let row = 1; row < prices.dates.length; row += 1) {
    let daily = 0;
    for (let column = 0; column < codes.length; column += 1) {
      daily += weights[column] * (prices.values[codes[column]][row] / prices.values[codes[column]][row - 1] - 1);
    }
    returns.push(daily);
    nav *= 1 + daily;
    peak = Math.max(peak, nav);
    maxDrawdown = Math.min(maxDrawdown, nav / peak - 1);
  }
  const years = Math.max((asTime(prices.dates.at(-1)) - asTime(prices.dates[0])) / DAY_MS / YEAR_DAYS, 1 / YEAR_DAYS);
  const annualReturn = nav ** (1 / years) - 1;
  const volatility = sampleStd(returns) * Math.sqrt(252);
  const sharpe = volatility > 0 ? annualReturn / volatility : 0;
  return { annualReturn, maxDrawdown, volatility, sharpe };
}

export function optimizeAllocation(prices, assets, options = {}) {
  const samples = Math.max(1, Number(options.samples ?? 2500));
  const seed = Number(options.seed ?? 42);
  const maxDrawdownLimit = Number(options.maxDrawdown ?? 0.15);
  const targetLow = Number(options.targetLow ?? 0.07);
  const targetHigh = Number(options.targetHigh ?? 0.1);
  const codes = assets.map((asset) => asset.code);
  const categories = assets.map((asset) => asset.category ?? "其他");
  const weightsBase = new Array(assets.length).fill(0);
  for (const [category, target] of [["现金", 0.05], ["美股", 0.1]]) {
    const positions = categories.map((value, index) => value === category ? index : -1).filter((index) => index >= 0);
    for (const position of positions) weightsBase[position] = target / positions.length;
  }
  const variable = weightsBase.map((value, index) => value === 0 ? index : -1).filter((index) => index >= 0);
  const remaining = 1 - weightsBase.reduce((sum, value) => sum + value, 0);
  const random = mulberry32(seed);
  const midpoint = (targetLow + targetHigh) / 2;
  let best = null;
  let validCandidates = 0;

  for (let sample = 0; sample < samples; sample += 1) {
    const structured = structuredDiversifiedSample(categories, random);
    const weights = structured ?? [...weightsBase];
    if (!structured) {
      const draws = variable.map(() => -Math.log(Math.max(random(), 1e-12)));
      const drawSum = draws.reduce((sum, value) => sum + value, 0);
      variable.forEach((position, index) => { weights[position] = remaining * draws[index] / drawSum; });
    }
    if (!allocationConstraintsMet(weights, categories)) continue;
    validCandidates += 1;
    const metrics = approximateCandidate(prices, codes, weights);
    const feasible = Math.abs(metrics.maxDrawdown) <= maxDrawdownLimit && metrics.annualReturn >= targetLow && metrics.annualReturn <= targetHigh;
    const concentration = weights.reduce((sum, value) => sum + value ** 2, 0);
    const score = metrics.sharpe - Math.abs(metrics.annualReturn - midpoint) * 3 - Math.max(0, Math.abs(metrics.maxDrawdown) - maxDrawdownLimit) * 20 - concentration * 0.08;
    const rank = (feasible ? 1_000 : 0) + score;
    if (!best || rank > best.rank) best = { rank, weights, feasible };
  }

  if (!best) {
    const weights = [...weightsBase];
    variable.forEach((position) => { weights[position] = remaining / Math.max(variable.length, 1); });
    best = { rank: -Infinity, weights, feasible: false };
  }
  const exact = backtestPortfolio(prices, codes, best.weights, "每年", Number(options.transactionCostBps ?? 5));
  const metrics = calculateMetrics(exact.dates, exact.nav);
  const feasible = allocationConstraintsMet(best.weights, categories)
    && Math.abs(metrics.maxDrawdown) <= maxDrawdownLimit
    && metrics.annualReturn >= targetLow
    && metrics.annualReturn <= targetHigh;
  return {
    weights: best.weights,
    metrics,
    nav: exact.nav,
    dates: exact.dates,
    feasible,
    allocationConstraintsMet: allocationConstraintsMet(best.weights, categories),
    sampleCount: validCandidates,
  };
}
