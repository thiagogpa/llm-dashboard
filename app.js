'use strict';

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  profile: 'orchestrator',
  budgetMax: 200,
  unitMode: 'month',     // 'month' | 'mtok'
  hermesOnly: false,
  providerFilter: '',
  nameFilter: '',
  sortCol: 'value',
  sortDir: 'desc',
  selectedId: null,
  usage: {},             // per-profile: {monthly_input_tokens, monthly_output_tokens}
};

let DATA = null;   // models.json contents

// ─── Computations ────────────────────────────────────────────────────────────

function profileWeights(profile) {
  return DATA.config.profiles[profile]?.weights ?? { overall: 1 };
}

function computeScore(scores, profile) {
  const weights = profileWeights(profile);
  let tw = 0, ts = 0;
  for (const [cat, w] of Object.entries(weights)) {
    const v = scores[cat];
    if (v != null) { ts += v * w; tw += w; }
  }
  return tw > 0 ? ts / tw : null;
}

function computeCost(model, profile) {
  const u = state.usage[profile] ?? DATA.config.profiles[profile];
  if (!u) return null;
  return (model.input_per_mtok * u.monthly_input_tokens
        + model.output_per_mtok * u.monthly_output_tokens) / 1_000_000;
}

function computeAvgCostPerMtok(model) {
  // Simple average of input+output rates weighted 3:1
  return (model.input_per_mtok * 0.75 + model.output_per_mtok * 0.25);
}

function enrichModels(models) {
  const p = state.profile;
  const rows = models.map(m => ({
    ...m,
    _score: computeScore(m.scores, p),
    _cost: computeCost(m, p),
    _costPerMtok: computeAvgCostPerMtok(m),
  }));
  // Normalise value to 0–5
  const maxVal = Math.max(...rows.map(r =>
    (r._score && r._cost > 0) ? r._score / r._cost : 0
  ));
  rows.forEach(r => {
    r._value = (r._score && r._cost > 0 && maxVal > 0)
      ? (r._score / r._cost / maxVal) * 5
      : null;
  });
  return rows;
}

function filterRows(rows) {
  return rows.filter(r => {
    if (state.hermesOnly && !r.hermes_ready) return false;
    if (state.providerFilter && !r.provider.toLowerCase().includes(state.providerFilter.toLowerCase())) return false;
    if (state.nameFilter && !r.name.toLowerCase().includes(state.nameFilter.toLowerCase())) return false;
    if (state.unitMode === 'month') {
      const cost = r.is_free ? 0 : r._cost;
      if (cost != null && cost > state.budgetMax) return false;
    } else {
      if (r._costPerMtok > state.budgetMax) return false;
    }
    return true;
  });
}

function sortRows(rows) {
  const dir = state.sortDir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    switch (state.sortCol) {
      case 'rank':    return dir * ((b._score ?? -1) - (a._score ?? -1));
      case 'name':    return dir * a.name.localeCompare(b.name);
      case 'provider':return dir * a.provider.localeCompare(b.provider);
      case 'quality': return dir * ((a._score ?? -1) - (b._score ?? -1));
      case 'price':   return dir * ((state.unitMode === 'mtok' ? a._costPerMtok : (a._cost ?? 0))
                                  - (state.unitMode === 'mtok' ? b._costPerMtok : (b._cost ?? 0)));
      case 'value':   return dir * ((a._value ?? -1) - (b._value ?? -1));
      default:        return 0;
    }
  });
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const PROFILE_COLORS = {
  orchestrator: '#5b8dee',
  subagent: '#a78bfa',
  coding: '#34d399',
  overall: '#fb923c',
};

function stars(value) {
  if (value == null) return '<span class="stars">—</span>';
  const full = Math.round(value);
  const s = '★'.repeat(Math.min(full, 5)) + '☆'.repeat(Math.max(0, 5 - full));
  return `<span class="stars">${s}</span>`;
}

function qualityBar(score, profile) {
  if (score == null) return '<span class="quality-cell"><span class="quality-score" style="color:var(--muted)">—</span></span>';
  const pct = Math.min(score, 100);
  const color = PROFILE_COLORS[profile];
  return `<span class="quality-cell">
    <span class="quality-bar-wrap">
      <span class="quality-bar" style="width:${pct}%;background:${color}"></span>
    </span>
    <span class="quality-score">${score.toFixed(1)}</span>
  </span>`;
}

