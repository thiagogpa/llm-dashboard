#!/usr/bin/env python3
import pytest
from build_data import (
    normalize,
    build_quality_index,
    match_quality,
    fill_overall,
    profile_score,
    monthly_cost,
)


# ── normalize ─────────────────────────────────────────────────────────────────

class TestNormalize:
    def test_strips_provider_prefix(self):
        assert normalize("anthropic/claude-opus-4.7") == "claude opus 4.7"

    def test_strips_display_prefix(self):
        assert normalize("Anthropic: Claude Opus 4.7") == "claude opus 4.7"

    def test_preserves_version_numbers(self):
        assert "4.7" in normalize("claude-opus-4.7")
        assert "3.5" in normalize("gpt-3.5-turbo")
        assert "2.5" in normalize("gemini-2.5-pro")

    def test_no_false_match_gpt35_vs_gpt55(self):
        # The bug that fuzzy matching used to cause
        assert normalize("openai/gpt-3.5-turbo") != normalize("gpt-5.5")

    def test_removes_noise_words(self):
        result = normalize("mistral-large-instruct-2512")
        assert "instruct" not in result

    def test_removes_noise_preview(self):
        result = normalize("gemini-3-flash-preview")
        assert "preview" not in result

    def test_removes_noise_free(self):
        result = normalize("qwen/qwen3-coder:free")
        assert "free" not in result

    def test_removes_noise_exp(self):
        result = normalize("deepseek/deepseek-v3.2-exp")
        assert "exp" not in result

    def test_lowercases(self):
        assert normalize("Claude-Opus") == normalize("claude-opus")

    def test_collapses_whitespace(self):
        result = normalize("claude  opus")
        assert "  " not in result
        assert result == result.strip()

    def test_empty_string(self):
        assert normalize("") == ""

    def test_alias_tilde_passthrough(self):
        # normalize doesn't skip ~, that's done in main(); just check it doesn't crash
        result = normalize("~anthropic/claude-opus-4.7")
        assert isinstance(result, str)

    def test_multi_digit_version(self):
        assert "235b" in normalize("qwen/qwen3-235b-a22b")

    def test_version_with_dot_preserved_across_noise_strip(self):
        # "4.7" must survive noise word removal around it
        assert "4.7" in normalize("claude-opus-4.7-beta")


# ── fill_overall ──────────────────────────────────────────────────────────────

class TestFillOverall:
    def test_does_nothing_when_overall_present(self):
        scores = {"overall": 50.0, "reasoning": 60.0, "coding": 40.0}
        fill_overall(scores)
        assert scores["overall"] == 50.0

    def test_estimates_from_sub_scores(self):
        scores = {"overall": None, "reasoning": 60.0, "coding": 40.0}
        fill_overall(scores)
        expected = round((60.0 + 40.0) / 2 * 1.19, 2)
        assert scores["overall"] == expected

    def test_ignores_none_sub_scores(self):
        scores = {"overall": None, "reasoning": 60.0, "coding": None, "agents": None}
        fill_overall(scores)
        expected = round(60.0 * 1.19, 2)
        assert scores["overall"] == expected

    def test_does_nothing_when_all_sub_scores_none(self):
        scores = {"overall": None, "reasoning": None}
        fill_overall(scores)
        assert scores["overall"] is None

    def test_single_sub_score(self):
        scores = {"overall": None, "coding": 50.0}
        fill_overall(scores)
        assert scores["overall"] == round(50.0 * 1.19, 2)


# ── profile_score ─────────────────────────────────────────────────────────────

class TestProfileScore:
    def test_single_weight(self):
        scores = {"coding": 80.0}
        assert profile_score(scores, {"coding": 1.0}) == 80.0

    def test_equal_weights(self):
        scores = {"coding": 60.0, "reasoning": 40.0}
        result = profile_score(scores, {"coding": 0.5, "reasoning": 0.5})
        assert result == 50.0

    def test_unequal_weights(self):
        scores = {"agents": 60.0, "reasoning": 40.0}
        result = profile_score(scores, {"agents": 0.6, "reasoning": 0.4})
        expected = round((60.0 * 0.6 + 40.0 * 0.4) / (0.6 + 0.4), 2)
        assert result == expected

    def test_missing_score_reduces_weight(self):
        # If one category is missing, total weight is reduced proportionally
        scores = {"coding": 80.0, "reasoning": None}
        result = profile_score(scores, {"coding": 0.5, "reasoning": 0.5})
        assert result == 80.0  # only coding contributes, weight normalised to 0.5/0.5

    def test_all_scores_none_returns_none(self):
        scores = {"coding": None, "reasoning": None}
        assert profile_score(scores, {"coding": 0.5, "reasoning": 0.5}) is None

    def test_empty_weights_returns_none(self):
        assert profile_score({"coding": 80.0}, {}) is None

    def test_returns_rounded_to_2dp(self):
        scores = {"coding": 100.0, "reasoning": 99.0}
        result = profile_score(scores, {"coding": 0.333, "reasoning": 0.667})
        assert result == round(result, 2)


