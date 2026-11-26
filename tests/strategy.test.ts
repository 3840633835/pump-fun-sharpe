// Unit tests for the crowd-selective strategy (strategy.ts).
// Run: node --test tests/strategy.test.ts
// These drive the bot directly through the kit SDK's BotState with synthetic
// batches — no dataset, no network — and assert the rules that the dev-window
// sweep depends on: scout vs crowded sizing, creator-sold filter, exits, the
// 5-position cap, and byte-level determinism.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BotState, type Batch, type Hello } from '../vendor/makefun-bot.ts';
import { createBot } from '../strategy.ts';

const MINT = 'FdfDYUcHRar4ezebmC7dbYvFLjoFK7ceUy5WzHzvpump';
const CREATOR = 'E1CrPhVtP9A7XWyAZQacdG5LxZSENRDm2FVrmV3Ndz1Y';

function hello(): Hello {
  return {
    type: 'hello',
    protocol: 'agent-fun/replay/v2',
    seed: '12345',
    universe: { program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', quote: 'SOL', mayhem: 'excluded', exclude_cashback: true, sample: { hash: 'sha256', modulus: 16, residue: 0 } },
    capital: { lamports: '10000000000' },
    caps: { max_open_positions: 5, max_order_bps_of_real_reserve: 100, max_orders_per_batch: 16, shorts: false, leverage: false },
    latency_slots: 2,
    fees: { protocol_bps_fallback: 95, creator_bps_fallback: 30, base_fee_lamports: '5000', priority_fee_lamports: '100000', failed_tx_bps: 200 },
  };
}

/** A bonding-curve price helper: virtual SOL 30 + real, virtual tokens 1.073e15. */
function reserves(realSol: number, priceMult = 1) {
  // price = vq/vt; base vq 30 SOL, vt 1.073e15 tokens. Raising vq by priceMult
  // raises the price by the same factor (tokens sold out of the curve).
  const vq = Math.round(30_000_000_000 * priceMult + realSol * 1e9);
  return {
    virtual_token_reserves: '1073000000000000',
    virtual_quote_reserves: String(vq),
    real_token_reserves: String(Math.round(793_100_000_000_000 - realSol * 1e9 * 0.5)),
    real_quote_reserves: String(Math.round(realSol * 1e9)),
  };
}

function createEvent(slot: number, buyer = CREATOR) {
  return {
    event: 'CreateEvent', name: 'Test', symbol: 'TST', uri: '', mint: MINT,
    bonding_curve: 'EeL819NdKaFrxWSbgGkpvqwn5FJ9rUSYst96FQLsAhnY', user: buyer, creator: CREATOR,
    timestamp: '1793588980', virtual_token_reserves: '1073000000000000',
    virtual_sol_reserves: '30000000000', real_token_reserves: '793100000000000',
    token_total_supply: '1000000000000000', token_program: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    is_mayhem_mode: false, is_cashback_enabled: false, quote_mint: '11111111111111111111111111111111',
    virtual_quote_reserves: '30000000000', creator_fee_bps: '0', is_holder_reward: false, depth: 0,
    slot, signature: 'sig-create', block_time: 1793588980, chain_seq: 0,
  };
}

function tradeEvent(slot: number, user: string, isBuy: boolean, sol: number, realSol: number, priceMult = 1) {
  const r = reserves(realSol, priceMult);
  return {
    event: 'TradeEvent', mint: MINT, sol_amount: String(Math.round(sol * 1e9)),
    token_amount: '1000000000000', is_buy: isBuy, user, timestamp: '1793588980',
    virtual_sol_reserves: r.virtual_quote_reserves, virtual_token_reserves: r.virtual_token_reserves,
    real_sol_reserves: r.real_quote_reserves, real_token_reserves: r.real_token_reserves,
    fee_recipient: '7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ', fee_basis_points: '95',
    fee: '0', creator: CREATOR, creator_fee_basis_points: '30', creator_fee: '0',
    track_volume: false, total_unclaimed_tokens: '0', total_claimed_tokens: '0',
    current_sol_volume: '0', last_update_timestamp: '0', ix_name: 'buy', mayhem_mode: false,
    cashback_fee_basis_points: '0', cashback: '0', buyback_fee_basis_points: '5000', buyback_fee: '0',
    shareholders: [], quote_mint: '11111111111111111111111111111111',
    quote_amount: String(Math.round(sol * 1e9)), virtual_quote_reserves: r.virtual_quote_reserves,
    real_quote_reserves: r.real_quote_reserves, holder_rewards_bps: '0', holder_rewards: '0',
    creator_fee_unclaimed: '0', slot, signature: `sig-${slot}-${user.slice(0, 4)}`,
    block_time: 1793588980, chain_seq: slot,
  };
}

function batch(seq: number, slot: number, events: any[], account?: any): Batch {
  return {
    type: 'batch', seq, slot, events, marks: [], fills: [],
    account: account ?? { cash_lamports: '10000000000', positions: [] },
  } as unknown as Batch;
}

/** Drive a fresh bot through batches, returning the orders per batch. */
function drive(batches: Batch[]) {
  const bot = createBot();
  const state = new BotState(hello());
  const out: any[][] = [];
  for (const b of batches) {
    state.applyBatch(b);
    out.push(bot.onBatch(state, b));
  }
  return out;
}

/** A launch at slot 100 with `buyers` distinct buyers in the create slot,
 * reaching `realSol` SOL of real liquidity by slot 100 + n. */
function launchBatches(buyers: string[], realSol: number): Batch[] {
  const events: any[] = [createEvent(100)];
  buyers.forEach((u, i) => events.push(tradeEvent(100, u, true, 0.5, 1 + i * 0.5)));
  events.push(tradeEvent(102, buyers[0]!, true, realSol - buyers.length * 0.5, realSol));
  return [batch(0, 100, events)];
}

const BUYERS12 = Array.from({ length: 12 }, (_, i) => `Buyer${String(i).padStart(2, '0')}11111111111111111111111`);

describe('crowd-selective strategy', () => {
  it('sends no orders on an empty batch', () => {
    const out = drive([batch(0, 100, [])]);
    assert.deepEqual(out[0], []);
  });

  it('buys a 0.01 SOL scout stake once real liquidity reaches 15 SOL', () => {
    const out = drive(launchBatches([CREATOR], 15));
    assert.equal(out[0]!.length, 1);
    assert.equal(out[0]![0].side, 'buy');
    assert.equal(out[0]![0].quote_lamports, 10_000_000n);
  });

  it('does not enter below 15 SOL of real liquidity', () => {
    const out = drive(launchBatches([CREATOR], 10));
    assert.deepEqual(out[0], []);
  });

  it('buys up to the 1% cap on a crowded launch (12 distinct create-slot buyers)', () => {
    const out = drive(launchBatches(BUYERS12, 15));
    assert.equal(out[0]!.length, 1);
    assert.equal(out[0]![0].side, 'buy');
    // cap = 1% of 15 SOL = 0.15 SOL; 97% of that = 0.1455 SOL. Scout x20 = 0.20
    // SOL, so the cap binds.
    assert.equal(out[0]![0].quote_lamports, 145_500_000n);
  });

  it('does not enter when the creator dumped their own coin', () => {
    const events: any[] = [createEvent(100)];
    events.push(tradeEvent(100, CREATOR, true, 1, 1));
    events.push(tradeEvent(101, CREATOR, false, 0.5, 15));
    events.push(tradeEvent(102, 'OtherBuyer111111111111111111111111', true, 14, 15));
    const out = drive([batch(0, 100, events)]);
    assert.deepEqual(out[0], []);
  });

  // A 0.01 SOL buy at the entry price (vq 45 SOL / vt 1.073e15) buys
  // 0.01 SOL / (45e9 / 1.073e15) ≈ 2.384e11 tokens; cost with fees ≈ 0.01023 SOL.
  const TOKENS = '238400000000';
  const COST = '10230000';

  it('take-profit: sells the whole position once value is +20% over cost', () => {
    const entry = launchBatches([CREATOR], 15)[0];
    // Price +29% (vq 45 -> 58 SOL): liquidation ratio ≈ 1.27 > 1.20.
    // The position is first *seen* on batch 1, so exits start on batch 2.
    const account = {
      cash_lamports: '9980000000',
      positions: [{ mint: MINT, token_amount: TOKENS, cost_lamports: COST }],
    };
    const held1 = batch(1, 110, [tradeEvent(110, 'BuyerX1111111111111111111111111', true, 1, 16, 1.4)], account);
    const held2 = batch(2, 111, [tradeEvent(111, 'BuyerX1111111111111111111111111', true, 0.1, 16, 1.4)], account);
    const out = drive([entry, held1, held2]);
    assert.equal(out[1]!.length, 0); // first sighting: record the position, no exit yet
    assert.equal(out[2]!.length, 1);
    assert.equal(out[2]![0].side, 'sell');
    assert.equal(out[2]![0].token_amount, 238_400_000_000n);
  });

  it('stop-loss: sells once value is −4% under cost', () => {
    const entry = launchBatches([CREATOR], 15)[0];
    // Price −12% (vq 45 -> 39.5 SOL): liquidation ratio ≈ 0.86 < 0.96.
    const account = {
      cash_lamports: '9980000000',
      positions: [{ mint: MINT, token_amount: TOKENS, cost_lamports: COST }],
    };
    const held1 = batch(1, 110, [tradeEvent(110, 'BuyerX1111111111111111111111111', false, 1, 14, 0.85)], account);
    const held2 = batch(2, 111, [tradeEvent(111, 'BuyerX1111111111111111111111111', false, 0.1, 14, 0.85)], account);
    const out = drive([entry, held1, held2]);
    assert.equal(out[1]!.length, 0);
    assert.equal(out[2]!.length, 1);
    assert.equal(out[2]![0].side, 'sell');
  });

  it('holds a flat position: no exit at +1% / −1%', () => {
    const entry = launchBatches([CREATOR], 15)[0];
    const account = {
      cash_lamports: '9980000000',
      positions: [{ mint: MINT, token_amount: TOKENS, cost_lamports: COST }],
    };
    const held1 = batch(1, 110, [tradeEvent(110, 'BuyerX1111111111111111111111111', true, 0.1, 15, 1.01)], account);
    const held2 = batch(2, 111, [tradeEvent(111, 'BuyerX1111111111111111111111111', true, 0.1, 15, 1.01)], account);
    const out = drive([entry, held1, held2]);
    assert.deepEqual(out[1], []);
    assert.deepEqual(out[2], []);
  });

  it('is deterministic: the same batches twice give identical orders', () => {
    const batches = [
      ...launchBatches(BUYERS12, 20),
      batch(1, 110, [tradeEvent(110, 'BuyerX1111111111111111111111111', true, 1, 21, 1.1)], {
        cash_lamports: '9850000000',
        positions: [{ mint: MINT, token_amount: '1000000000000', cost_lamports: '146555000' }],
      }),
      batch(2, 120, [tradeEvent(120, 'BuyerY1111111111111111111111111', false, 2, 18, 0.95)], {
        cash_lamports: '9850000000',
        positions: [{ mint: MINT, token_amount: '1000000000000', cost_lamports: '146555000' }],
      }),
    ];
    const a = drive(batches);
    const b = drive(batches);
    assert.equal(JSON.stringify(a, (_, v) => (typeof v === 'bigint' ? v.toString() : v)), JSON.stringify(b, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  });
});
