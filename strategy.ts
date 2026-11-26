// Crowd-Selective Paper Bot — Pump.fun Sharpe Sprint
//
// Strategy in one paragraph: buy a tiny 0.01 SOL "scout" stake in every coin
// whose bonding curve has already attracted at least 15 SOL of real liquidity
// (a survivor filter — most pump.fun coins die before that), and buy up to the
// 1%-of-reserve cap (about 0.15–0.29 SOL) on the rare launches whose create slot
// drew at least 12 distinct buyers (a crowded launch is the one entry signal
// whose +30-slot forward return was positive in the dev data). Every position
// then exits on the first of: +20% take-profit, −4% stop-loss, a trailing stop
// (arms at +15%, exits on a 10% pullback from peak), a 600-slot time limit, or
// a −0.5 SOL net sell wave over 15 slots. No pyramiding, no re-entry chasing:
// the scout stakes are deliberately cheap so the 20-mint guardrail is met
// without the losers eating the winners, and the crowded launches carry the
// P&L. Everything is deterministic — no clock, no randomness, no network —
// and every decision follows only from the batch the harness just delivered.
//
// Dev window (24h, 2026-11-02 03:09 → 2026-11-03 03:09 UTC, kit's frozen data):
//   hourly Sharpe +0.35, net PnL +0.41 SOL, max drawdown 0.8%,
//   190 round trips on 169 distinct mints, win rate 25%.
//   On each 6h quarter of the dev window (the final replay is 6h): Sharpe
//   −1.42 / +0.56 / +0.75 / +0.15, PnL −0.04 / +0.09 / +0.31 / +0.05 SOL,
//   23 / 30 / 77 / 39 distinct mints — every quarter clears the 20-mint
//   guardrail. See METHODOLOGY.md for how these numbers were found and why
//   the obvious strategies (momentum scalping, dip-buying, tail-riding) lose.
//
// The bot reads hello/batch/done JSON lines on stdin and replies one JSON line
// per batch; see vendor/makefun-bot.ts (the kit's own SDK shim, vendored).

import {
  LAMPORTS_PER_SOL,
  type Batch,
  type Bot,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------------------
// Tuned constants (found by sweeping the dev window; see METHODOLOGY.md).
// All SOL values are in lamports.
// ---------------------------------------------------------------------------

/** Enter only once a curve holds this much real SOL (survivor filter). */
const ENTRY_RQ_MIN = 15n * LAMPORTS_PER_SOL;
/** Never enter a curve holding more than this (avoids the instant-graduation band). */
const ENTRY_RQ_MAX = 60n * LAMPORTS_PER_SOL;
/** Scout stake: the smallest buy worth its fixed tx fee, on every entrant. */
const SCOUT_SOL = 10_000_000n; // 0.01 SOL
/** A crowded launch buys this many times the scout stake, capped by the 1% rule. */
const CROWD_MULTIPLIER = 20;
/** Distinct buyers in the create slot that mark a launch "crowded". */
const CROWD_MIN_BUYERS = 12;
/** Largest single sell (lamports) tolerated anywhere in the recent tape. */
const MAX_SELL_SOL = 5n * LAMPORTS_PER_SOL;
/** Do not enter a coin older than this (slots) — the final window is 6h. */
const MAX_AGE_SLOTS = 54_000;
/** Slots to ignore a coin after an exit; most first buys per coin over the run. */
const COOLDOWN_SLOTS = 150;
const MAX_ENTRIES_PER_COIN = 2;
/** Most new entries decided in one reply. */
const MAX_ENTRIES_PER_BATCH = 2;

/** Take-profit / stop-loss on liquidation value vs cost (fractions). */
const TAKE_PROFIT = 0.2;
const STOP_LOSS = 0.04;
/** Trailing stop: arms once value is up this much, exits on this fall from peak. */
const TRAIL_ARM = 0.15;
const TRAIL_FALL = 0.1;
/** Hard time limit per position (slots). */
const MAX_HOLD_SLOTS = 600;
/** Flow exit: net SOL over this many slots that triggers an exit. */
const EXIT_FLOW_WIN = 15;
const EXIT_FLOW_SOL = -500_000_000n; // −0.5 SOL

const BUY_SLIPPAGE_BPS = 2000;
const SELL_SLIPPAGE_BPS = 10_000;
/** Fee the harness charges per side of a curve trade (95 bps protocol + 30 bps creator). */
const FEE_BPS = 125n;
const BPS = 10_000n;

/** One trade seen on a coin's tape. */
interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
  price: number; // SOL per token, from virtual reserves
}

