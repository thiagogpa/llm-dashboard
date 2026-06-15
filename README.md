# LLM Dashboard

A personal, self-hosted dashboard for comparing LLM models by quality, cost, and value — tailored to real usage patterns rather than generic benchmarks.

## Features

- **Four evaluation profiles** — rank models differently depending on the workload:
  - **Orchestrator** — main agent planning & coordination (60% agents + 40% reasoning)
  - **Subagent** — delegated subtasks (50% coding + 50% reasoning)
  - **Coding** — personal coding sessions (100% coding score)
  - **Overall** — general-purpose reference ranking
- **Usage-aware cost estimation** — monthly cost calculated from real token volumes per profile; live re-ranking as you adjust in the usage editor
- **Budget filter** — slider to hide models above your monthly or per-million-token ceiling
- **Equivalence drawer** — click any model to see cheaper alternatives that reach ≥90% of its quality score, with cost savings shown
- **Subscription plans panel** — flat-rate plans (Claude Pro/Max, ChatGPT Plus/Pro, Gemini Advanced, DeepSeek, Kimi, etc.) with staleness tracking
- **Hermes integration** — highlights models with native Hermes provider support; profiles map directly to Hermes config slots
- **Mobile-friendly** — responsive layout tested on iPhone-sized screens

## Data pipeline

Data is refreshed in three steps:

```
fetch_prices.py   →   data/prices.json    (OpenRouter API)
fetch_quality.py  →   data/quality.json   (llm-stats.com API)
build_data.py     →   data/models.json    (merged, scored, normalised)
```

### Price data

`refresh/fetch_prices.py` pulls from the [OpenRouter API](https://openrouter.ai) (no key required). All prices are in USD per million tokens.

### Quality data

`refresh/fetch_quality.py` pulls TrueSkill rankings from [llm-stats.com](https://llm-stats.com). Requires a free API key:

```bash
export LLM_STATS_API_KEY=your_key_here
```

Without a key, the script falls back to `data/quality_seed.json` (bundled baseline scores). Models scored from seed data are tagged with an `est` badge in the UI.

### Build step

`refresh/build_data.py` joins the two datasets:

- Normalises model name slugs to match pricing entries to quality entries
- Estimates missing `overall` scores as `avg(sub-scores) × 1.19`
- Computes per-profile weighted scores and monthly costs
- Normalises value scores on a 0–5 scale (best-value model = 5 stars)

Run all three steps at once:

```bash
bash refresh/refresh_all.sh
```

## Quick start

```bash
# 1. Fetch data
export LLM_STATS_API_KEY=your_key_here   # optional, falls back to seed
bash refresh/refresh_all.sh

# 2. Serve
python3 -m http.server 8080

# 3. Open
open http://localhost:8080
```

## Docker deployment

A `docker-compose.yaml` is included at the project root. It serves the dashboard with nginx:alpine and integrates with a Traefik reverse proxy:

```bash
# Edit the Host rule in docker-compose.yaml to match your domain, then:
docker compose up -d
```

The container mounts the project directory read-only, so updating `data/models.json` on the host is immediately reflected — no restart needed.

## Automated weekly refresh

Two cron jobs handle weekly data updates:

| Job | Schedule | What it does |
|-----|----------|--------------|
| `llm-dashboard data refresh` | Sun 3:00 AM | Runs `refresh_all.sh` — fetches prices, quality, rebuilds `models.json` |
| `llm-dashboard subscription refresh` | Sun 4:00 AM | LLM agent visits provider pricing pages and updates `subscriptions.json` |

### Manual subscription refresh

Subscription prices are not available via API. Use the prompt below with any capable LLM (Claude, GPT-4, etc.) to update them. Copy and send as-is — the prompt is self-contained:

---

> Research current LLM subscription plan prices and update `/path/to/llm-dashboard/data/subscriptions.json`.
>
> First, read the current file to see existing entries. Then visit each provider's official pricing page and verify the current monthly price in USD:
>
> - Claude Pro / Max: https://claude.ai/upgrade
> - ChatGPT Plus / Pro: https://openai.com/chatgpt/pricing
> - Google One AI Premium: https://one.google.com/about/plans
> - DeepSeek Pro: https://chat.deepseek.com
> - Kimi Plus: https://kimi.ai
> - Tongyi Qianwen Plus: https://tongyi.aliyun.com
> - ChatGLM Plus: https://chatglm.cn
> - MiniMax Pro: https://hailuoai.com
>
> For each plan update: `price_usd_month` (convert to USD if shown in CNY), `notable` (key feature summary), `source_url`, `fetched_at` (today's date). Set `confidence` to `"confirmed"` for prices you verified directly, `"estimated"` for prices you couldn't verify.
>
> After updating `subscriptions.json`, run:
> ```
> python3 /path/to/llm-dashboard/refresh/build_data.py
> ```
>
> Report a summary of what changed (price increases, decreases, new plans, failed lookups).

---

## Configuration

Edit `config.json` to customise profiles, token volumes, or budget ceiling:

```json
{
  "budget_ceiling_usd_month": 200,
  "equivalence_threshold": 0.90,
  "profiles": {
    "orchestrator": {
      "weights": { "agents": 0.60, "reasoning": 0.40 },
      "monthly_input_tokens": 15000000,
      "monthly_output_tokens": 5000000
    }
  }
}
```

After changing token volumes or weights, re-run `build_data.py` to rebuild `models.json`.

## Tests

```bash
make test       # run all tests
make test-py    # pytest — build_data.py scoring and normalisation
make test-js    # node:test — app.js filtering, sorting, rendering helpers
```

The test suite covers scoring edge cases (null scores, renormalised weights), cost calculations, value normalisation, equivalence filtering, and all sort/filter combinations.

> [!NOTE]
> `quality_seed.json` and `subscriptions.json` are version-controlled as source-of-truth data. The auto-generated files (`prices.json`, `quality.json`, `models.json`) are gitignored.
