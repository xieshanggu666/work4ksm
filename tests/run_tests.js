"use strict";
const assert = require("assert");
const market = require("../engine/market");
const ind = require("../engine/indicators");
const bt = require("../engine/backtest");
const metrics = require("../engine/metrics");
const mc = require("../engine/montecarlo");

let passed = 0;
let failed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log("ok  -", name);
  } catch (e) {
    failed++;
    console.log("FAIL -", name, "::", e.message);
  }
}

t("sma 手算正确", () => {
  const v = [1, 2, 3, 4, 5];
  const s = ind.sma(v, 3);
  assert.strictEqual(s[2], 2);
  assert.strictEqual(s[3], 3);
  assert.strictEqual(s[4], 4);
  assert.strictEqual(s[1], null);
});

t("ema 首值等于输入首值", () => {
  const e = ind.ema([10, 20, 30], 3);
  assert.strictEqual(e[0], 10);
  assert(e[2] > 20 && e[2] < 30);
});

t("rsi 单调上涨接近 100", () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const r = ind.rsi(up, 14);
  assert(r[29] > 99);
});

t("rsi 单调下跌接近 0", () => {
  const dn = Array.from({ length: 30 }, (_, i) => 200 - i);
  const r = ind.rsi(dn, 14);
  assert(r[29] < 1);
});

t("macd 信号线为 line 的平滑", () => {
  const v = [10, 11, 12, 11, 13, 14, 13, 15, 16, 17, 16, 18, 19, 20, 21];
  const m = ind.macd(v, 3, 6, 4);
  assert.strictEqual(m.line.length, v.length);
  assert.strictEqual(m.signal.length, v.length);
  assert(m.signal[14] != null);
});

t("bollinger 上下轨对称", () => {
  const v = Array.from({ length: 30 }, (_, i) => 100 + (i % 5));
  const b = ind.bollinger(v, 10, 2);
  for (let i = 9; i < 30; i++) {
    assert(b.upper[i] > b.mid[i]);
    assert(b.lower[i] < b.mid[i]);
    assert(Math.abs((b.upper[i] - b.mid[i]) - (b.mid[i] - b.lower[i])) < 1e-9);
  }
});

t("atr 正值且首 n-1 为 null", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ high: 100 + i, low: 95 + i, close: 98 + i }));
  const a = ind.atr(rows, 14);
  assert.strictEqual(a[12], null);
  assert(a[13] > 0);
  for (let i = 14; i < 20; i++) assert(a[i] > 0);
});

t("行情生成确定性（同种子同结果）", () => {
  const a = market.generateMarket({ seed: 7, days: 100 });
  const b = market.generateMarket({ seed: 7, days: 100 });
  assert.deepStrictEqual(a.rows, b.rows);
  assert.strictEqual(a.dates.length, 100);
});

t("行情价格恒正且高低有序", () => {
  const m = market.generateMarket({ seed: 3, days: 300, vol: 0.03 });
  for (const r of m.rows) {
    assert(r.high >= Math.max(r.open, r.close));
    assert(r.low <= Math.min(r.open, r.close));
    assert(r.open > 0 && r.close > 0);
  }
});

t("前复权缩放历史价格", () => {
  const m = market.generateMarket({ seed: 1, days: 100 });
  const adj = market.adjustForward(m.rows, 50, 0.5);
  assert(Math.abs(adj[49].close * 1.5 - m.rows[49].close) < 1e-9);
  assert.strictEqual(adj[50].close, m.rows[50].close);
});

t("信号延迟一日于开盘成交", () => {
  const rows = [
    { date: "2023-01-01", open: 10, high: 11, low: 9, close: 10, volume: 1 },
    { date: "2023-01-02", open: 10, high: 11, low: 9, close: 10, volume: 1 },
    { date: "2023-01-03", open: 10, high: 11, low: 9, close: 10, volume: 1 },
    { date: "2023-01-04", open: 50, high: 55, low: 48, close: 52, volume: 1 },
    { date: "2023-01-05", open: 52, high: 56, low: 50, close: 54, volume: 1 },
    { date: "2023-01-06", open: 54, high: 58, low: 52, close: 56, volume: 1 },
  ];
  const signal = [0, 0, 1, 1, 0, 0];
  const r = bt.backtest({ rows }, { cash: 10000, feeRate: 0, slippageBp: 0, strategy: {} }, signal);
  assert.strictEqual(r.trades.length, 1);
  assert.strictEqual(r.trades[0].entry_price, 50);
  assert.strictEqual(r.trades[0].entry_idx, 3);
  assert.strictEqual(r.trades[0].exit_price, 54);
  assert.strictEqual(r.trades[0].exit_idx, 5);
});

