const { createApp } = Vue;

function smaArr(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

const app = createApp({
  data() {
    return {
      busy: false,
      market: { seed: 42, days: 400, start: 100, drift: 0.0004, vol: 0.012 },
      strategy: { type: "ma_cross", fast: 10, slow: 30, rsiN: 14, rsiBuy: 30, rsiSell: 70, bbN: 20, bbK: 2 },
      trade: { cash: 100000, feeRate: 0.0005, slippageBp: 5, stopLoss: 0.05, takeProfit: 0.15, positionRatio: 1 },
      stats: null,
      trades: [],
      equity: null,
      drawdown: null,
      rows: null,
      dates: null,
      mc: null,
    };
  },
  methods: {
    async runAll() {
      this.busy = true;
      this.mc = null;
      try {
        const r = await API.backtest({ ...this.market }, { strategy: { ...this.strategy }, ...this.trade });
        this.stats = r.stats;
        this.trades = r.trades || [];
        this.equity = r.equity;
        this.drawdown = r.drawdown;
        this.rows = r.rows;
        this.dates = r.dates;
        this.$nextTick(() => {
          const close = this.rows.map(x => x.close);
          const overlays = [];
          if (this.strategy.type === "ma_cross") {
            overlays.push({ color: "#ffd166", data: smaArr(close, this.strategy.fast) });
            overlays.push({ color: "#7a5cff", data: smaArr(close, this.strategy.slow) });
          }
          Charts.kline(this.$refs.kchart, this.rows, overlays);
          Charts.series(this.$refs.echart, this.equity, { color: "#4f8cff" });
          Charts.series(this.$refs.dchart || { getContext: () => null }, [], {});
        });
        this.$nextTick(() => {
          if (this.$refs.dchart) Charts.series(this.$refs.dchart, this.drawdown, { color: "#e2533e", baseline: 0 });
        });
      } catch (e) {
        alert("执行失败：" + e.message);
      } finally {
        this.busy = false;
      }
    },
    async runMonteCarlo() {
      if (!this.equity) return;
      this.busy = true;
      try {
        this.mc = await API.montecarlo(this.equity.map(d => d[1]), 300, 252, this.market.seed + 1);
        this.$nextTick(() => {
          if (this.$refs.mchart) Charts.band(this.$refs.mchart, this.mc.quantiles, {});
        });
      } catch (e) {
        alert("模拟失败：" + e.message);
      } finally {
        this.busy = false;
      }
    },
  },
  mounted() {
    this.runAll();
  },
});

app.mount("#app");
