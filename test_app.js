'use strict';
// node:test — run with: node --test test_app.js

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Stub browser globals consumed at require-time
global.document = { addEventListener: () => {} };

const {
  computeScore, computeCost, computeAvgCostPerMtok,
  enrichModels, filterRows, sortRows,
  stars, fmtCost,
  _setDATA, _setState,
} = require('./app.js');

// ── Fixtures ─────────────────────────────────────────────────────────────────

const DATA_FIXTURE = {
  config: {
    equivalence_threshold: 0.9,
    budget_ceiling_usd_month: 200,
    profiles: {
      orchestrator: {
        name: 'Orchestrator',
        weights: { agents: 0.6, reasoning: 0.4 },
        monthly_input_tokens: 15_000_000,
        monthly_output_tokens:  5_000_000,
      },
      coding: {
        name: 'Coding',
        weights: { coding: 1.0 },
        monthly_input_tokens:  7_500_000,
        monthly_output_tokens: 2_500_000,
      },
    },
  },
};

_setDATA(DATA_FIXTURE);

const DEFAULT_STATE = {
  profile: 'orchestrator',
  budgetMax: 200,
  unitMode: 'month',
  hermesOnly: false,
  providerFilter: '',
  nameFilter: '',
  sortCol: 'value',
  sortDir: 'desc',
  selectedId: null,
  usage: {},
};

function resetState(overrides = {}) {
  _setState({ ...DEFAULT_STATE, usage: {}, ...overrides });
}

function model(overrides = {}) {
  return {
    id: 'test/model',
    name: 'Test Model',
    provider: 'test',
    hermes_ready: false,
    hermes_provider: null,
    input_per_mtok: 3.0,
    output_per_mtok: 15.0,
    is_free: false,
    scores: { agents: 60, reasoning: 40, coding: 50, overall: 55 },
    data_quality: 'confirmed',
    ...overrides,
  };
}

// ── computeScore ─────────────────────────────────────────────────────────────

describe('computeScore', () => {
  it('returns weighted average for orchestrator (agents×0.6 + reasoning×0.4)', () => {
    const scores = { agents: 60, reasoning: 40 };
    // (60×0.6 + 40×0.4) / (0.6+0.4) = 52
    assert.equal(computeScore(scores, 'orchestrator'), 52);
  });

  it('returns the score directly for a single-weight profile', () => {
    assert.equal(computeScore({ coding: 80 }, 'coding'), 80);
  });

  it('normalises weight when one category is missing from scores', () => {
    // Only agents contributes → 60×0.6/0.6 = 60
    assert.equal(computeScore({ agents: 60, reasoning: null }, 'orchestrator'), 60);
  });

  it('returns null when all relevant scores are null', () => {
    assert.equal(computeScore({ agents: null, reasoning: null }, 'orchestrator'), null);
  });

  it('returns null for an empty scores object', () => {
    assert.equal(computeScore({}, 'orchestrator'), null);
  });

  it('falls back to {overall:1} for an unknown profile', () => {
    assert.equal(computeScore({ overall: 77 }, 'nonexistent'), 77);
  });
});

// ── computeCost ──────────────────────────────────────────────────────────────

describe('computeCost', () => {
  beforeEach(() => resetState());

  it('uses profile config tokens by default', () => {
    const m = model({ input_per_mtok: 3, output_per_mtok: 15 });
    // orchestrator: 15M input + 5M output → (3×15 + 15×5) = 120
    assert.equal(computeCost(m, 'orchestrator'), 120);
  });

  it('uses state.usage tokens when set', () => {
    _setState({ usage: { orchestrator: { monthly_input_tokens: 1_000_000, monthly_output_tokens: 1_000_000 } } });
    const m = model({ input_per_mtok: 3, output_per_mtok: 15 });
    // (3×1 + 15×1) = 18
    assert.equal(computeCost(m, 'orchestrator'), 18);
  });

  it('returns 0 for zero-priced model', () => {
    const m = model({ input_per_mtok: 0, output_per_mtok: 0 });
    assert.equal(computeCost(m, 'orchestrator'), 0);
  });
});

// ── computeAvgCostPerMtok ─────────────────────────────────────────────────────

describe('computeAvgCostPerMtok', () => {
  it('weights input at 75% and output at 25%', () => {
    // 4×0.75 + 16×0.25 = 3 + 4 = 7
    assert.equal(computeAvgCostPerMtok(model({ input_per_mtok: 4, output_per_mtok: 16 })), 7);
  });

  it('returns 75% of input when output is zero', () => {
    assert.equal(computeAvgCostPerMtok(model({ input_per_mtok: 8, output_per_mtok: 0 })), 6);
  });
});

