# LLM Model Dashboard — Implementation Plan

A personal, interactive dashboard to pick the best-value LLM **per task** —
primarily to feed your **Hermes** model slots and your own coding — comparing
**flat-rate subscriptions vs token pricing**, across **Western and leading
Chinese** models, with budget-first sorting and "find me a cheaper equivalent."

Project root: `~/llm-dashboard/`

---

## 1. Profiles

Profiles map 1:1 to the model slots Hermes actually exposes (confirmed by
reading `~/.hermes/hermes-agent/`: one `model.default`, one global
`delegation.model` for all subagents, and the per-invocation `--model`).

| Profile | Hermes slot | Quality basis (AA categories) | Price sensitivity | Default weighting |
|---|---|---|---|---|
| **Orchestrator** | `model.default` | agents + reasoning | low | 60% agents / 40% reasoning |
| **Subagent** | `delegation.model` (one global) | general + coding | **high** | 50% general / 50% coding |
| **Coding (you)** | CLI `--model` | AA Coding Index | medium | 100% Coding Index |
| **Overall** | reference | full Intelligence Index | — | AA Intelligence Index as-is |

- Weightings live in editable config; the table values are defaults, not hard-coded logic.
- Anchors default to **Opus 4.7** (planning) / **Sonnet 4.6** (execution), **swappable** per profile.
- MoA pool is **out of v1** (Hermes `REFERENCE_MODELS` list) — easy to add later.

---

## 2. Data Layers

The UI reads pre-built JSON only — never calls APIs or holds keys.

| File | Source | Method | Cadence |
|---|---|---|---|
| `data/prices.json` | OpenRouter `/api/v1/models` | Deterministic cron script (HTTP → parse) | weekly |
| `data/quality.json` | Artificial Analysis (Intelligence Index v4.0 categories + Coding Index) | Deterministic cron script; AA key if a free tier exists, else cached scrape | weekly |
| `data/subscriptions.json` | Flat-plan prices incl. Chinese plans | **Hermes routine**, LLM web-research | weekly |

### Provenance (subscriptions especially)
Every subscription entry carries audit fields so prices can be trusted and aged:
```json
{ "plan": "Claude Pro", "price_usd_month": 20,
  "source_url": "https://...", "fetched_at": "2026-06-15",
  "confidence": "verified" }
```
Anything past its weekly window shows a ⚠️ staleness badge in the UI.

### Refresh principle
Never use an LLM for work a deterministic API call already does. Prices and
quality are plain scripts; only subscription research (genuine web lookup) is a
Hermes routine. A failure in one job never blocks the others.

---

## 3. Scope

- **Universe** = models with **both** a price and an AA quality score (~130,
  includes major Chinese models: DeepSeek, Qwen, GLM/zai, Kimi/Moonshot, MiniMax).
