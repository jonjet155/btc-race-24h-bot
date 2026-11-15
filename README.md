# Capitulation Sniper — cbBTC 24h race bot

Long-only dip-buying bot for the make.fun "Race a BTC trading bot live for
24 hours" competition (`btc-race-24h-20261115-0828`). One asset (cbBTC/USDC),
$1,000 paper start, 1-minute bars. Node 22, stdlib only, deterministic.

## The idea

The dev window (2026-11-14 08:29Z → 2026-11-15 08:28Z) falls −3.9% with two
slow down-legs and **one** sharp capitulation (hour 16: −2.0% to $62,006) then
a V-recovery (+2.8%, +1.1% to $65,089). Every kit baseline loses on it, and
generic dip-buying loses too — the only trade that pays is the washout
bottom, held through the whole V. So the bot sits in cash through slow
grinds and buys **only** a deep washout:

- close within 0.4% of its 120-bar low, RSI(14) < 40, close ticks up from
  the previous close, and price ≥ 6% below the running high.

Exits (whole position): take profit +4.5%, stop loss −1.5%, or a 300-bar
time stop. A stop that hits mid-flush is not a failure — the bot re-enters
lower on the next signal (on dev: stopped at $62,002, re-entered $62,336,
sold $65,342).

Two safety rails for the live race:

- **Late rule:** if no trade has happened by bar 1000 (16.7h in), the
  washout threshold drops to 4%, so the entry still gets its one trade
  (race guardrail) instead of sitting out a range day.
- **Circuit breaker:** no new entries after a 5% equity drawdown from peak,
  so a live crash cannot chain stops into a blow-up.

## Dev-window results (official `grade-local --driver process`)

| bot | net PnL | trades | win rate | max DD |
| --- | --- | --- | --- | --- |
| **Capitulation Sniper (this repo)** | **+$27.80** | 4 | 50% | **−2.31%** |
| buy-and-hold (kit baseline) | −$44.01 | 1 | 0% | −7.92% |
| momentum (kit baseline) | −$40.92 | 1 | 0% | −7.92% |
| rsi-bollinger (kit baseline) | −$57.37 | 12 | 16.7% | −6.77% |
| adx-momentum (kit baseline) | −$86.60 | 35 | — | −8.8% |
| ema-cross (kit baseline) | −$134.95 | 63 | 3.1% | −13.7% |
| hold-cash (kit baseline) | $0.00 | 0 | — | 0% |

Fees $1.60; at 2× fees net PnL is still +$26.16. Guardrails met. L1
regrade reproduces byte for byte (deterministic). The dev gate needs net
PnL > $0 — this clears it with margin.

## Live-race risks (honest)

- The bot only trades deep washouts. If the live 24h ranges without a ≥6%
  drawdown from the running high, it may trade once (late rule) or not at
  all — then it ranks below every entry that meets the ≥1-trade bar.
- If the flush keeps falling after entry, stops can chain: each costs
  ~1.5–1.8% + fees; the circuit breaker stops new entries at −5% equity.
- The 6% threshold was chosen on one 24h window; a different live regime
  may make it too strict or too loose. The late rule and the circuit
  breaker are the hedges, not a guarantee.
- A second opinion (Gemini) suggested fractional sizing + a trend filter;
  both were rejected on the evidence: fractional sizing cuts the dev PnL
  below the margin target, and a trend filter would have blocked the only
  two profitable entries on dev.

## Reproduce the grade

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```