function fmtCost(r) {
  if (r.is_free) return '<span class="free">FREE</span>';
  if (state.unitMode === 'month') {
    const c = r._cost;
    if (c == null) return '—';
    return c < 1 ? `$${c.toFixed(3)}` : `$${c.toFixed(c < 10 ? 2 : 0)}`;
  } else {
    const c = r._costPerMtok;
    return c < 0.1 ? `$${c.toFixed(4)}/M` : `$${c.toFixed(2)}/M`;
  }
}

function renderTable() {
  const tbody = document.getElementById('model-tbody');
  const empty = document.getElementById('table-empty');

  const allRows = enrichModels(DATA.models);
  const filtered = filterRows(allRows);
  const sorted = sortRows(filtered);

  if (sorted.length === 0) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const anchor = state.selectedId
    ? sorted.find(r => r.id === state.selectedId)
    : null;
  const anchorScore = anchor ? anchor._score : null;

  tbody.innerHTML = sorted.map((r, i) => {
    const isSelected = r.id === state.selectedId;
    const isAnchor = isSelected;
    const costCls = r.is_free ? 'price-cell free' : 'price-cell';
    const dqBadge = r.data_quality === 'estimated'
      ? '<span class="badge-estimated" title="Score estimated — get a llm-stats API key for verified data">est</span>' : '';
    const hermesCell = r.hermes_ready
      ? `<td class="hermes-cell" title="Hermes provider: ${r.hermes_provider}">✓</td>`
      : '<td class="hermes-cell"></td>';

    // Highlight if this is an equivalent of the anchor
    let rowClass = '';
    if (isAnchor) rowClass = 'anchor-row';

    return `<tr class="${rowClass}" data-id="${r.id}">
      <td class="rank-cell">${i + 1}</td>
      <td class="name-cell">
        <span class="name-text">${r.name}${dqBadge}</span>
        <span class="model-id">${r.id}</span>
      </td>
      <td class="provider-cell">${r.provider}</td>
      ${hermesCell}
      <td>${qualityBar(r._score, state.profile)}</td>
      <td class="${costCls}">${fmtCost(r)}</td>
      <td>${stars(r._value)}</td>
    </tr>`;
  }).join('');

  // Attach click handlers
  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => {
      const id = tr.dataset.id;
      state.selectedId = state.selectedId === id ? null : id;
      if (state.selectedId) {
        const model = allRows.find(r => r.id === id);
        openDrawer(model, allRows);
      } else {
        closeDrawer();
      }
      renderTable();
    });
  });
}

function renderSubscriptions() {
  const grid = document.getElementById('subs-grid');
  const staleSpan = document.getElementById('subs-stale');
  const plans = DATA.subscriptions ?? [];

  if (!plans.length) { grid.innerHTML = '<p style="color:var(--muted);font-size:12px">No subscription data. Run the Hermes subscription refresh routine.</p>'; return; }

  // Staleness check
  const subsDate = DATA.subs_date ? new Date(DATA.subs_date) : null;
  const daysOld = subsDate ? (Date.now() - subsDate) / 86400000 : 99;
  if (daysOld > 8) staleSpan.textContent = `⚠ data ${Math.floor(daysOld)}d old`;

  grid.innerHTML = plans.map(p => {
    const over = state.budgetMax > 0 && p.price_usd_month > state.budgetMax;
    const staleNote = daysOld > 8 ? '<div class="sub-stale">⚠ stale</div>' : '';
    const confNote = p.confidence === 'estimated'
      ? '<span class="sub-confidence-estimated"> (est)</span>' : '';
    return `<div class="sub-card${over ? ' over-budget' : ''}">
      <div class="sub-card-header">
        <div>
          <div class="sub-name">${p.name}${confNote}</div>
          <div class="sub-provider">${p.provider}</div>
        </div>
        <div class="sub-price">$${p.price_usd_month}/mo</div>
      </div>
      ${p.notable ? `<div class="sub-notable">${p.notable}</div>` : ''}
      ${staleNote}
    </div>`;
  }).join('');
}

// ─── Drawer ──────────────────────────────────────────────────────────────────