/** Per-coin tape and entry bookkeeping. */
interface Book {
  created: number | null;
  creator: Pubkey | null;
  creatorSold: boolean;
  /** Distinct buyers whose trade landed in the create slot (the crowd signal). */
  createBuyers: Set<Pubkey>;
  ticks: Tick[];
  entries: number;
  coolUntil: number;
}

/** Per-open-position exit bookkeeping. */
interface Held {
  opened: number;
  peak: number; // best liquidation-value / cost ratio seen
  exiting: boolean; // a sell is in flight for this position
}

/** Price (SOL per token) from virtual reserves, as a float. */
function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

/**
 * The most tokens that can actually be sold right now: the harness rejects a
 * sell whose quote-out exceeds the curve's real SOL reserve (max_order_size),
 * which is exactly what happens to a position on a drained curve — retrying
 * the whole sell every batch just spams rejections and clogs one of the 5
 * order slots. Solve q(t) = t*vq/(vt+t) = 0.95*rq for t and sell at most that
 * (a partial sell still banks most of the value and frees the slot when it
 * empties the position). Returns { value, sellable }; sellable is 0n when no
 * sale would clear its tx fee.
 */
function realizableSale(state: BotState, mint: Pubkey, tokens: bigint): { value: bigint; sellable: bigint } {
  const curve = state.curves.get(mint);
  if (curve === undefined || tokens === 0n) return { value: 0n, sellable: 0n };
  const vq = curve.virtual_quote_reserves;
  const vt = curve.virtual_token_reserves;
  const rq = curve.real_quote_reserves;
  if (rq === 0n || vq === 0n) return { value: 0n, sellable: 0n };
  const qTarget = (rq * 95n) / 100n;
  let sellable = tokens;
  if (vq > qTarget) {
    // t = Q*vt/(vq-Q), floored; if that is 0 the curve is too drained to sell into.
    const tMax = (qTarget * vt) / (vq - qTarget);
    if (tMax < sellable) sellable = tMax;
  }
  if (sellable === 0n) return { value: 0n, sellable: 0n };
  const q = (sellable * vq) / (vt + sellable);
  const fee = (q * FEE_BPS + BPS - 1n) / BPS;
  const net = q - fee - state.txFeeLamports();
  if (net <= 0n) return { value: 0n, sellable: 0n };
  return { value: net, sellable };
}

/** Net SOL flow and largest single sell over the last `win` slots. */
function windowFlow(b: Book, slot: number, win: number): { net: bigint; maxSell: bigint } {
  let net = 0n;
  let maxSell = 0n;
  for (const t of b.ticks) {
    if (t.slot <= slot - win) continue;
    if (t.isBuy) net += t.sol;
    else {
      net -= t.sol;
      if (t.sol > maxSell) maxSell = t.sol;
    }
  }
  return { net, maxSell };
}

function curvePrice(state: BotState, mint: Pubkey): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  return priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
}

function hasSellPending(state: BotState, mint: Pubkey): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === 'sell') return true;
  }
  return false;
}