t("止损触发价处理跳空", () => {
  const rows = [
    { date: "d1", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { date: "d2", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { date: "d3", open: 100, high: 101, low: 85, close: 90, volume: 1 },
    { date: "d4", open: 85, high: 90, low: 80, close: 86, volume: 1 },
  ];
  const signal = [0, 1, 1, 0];
  const r = bt.backtest({ rows }, { cash: 10000, feeRate: 0, slippageBp: 0, stopLoss: 0.1, strategy: {} }, signal);
  assert.strictEqual(r.trades.length, 1);
  assert.strictEqual(r.trades[0].reason, "止损");
  assert.strictEqual(r.trades[0].entry_price, 100);
  assert.strictEqual(r.trades[0].exit_price, 85);
});

t("止损无跳空时按止损价成交", () => {
  const rows = [
    { date: "d1", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { date: "d2", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { date: "d3", open: 100, high: 101, low: 85, close: 90, volume: 1 },
    { date: "d4", open: 95, high: 96, low: 85, close: 90, volume: 1 },
  ];
  const signal = [0, 1, 1, 0];
  const r = bt.backtest({ rows }, { cash: 10000, feeRate: 0, slippageBp: 0, stopLoss: 0.1, strategy: {} }, signal);
  assert.strictEqual(r.trades.length, 1);
  assert.strictEqual(r.trades[0].exit_price, 90);
  assert.strictEqual(r.trades[0].reason, "止损");
});

t("止损平仓当日不再重新开仓", () => {
  const rows = [
    { date: "d1", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { date: "d2", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { date: "d3", open: 100, high: 101, low: 85, close: 90, volume: 1 },
    { date: "d4", open: 95, high: 96, low: 85, close: 90, volume: 1 },
    { date: "d5", open: 90, high: 92, low: 88, close: 91, volume: 1 },
  ];
  const signal = [0, 1, 1, 1, 0];
  const r = bt.backtest({ rows }, { cash: 10000, feeRate: 0, slippageBp: 0, stopLoss: 0.1, strategy: {} }, signal);
  assert.strictEqual(r.trades.length, 1);
});

t("手续费与滑点计入成本", () => {
  const rows = [
    { date: "d1", open: 10, high: 11, low: 9, close: 10, volume: 1 },
    { date: "d2", open: 10, high: 11, low: 9, close: 10, volume: 1 },
    { date: "d3", open: 10, high: 11, low: 9, close: 10, volume: 1 },
  ];
  const signal = [0, 1, 0];
  const r0 = bt.backtest({ rows }, { cash: 10000, feeRate: 0, slippageBp: 0, strategy: {} }, signal);
  const r1 = bt.backtest({ rows }, { cash: 10000, feeRate: 0.01, slippageBp: 100, strategy: {} }, signal);
  assert(r1.final_equity < r0.final_equity);
});

t("买入持有权益随收盘价变化", () => {
  const rows = [
    { date: "d1", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { date: "d2", open: 100, high: 110, low: 99, close: 110, volume: 1 },
  ];
  const r = bt.backtest({ rows }, { cash: 10000, feeRate: 0, slippageBp: 0, strategy: { type: "buy_hold" } });
  assert.strictEqual(r.final_equity, 11000);
});

t("最大回撤计算正确", () => {
  const eq = [100, 120, 110, 130, 90];
  const dd = metrics.maxDrawdown(eq);
  assert(Math.abs(dd.maxDD - (90 / 130 - 1)) < 1e-9);
  assert.strictEqual(dd.start, 3);
  assert.strictEqual(dd.end, 4);
});

t("指标汇总总收益与年化", () => {
  const eq = [100, 100, 100, 121];
  const s = metrics.summarize(eq, { periodsPerYear: 3 });
  assert(Math.abs(s.total_return - 0.21) < 1e-9);
  assert(Math.abs(s.cagr - Math.pow(1.21, 1) + 1) < 1e-9);
});

t("夏普在有波动时有限", () => {
  const eq = [100, 102, 101, 104, 103, 106];
  const s = metrics.summarize(eq, { periodsPerYear: 252, riskFree: 0 });
  assert(Number.isFinite(s.sharpe));
});

t("蒙特卡洛分位数单调", () => {
  const eq = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
  const r = mc.simulate(eq, 500, 50, 11);
  assert.strictEqual(r.quantiles.p5.length, 51);
  for (let i = 0; i <= 50; i++) {
    assert(r.quantiles.p5[i] <= r.quantiles.p50[i] + 1e-9);
    assert(r.quantiles.p50[i] <= r.quantiles.p95[i] + 1e-9);
  }
  assert(r.prob_loss >= 0 && r.prob_loss <= 1);
});

t("蒙特卡洛确定性", () => {
  const eq = [100, 101, 102, 103, 104];
  const a = mc.simulate(eq, 50, 20, 5);
  const b = mc.simulate(eq, 50, 20, 5);
  assert.deepStrictEqual(a.quantiles, b.quantiles);
});

t("均线金叉策略生成非零信号", () => {
  const m = market.generateMarket({ seed: 9, days: 400 });
  const sig = bt.buildSignal(m.rows, { type: "ma_cross", fast: 10, slow: 30 });
  assert(sig.some(v => v === 1));
  assert(sig.some(v => v === 0));
});

t("回测总体运行无异常", () => {
  const m = market.generateMarket({ seed: 21, days: 600 });
  const r = bt.backtest(m, {
    cash: 100000, feeRate: 0.0005, slippageBp: 5, stopLoss: 0.05, takeProfit: 0.2,
    strategy: { type: "boll", bbN: 20, bbK: 2 },
  });
  assert.strictEqual(r.equity.length, 600);
  assert(Number.isFinite(r.final_equity));
  const s = metrics.summarize(r.equity, {});
  assert(Number.isFinite(s.sharpe));
});

// 构造 ATR 测试数据：atrN=3，平稳段 H11 L9 C10（TR=2，ATR 收敛于 2）
function calmBar() { return { date: "d", open: 10, high: 11, low: 9, close: 10, volume: 1 }; }

t("ATR 止损触发且跟踪最高价上移", () => {
  const rows = [calmBar(), calmBar(), calmBar(), calmBar(), calmBar(),
    { date: "d5", open: 10, high: 10.5, low: 6.5, close: 9, volume: 1 }];
  const signal = [0, 0, 1, 1, 1, 1];
  const r = bt.backtest({ rows }, {
    cash: 10000, feeRate: 0, slippageBp: 0, strategy: {},
    stopMode: "atr", atrN: 3, atrStopMult: 2, volState: false,
  }, signal);
  assert.strictEqual(r.trades.length, 1);
  const tr = r.trades[0];
  assert.strictEqual(tr.reason, "止损");
  // 入场价 10，初始止损 10-2*2=6；bar3/bar4 最高 11 把止损上移至 11-2*2=7
  assert.strictEqual(tr.exit_price, 7);
  assert.strictEqual(tr.stop_price, 7);
  assert.strictEqual(tr.atr, 2);
  assert.strictEqual(tr.vol_scale, 1);
  assert.strictEqual(tr.stop_mode, "atr");
});

t("ATR 止盈按入场价+倍数*ATR 触发", () => {
  const rows = [calmBar(), calmBar(), calmBar(), calmBar(),
    { date: "d4", open: 10, high: 17, low: 9.5, close: 15, volume: 1 }];
  const signal = [0, 0, 1, 1, 1];
  const r = bt.backtest({ rows }, {
    cash: 10000, feeRate: 0, slippageBp: 0, strategy: {},
    stopMode: "atr", atrN: 3, atrStopMult: 0, atrTakeMult: 3, volState: false,
  }, signal);
  assert.strictEqual(r.trades.length, 1);
  assert.strictEqual(r.trades[0].reason, "止盈");
  assert.strictEqual(r.trades[0].exit_price, 16); // 10 + 3*2
  assert.strictEqual(r.trades[0].take_price, 16);
});

t("ATR 止损跳空按开盘价成交", () => {
  const rows = [calmBar(), calmBar(), calmBar(), calmBar(), calmBar(),
    { date: "d5", open: 5, high: 5.5, low: 4, close: 4.5, volume: 1 }];
  const signal = [0, 0, 1, 1, 1, 1];
  const r = bt.backtest({ rows }, {
    cash: 10000, feeRate: 0, slippageBp: 0, strategy: {},
    stopMode: "atr", atrN: 3, atrStopMult: 2, volState: false,
  }, signal);
  assert.strictEqual(r.trades.length, 1);
  assert.strictEqual(r.trades[0].reason, "止损");
  assert.strictEqual(r.trades[0].exit_price, 5); // 开盘 5 低于止损位 7，按开盘价
});

t("波动状态缩放系数截断正确", () => {
  const s = bt.volStateScale([2, 2, 2, 2, 4, 1], 3, 0.5, 2);
  assert.strictEqual(s[0], null); // 无历史基准
  assert.strictEqual(s[1], 1);
  assert.strictEqual(s[3], 1);
  assert.strictEqual(s[4], 2);   // 4/2=2，触及上限
  assert.strictEqual(s[5], 0.5); // 1/(8/3)=0.375，截断到下限
});

t("高波动状态下 ATR 止损更宽", () => {
  const rows = [];
  for (let i = 0; i < 80; i++) rows.push(calmBar());
  for (let i = 0; i < 9; i++) rows.push({ date: "w" + i, open: 10, high: 14, low: 6, close: 10, volume: 1 });
  rows.push(calmBar()); // bar 89：入场
  rows.push(calmBar()); // bar 90：信号平仓
  const signal = new Array(rows.length).fill(0);
  signal[88] = 1;
  const atrArr = ind.atr(rows, 3);
  const base = { cash: 10000, feeRate: 0, slippageBp: 0, strategy: {}, stopMode: "atr", atrN: 3, atrStopMult: 2, volLookback: 60 };
  const on = bt.backtest({ rows }, { ...base, volState: true }, signal);
  const off = bt.backtest({ rows }, { ...base, volState: false }, signal);
  assert.strictEqual(on.trades.length, 1);
  assert.strictEqual(off.trades.length, 1);
  const tOn = on.trades[0];
  const tOff = off.trades[0];
  assert.strictEqual(tOn.vol_scale, 2); // 高波动，缩放触及上限
  // bar90 止损位 = 持仓内最高 11 - 2*scale*atr[89]
  assert(Math.abs(tOff.stop_price - (11 - 2 * atrArr[89])) < 1e-9);
  assert(Math.abs(tOn.stop_price - (11 - 4 * atrArr[89])) < 1e-9);
  assert(tOn.stop_price < tOff.stop_price);
});

t("旧参数缺省 stopMode 复现原结果", () => {
  const m = market.generateMarket({ seed: 21, days: 600 });
  const oldOpts = {
    cash: 100000, feeRate: 0.0005, slippageBp: 5, stopLoss: 0.05, takeProfit: 0.2,
    strategy: { type: "boll", bbN: 20, bbK: 2 },
  };
  const a = bt.backtest(m, oldOpts);
  // 显式 fixed + 混入 ATR 参数，结果必须逐位一致
  const b = bt.backtest(m, { ...oldOpts, stopMode: "fixed", atrN: 10, atrStopMult: 3, atrTakeMult: 4, volState: true });
  assert.deepStrictEqual(a.equity, b.equity);
  assert.deepStrictEqual(a.trades, b.trades);
  assert.strictEqual(a.final_equity, b.final_equity);
});

t("ATR 模式在模拟行情上运行且明细含波动字段", () => {
  const m = market.generateMarket({ seed: 21, days: 600 });
  const r = bt.backtest(m, {
    cash: 100000, feeRate: 0.0005, slippageBp: 5,
    stopMode: "atr", atrN: 14, atrStopMult: 2, atrTakeMult: 3, volState: true,
    strategy: { type: "ma_cross", fast: 10, slow: 30 },
  });
  assert.strictEqual(r.equity.length, 600);
  assert(Number.isFinite(r.final_equity));
  assert(r.trades.length > 0);
  for (const tr of r.trades) {
    assert.strictEqual(tr.stop_mode, "atr");
    assert(tr.atr == null || tr.atr > 0);
    assert(tr.vol_scale == null || (tr.vol_scale >= 0.5 && tr.vol_scale <= 2));
  }
  const s = metrics.summarize(r.equity, {});
  assert(Number.isFinite(s.sharpe));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