# ── monthly_cost ──────────────────────────────────────────────────────────────

class TestMonthlyCost:
    def test_basic_calculation(self):
        model = {"input_per_mtok": 3.0, "output_per_mtok": 15.0}
        profile = {"monthly_input_tokens": 1_000_000, "monthly_output_tokens": 1_000_000}
        # (3 * 1M + 15 * 1M) / 1M = 18.0
        assert monthly_cost(model, profile) == 18.0

    def test_input_output_ratio(self):
        model = {"input_per_mtok": 3.0, "output_per_mtok": 15.0}
        profile = {"monthly_input_tokens": 15_000_000, "monthly_output_tokens": 5_000_000}
        expected = round((3.0 * 15_000_000 + 15.0 * 5_000_000) / 1_000_000, 4)
        assert monthly_cost(model, profile) == expected

    def test_free_model(self):
        model = {"input_per_mtok": 0.0, "output_per_mtok": 0.0}
        profile = {"monthly_input_tokens": 10_000_000, "monthly_output_tokens": 5_000_000}
        assert monthly_cost(model, profile) == 0.0

    def test_returns_rounded_to_4dp(self):
        model = {"input_per_mtok": 1.0, "output_per_mtok": 1.0}
        profile = {"monthly_input_tokens": 1, "monthly_output_tokens": 1}
        result = monthly_cost(model, profile)
        assert result == round(result, 4)


# ── build_quality_index ───────────────────────────────────────────────────────

class TestBuildQualityIndex:
    def _model(self, id_, name=""):
        return {"id": id_, "name": name, "scores": {"overall": 50.0}}

    def test_indexes_by_normalized_id(self):
        m = self._model("claude-opus-4.7", "Claude Opus 4.7")
        idx = build_quality_index([m], {})
        assert "claude opus 4.7" in idx

    def test_indexes_by_normalized_name(self):
        m = self._model("some-id", "Claude Opus 4.7")
        idx = build_quality_index([m], {})
        assert "claude opus 4.7" in idx

    def test_id_override_applied(self):
        m = self._model("old-id", "Old Name")
        idx = build_quality_index([m], {"old-id": "new-id"})
        assert "new id" in idx

    def test_empty_list(self):
        assert build_quality_index([], {}) == {}

    def test_duplicate_slugs_last_wins(self):
        m1 = self._model("model-a", "Same Name")
        m2 = self._model("model-b", "Same Name")
        idx = build_quality_index([m1, m2], {})
        assert idx["same name"] is m2


# ── match_quality ─────────────────────────────────────────────────────────────

class TestMatchQuality:
    def _qm(self, id_, name=""):
        return {"id": id_, "name": name, "scores": {"overall": 50.0}}

    def test_matches_by_id(self):
        qm = self._qm("claude-opus-4.7")
        idx = build_quality_index([qm], {})
        pm = {"id": "anthropic/claude-opus-4.7", "name": "Claude Opus 4.7"}
        assert match_quality(pm, idx, {}) is qm

    def test_matches_by_name(self):
        qm = self._qm("x", "Claude Opus 4.7")
        idx = build_quality_index([qm], {})
        pm = {"id": "anthropic/claude-opus-4.7", "name": "Claude Opus 4.7"}
        assert match_quality(pm, idx, {}) is qm

    def test_no_match_returns_none(self):
        idx = {}
        pm = {"id": "unknown/model", "name": "Unknown Model"}
        assert match_quality(pm, idx, {}) is None

    def test_id_override_used_first(self):
        qm = self._qm("override-target")
        idx = build_quality_index([qm], {})
        pm = {"id": "anthropic/some-model", "name": "Some Model"}
        overrides = {"anthropic/some-model": "override-target"}
        assert match_quality(pm, idx, overrides) is qm

    def test_alias_model_not_matched_by_tilde(self):
        # ~ models are skipped in main(); match_quality itself can still try —
        # but they should NOT appear in the quality index
        idx = {}
        pm = {"id": "~anthropic/claude-opus-4.7", "name": "Claude Opus 4.7"}
        assert match_quality(pm, idx, {}) is None

    def test_no_false_positive_gpt35_vs_gpt55(self):
        qm = self._qm("gpt-5.5", "GPT-5.5")
        idx = build_quality_index([qm], {})
        pm = {"id": "openai/gpt-3.5-turbo", "name": "GPT-3.5 Turbo"}
        assert match_quality(pm, idx, {}) is None