// ── enrichModels ─────────────────────────────────────────────────────────────

describe('enrichModels', () => {
  beforeEach(() => resetState({ profile: 'coding' }));

  it('attaches _score, _cost, _costPerMtok to every row', () => {
    const [row] = enrichModels([model()]);
    assert.ok(row._score != null);
    assert.ok(row._cost != null);
    assert.ok(row._costPerMtok != null);
  });

  it('normalises _value so the best model gets exactly 5', () => {
    const cheap = model({ id: 'a', input_per_mtok: 0.1, output_per_mtok: 0.1, scores: { coding: 80 } });
    const pricey = model({ id: 'b', input_per_mtok: 10,  output_per_mtok: 40,  scores: { coding: 40 } });
    const rows = enrichModels([cheap, pricey]);
    assert.equal(Math.max(...rows.map(r => r._value ?? 0)), 5);
  });

  it('sets _value to null when _score is null', () => {
    const [row] = enrichModels([model({ scores: { coding: null } })]);
    assert.equal(row._value, null);
  });

  it('sets _value to null for a free model (cost = 0)', () => {
    const [row] = enrichModels([model({ is_free: true, input_per_mtok: 0, output_per_mtok: 0 })]);
    assert.equal(row._value, null);
  });
});

// ── filterRows ───────────────────────────────────────────────────────────────

describe('filterRows', () => {
  function row(overrides = {}) {
    return {
      id: 'test/model', name: 'Test', provider: 'openai',
      hermes_ready: true, is_free: false,
      _cost: 50, _costPerMtok: 5, _score: 40, _value: 3,
      ...overrides,
    };
  }

  beforeEach(() => resetState({ budgetMax: 100, unitMode: 'month' }));

  it('passes all rows when no filters active', () => {
    assert.equal(filterRows([row(), row({ id: 'b' })]).length, 2);
  });

  it('filters by hermes_ready', () => {
    _setState({ hermesOnly: true });
    const result = filterRows([row({ hermes_ready: true }), row({ id: 'b', hermes_ready: false })]);
    assert.deepEqual(result.map(r => r.hermes_ready), [true]);
  });

  it('filters by provider (case-insensitive)', () => {
    _setState({ providerFilter: 'OPEN' });
    const result = filterRows([row({ provider: 'openai' }), row({ id: 'b', provider: 'anthropic' })]);
    assert.equal(result.length, 1);
    assert.equal(result[0].provider, 'openai');
  });

  it('filters by name (case-insensitive)', () => {
    _setState({ nameFilter: 'gpt' });
    const result = filterRows([row({ name: 'GPT-5 Nano' }), row({ id: 'b', name: 'Claude Sonnet' })]);
    assert.equal(result.length, 1);
  });

  it('hides models over budget in month mode', () => {
    _setState({ budgetMax: 30 });
    const result = filterRows([row({ _cost: 20 }), row({ id: 'b', _cost: 50 })]);
    assert.equal(result.length, 1);
    assert.equal(result[0]._cost, 20);
  });

  it('never hides a free model regardless of budget', () => {
    _setState({ budgetMax: 0 });
    assert.equal(filterRows([row({ is_free: true, _cost: 0 })]).length, 1);
  });

  it('filters by $/Mtok in mtok mode', () => {
    _setState({ unitMode: 'mtok', budgetMax: 3 });
    const result = filterRows([row({ _costPerMtok: 2 }), row({ id: 'b', _costPerMtok: 5 })]);
    assert.equal(result.length, 1);
  });
});

// ── sortRows ─────────────────────────────────────────────────────────────────

