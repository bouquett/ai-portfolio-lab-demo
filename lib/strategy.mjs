export const STRATEGY_POLICY = Object.freeze({
  totalAmount: 2_000_000,
  targetReturn: [0.07, 0.10],
  maxDrawdown: 0.15,
  rebalance: "每年",
  transactionCostBps: 5,
  buckets: Object.freeze([
    { category: "固收", label: "固收底仓", amount: 1_100_000, weight: 0.55, note: "短融、综合债券指数、信用债、纯债四层分散" },
    { category: "宽基", label: "A股宽基增长", amount: 800_000, weight: 0.40, note: "沪深300、中证500各自分散" },
    { category: "现金", label: "现金备用", amount: 100_000, weight: 0.05, note: "应急与再平衡缓冲" },
  ]),
});

export const DEFAULT_ASSETS = Object.freeze([
  Object.freeze({ id: "fixed-short", type: "债券基金", category: "固收", code: "000128", name: "大成景安短融债券A", amount: 250_000, sleeve: "货币与短久期", manager: "大成基金", source: "" }),
  Object.freeze({ id: "fixed-index", type: "债券基金", category: "固收", code: "161119", name: "易方达中债新综指发起式(LOF)A", amount: 350_000, sleeve: "综合债券指数", manager: "易方达基金", source: "" }),
  Object.freeze({ id: "fixed-credit", type: "债券基金", category: "固收", code: "000191", name: "富国信用债债券A/B", amount: 300_000, sleeve: "信用债", manager: "富国基金", source: "" }),
  Object.freeze({ id: "fixed-pure", type: "债券基金", category: "固收", code: "270048", name: "广发纯债债券A", amount: 200_000, sleeve: "纯债", manager: "广发基金", source: "" }),
  Object.freeze({ id: "cn-large", type: "ETF", category: "A股宽基", code: "510300", name: "沪深300ETF华泰柏瑞", amount: 450_000, sleeve: "A股大盘宽基", manager: "华泰柏瑞基金", source: "" }),
  Object.freeze({ id: "cn-mid", type: "ETF", category: "A股宽基", code: "510500", name: "中证500ETF南方", amount: 350_000, sleeve: "A股中盘宽基", manager: "南方基金", source: "" }),
  Object.freeze({ id: "cash", type: "现金", category: "现金", code: "CASH", name: "现金备用金", amount: 100_000, cashRate: 0.015, sleeve: "应急备用", manager: "用户设定", source: "用户设定现金年化代理（非行情）" }),
]);

export function inferSleeve(category, name = "") {
  if (category !== "固收") return category || "自定义资产";
  const text = String(name);
  if (/货币|日利|现金|短融|短债|超短|同业存单/.test(text)) return "货币与短久期";
  if (/城投/.test(text)) return "城投债";
  if (/国债|政金|国开|政策性金融/.test(text)) return "利率债";
  if (/中债.*综|综合债券.*指数|新综指/.test(text)) return "综合债券指数";
  if (/可转债|转债/.test(text)) return "可转债";
  if (/信用|公司债|企业债/.test(text)) return "信用债";
  if (/纯债/.test(text)) return "纯债";
  return "自定义固收";
}

export function createDefaultAssets() {
  return DEFAULT_ASSETS.map((asset) => ({ ...asset }));
}