- Priced-but-unscored models are excluded from v1 (can't be ranked/compared).
- **"✓ Hermes-ready" badge** tags models Hermes can actually run (anthropic,
  openai, gemini, deepseek, zai, kimi, minimax, qwen, openrouter, opencode-zen,
  …). Not a hard filter — a badge — so models you'd use outside Hermes stay visible.

---

## 4. Core Features

### Best-per-task & overall
Sortable ranking; quality basis switches with the active profile.

### Budget-first sorting
- Each profile carries a **usage estimate**: monthly token volume + input:output
  ratio (default 3:1). This projects token-priced models into **$/month**.
- `$/Mtok ⟷ $/month` unit toggle; in $/month mode, token models and
  subscriptions sit in one comparable column.
- **One global per-item budget ceiling**: hides any single model/plan whose
  (projected) monthly cost exceeds the ceiling. (Per-item cap, not a summed total.)
- **Value** = active-profile quality ÷ projected monthly cost, normalized to
  5 stars. Default sort is Value descending — this is what surfaces
  cheap-but-good models.

### Equivalence ("find a cheaper equal")
Pick a model as anchor → models scoring **≥90% of the anchor on the active
profile's weighted score**, **cheaper only**, ranked by price ascending.
- Threshold 90% (config; loosenable to 85%).
- ⚠️ flag if a match falls below the profile's quality floor (the anchor).
- Per-profile: equivalence "for coding" uses the Coding Index; "for
  orchestration" uses agents+reasoning.

---

## 5. UI — Static Single-Page App + Drawer

No live API calls in the browser. Opens as files or via `python -m http.server`.

```
┌────────────────────────────────────────────────────────┐
│ [Orchestrator] Subagent  Coding  Overall  ← profile     │
│ Budget ≤ $[210]/mo   Units:(○$/Mtok ◉$/mo)  ☑Hermes-ready│
│ Usage: 40M tok/mo · 3:1 ▾              🔍 filter provider │
├────────────────────────────────────────────────────────┤
│ #  Model         Prov ✓  Quality     $/mo  Value         │
│ 1  Opus 4.7      anth ✓  ███████ 64   $210  ★★           │
│ 2  DeepSeek V3.2 dpsk ✓  █████   58   $12   ★★★★★  ◄ click│
│ 3  GLM-5         zai  ✓  █████   57    $9   ★★★★★         │
│ 4  Sonnet 4.6    anth ✓  ██████  60   $48   ★★★          │
└────────────────────────────────────────────────────────┘
     click row → drawer: Equivalents to X (active profile),
     ≥90% quality · cheaper only, each with score/price/stars/✓Hermes
```

- **Control bar:** profile lens · budget ceiling · unit toggle · Hermes-ready
  filter · collapsible per-profile usage editor · provider/region filter.
- **Table:** rank · model · provider · ✓Hermes · quality bar (active profile) ·
  price (native or projected) · Value. Any column sortable; anchor highlighted;
  ⚠️ staleness inline.
- **Drawer:** slides in on row click with the equivalence set, scoped to the
  active profile.

---

## 6. Proposed File Structure

```
~/llm-dashboard/
  PLAN.md
  config.json            # profile weightings, anchors, thresholds, usage estimates, budget ceiling
  data/
    prices.json
    quality.json
    subscriptions.json
  refresh/
    fetch_prices.py      # OpenRouter → prices.json
    fetch_quality.py     # Artificial Analysis → quality.json
    # subscriptions refreshed by a Hermes routine (see §7)
  web/
    index.html
    app.js               # load JSON, profile lens, sort/filter, projection, equivalence drawer
    style.css
```

`config.json` holds everything tunable (weightings, anchors, 90% threshold,
3:1 ratio, per-profile monthly volume, global budget ceiling) so behavior
changes without touching code.

---

## 7. Build Sequence (each step independently verifiable)

1. **Config + schema** → write `config.json` and the three JSON schemas.
   *Verify:* schemas documented; a hand-made tiny `prices.json`/`quality.json` validates.
2. **`fetch_prices.py`** → pull OpenRouter, write `prices.json`.
   *Verify:* file lists 300+ models with input/output prices per provider.
3. **`fetch_quality.py`** → pull/cache Artificial Analysis category scores.
   *Verify:* ~130 models with agents/coding/general/science + Coding Index; confirm AA access (key vs scrape).
4. **Join + scope** → intersect price∩quality, tag Hermes-ready.
   *Verify:* ~130 rows, each with price + score; Chinese models present; badge correct against Hermes provider list.
5. **Static UI shell** → table renders from JSON, profile lens re-ranks.
   *Verify:* switching profile changes quality column and order.
6. **Budget/usage/projection** → unit toggle, $/mo projection, ceiling filter, Value/stars.
   *Verify:* a cheap-but-good model sorts to the top; raising the ceiling reveals expensive ones.
7. **Equivalence drawer** → click anchor → ≥90% cheaper matches, per profile.
   *Verify:* pick Opus 4.7 (Orchestrator) → returns cheaper ≥90% models; switch to Coding profile → set changes.
8. **Hermes subscription routine** → schedule weekly web-research job writing `subscriptions.json` with provenance.
   *Verify:* file populated incl. Chinese plans, each with source_url + fetched_at; ⚠️ badge appears when stale.
9. **Cron wiring** → weekly schedule for prices + quality scripts.
   *Verify:* jobs run end-to-end; UI reflects fresh data.

---

## 8. Open Items to Confirm at Build Time

- **Artificial Analysis access**: confirm whether a free API key exists; if not,
  decide scrape-and-cache vs paid tier (affects step 3).
- **AA category granularity**: verify the API/site exposes per-model *category*
  sub-scores (agents/coding/general/science), not just the single index — the
  per-profile weighting depends on it. Fall back to Coding Index + overall if not.
- **Subscription plan list**: finalize which plans to track (Claude Pro/Max,
  ChatGPT Plus/Pro, Gemini, zai/GLM, Kimi, MiniMax, Qwen, …).