describe('sortRows', () => {
  function row(id, overrides = {}) {
    return { id, name: id, provider: id, _score: 50, _cost: 10, _costPerMtok: 5, _value: 3, ...overrides };
  }

  beforeEach(() => resetState({ sortCol: 'value', sortDir: 'desc', unitMode: 'month' }));

  it('sorts by value descending by default', () => {
    const rows = [row('a', { _value: 2 }), row('b', { _value: 5 }), row('c', { _value: 3 })];
    assert.deepEqual(sortRows(rows).map(r => r._value), [5, 3, 2]);
  });

  it('sorts by value ascending when sortDir is asc', () => {
    _setState({ sortDir: 'asc' });
    const rows = [row('a', { _value: 2 }), row('b', { _value: 5 }), row('c', { _value: 3 })];
    assert.deepEqual(sortRows(rows).map(r => r._value), [2, 3, 5]);
  });

  it('sorts by quality descending', () => {
    _setState({ sortCol: 'quality' });
    const rows = [row('a', { _score: 30 }), row('b', { _score: 70 }), row('c', { _score: 50 })];
    assert.deepEqual(sortRows(rows).map(r => r._score), [70, 50, 30]);
  });

  it('sorts by name alphabetically asc', () => {
    _setState({ sortCol: 'name', sortDir: 'asc' });
    const rows = [row('Charlie'), row('Alpha'), row('Bravo')];
    assert.deepEqual(sortRows(rows).map(r => r.name), ['Alpha', 'Bravo', 'Charlie']);
  });

  it('sorts by monthly price asc', () => {
    _setState({ sortCol: 'price', sortDir: 'asc' });
    const rows = [row('a', { _cost: 30 }), row('b', { _cost: 10 }), row('c', { _cost: 20 })];
    assert.deepEqual(sortRows(rows).map(r => r._cost), [10, 20, 30]);
  });

  it('sorts by $/Mtok in mtok mode', () => {
    _setState({ sortCol: 'price', sortDir: 'asc', unitMode: 'mtok' });
    const rows = [row('a', { _costPerMtok: 3 }), row('b', { _costPerMtok: 1 }), row('c', { _costPerMtok: 2 })];
    assert.deepEqual(sortRows(rows).map(r => r._costPerMtok), [1, 2, 3]);
  });

  it('does not mutate the input array', () => {
    const rows = [row('a', { _value: 1 }), row('b', { _value: 5 })];
    const copy = [...rows];
    sortRows(rows);
    assert.deepEqual(rows, copy);
  });

  it('places null _value rows last when sorting desc', () => {
    const rows = [row('a', { _value: null }), row('b', { _value: 4 }), row('c', { _value: null })];
    assert.equal(sortRows(rows)[0]._value, 4);
  });
});

// ── stars ────────────────────────────────────────────────────────────────────

describe('stars', () => {
  it('returns em dash for null', () => { assert.ok(stars(null).includes('—')); });
  it('returns 5 full stars for value 5', () => { assert.ok(stars(5).includes('★★★★★') && !stars(5).includes('☆')); });
  it('returns all empty stars for value 0', () => { assert.ok(stars(0).includes('☆☆☆☆☆') && !stars(0).includes('★')); });
  it('rounds 2.5 → 3 full stars', () => { assert.ok(stars(2.5).includes('★★★') && stars(2.5).includes('☆☆')); });
  it('caps at 5 stars for values above 5', () => { assert.ok(stars(10).includes('★★★★★') && !stars(10).includes('☆')); });
});

// ── fmtCost ──────────────────────────────────────────────────────────────────

describe('fmtCost', () => {
  beforeEach(() => resetState({ unitMode: 'month' }));

  it('returns FREE for free models', () => {
    assert.ok(fmtCost({ is_free: true, _cost: 0, _costPerMtok: 0 }).includes('FREE'));
  });

  it('returns em dash when cost is null', () => {
    assert.equal(fmtCost({ is_free: false, _cost: null, _costPerMtok: 0 }), '—');
  });

  it('shows 3 decimal places for cost < $1/mo', () => {
    assert.match(fmtCost({ is_free: false, _cost: 0.456, _costPerMtok: 0 }), /\$0\.456/);
  });

  it('shows 2 decimal places for $1–$9.99/mo', () => {
    assert.match(fmtCost({ is_free: false, _cost: 5.5, _costPerMtok: 0 }), /\$5\.50/);
  });

  it('shows 0 decimal places for cost ≥ $10/mo', () => {
    assert.match(fmtCost({ is_free: false, _cost: 12.7, _costPerMtok: 0 }), /\$13/);
  });

  it('shows 4 decimal places for $/Mtok < 0.1', () => {
    _setState({ unitMode: 'mtok' });
    assert.match(fmtCost({ is_free: false, _cost: 0, _costPerMtok: 0.05 }), /\$0\.0500\/M/);
  });

  it('shows 2 decimal places for $/Mtok ≥ 0.1', () => {
    _setState({ unitMode: 'mtok' });
    assert.match(fmtCost({ is_free: false, _cost: 0, _costPerMtok: 3.5 }), /\$3\.50\/M/);
  });
});
