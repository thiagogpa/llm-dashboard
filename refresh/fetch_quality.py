#!/usr/bin/env python3
"""Fetch model quality scores from llm-stats.com API → data/quality.json

Requires LLM_STATS_API_KEY env var (get one free at https://llm-stats.com/developer).
Without a key, falls back to data/quality_seed.json if it exists.
"""
import json
import os
import sys
from datetime import date
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import HTTPError

BASE_URL = "https://api.llm-stats.com/stats/v1"
OUTPUT = Path(__file__).parent.parent / "data" / "quality.json"
SEED = Path(__file__).parent.parent / "data" / "quality_seed.json"


def fetch_models(api_key):
    url = f"{BASE_URL}/models"
    req = Request(url, headers={
        "Authorization": f"Bearer {api_key}",
        "User-Agent": "llm-dashboard/1.0",
    })
    with urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def fetch_rankings(api_key):
    """Fetch TrueSkill rankings by category for richer per-category scores."""
    results = {}
    for category in ("overall", "reasoning", "coding", "agents"):
        url = f"{BASE_URL}/rankings?category={category}&limit=500"
        req = Request(url, headers={
            "Authorization": f"Bearer {api_key}",
            "User-Agent": "llm-dashboard/1.0",
        })
        try:
            with urlopen(req, timeout=30) as r:
                data = json.loads(r.read())
                for entry in data.get("rankings", data if isinstance(data, list) else []):
                    model_id = entry.get("model_id") or entry.get("id")
                    score = entry.get("score") or entry.get("rating") or entry.get("mu")
                    if model_id and score is not None:
                        if model_id not in results:
                            results[model_id] = {}
                        results[model_id][category] = float(score)
        except Exception as e:
            print(f"  Warning: could not fetch {category} rankings: {e}")
    return results


def parse_models(raw):
    """Parse /models response into our format."""
    model_list = raw if isinstance(raw, list) else raw.get("models", raw.get("data", []))
    models = []
    for m in model_list:
        model_id = m.get("id") or m.get("model_id")
        name = m.get("name") or model_id
        if not model_id:
            continue

        scores_raw = m.get("scores", m.get("category_scores", {}))
        scores = {
            "overall": _get(scores_raw, "overall", "llm_stats_score", "score"),
            "reasoning": _get(scores_raw, "reasoning", "reason"),
            "coding": _get(scores_raw, "coding", "code"),
            "agents": _get(scores_raw, "agents", "agent", "agentic"),
        }

        models.append({"id": model_id, "name": name, "scores": scores})
    return models


def _get(d, *keys):
    for k in keys:
        if k in d and d[k] is not None:
            return float(d[k])
    return None


def main():
    api_key = os.environ.get("LLM_STATS_API_KEY", "").strip()

    if not api_key:
        print("LLM_STATS_API_KEY not set. Get a free key at https://llm-stats.com/developer")
        if SEED.exists():
            print(f"Using seed data from {SEED}")
            data = json.loads(SEED.read_text())
            data["source"] = "seed (no API key)"
            data["fetched_at"] = date.today().isoformat()
            OUTPUT.parent.mkdir(exist_ok=True)
            OUTPUT.write_text(json.dumps(data, indent=2))
            print(f"Wrote {len(data.get('models', []))} models to {OUTPUT}")
        else:
            print("No seed file found. Run with LLM_STATS_API_KEY to fetch live data.")
            sys.exit(1)
        return

    print("Fetching quality scores from llm-stats.com...", flush=True)
    try:
        print("  Fetching models catalog...")
        raw = fetch_models(api_key)
        models = parse_models(raw)

        print("  Fetching per-category rankings...")
        rankings = fetch_rankings(api_key)

        # Merge ranking scores into model scores (rankings override catalog if present)
        for m in models:
            if m["id"] in rankings:
                for cat, val in rankings[m["id"]].items():
                    if val is not None:
                        m["scores"][cat] = val

    except HTTPError as e:
        print(f"ERROR: HTTP {e.code} from llm-stats API: {e.reason}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    OUTPUT.parent.mkdir(exist_ok=True)
    OUTPUT.write_text(json.dumps({
        "fetched_at": date.today().isoformat(),
        "source": "llm-stats.com",
        "count": len(models),
        "models": models,
    }, indent=2))
    print(f"Wrote {len(models)} models to {OUTPUT}")


if __name__ == "__main__":
    main()
