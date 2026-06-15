#!/usr/bin/env python3
"""Join prices + quality + subscriptions → data/models.json (what the UI reads)"""
import json
import re
from datetime import date
from pathlib import Path

ROOT = Path(__file__).parent.parent
PRICES = ROOT / "data" / "prices.json"
QUALITY = ROOT / "data" / "quality.json"
SUBS = ROOT / "data" / "subscriptions.json"
CONFIG = ROOT / "config.json"
OUTPUT = ROOT / "data" / "models.json"

HERMES_NATIVE = {
    "anthropic": "anthropic", "openai": "openai-codex", "google": "gemini",
    "deepseek": "deepseek", "moonshotai": "kimi-coding", "moonshot": "kimi-coding",
    "minimax": "minimax", "qwen": "qwen-oauth", "alibaba": "alibaba",
    "zhipu": "zai", "stepfun": "stepfun", "nvidia": "nvidia",
    "xiaomi": "xiaomi", "x-ai": "xai", "xai": "xai",
    "novita": "novita", "arcee": "arcee", "microsoft": "azure-foundry",
}

_NOISE = re.compile(
    r"\b(preview|latest|instruct|chat|beta|alpha|exp|experimental|thinking"
    r"|free|turbo|online|fast|high|codeinterp|customtools|search|image"
    r"|thinking2507|0905|0711)\b"
)
# Protect digit.digit version numbers (e.g. "3.5" → "3V5") before stripping non-alnum
_VER_DOT = re.compile(r"(\d)\.(\d)")
_NON_ALNUM = re.compile(r"[^a-z0-9]")


def normalize(text):
    """Normalize name/id to a slug preserving version numbers like '4.7'."""
    s = text.lower()
    if "/" in s:
        s = s.split("/", 1)[1]         # strip provider prefix
    if ": " in s:
        s = s.split(": ", 1)[1]        # strip "Anthropic: " display prefix
    s = _NOISE.sub(" ", s)
    s = _VER_DOT.sub(r"\1v\2", s)      # "4.7" → "4v7" (all lowercase, safe)
    s = _NON_ALNUM.sub(" ", s)
    s = s.replace(" v ", ".")           # "4 v 7" → but we want "4v7" → hmm
    # Restore version dots: "4v7" → "4.7"
    s = re.sub(r"(\d)v(\d)", r"\1.\2", s)
    return " ".join(s.split())


def build_quality_index(quality_models, id_overrides):
    idx = {}
    for m in quality_models:
        qid = id_overrides.get(m["id"], m["id"])
        for text in (qid, m.get("name", "")):
            if text:
                slug = normalize(text)
                if slug:
                    idx[slug] = m
    return idx


def match_quality(price_model, quality_idx, id_overrides):
    pid = price_model["id"]
    pname = price_model["name"]

    if pid in id_overrides:
        s = normalize(id_overrides[pid])
        if s in quality_idx:
            return quality_idx[s]

    for text in (pid, pname):
        s = normalize(text)
        if s in quality_idx:
            return quality_idx[s]

    return None


def fill_overall(scores):
    """Estimate overall from sub-scores when missing (×1.19 corrects for missing benchmarks)."""
    if scores.get("overall") is not None:
        return
    sub = [v for k, v in scores.items() if k != "overall" and v is not None]
    if sub:
        scores["overall"] = round(sum(sub) / len(sub) * 1.19, 2)


def profile_score(scores, weights):
    total_w = total_s = 0.0
    for cat, w in weights.items():
        v = scores.get(cat)
        if v is not None:
            total_s += v * w
            total_w += w
    return round(total_s / total_w, 2) if total_w else None


def monthly_cost(model, profile_cfg):
    cost = (
        model["input_per_mtok"] * profile_cfg["monthly_input_tokens"]
        + model["output_per_mtok"] * profile_cfg["monthly_output_tokens"]
    ) / 1_000_000
    return round(cost, 4)


def main():
    if not PRICES.exists():
        print("ERROR: data/prices.json missing — run refresh/fetch_prices.py first")
        return
    if not QUALITY.exists():
        print("ERROR: data/quality.json missing — run refresh/fetch_quality.py first")
        return

    prices_data = json.loads(PRICES.read_text())
    quality_data = json.loads(QUALITY.read_text())
    config = json.loads(CONFIG.read_text())
    subs_data = json.loads(SUBS.read_text()) if SUBS.exists() else {"plans": []}

    id_overrides = config.get("id_overrides", {})
    profiles = config["profiles"]
    quality_models = quality_data["models"]

    for qm in quality_models:
        fill_overall(qm["scores"])

    quality_idx = build_quality_index(quality_models, id_overrides)

    unmatched = 0
    models = []

    for pm in prices_data["models"]:
        if pm["id"].startswith("~"):
            continue  # skip alias/redirect models

        qm = match_quality(pm, quality_idx, id_overrides)
        if not qm:
            unmatched += 1
            continue

        scores = dict(qm["scores"])
        hermes_provider = HERMES_NATIVE.get(pm["provider"])

        profile_scores, profile_costs, profile_values = {}, {}, {}
        for pid, pcfg in profiles.items():
            ps = profile_score(scores, pcfg["weights"])
            pc = monthly_cost(pm, pcfg)
            profile_scores[pid] = ps
            profile_costs[pid] = pc
            profile_values[pid] = round(ps / pc, 6) if (ps and pc and pc > 0) else None

        models.append({
            "id": pm["id"],
            "name": pm["name"],
            "provider": pm["provider"],
            "hermes_ready": hermes_provider is not None,
            "hermes_provider": hermes_provider,
            "input_per_mtok": pm["input_per_mtok"],
            "output_per_mtok": pm["output_per_mtok"],
            "is_free": pm.get("is_free", False),
            "context_length": pm.get("context_length"),
            "scores": scores,
            "data_quality": qm.get("data_quality", "unknown"),
            "profile_scores": profile_scores,
            "profile_costs": profile_costs,
            "profile_values": profile_values,
        })

    models.sort(key=lambda m: m["profile_scores"].get("overall") or 0, reverse=True)

    for pid in profiles:
        vals = [m["profile_values"][pid] for m in models if m["profile_values"].get(pid)]
        if not vals:
            continue
        max_val = max(vals)
        if max_val > 0:
            for m in models:
                v = m["profile_values"].get(pid)
                if v is not None:
                    m["profile_values"][pid] = round(v / max_val * 5, 2)

    OUTPUT.parent.mkdir(exist_ok=True)
    OUTPUT.write_text(json.dumps({
        "generated_at": date.today().isoformat(),
        "prices_date": prices_data.get("fetched_at"),
        "quality_date": quality_data.get("fetched_at"),
        "quality_source": quality_data.get("source"),
        "subs_date": subs_data.get("fetched_at"),
        "model_count": len(models),
        "unmatched_price_only": unmatched,
        "models": models,
        "subscriptions": subs_data.get("plans", []),
        "config": config,
    }, indent=2))
    print(f"Built {len(models)} models ({unmatched} skipped) → {OUTPUT}")


if __name__ == "__main__":
    main()