function openDrawer(model, allRows) {
  const score = computeScore(model.scores, state.profile);
  const cost = computeCost(model, state.profile);
  const threshold = DATA.config.equivalence_threshold ?? 0.9;
  const minScore = (score ?? 0) * threshold;

  document.getElementById('drawer-title').textContent =
    `Equivalents · ${DATA.config.profiles[state.profile]?.name ?? state.profile}`;
  document.getElementById('drawer-subtitle').textContent =
    `≥${Math.round(threshold * 100)}% quality of anchor · cheaper only`;

  const anchor = document.getElementById('drawer-anchor');
  anchor.innerHTML = `
    <div class="anch-label">Anchor</div>
    <div class="anch-name">${model.name}</div>
    <div class="anch-score">Score ${score != null ? score.toFixed(1) : '—'} · $${cost != null ? cost.toFixed(2) : '—'}/mo</div>
  `;

  const equivs = allRows
    .filter(r => {
      if (r.id === model.id) return false;
      const s = computeScore(r.scores, state.profile);
      const c = computeCost(r, state.profile);
      return s != null && s >= minScore && c != null && c < (cost ?? Infinity);
    })
    .sort((a, b) => {
      const ca = computeCost(a, state.profile) ?? 0;
      const cb = computeCost(b, state.profile) ?? 0;
      return ca - cb;
    });

  const list = document.getElementById('drawer-list');
  if (!equivs.length) {
    list.innerHTML = '<div class="no-equiv">No cheaper models meet the quality threshold.<br><small>Try lowering the threshold in config.json or refreshing quality data.</small></div>';
  } else {
    list.innerHTML = `<div class="drawer-section-label">${equivs.length} cheaper equivalent${equivs.length !== 1 ? 's' : ''} found</div>`
      + equivs.map(r => {
        const s = computeScore(r.scores, state.profile);
        const c = computeCost(r, state.profile) ?? 0;
        const savings = cost != null ? ((cost - c) / cost * 100).toFixed(0) : null;
        const hermesNote = r.hermes_ready ? `<small>✓ ${r.hermes_provider}</small>` : '';
        const dqNote = r.data_quality === 'estimated' ? ' <span class="badge-estimated">est</span>' : '';
        return `<div class="equiv-row">
          <div class="equiv-name">
            ${r.name}${dqNote}
            ${hermesNote}
          </div>
          <div class="equiv-right">
            <div class="equiv-score">Quality ${s?.toFixed(1) ?? '—'}</div>
            <div class="equiv-cost">$${c.toFixed(c < 1 ? 3 : 0)}/mo</div>
            ${savings != null ? `<div class="equiv-savings">−${savings}% cost</div>` : ''}
          </div>
        </div>`;
      }).join('');
  }

  document.getElementById('drawer').classList.remove('drawer-closed');
  document.getElementById('drawer-overlay').classList.remove('hidden');
}

function closeDrawer() {
  state.selectedId = null;
  document.getElementById('drawer').classList.add('drawer-closed');
  document.getElementById('drawer-overlay').classList.add('hidden');
}

// ─── Controls ────────────────────────────────────────────────────────────────

function updatePriceHeader() {
  document.getElementById('price-th').textContent =
    state.unitMode === 'month' ? 'Cost/mo' : 'Cost/Mtok';
}

function updateSortIndicators() {
  document.querySelectorAll('#model-table th').forEach(th => {
    th.classList.toggle('sorted', th.dataset.sort === state.sortCol);
  });
}

function renderUsageEditor() {
  const grid = document.getElementById('usage-grid');
  const profiles = DATA.config.profiles;
  grid.innerHTML = Object.entries(profiles).map(([pid, pcfg]) => {
    const u = state.usage[pid] ?? pcfg;
    const totalM = ((u.monthly_input_tokens + u.monthly_output_tokens) / 1e6).toFixed(0);
    return `<div class="usage-item">
      <label>${pcfg.name}: monthly tokens (M)</label>
      <input type="number" data-profile="${pid}" data-field="total_m" value="${totalM}" step="10" min="1">
    </div>`;
  }).join('');

  grid.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', () => {
      const pid = inp.dataset.profile;
      const pcfg = DATA.config.profiles[pid];
      const totalM = parseFloat(inp.value) || 0;
      // Apply 3:1 input:output ratio
      state.usage[pid] = {
        monthly_input_tokens: Math.round(totalM * 0.75 * 1e6),
        monthly_output_tokens: Math.round(totalM * 0.25 * 1e6),
      };
      renderTable();
    });
  });
}

