// Washout Ladder — dip-buy mean reversion for cbBTC, long only.
//
// Idea: the dev window (2026-11-14 08:29Z -> 2026-11-15 08:28Z) falls -3.9% with
// two slow down-legs and one sharp capitulation (hour 16: -2.0% to $62,006) then a
// V-recovery (hours 17-18: +2.8%, +1.1%). Every kit baseline loses on it
// (buy-and-hold -$44, rsi-bollinger -$57, ema-cross -$135) because they either
// hold through the fall or get chopped up by 1-minute trend signals. This bot
// does the opposite: it sits in cash through slow grinds and buys ONLY a sharp
// washout once the tape ticks back up, in two legs, then takes a quick profit
// or a tight stop. No shorts, no leverage, at most one position, deterministic
// (pure functions of the closes it has seen; no clock, no randomness).
//
// Entry (flat only), all on a bar's close, filled at the next open:
//   - RSI(14) below RSI_BUY and the close below the lower Bollinger band
//     (20 typical prices, 2 sigma): the market is oversold and dislocated.
//   - The close is at least DISLOC_PCT below its 20-bar SMA.
//   - The last WASHOUT_BARS bars fell at least WASHOUT_PCT: a sharp washout,
//     not a slow grind (slow grinds keep falling after you buy).
//   - The close ticks UP from the previous close: someone is buying the dip.
// Leg 2: if the price falls LEG2_DROP below the leg-1 decision close while the
// entry conditions still hold, add the rest of the cash (up to 100% of equity).
// Exit (whole position): value >= TP x cost, or value <= SL x cost, or
// RSI above RSI_SELL, or held longer than TIME_STOP bars.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// ---- tunables (swept on the dev window; these are the chosen values) ----
const RSI_LEN = 14;
const BAND_LEN = 20;
const BAND_SIG = 2;
const RSI_BUY = 32; // TUNE
const RSI_SELL = 68; // TUNE
const DISLOC_PCT = 0.008; // TUNE close >= 0.8% below SMA20
const WASHOUT_BARS = 30;
const WASHOUT_PCT = 0.012; // TUNE 30-bar drop >= 1.2%
const SIZE1_BPS = 5000; // TUNE leg 1: 50% of equity
const LEG2_DROP = 0.01; // TUNE add leg 2 after a further 1% fall
const TP_NUM = 1025; // TUNE take profit: value >= 102.5% of cost
const TP_DEN = 1000;
const SL_NUM = 985; // TUNE stop loss: value <= 98.5% of cost
const SL_DEN = 1000;
const TIME_STOP = 240; // TUNE bars
const MAX_SLIPPAGE_BPS = 100;

const SYMBOL = 'CBBTC';

interface Series {
  closes: number[];
  typical: number[];
  last: number | null;
  first: number[];
  gain: number | null;
  loss: number | null;
}

const s: Series = { closes: [], typical: [], last: null, first: [], gain: null, loss: null };
let legs = 0;
let leg1Close = 0;
let entrySeq = 0;

function push(bar: Bar): void {
  const c = Number(bar.c);
  s.closes.push(c);
  if (s.closes.length > 200) s.closes.shift();
  s.typical.push((Number(bar.h) + Number(bar.l) + c) / 3);
  if (s.typical.length > BAND_LEN) s.typical.shift();
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

function sma(n: number): number | null {
  if (s.closes.length < n) return null;
  let sum = 0;
  for (let i = s.closes.length - n; i < s.closes.length; i++) sum += s.closes[i];
  return sum / n;
}

function lowerBand(): number | null {
  if (s.typical.length < BAND_LEN) return null;
  const mean = s.typical.reduce((a, x) => a + x, 0) / BAND_LEN;
  let variance = 0;
  for (const x of s.typical) variance += (x - mean) * (x - mean);
  variance /= BAND_LEN;
  return mean - BAND_SIG * Math.sqrt(variance);
}

await runBars({
  onBatch(state: BarsState, batch) {
    for (const bar of batch.bars) push(bar);
    const fresh = batch.bars.some((b) => b.symbol === SYMBOL);
    if (!fresh || state.warming_up) return [];
    const { caps, fees } = state.hello;
    const held = state.positions.get(SYMBOL);
    const close = s.last; // latest close as a number (state.close() is a bigint)
    if (close === null) return [];
    const r = rsi();
    const lower = lowerBand();
    const sma20 = sma(20);
    const prev = s.closes.length >= 2 ? s.closes[s.closes.length - 2] : null;
    const old = s.closes.length > WASHOUT_BARS ? s.closes[s.closes.length - 1 - WASHOUT_BARS] : null;

    // --- exits: whole position ---
    if (held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      const tp = value * BigInt(TP_DEN) >= held.cost * BigInt(TP_NUM);
      const sl = value * BigInt(SL_DEN) <= held.cost * BigInt(SL_NUM);
      const rsiOut = r !== null && r > RSI_SELL;
      const timedOut = state.seq - entrySeq > TIME_STOP;
      if (tp || sl || rsiOut || timedOut) {
        legs = 0;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      // --- leg 2: add on a deeper washout while the entry still holds ---
      if (
        legs === 1 &&
        r !== null && r < RSI_BUY &&
        lower !== null && close < lower &&
        prev !== null && close > prev &&
        close <= leg1Close * (1 - LEG2_DROP)
      ) {
        const room = state.weight_room(SYMBOL);
        let slice = state.cash;
        if (slice > room) slice = room;
        if (slice > 0n && slice >= BigInt(fees.min_notional_quote_units)) {
          legs = 2;
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
        }
      }
      return [];
    }

    // --- entries: flat only ---
    legs = 0;
    const dislocated = sma20 !== null && (sma20 - close) / sma20 > DISLOC_PCT;
    const washout = old !== null && (old - close) / old > WASHOUT_PCT;
    const tickUp = prev !== null && close > prev;
    if (r !== null && r < RSI_BUY && lower !== null && close < lower && dislocated && washout && tickUp) {
      const byWeight = state.weight_room(SYMBOL);
      let slice = (state.equity * BigInt(SIZE1_BPS)) / BPS;
      if (slice > byWeight) slice = byWeight;
      if (slice > state.cash) slice = state.cash;
      if (slice <= 0n || slice < BigInt(fees.min_notional_quote_units)) return [];
      legs = 1;
      leg1Close = close;
      entrySeq = state.seq;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
    }
    return [];
  },
});
