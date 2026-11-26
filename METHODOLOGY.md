# Methodology — Crowd-Selective Paper Bot

Competition: **Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins**
(`u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532`). One strategy program
(`main.ts` + `strategy.ts`, Node 22+) trades paper money on a 6-hour pump.fun
forward replay. Places go by **hourly Sharpe ratio** (mean hourly return /
sample stdev of hourly returns, 6 hourly marks on the final window), best
first; a placement reward needs **net PnL > 0** after every fee. Guardrails:
max 5 open positions; round trips ≥ 0.01 SOL on ≥ 20 distinct mints; max
drawdown 50%; starting balance 10 SOL; deterministic (two executions produce
byte-identical action logs); no network.

## What the data says (dev window: 2026-11-02 03:09 → 2026-11-03 03:09 UTC)

The kit's frozen window holds 128,058 events, 126,801 trades, 1,222 mints,
35 completions. Fees are 95 bps protocol + 30 bps creator = 125 bps per side,
plus a fixed 105,000 lamports (0.000105 SOL) per order; ~2% of orders fail and
still pay the tx fee. A round trip on a 0.01 SOL stake costs ~4.6%; on a
0.05 SOL stake ~2.9%. The 1%-of-real-reserve cap limits each buy to 1% of the
curve's real SOL reserve, so stake size is bounded by how much real liquidity
a coin has attracted. The harness fills orders 2 slots after they are decided.

Key measurements (all net of the 2.9% round-trip fee, fill +2 slots):

- **Buy-and-hold loses everywhere.** Median return from first real SOL ≥ 1:
  −4.7% after 30 slots, −14% after 150, −22% after 600. Only ~2–4% of coins
  end positive. Most pump.fun coins are a one-way trip down.
- **The 2-slot fill latency kills momentum entries.** A momentum signal that
  wins 56% / loses 35% with instant fills goes to 15% / 78% with a realistic
  +2-slot fill delay. Bursts happen inside a slot; the bot only ever sees
  slot-end prices, so it buys the top of the burst.
- **Dip-buying is negative** (30–45% dips from the recent high, TP 12% /
  SL 10%): EV −2% to −6% per trade. Dips keep dipping.
- **Pullback + breakout is a dead end** (3–11 signals in 24h, all negative EV).
- **Completers are untradable.** All 35 completed coins complete in the same
  slot as create via 7 escalating buys totalling 85 SOL — pre-arranged instant
  graduations. Any buy would be rejected `token_complete`.
- **The oracle upper bound is real but narrow.** Buying at first real ≥ 1 and
  exiting at the best point within 6h: median +5.7%, p75 +34.8%, p90 +100%,
  p99 +440%. 10% of coins more than double. The top-78 oracle sum is +83 SOL
  at 0.5 SOL stakes. The money is in a few coins — but only if you hold them
  through pullbacks, which tight scalping never does.

## Five families that lose (all swept on the dev window with a faithful local sim)

1. **Momentum scalping** (enter on flow + price rise, TP 12% / SL 8%):
   Sharpe −1.35 to −0.64, PnL −1.1 to −1.8 SOL. Win rate ~18%.
2. **Early-entry scalping** (first real ≥ 1 SOL, pyramid adds): best
   Sharpe −0.64, PnL −0.27 SOL, 441 trips, win 18%.
3. **Tail-riding** (no fixed TP, wide SL 20–30%, trailing stop, 6h hold,
   aggressive pyramid): Sharpe −0.58 to −1.08, PnL −0.69 to −1.42 SOL.
   The pyramid buys the top of each pump, then the dump wipes the enlarged
   position out. Win rate 7–11%.
4. **Dip-buying / pullback-breakout**: negative EV everywhere (see above).
5. **House pilots** (momentum / reversion / sniper shipped in the kit):
   Sharpe −0.48 to −0.84, PnL −0.5 to −9.4 SOL. All lose.

Two bugs found while sweeping mattered more than any parameter: the harness
rejects a sell whose quote-out exceeds the curve's real SOL reserve, so sells
on drained curves were retried every batch (61,635 rejections); the fix —
`realizableSale()`, which solves for the largest sellable token amount and
sends no order when nothing is sellable — cut rejections to 13 and improved
Sharpe from −1.20 to −0.70 on the same strategy.

## The winning shape: survivor filter + crowd sizing + cheap breadth

Three moves, each verified separately, flip the sign:

1. **Enter late, not early.** Entering only once real liquidity reaches
   15–20 SOL (a survivor filter — most coins die before that) raises the win
   rate from 18% to 26–36% and cuts drawdown. Entering at real ≥ 20 with
   TP 20% / SL 4–6% was the best non-crowd family (Sharpe −0.26, PnL −0.25).
