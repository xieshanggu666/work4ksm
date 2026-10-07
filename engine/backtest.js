"use strict";
const ind = require("./indicators");

function buildSignal(rows, strategy) {
  const close = rows.map(r => r.close);
  const n = rows.length;
  const signal = new Array(n).fill(0);
  const st = strategy || {};
  if (st.type === "ma_cross") {
    const fast = ind.sma(close, st.fast || 10);
    const slow = ind.sma(close, st.slow || 30);
    for (let i = 1; i < n; i++) {
      if (fast[i] == null || slow[i] == null) continue;
      const prevF = fast[i - 1], prevS = slow[i - 1];
      if (prevF <= prevS && fast[i] > slow[i]) signal[i] = 1;
      else if (prevF >= prevS && fast[i] < slow[i]) signal[i] = 0;
      else signal[i] = signal[i - 1];
    }
  } else if (st.type === "rsi") {
    const r = ind.rsi(close, st.rsiN || 14);
    const buy = st.rsiBuy == null ? 30 : st.rsiBuy;
    const sell = st.rsiSell == null ? 70 : st.rsiSell;
    for (let i = 1; i < n; i++) {
      if (r[i] == null) continue;
      if (r[i] < buy) signal[i] = 1;
      else if (r[i] > sell) signal[i] = 0;
      else signal[i] = signal[i - 1];
    }
  } else if (st.type === "boll") {
    const b = ind.bollinger(close, st.bbN || 20, st.bbK == null ? 2 : st.bbK);
    for (let i = 1; i < n; i++) {
      if (b.lower[i] == null) continue;
      if (close[i] < b.lower[i]) signal[i] = 1;
      else if (close[i] > b.upper[i]) signal[i] = 0;
      else signal[i] = signal[i - 1];
    }
  } else if (st.type === "buy_hold") {
    for (let i = 0; i < n; i++) signal[i] = 1;
  }
  return signal;
}

function backtest(market, opts, signalOverride) {
  const rows = market.rows;
  const n = rows.length;
  const opts2 = opts || {};
  const cash0 = opts2.cash || 100000;
  const feeRate = opts2.feeRate == null ? 0.0005 : opts2.feeRate;
  const slippage = (opts2.slippageBp == null ? 5 : opts2.slippageBp) / 10000;
  const stopLoss = opts2.stopLoss == null ? 0 : opts2.stopLoss;
  const takeProfit = opts2.takeProfit == null ? 0 : opts2.takeProfit;
  const positionRatio = opts2.positionRatio == null ? 1 : Math.max(0, Math.min(1, opts2.positionRatio));
  const signal = signalOverride || buildSignal(rows, opts2.strategy);

  let cash = cash0;
  let shares = 0;
  let inPos = false;
  let entryPrice = 0;
  let entryIdx = 0;
  let stopOutBar = -1;
  const equity = new Array(n).fill(null);
  const trades = [];

  for (let i = 0; i < n; i++) {
    const bar = rows[i];
    if (inPos) {
      const sl = entryPrice * (1 - stopLoss);
      const tp = entryPrice * (1 + takeProfit);
      let exitPrice = null;
      let reason = null;
      if (stopLoss > 0 && bar.low <= sl) {
        exitPrice = bar.open < sl ? bar.open : sl;
        reason = "止损";
      } else if (takeProfit > 0 && bar.high >= tp) {
        exitPrice = bar.open > tp ? bar.open : tp;
        reason = "止盈";
      }
      if (exitPrice != null) {
        const px = exitPrice * (1 - slippage);
        cash = shares * px - shares * px * feeRate;
        trades.push({
          entry_idx: entryIdx,
          exit_idx: i,
          entry_date: rows[entryIdx].date,
          exit_date: bar.date,
          entry_price: entryPrice,
          exit_price: exitPrice,
          reason,
          shares,
          pnl: shares * exitPrice * (1 - slippage) - shares * entryPrice * (1 + slippage) - shares * exitPrice * feeRate - shares * entryPrice * feeRate,
          hold_bars: i - entryIdx,
        });
        shares = 0;
        inPos = false;
        stopOutBar = i;
      }
    }
    const target = i > 0 ? signal[i - 1] : 0;
    const desired = target >= 0.5 ? positionRatio : 0;
    if (desired > 0 && !inPos && i > stopOutBar) {
      const px = bar.open * (1 + slippage);
      const amount = cash * desired;
      const sh = Math.floor(amount / px);
      if (sh > 0) {
        cash -= sh * px + sh * px * feeRate;
        shares = sh;
        inPos = true;
        entryPrice = bar.open;
        entryIdx = i;
      }
    } else if (desired === 0 && inPos) {
      const px = bar.open * (1 - slippage);
      cash = shares * px - shares * px * feeRate;
      trades.push({
        entry_idx: entryIdx,
        exit_idx: i,
        entry_date: rows[entryIdx].date,
        exit_date: bar.date,
        entry_price: entryPrice,
        exit_price: bar.open,
        reason: "信号平仓",
        shares,
        pnl: shares * bar.open * (1 - slippage) - shares * entryPrice * (1 + slippage) - shares * bar.open * feeRate - shares * entryPrice * feeRate,
        hold_bars: i - entryIdx,
      });
      shares = 0;
      inPos = false;
    }
    equity[i] = cash + shares * bar.close;
  }

  const drawdown = computeDrawdown(equity);
  return {
    equity,
    drawdown,
    trades,
    final_equity: equity[n - 1],
    total_return: equity[n - 1] / cash0 - 1,
    bars: n,
  };
}

function computeDrawdown(equity) {
  const out = new Array(equity.length).fill(0);
  let peak = equity[0];
  for (let i = 1; i < equity.length; i++) {
    if (equity[i] > peak) peak = equity[i];
    out[i] = peak > 0 ? equity[i] / peak - 1 : 0;
  }
  return out;
}

module.exports = { backtest, buildSignal, computeDrawdown };
