#!/bin/bash
set -e
cd "$(dirname "$0")/.."
echo "[$(date)] Starting LLM dashboard data refresh"
python3 refresh/fetch_prices.py
python3 refresh/fetch_quality.py
python3 refresh/build_data.py
echo "[$(date)] Done"