// ─── Data freshness badge ─────────────────────────────────────────────────────

function renderDataAge() {
  const el = document.getElementById('data-age');
  const d = DATA.prices_date || DATA.quality_date;
  if (!d) { el.textContent = ''; return; }
  const days = (Date.now() - new Date(d)) / 86400000;
  if (days > 8) {
    el.textContent = `⚠ data ${Math.floor(days)}d old — run refresh scripts`;
    el.classList.add('stale');
  } else {
    el.textContent = `updated ${d}`;
  }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

async function init() {
  try {
    const res = await fetch('data/models.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DATA = await res.json();
  } catch (e) {
    document.getElementById('app').innerHTML =
      `<div style="padding:40px;color:#f87171;font-family:monospace">
        <h2>Could not load data/models.json</h2>
        <p style="margin-top:8px">Run: <code>python3 refresh/fetch_prices.py && python3 refresh/fetch_quality.py && python3 refresh/build_data.py</code></p>
        <p style="margin-top:4px">Then serve from the project root: <code>python3 -m http.server 8080</code></p>
        <pre style="margin-top:12px;opacity:.6">${e.message}</pre>
      </div>`;
    return;
  }

  // Init state from config
  state.budgetMax = DATA.config.budget_ceiling_usd_month ?? 200;
  document.getElementById('budget-input').value = state.budgetMax;

  // Profile tabs
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach(tab => {
    tab.classList.toggle('active', tab.dataset.profile === state.profile);
    tab.addEventListener('click', () => {
      state.profile = tab.dataset.profile;
      state.selectedId = null;
      closeDrawer();
      tabs.forEach(t => t.classList.toggle('active', t.dataset.profile === state.profile));
      renderTable();
    });
  });

  // Budget
  document.getElementById('budget-input').addEventListener('input', e => {
    state.budgetMax = parseFloat(e.target.value) || 0;
    renderTable();
    renderSubscriptions();
  });

  // Unit toggle
  document.querySelectorAll('.unit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.unitMode = btn.dataset.unit;
      document.querySelectorAll('.unit-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.unit === state.unitMode));
      updatePriceHeader();
      renderTable();
    });
  });

  // Hermes filter
  document.getElementById('hermes-filter').addEventListener('change', e => {
    state.hermesOnly = e.target.checked;
    renderTable();
  });

  // Provider filter
  document.getElementById('provider-filter').addEventListener('input', e => {
    state.providerFilter = e.target.value;
    renderTable();
  });

  // Name filter
  document.getElementById('name-filter').addEventListener('input', e => {
    state.nameFilter = e.target.value;
    renderTable();
  });

  // Usage toggle
  document.getElementById('usage-toggle').addEventListener('click', () => {
    const panel = document.getElementById('usage-panel');
    const arrow = document.getElementById('usage-arrow');
    panel.classList.toggle('collapsed');
    arrow.textContent = panel.classList.contains('collapsed') ? '▾' : '▴';
  });

  // Sort columns
  document.querySelectorAll('#model-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      if (state.sortCol === th.dataset.sort) {
        state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
      } else {
        state.sortCol = th.dataset.sort;
        state.sortDir = 'desc';
      }
      updateSortIndicators();
      renderTable();
    });
  });

  // Drawer close
  document.getElementById('drawer-close').addEventListener('click', () => {
    closeDrawer();
    renderTable();
  });
  document.getElementById('drawer-overlay').addEventListener('click', () => {
    closeDrawer();
    renderTable();
  });

  // Initial render
  renderDataAge();
  renderUsageEditor();
  updatePriceHeader();
  updateSortIndicators();
  renderTable();
  renderSubscriptions();
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}

// CommonJS exports for unit tests (ignored in browser where module is undefined)
if (typeof module !== 'undefined') {
  module.exports = {
    computeScore, computeCost, computeAvgCostPerMtok,
    enrichModels, filterRows, sortRows,
    stars, fmtCost,
    _setDATA: (d) => { DATA = d; },
    _setState: (s) => { Object.assign(state, s); },
  };
}
