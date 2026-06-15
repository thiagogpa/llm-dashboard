#!/usr/bin/env python3
"""Fetch model pricing from OpenRouter API → data/prices.json"""
import json
import sys
from datetime import date
from pathlib import Path
from urllib.request import urlopen, Request

OUTPUT = Path(__file__).parent.parent / "data" / "prices.json"
URL = "https://openrouter.ai/api/v1/models"


def fetch():
    req = Request(URL, headers={"HTTP-Referer": "llm-dashboard", "User-Agent": "llm-dashboard/1.0"})
    with urlopen(req, timeout=30) as r:
        return json.loads(r.read())["data"]


def parse(raw):
    models = []
    for m in raw:
        pricing = m.get("pricing", {})
        prompt = pricing.get("prompt", "-1")
        completion = pricing.get("completion", "-1")

        if prompt == "-1" or completion == "-1":
            continue

        try:
            input_per_mtok = float(prompt) * 1_000_000
            output_per_mtok = float(completion) * 1_000_000
        except (ValueError, TypeError):
            continue

        model_id = m["id"]
        provider = model_id.split("/")[0] if "/" in model_id else "unknown"

        models.append({
            "id": model_id,
            "name": m.get("name", model_id),
            "provider": provider,
            "input_per_mtok": round(input_per_mtok, 6),
            "output_per_mtok": round(output_per_mtok, 6),
            "is_free": input_per_mtok == 0 and output_per_mtok == 0,
            "context_length": m.get("context_length"),
        })

    return sorted(models, key=lambda x: x["name"])


def main():
    print("Fetching prices from OpenRouter...", flush=True)
    try:
        raw = fetch()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    models = parse(raw)
    OUTPUT.parent.mkdir(exist_ok=True)
    OUTPUT.write_text(json.dumps({
        "fetched_at": date.today().isoformat(),
        "source": "openrouter.ai/api/v1/models",
        "count": len(models),
        "models": models,
    }, indent=2))
    print(f"Wrote {len(models)} models to {OUTPUT}")


if __name__ == "__main__":
    main()
