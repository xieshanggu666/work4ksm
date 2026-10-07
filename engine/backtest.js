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

// 止损止盈参数归一化。stopMode 缺省为 "fixed"，旧参数 stopLoss/takeProfit 语义不变；
// "atr" 模式下止损/止盈距离按 ATR 倍数给出，并可按波动状态（当前 ATR 相对其基准均值）缩放。
function normalizeStopOpts(o) {
  return {
    mode: o.stopMode === "atr" ? "atr" : "fixed",
    stopLoss: o.stopLoss == null ? 0 : o.stopLoss,
    takeProfit: o.takeProfit == null ? 0 : o.takeProfit,
    atrN: o.atrN || 14,
    atrStopMult: o.atrStopMult == null ? 2 : o.atrStopMult,
    atrTakeMult: o.atrTakeMult == null ? 0 : o.atrTakeMult,
    volState: o.volState == null ? true : !!o.volState,
    volLookback: o.volLookback || 60,
    volLo: o.volLo == null ? 0.5 : o.volLo,
    volHi: o.volHi == null ? 2 : o.volHi,
  };
}

// 波动状态缩放系数：scale[i] = clamp(atr[i] / mean(前 lookback 个 ATR), lo, hi)。
// 仅用第 i 根之前的数据，无未来函数；历史不足时为 null（调用方按 1 处理）。
function volStateScale(atrArr, lookback, lo, hi) {
  const n = atrArr.length;
  const out = new Array(n).fill(null);
  const win = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = atrArr[i];
    if (a != null && win.length > 0) {
      const base = sum / win.length;
      if (base > 0) out[i] = Math.min(hi, Math.max(lo, a / base));
    }
    if (a != null) {
      win.push(a);
      sum += a;
      if (win.length > lookback) sum -= win.shift();
    }
  }
  return out;
}

function backtest(market, opts, signalOverride) {
  const rows = market.rows;
  const n = rows.length;
  const opts2 = opts || {};
  const cash0 = opts2.cash || 100000;
  const feeRate = opts2.feeRate == null ? 0.0005 : opts2.feeRate;
  const slippage = (opts2.slippageBp == null ? 5 : opts2.slippageBp) / 10000;
  const positionRatio = opts2.positionRatio == null ? 1 : Math.max(0, Math.min(1, opts2.positionRatio));
  const signal = signalOverride || buildSignal(rows, opts2.strategy);
  const S = normalizeStopOpts(opts2);
  const atrArr = S.mode === "atr" ? ind.atr(rows, S.atrN) : null;
  const scaleArr = S.mode === "atr" && S.volState ? volStateScale(atrArr, S.volLookback, S.volLo, S.volHi) : null;

  let cash = cash0;
  let shares = 0;
  let inPos = false;
  let entryPrice = 0;
  let entryIdx = 0;
  let stopOutBar = -1;
  let posMaxHigh = 0;   // 持仓期间（含入场 bar）的最高价，用于 ATR 跟踪止损
  let stopLevel = null; // ATR 模式下的当前止损位（只上不下）
  let takeLevel = null; // ATR 模式下的当前止盈位（随波动状态浮动）
  const equity = new Array(n).fill(null);
  const trades = [];

  for (let i = 0; i < n; i++) {
    const bar = rows[i];
    // ATR 模式下本 bar 使用的 ATR 与波动状态缩放（取自第 i-1 根，决策时点已知）
    let curAtr = null;
    let curScale = null;
    if (S.mode === "atr" && i > 0) {
      curAtr = atrArr[i - 1];
      curScale = scaleArr ? (scaleArr[i - 1] == null ? 1 : scaleArr[i - 1]) : 1;
    }
    if (inPos) {
      // 两种模式共用同一套撮合语义：盘中触及即触发，跳空越过触发价按开盘价成交。
      // 触发价只使用第 i-1 根及之前的数据（ATR、波动状态、持仓内最高价），无未来函数。
      let sl = null;
      let tp = null;
      if (S.mode === "fixed") {
        if (S.stopLoss > 0) sl = entryPrice * (1 - S.stopLoss);
        if (S.takeProfit > 0) tp = entryPrice * (1 + S.takeProfit);
      } else {
        if (curAtr != null) {
          if (S.atrStopMult > 0) {
            const trail = posMaxHigh - S.atrStopMult * curScale * curAtr;
            stopLevel = stopLevel == null ? trail : Math.max(stopLevel, trail);
          }
          if (S.atrTakeMult > 0) takeLevel = entryPrice + S.atrTakeMult * curScale * curAtr;
        }
        sl = stopLevel;
        tp = takeLevel;
      }
      let exitPrice = null;
      let reason = null;
      if (sl != null && bar.low <= sl) {
        exitPrice = bar.open < sl ? bar.open : sl;
        reason = "止损";
      } else if (tp != null && bar.high >= tp) {
        exitPrice = bar.open > tp ? bar.open : tp;
        reason = "止盈";
      }
      if (exitPrice != null) {
        const px = exitPrice * (1 - slippage);
        cash = shares * px - shares * px * feeRate;
        const trade = {
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
          stop_mode: S.mode,
          stop_price: sl,
          take_price: tp,
        };
        if (S.mode === "atr") {
          trade.atr = curAtr;
          trade.vol_scale = curScale;
        }
        trades.push(trade);
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
        posMaxHigh = bar.open;
        stopLevel = null;
        takeLevel = null;
        if (S.mode === "atr" && curAtr != null) {
          if (S.atrStopMult > 0) stopLevel = entryPrice - S.atrStopMult * curScale * curAtr;
          if (S.atrTakeMult > 0) takeLevel = entryPrice + S.atrTakeMult * curScale * curAtr;
        }
      }
    } else if (desired === 0 && inPos) {
      const px = bar.open * (1 - slippage);
      cash = shares * px - shares * px * feeRate;
      const sigTrade = {
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
        stop_mode: S.mode,
        stop_price: S.mode === "fixed" ? (S.stopLoss > 0 ? entryPrice * (1 - S.stopLoss) : null) : stopLevel,
        take_price: S.mode === "fixed" ? (S.takeProfit > 0 ? entryPrice * (1 + S.takeProfit) : null) : takeLevel,
      };
      if (S.mode === "atr") {
        sigTrade.atr = curAtr;
        sigTrade.vol_scale = curScale;
      }
      trades.push(sigTrade);
      shares = 0;
      inPos = false;
    }
    if (inPos && bar.high > posMaxHigh) posMaxHigh = bar.high;
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

module.exports = { backtest, buildSignal, computeDrawdown, normalizeStopOpts, volStateScale };