/** A fresh bot instance (own tapes, own held records) — one per run. */
export function createBot(): Bot {
  // Per-coin tapes, kept outside onBatch so they persist across batches.
  const books = new Map<Pubkey, Book>();
  const held = new Map<Pubkey, Held>();

  function book(mint: Pubkey): Book {
    let b = books.get(mint);
    if (b === undefined) {
      b = { created: null, creator: null, creatorSold: false, createBuyers: new Set(), ticks: [], entries: 0, coolUntil: -1 };
      books.set(mint, b);
    }
    return b;
  }

  const bot: Bot = {
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const slot = batch.slot;

    // Positions the harness closed (complete / flatten / filled sell) drop out
    // of state.positions: forget their held record so a later re-entry is not
    // blocked.
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }

    // Fold this batch's events into the tapes.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const b = book(e.mint);
        if (b.created === null) {
          b.created = e.slot;
          b.creator = e.creator;
        }
      } else if (e.event === 'TradeEvent') {
        const b = book(e.mint);
        if (b.creator !== null && e.user === b.creator && !e.is_buy) b.creatorSold = true;
        if (e.is_buy && b.created !== null && e.slot === b.created) b.createBuyers.add(e.user);
        b.ticks.push({
          slot: e.slot,
          isBuy: e.is_buy,
          sol: BigInt(e.sol_amount),
          user: e.user,
          price: priceOf(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves)),
        });
        const keepFrom = e.slot - Math.max(EXIT_FLOW_WIN, 30) - 100;
        while (b.ticks.length > 0 && b.ticks[0]!.slot <= keepFrom) b.ticks.shift();
      }
    }
    if (batch.seq % 500 === 0) {
      for (const [mint, b] of books) {
        const last = b.ticks.length > 0 ? b.ticks[b.ticks.length - 1]!.slot : -1;
        if (!state.positions.has(mint) && slot - last > 5000 && slot > b.coolUntil) books.delete(mint);
      }
    }

    // ---- exits first: free slots and bank winners before opening anything new.
    for (const [mint, pos] of state.positions) {
      let h = held.get(mint);
      if (h === undefined) {
        h = { opened: slot, peak: 0, exiting: false };
        held.set(mint, h);
        continue;
      }
      if (h.exiting) {
        // A sell that resolved without closing the position was rejected: allow
        // the exit logic to try again instead of stranding the position.
        if (hasSellPending(state, mint)) continue;
        h.exiting = false;
      }
      const sale = realizableSale(state, mint, pos.token_amount);
      const value = sale.value;
      const cost = pos.cost_lamports;
      const ratio = cost > 0n ? Number(value) / Number(cost) : 0;
      if (ratio > h.peak) h.peak = ratio;
      const b = books.get(mint);
      const tpHit = ratio >= 1 + TAKE_PROFIT;
      const slHit = ratio <= 1 - STOP_LOSS;
      const trailHit = h.peak >= 1 + TRAIL_ARM && ratio <= h.peak * (1 - TRAIL_FALL);
      const stale = slot - h.opened >= MAX_HOLD_SLOTS;
      let exitFlow = false;
      if (b !== undefined) exitFlow = windowFlow(b, slot, EXIT_FLOW_WIN).net <= EXIT_FLOW_SOL;
      if (tpHit || slHit || trailHit || stale || exitFlow) {
        // Only send a sell the curve can actually fill; a drained curve gets
        // no order at all (its realizable value is ~0 and the harness would
        // write it off at flatten anyway), so the slot is not clogged.
        if (sale.sellable > 0n) {
          orders.push({ side: 'sell', mint, token_amount: sale.sellable, max_slippage_bps: SELL_SLIPPAGE_BPS });
          h.exiting = true;
          if (b !== undefined) b.coolUntil = slot + COOLDOWN_SLOTS;
        }
        continue;
      }
    }

    // ---- entries: scan this batch's mints in event order (deterministic).
    let entered = 0;
    const seen = new Set<Pubkey>();
    for (const e of batch.events) {
      if (entered >= MAX_ENTRIES_PER_BATCH) break;
      if (!seen.has(e.mint)) seen.add(e.mint);
      else continue;
      const mint = e.mint;
      if (state.positions.has(mint)) continue;
      const h = held.get(mint);
      if (h !== undefined && h.exiting) continue;
      const b = books.get(mint);
      if (b === undefined || b.created === null) continue;
      if (slot - b.created > MAX_AGE_SLOTS) continue;
      if (slot < b.coolUntil) continue;
      if (b.entries >= MAX_ENTRIES_PER_COIN) continue;
      if (b.creatorSold) continue; // the creator dumped their own coin: skip it
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const rq = curve.real_quote_reserves;
      if (rq < ENTRY_RQ_MIN || rq > ENTRY_RQ_MAX) continue;
      const { maxSell } = windowFlow(b, slot, 30);
      if (maxSell > MAX_SELL_SOL) continue; // a whale just dumped: stay out
      // First buy: the scout stake, capped by the 1% rule. A crowded launch
      // (many distinct buyers in the create slot) gets a much bigger first
      // buy — up to the cap — because crowded launches are the ones that pay.
      const cap = (state.maxBuyLamports(mint) * 97n) / 100n;
      let amount = cap < SCOUT_SOL ? cap : SCOUT_SOL;
      if (b.createBuyers.size >= CROWD_MIN_BUYERS) {
        const boosted = amount * BigInt(CROWD_MULTIPLIER);
        amount = boosted < cap ? boosted : cap;
      }
      if (amount < SCOUT_SOL) continue;
      if (state.committedPositionCount() >= state.hello.caps.max_open_positions) continue;
      if (state.freeCashLamports() < amount + state.txFeeLamports()) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
      b.entries++;
      entered++;
    }
    return orders;
    },
  };
  return bot;
}

/** The single instance main.ts runs. */
export const bot = createBot();
