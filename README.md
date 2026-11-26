# Crowd-Selective Paper Bot — Pump.fun Sharpe Sprint

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/3840633835/pump-fun-sharpe/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/3840633835/pump-fun-sharpe/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the pump.fun forward replay. It buys a tiny 0.01 SOL
"scout" stake in every coin whose bonding curve has already attracted at least
15 SOL of real liquidity, and buys up to the 1%-of-reserve cap on the rare
launches whose create slot drew at least 12 distinct buyers. Every position
exits on the first of +20% take-profit, −4% stop-loss, a trailing stop
(arms +15%, exits on a 10% pullback), a 600-slot time limit, or a −0.5 SOL
sell wave over 15 slots.

**Dev window (24h frozen pump.fun data): hourly Sharpe +0.35, net PnL +0.41 SOL,
max drawdown 0.8%, 190 round trips on 169 distinct mints, win rate 25%.**
On each 6h quarter of the dev window (the final replay is 6h): Sharpe
−1.42 / +0.56 / +0.75 / +0.15, PnL −0.04 / +0.09 / +0.31 / +0.05 SOL,
23 / 30 / 77 / 39 distinct mints — every quarter clears the 20-mint guardrail.

## Run it

```sh
node main.ts
```

`main.ts` is the entrypoint; the strategy lives in `strategy.ts`, and
`vendor/makefun-bot.ts` is the kit's own protocol shim (vendored, as the kit
instructs). Node 22+ runs the TypeScript directly — no build step, no
dependencies, no network. The bot reads hello/batch/done JSON lines on stdin
and replies one JSON line per batch. It is fully deterministic: same input,
byte-identical action log.

## Test it

```sh
node --test tests/strategy.test.ts
```

Nine unit tests drive the strategy through the SDK's `BotState` with synthetic
batches: scout vs crowded sizing, the creator-sold filter, take-profit,
stop-loss, holding a flat position, and determinism (same batches twice →
identical orders).

See [METHODOLOGY.md](METHODOLOGY.md) for how the strategy was found — including
the five strategy families that lose money on this data and why — and the full
dev-window numbers.

---

<sub>Entered on [make.fun](https://make.fun/?ref=brisk-lark-63-4025&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
