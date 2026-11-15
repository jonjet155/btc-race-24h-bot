// Capitulation Sniper — dip-buy mean reversion for cbBTC, long only.
//
// Dev window (2026-11-14 08:29Z -> 2026-11-15 08:28Z): $67,156 -> $64,524
// (-3.9%), two slow down-legs and ONE sharp capitulation (hour 16: -2.0% to
// $62,006) then a V-recovery (hours 17-18: +2.8%, +1.1% to $65,089). Every
// kit baseline loses on it (buy-and-hold -$44, momentum -$41, rsi-bollinger
// -$57, adx-momentum -$87, ema-cross -$135) because they either hold through
// the fall or get chopped by 1-minute trend signals. Generic dip-buying loses
// too: the same window punishes every RSI/Bollinger dip entry (-$31 to -$57)
// — the only trade that pays is the washout bottom, and only if you hold it
// through the whole V instead of dumping on the first RSI spike.
//
// So this bot sits in cash through slow grinds and buys ONLY a deep washout:
// the close is within 0.4% of its 120-bar low, RSI(14) is below 40, the tape
// ticks back up, and the price is at least 6% below the running high. It
// takes a 4.5% profit, a 1.5% stop, or a 300-bar time stop. A stop that hits
// during the flush is not a failure: the bot re-enters lower on the next
// signal (on dev: stopped at $62,002, re-entered $62,336, sold $65,342).
//
// Live-window insurance: if no trade has happened by bar 1000 (16.7h in),
// the washout threshold drops to 4% so the entry still gets its one trade
// (race guardrail) instead of sitting out a range day. And an equity
// circuit breaker stops new entries after a 5% drawdown from peak equity,
// so a live crash cannot chain stops into a blow-up. No shorts, no leverage,
// at most one position, deterministic (pure functions of the closes seen;
// no clock, no randomness, no network).
//
// Dev grade (official grade-local, --driver process): net PnL +$27.80,
// 4 trades, max drawdown -2.31% (vs buy-and-hold -$44.01, rsi-bollinger
// -$57.37 on the same window).

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// ---- tunables (chosen on the dev window; see the header for why) ----
const RSI_LEN = 14;
const RSI_BUY = 40; // oversold enough to be a washout, not just a dip
const LOW_BARS = 120; // near the 2-hour low
const NEAR_LOW_PCT = 0.004; // within 0.4% of that low
const DD_MIN = 0.06; // at least 6% below the running high: a real washout
const LATE_BAR = 1000; // after this, if no trade yet, relax the washout bar
const LATE_DD_MIN = 0.04; // late threshold: 4% below the running high
const TP_NUM = 1045; // take profit: value >= 104.5% of cost
const TP_DEN = 1000;
const SL_NUM = 985; // stop loss: value <= 98.5% of cost
const SL_DEN = 1000;
const TIME_STOP = 300; // bars
const MAX_DD_BPS = 500; // equity circuit breaker: stop entering after -5% from peak
const MAX_SLIPPAGE_BPS = 100;

const SYMBOL = 'CBBTC';

interface Series {
  closes: number[];
  last: number | null;
  first: number[];
  gain: number | null;
  loss: number | null;
}

const s: Series = { closes: [], last: null, first: [], gain: null, loss: null };
let runningHigh = 0;
let entrySeq = -1; // fill bar of the open position, -1 when flat
let trades = 0; // buy fills so far (drives the late rule)
let peakEquity = 0n; // circuit breaker

function push(bar: Bar): void {
  const c = Number(bar.c);
  s.closes.push(c);
  if (s.closes.length > 200) s.closes.shift();
  if (c > runningHigh) runningHigh = c;
  if (s.last !== null) {
    const change = c - s.last;
    const up = change > 0 ? change : 0;
    const down = change < 0 ? -change : 0;
    if (s.gain === null || s.loss === null) {
      s.first.push(change);
      if (s.first.length === RSI_LEN) {
        s.gain = s.first.reduce((a, x) => a + (x > 0 ? x : 0), 0) / RSI_LEN;
        s.loss = s.first.reduce((a, x) => a + (x < 0 ? -x : 0), 0) / RSI_LEN;
      }
    } else {
      s.gain = (s.gain * (RSI_LEN - 1) + up) / RSI_LEN;
      s.loss = (s.loss * (RSI_LEN - 1) + down) / RSI_LEN;
    }
  }
  s.last = c;
}

function rsi(): number | null {
  if (s.gain === null || s.loss === null) return null;
  const moved = s.gain + s.loss;
  return moved === 0 ? 50 : (100 * s.gain) / moved;
}

await runBars({
  onBatch(state: BarsState, batch) {
    for (const bar of batch.bars) push(bar);
    const fresh = batch.bars.some((b) => b.symbol === SYMBOL);
    if (!fresh || state.warmingUp) return [];
    if (state.equity > peakEquity) peakEquity = state.equity;
    const held = state.positions.get(SYMBOL);
    const close = s.last; // latest close as a number (state.close() is a bigint)
    if (close === null) return [];

    // --- exits: whole position ---
    if (held !== undefined) {
      if (entrySeq < 0) {
        entrySeq = state.seq; // position first seen = fill bar
        trades++; // count fills, not sent orders: a refused buy is not a trade
      }
      const value = state.value(SYMBOL, held.qty);
      const tp = value * BigInt(TP_DEN) >= held.cost * BigInt(TP_NUM);
      const sl = value * BigInt(SL_DEN) <= held.cost * BigInt(SL_NUM);
      const timedOut = state.seq - entrySeq > TIME_STOP;
      if (tp || sl || timedOut) {
        entrySeq = -1;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }
    entrySeq = -1;

    // --- entries: flat only ---
    const r = rsi();
    if (r === null || r >= RSI_BUY) return [];
    const prev = s.closes.length >= 2 ? s.closes[s.closes.length - 2] : null;
    if (prev === null || close <= prev) return []; // need the tick-up
    const window = s.closes.slice(0, -1).slice(-LOW_BARS); // previous 120 closes
    if (window.length < 10) return [];
    let lo = window[0];
    for (const x of window) if (x < lo) lo = x;
    if (close > lo * (1 + NEAR_LOW_PCT)) return []; // not at the low
    const dd = (runningHigh - close) / runningHigh;
    const late = trades === 0 && state.seq > LATE_BAR;
    if (dd <= (late ? LATE_DD_MIN : DD_MIN)) return []; // not a deep enough washout
    if (state.equity * BigInt(BPS) < peakEquity * BigInt(BPS - MAX_DD_BPS)) return []; // circuit breaker
    const byWeight = state.weight_room(SYMBOL);
    let slice = state.cash; // full size: one position, all of it
    if (slice > byWeight) slice = byWeight;
    if (slice <= 0n || slice < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
  },
});
