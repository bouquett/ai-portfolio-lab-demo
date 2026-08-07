# 真实资产配置回测 · GitHub Pages

稳定在线地址：<https://bouquett.github.io/ai-portfolio-lab-demo/>

这是不依赖临时应用域名的浏览器端真实数据版本。它支持卡片式配置、代码自动识别、1 / 3 / 5 / 10 年回测、年度再平衡、交易成本、最大回撤和约束优化。

## 数据完整性

- 场外基金：以跨域脚本方式读取东方财富完整累计净值。
- 境内 ETF / 股票：读取腾讯证券前复权日线；ETF 在腾讯失败时可回退到东方财富累计净值。
- SPY：由 GitHub Actions 从 Yahoo Finance 或 Nasdaq 读取真实行情，并结合 USD/CNY 汇率生成同源日更快照。
- 现金：只使用界面中明确给出的年化代理假设。
- 任一市场资产取数失败时停止回测，不生成替代走势。

`data/us/SPY.json` 工作日自动更新。若 Yahoo 不可用而使用 Nasdaq 收盘价，页面会显示“不计现金分红”的口径警告。

## 本地运行

```bash
python3 -m http.server 8080
```

打开 <http://localhost:8080/>。直接双击 HTML 会因为浏览器模块安全限制而无法正常工作。

## 验证

```bash
npm test
npm run update-data
```

历史结果不代表未来收益，不构成投资建议。DeepSeek API Key 只保留在私有本地版本的环境变量中，不进入本公共仓库。