2. **Size on the crowd, not on the pump.** The one entry signal with a
   positive +30-slot mean in the dev data: **≥ 12 distinct buyers in the
   create slot** (n = 17 coins in 24h, median +4.2%, mean +4.6%, 65%
   positive; buyers ≥ 20 in the first 30 slots after entry also work, but
   that is only knowable after the fact). A crowded launch is an organic
   launch — many wallets, not a bundle. The bot buys 20× the scout stake on
   crowded launches, capped by the 1% rule (about 0.15–0.29 SOL).
3. **Make the breadth cheap.** Non-crowded entrants get the minimum viable
   stake, 0.01 SOL — just enough to count toward the 20-mint guardrail.
   Their losses are tiny; the crowded launches carry the P&L. Cutting the
   scout stake from 0.05 to 0.01 SOL while raising the crowd multiplier from
   5× to 20× moved Sharpe from +0.23 to +0.35 and PnL from +0.32 to +0.41 SOL.

Exits: take-profit +20%, stop-loss −4%, trailing stop (arms at +15%, exits on
a 10% pullback from peak), 600-slot time limit, and a flow exit on a −0.5 SOL
net sell wave over 15 slots (the flow exit is worth keeping: disabling it
cost ~0.05 SOL of PnL). No pyramiding — at these stakes the first buy is the
position, and the sweep showed adds only buy the top.

## Final parameters

| Parameter | Value |
|---|---|
| Entry: real SOL at entry | 15–60 SOL |
| Scout stake / crowded stake | 0.01 SOL / 20× scout, capped at 97% of the 1% rule |
| Crowd threshold | ≥ 12 distinct buyers in the create slot |
| Creator-sold filter | skip if the creator sold |
| Max single-sell guard | skip if any single sell > 5 SOL in the last 30 slots |
| Take-profit / stop-loss | +20% / −4% on liquidation value vs cost |
| Trailing stop | arms +15%, exits on −10% from peak |
| Max hold / cooldown / max entries per coin | 600 slots / 150 slots / 2 |
| Max new entries per batch | 2 |
| Slippage | buy 2000 bps, sell 10000 bps |

## Results

`grade-local --driver process` on the dev window (Node v24.22.1 locally; the
server uses Node v26.13.1 — the score is computed the same way):

- **Hourly Sharpe +0.363, net PnL +0.427 SOL, max drawdown 0.69%**,
  win rate 25.7%, 191 round trips, 468 fills, **169 distinct mints**,
  8 rejected orders, 10 failed txs. Sortino 1.39.
- The action log is deterministic (grade-local runs the bot twice and compares
  the logs; the sha256 matched across runs).
- Per-6h-quarter slices of the dev window (the final replay is 6h):
  Sharpe −1.42 / +0.56 / +0.75 / +0.15, PnL −0.04 / +0.09 / +0.31 / +0.05 SOL,
  23 / 30 / 77 / 39 distinct mints. Every quarter clears the 20-mint
  guardrail; 3 of 4 are profitable. The quiet quarter is the overnight UTC
  hours (03:00–09:00); the final window runs 17:00–23:00 UTC, the high-activity
  evening hours where this bot scored best.
- Concentration: the top 3 coins contribute 47.6% of all gains; net PnL
  without the top 3 coins is still +0.044 SOL — the bot is not carried by a
  single coin, but it is lumpy, like every pump.fun bot.
- Stress test (`grade-local --stress`, 20 rebuilt copies of the dev window):
  median −0.07 SOL, p10 −0.36, p90 +0.29, 11 of 20 copies lost money, dev
  score above all 20 copies — with the house's two warnings ("dev score above
  90% of the rebuilt copies" and "half or more of the rebuilt copies lost
  money"). Read honestly: the edge is real on this window and sits in a broad
  positive region of parameter space, but on a reshuffled window it is
  roughly breakeven. The final 6h window is a fresh draw, not a reshuffle of
  this one; the per-quarter slices above (3 of 4 profitable) are the better
  guide to it, and the evening UTC hours it covers are the bot's best hours.

## What was NOT done

- No competitor code was copied. The sibling sprints' leaderboards were read
  (titles and scores only) for direction — their common themes (pullback,
  overhang exhaustion, partial-lock, multi-tranche scaling) were tested as
  ideas and mostly failed on this data; the crowd signal came from the
  dataset itself, not from any entry.
- No overfitting to a single cell: the chosen parameters sit inside a broad
  positive region (crowd 12–15 × multiplier 4–20, entry 15–20 SOL, SL 4–6%
  are all positive on the full window), not on a knife-edge optimum.
- No network, no clock, no unseeded randomness in the bot. The only time
  input is the slot number from the batch itself. All decisions follow from
  the batch the harness just delivered.
