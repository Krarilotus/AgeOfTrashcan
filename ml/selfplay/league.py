from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

import math
import random

@dataclass(slots=True)
class StrategyProfile:
    archetype: str = "balanced"
    codename: str = "Balanced Vanguard"
    aggression: float = 0.5
    teching: float = 0.5
    defense: float = 0.5
    action_mix: Dict[str, float] = field(default_factory=dict)


@dataclass(slots=True)
class LeagueEntry:
    checkpoint_path: str
    steps: int
    elo: float = 1000.0
    winrate_vs_smart: float = 0.0
    games_played: int = 0
    score_sum: float = 0.0
    profile: StrategyProfile = field(default_factory=StrategyProfile)
    novelty: float = 0.0
    promoted: bool = False
    source: str = "checkpoint"
    use_checkpoint: bool = True
    difficulty: str | None = None
    fixed: bool = False


class LeaguePool:
    def __init__(
        self,
        keep_top_n: int = 5,
        keep_diverse_n: int = 5,
        max_agents: int = 10,
        min_promote_winrate: float = 0.55,
        archetype_winrate_floor: float = 0.52,
        arbiters_csv: str = "EASY,MEDIUM,HARD,SMART,CHEATER",
        min_games_per_agent: int = 3,
        elo_random_factor: float = 0.15,
        use_checkpoint_opponents: bool = False,
        spinoffs_per_anchor: int = 0,
        spinoff_noise: float = 0.12,
    ) -> None:
        self.keep_top_n = max(1, int(keep_top_n))
        self.keep_diverse_n = max(0, int(keep_diverse_n))
        self.max_agents = max(self.keep_top_n, int(max_agents))
        self.min_promote_winrate = float(min_promote_winrate)
        self.archetype_winrate_floor = float(archetype_winrate_floor)
        self.arbiters_csv = str(arbiters_csv or "").strip()
        self.min_games_per_agent = max(1, int(min_games_per_agent))
        self.elo_random_factor = max(0.0, min(1.0, float(elo_random_factor)))
        self.use_checkpoint_opponents = bool(use_checkpoint_opponents)
        self.spinoffs_per_anchor = max(0, int(spinoffs_per_anchor))
        self.spinoff_noise = max(0.0, float(spinoff_noise))
        self.entries: List[LeagueEntry] = []
        self.baseline_entries: List[LeagueEntry] = self._build_baseline_entries()
        self.disabled_baselines: Set[str] = set()
        self.sample_counts: Dict[str, int] = {}

    def add_checkpoint(
        self,
        checkpoint_path: str,
        steps: int,
        winrate_vs_smart: float,
        profile: StrategyProfile | None = None,
    ) -> LeagueEntry:
        profile = profile or StrategyProfile()
        normalized_winrate = self._clamp(float(winrate_vs_smart), 0.0, 1.0)
        seeded_elo = 1000.0 + max(-200.0, min(250.0, (normalized_winrate - 0.5) * 500.0))
        existing = self._find_checkpoint_entry(checkpoint_path)
        if existing is not None:
            existing.steps = max(int(existing.steps), int(steps))
            existing.profile = profile
            existing.source = "checkpoint"
            existing.use_checkpoint = True
            existing.fixed = False
            if int(existing.games_played) <= 0:
                existing.winrate_vs_smart = normalized_winrate
                existing.elo = self._clamp(seeded_elo, 700.0, 1900.0)
            else:
                blend = 0.15
                existing.winrate_vs_smart = self._clamp(
                    (1.0 - blend) * float(existing.winrate_vs_smart) + blend * normalized_winrate,
                    0.0,
                    1.0,
                )
            existing.novelty = self._compute_novelty(existing)
            self._prune_diverse()
            return existing

        entry = LeagueEntry(
            checkpoint_path=checkpoint_path,
            steps=steps,
            elo=seeded_elo,
            winrate_vs_smart=normalized_winrate,
            profile=profile,
            source="checkpoint",
            use_checkpoint=True,
        )
        entry.novelty = self._compute_novelty(entry)
        self.entries.append(entry)
        self._prune_diverse()
        return entry

    def record_training_match(self, opponent: LeagueEntry | None, learner_score: float) -> None:
        if opponent is None:
            return
        entry = self._resolve_entry_for_update(opponent)
        if entry is None:
            return
        learner_score = self._clamp(float(learner_score), 0.0, 1.0)
        opponent_score = 1.0 - learner_score

        expected_opp = 1.0 / (1.0 + pow(10.0, (1000.0 - float(entry.elo)) / 400.0))
        k_factor = 24.0 if entry.fixed else 18.0
        entry.elo = self._clamp(float(entry.elo) + k_factor * (opponent_score - expected_opp), 700.0, 1900.0)

        entry.games_played = max(0, int(entry.games_played)) + 1
        entry.score_sum = max(0.0, float(entry.score_sum)) + opponent_score
        empirical_winrate = self._clamp(entry.score_sum / max(1, entry.games_played), 0.0, 1.0)
        ema_alpha = 0.08
        entry.winrate_vs_smart = self._clamp(
            (1.0 - ema_alpha) * float(entry.winrate_vs_smart) + ema_alpha * empirical_winrate,
            0.0,
            1.0,
        )
        if not entry.fixed and entry in self.entries:
            entry.novelty = self._compute_novelty(entry)
            self._prune_diverse()

    def promote_if_qualified(self, candidate: LeagueEntry, top3_baseline: List[float]) -> bool:
        if candidate.winrate_vs_smart < self.min_promote_winrate:
            is_archetype_champion = self._is_archetype_champion(candidate)
            if not is_archetype_champion or candidate.winrate_vs_smart < self.archetype_winrate_floor:
                return False
        if top3_baseline and min(top3_baseline) > candidate.winrate_vs_smart:
            is_archetype_champion = self._is_archetype_champion(candidate)
            if not is_archetype_champion:
                return False

        candidate.promoted = True
        if candidate not in self.entries:
            self.entries.append(candidate)
        self._prune_diverse()
        return True

    def top(self, n: int) -> List[LeagueEntry]:
        if n <= 0:
            return []
        return sorted(self.entries, key=self._rank_tuple, reverse=True)[:n]

    def sample_opponent(self, current_checkpoint: Optional[str]) -> Optional[LeagueEntry]:
        full_roster = self._all_entries()
        if not full_roster:
            return None
        candidates = [entry for entry in full_roster if entry.checkpoint_path != current_checkpoint]
        if not candidates:
            candidates = full_roster
        expanded_candidates = self._expanded_sampling_pool(candidates)
        if not expanded_candidates:
            return None

        cycle_keys = {self._cycle_key(item) for item in expanded_candidates}
        self._prune_sample_counts(cycle_keys)
        underplayed_keys = {
            key for key in cycle_keys if self.sample_counts.get(key, 0) < self.min_games_per_agent
        }
        if not underplayed_keys:
            for key in cycle_keys:
                self.sample_counts[key] = 0
            underplayed_keys = set(cycle_keys)
        cycle_filtered = [item for item in expanded_candidates if self._cycle_key(item) in underplayed_keys]
        selection_pool = cycle_filtered if cycle_filtered else expanded_candidates

        entry = self._weighted_pick(selection_pool)
        self.sample_counts[self._cycle_key(entry)] = self.sample_counts.get(self._cycle_key(entry), 0) + 1
        return entry

    def _weighted_pick(self, candidates: List[LeagueEntry]) -> LeagueEntry:
        if len(candidates) == 1:
            return candidates[0]

        weights: List[float] = []
        archetype_counts: Dict[str, int] = {}
        for item in candidates:
            archetype_counts[item.profile.archetype] = archetype_counts.get(item.profile.archetype, 0) + 1

        elos = [float(item.elo) for item in candidates]
        median_elo = float(sorted(elos)[len(elos) // 2]) if elos else 1000.0
        elo_jitter = (random.random() * 2.0 - 1.0) * (120.0 * self.elo_random_factor)
        target_elo = median_elo + elo_jitter
        elo_sigma = max(50.0, 220.0 * max(0.05, self.elo_random_factor))

        for entry in candidates:
            archetype_count = archetype_counts.get(entry.profile.archetype, 1)
            quality = 0.7 + max(0.0, (entry.elo - 900.0) / 500.0)
            novelty = 0.6 + max(0.0, entry.novelty)
            diversity_boost = 1.0 / math.sqrt(archetype_count)
            promotion_boost = 1.15 if entry.promoted else 1.0
            elo_bias = math.exp(-abs(float(entry.elo) - target_elo) / elo_sigma)
            randomness = max(0.05, 1.0 + random.uniform(-self.elo_random_factor, self.elo_random_factor))
            if entry.source == "checkpoint":
                source_boost = 1.0
            elif entry.source == "baseline":
                source_boost = 0.95
            else:
                source_boost = 0.95
            weights.append(
                max(0.01, quality * novelty * diversity_boost * promotion_boost * max(0.05, elo_bias) * randomness)
            )
            weights[-1] *= source_boost
        return random.choices(candidates, weights=weights, k=1)[0]

    def ensure_path(self, path: str) -> None:
        Path(path).parent.mkdir(parents=True, exist_ok=True)

    def roster(self) -> List[LeagueEntry]:
        learned = sorted(self.entries, key=self._rank_tuple, reverse=True)[: self.max_agents]
        combined = [*self._active_baseline_entries(), *learned]
        return sorted(combined, key=self._rank_tuple, reverse=True)

    def set_disabled_baselines(self, disabled: Set[str] | List[str] | Tuple[str, ...]) -> None:
        normalized: Set[str] = set()
        for value in disabled:
            key = str(value).strip().upper()
            if key:
                normalized.add(key)
        self.disabled_baselines = normalized

    def export_state(self) -> Dict[str, object]:
        return {
            "entries": [self._entry_to_dict(entry) for entry in self.entries],
            "baseline_entries": [self._entry_to_dict(entry) for entry in self.baseline_entries],
            "disabled_baselines": sorted(self.disabled_baselines),
            "sample_counts": {str(key): int(value) for key, value in self.sample_counts.items()},
        }

    def import_state(self, state: Dict[str, object] | None) -> None:
        self.entries = []
        self.sample_counts = {}
        self.disabled_baselines = set()
        if not isinstance(state, dict):
            return
        raw_entries = state.get("entries")
        if isinstance(raw_entries, list):
            parsed_entries: List[LeagueEntry] = []
            for raw in raw_entries:
                entry = self._entry_from_dict(raw)
                if entry is None:
                    continue
                if entry.fixed or entry.source == "baseline":
                    continue
                parsed_entries.append(entry)
            self.entries = sorted(parsed_entries, key=self._rank_tuple, reverse=True)[: self.max_agents]
            self._prune_diverse()
        raw_baselines = state.get("baseline_entries")
        if isinstance(raw_baselines, list):
            baseline_map = {
                entry.difficulty: entry
                for entry in self.baseline_entries
                if entry.fixed and isinstance(entry.difficulty, str)
            }
            for raw in raw_baselines:
                parsed = self._entry_from_dict(raw)
                if parsed is None:
                    continue
                if not parsed.fixed:
                    continue
                difficulty = parsed.difficulty if isinstance(parsed.difficulty, str) else None
                if not difficulty:
                    continue
                target = baseline_map.get(difficulty)
                if target is None:
                    continue
                target.elo = float(parsed.elo)
                target.winrate_vs_smart = float(parsed.winrate_vs_smart)
                target.novelty = float(parsed.novelty)
                target.promoted = bool(parsed.promoted)
                target.profile = parsed.profile
        raw_counts = state.get("sample_counts")
        if isinstance(raw_counts, dict):
            for key, value in raw_counts.items():
                if isinstance(key, str):
                    try:
                        self.sample_counts[key] = max(0, int(value))
                    except (TypeError, ValueError):
                        continue
        raw_disabled = state.get("disabled_baselines")
        if isinstance(raw_disabled, list):
            self.set_disabled_baselines({str(item) for item in raw_disabled if isinstance(item, str)})

    def _entry_to_dict(self, entry: LeagueEntry) -> Dict[str, object]:
        return {
            "checkpoint_path": str(entry.checkpoint_path),
            "steps": int(entry.steps),
            "elo": float(entry.elo),
            "winrate_vs_smart": float(entry.winrate_vs_smart),
            "games_played": int(entry.games_played),
            "score_sum": float(entry.score_sum),
            "novelty": float(entry.novelty),
            "promoted": bool(entry.promoted),
            "source": str(entry.source),
            "use_checkpoint": bool(entry.use_checkpoint),
            "difficulty": entry.difficulty if isinstance(entry.difficulty, str) else None,
            "fixed": bool(entry.fixed),
            "profile": {
                "archetype": str(entry.profile.archetype),
                "codename": str(entry.profile.codename),
                "aggression": float(entry.profile.aggression),
                "teching": float(entry.profile.teching),
                "defense": float(entry.profile.defense),
                "action_mix": {
                    str(key): float(value)
                    for key, value in entry.profile.action_mix.items()
                    if isinstance(key, str)
                },
            },
        }

    def _entry_from_dict(self, raw: object) -> LeagueEntry | None:
        if not isinstance(raw, dict):
            return None
        profile_raw = raw.get("profile")
        profile = StrategyProfile()
        if isinstance(profile_raw, dict):
            profile = StrategyProfile(
                archetype=str(profile_raw.get("archetype", "balanced")),
                codename=str(profile_raw.get("codename", "Balanced Vanguard")),
                aggression=float(profile_raw.get("aggression", 0.5)),
                teching=float(profile_raw.get("teching", 0.5)),
                defense=float(profile_raw.get("defense", 0.5)),
                action_mix={
                    str(key): float(value)
                    for key, value in (profile_raw.get("action_mix", {}) or {}).items()
                    if isinstance(key, str)
                } if isinstance(profile_raw.get("action_mix", {}), dict) else {},
            )
        checkpoint_path = str(raw.get("checkpoint_path", ""))
        try:
            steps = int(raw.get("steps", 0))
            elo = float(raw.get("elo", 1000.0))
            winrate_vs_smart = float(raw.get("winrate_vs_smart", 0.0))
            games_played = int(raw.get("games_played", 0))
            score_sum = float(raw.get("score_sum", 0.0))
            novelty = float(raw.get("novelty", 0.0))
        except (TypeError, ValueError):
            return None
        return LeagueEntry(
            checkpoint_path=checkpoint_path,
            steps=max(0, steps),
            elo=elo,
            winrate_vs_smart=winrate_vs_smart,
            games_played=max(0, games_played),
            score_sum=max(0.0, score_sum),
            profile=profile,
            novelty=novelty,
            promoted=bool(raw.get("promoted", False)),
            source=str(raw.get("source", "checkpoint")),
            use_checkpoint=bool(raw.get("use_checkpoint", True)),
            difficulty=str(raw.get("difficulty")) if isinstance(raw.get("difficulty"), str) else None,
            fixed=bool(raw.get("fixed", False)),
        )

    def _find_checkpoint_entry(self, checkpoint_path: str) -> LeagueEntry | None:
        if not checkpoint_path:
            return None
        for entry in self.entries:
            if entry.checkpoint_path == checkpoint_path:
                return entry
        return None

    def _resolve_entry_for_update(self, opponent: LeagueEntry) -> LeagueEntry | None:
        if opponent.fixed and opponent.difficulty:
            for entry in self.baseline_entries:
                if entry.difficulty == opponent.difficulty:
                    return entry
            return None

        if opponent in self.entries:
            return opponent

        if opponent.checkpoint_path:
            found = self._find_checkpoint_entry(opponent.checkpoint_path)
            if found is not None:
                return found

        if opponent.source == "spinoff":
            anchor_name = opponent.profile.codename.split(" Evo", 1)[0]
            for entry in self.entries:
                if entry.profile.codename == anchor_name:
                    return entry
        return None

    def _is_archetype_champion(self, candidate: LeagueEntry) -> bool:
        same_archetype = [item for item in self.entries if item.profile.archetype == candidate.profile.archetype]
        if not same_archetype:
            return True
        best = max(same_archetype, key=self._rank_tuple)
        return best is candidate or self._rank_tuple(candidate) >= self._rank_tuple(best)

    def _compute_novelty(self, candidate: LeagueEntry) -> float:
        if not self.entries:
            return 1.0
        distances = [self._profile_distance(candidate.profile, item.profile) for item in self.entries]
        if not distances:
            return 1.0
        nearest = min(distances)
        return float(max(0.0, min(2.0, nearest)))

    def _profile_distance(self, left: StrategyProfile, right: StrategyProfile) -> float:
        if left.archetype != right.archetype:
            archetype_bias = 0.5
        else:
            archetype_bias = 0.0
        values = (
            abs(left.aggression - right.aggression),
            abs(left.teching - right.teching),
            abs(left.defense - right.defense),
        )
        action_keys = set(left.action_mix.keys()) | set(right.action_mix.keys())
        action_distance = 0.0
        for key in action_keys:
            action_distance += abs(float(left.action_mix.get(key, 0.0)) - float(right.action_mix.get(key, 0.0)))
        action_distance *= 0.5
        return float(sum(values) + action_distance + archetype_bias)

    def _prune_diverse(self) -> None:
        if not self.entries:
            return
        ranked = sorted(self.entries, key=self._rank_tuple, reverse=True)
        top_core = ranked[: self.keep_top_n]

        best_by_archetype: Dict[str, LeagueEntry] = {}
        for entry in ranked:
            key = entry.profile.archetype
            current = best_by_archetype.get(key)
            if current is None or self._rank_tuple(entry) > self._rank_tuple(current):
                best_by_archetype[key] = entry

        selected: List[LeagueEntry] = []
        selected.extend(top_core)
        for champion in best_by_archetype.values():
            if champion not in selected:
                selected.append(champion)
        remaining = [item for item in ranked if item not in selected]
        remaining.sort(key=lambda item: (item.novelty, *self._rank_tuple(item)), reverse=True)

        diversity_slots = max(0, self.keep_diverse_n)
        for entry in remaining[:diversity_slots]:
            if entry not in selected:
                selected.append(entry)

        if len(selected) < self.max_agents:
            for entry in remaining[diversity_slots:]:
                if len(selected) >= self.max_agents:
                    break
                if entry not in selected:
                    selected.append(entry)

        self.entries = sorted(selected, key=self._rank_tuple, reverse=True)[: self.max_agents]

    def _rank_tuple(self, item: LeagueEntry) -> tuple[float, float, int]:
        return (item.elo + item.novelty * 15.0, item.winrate_vs_smart, item.steps)

    def _expanded_sampling_pool(self, candidates: List[LeagueEntry]) -> List[LeagueEntry]:
        if not candidates:
            return []
        expanded: List[LeagueEntry] = list(candidates)
        per_anchor = self._effective_spinoffs_per_anchor()
        if per_anchor <= 0:
            return expanded
        anchors = self._sampling_anchors(candidates)
        for anchor in anchors:
            for spinoff_idx in range(per_anchor):
                expanded.append(self._make_spinoff(anchor, spinoff_idx))
        return expanded

    def _effective_spinoffs_per_anchor(self) -> int:
        if self.spinoffs_per_anchor > 0:
            return self.spinoffs_per_anchor
        kept = max(1, self.keep_top_n + self.keep_diverse_n)
        return max(0, (self.max_agents // kept) - 1)

    def _sampling_anchors(self, candidates: List[LeagueEntry]) -> List[LeagueEntry]:
        ranked = [entry for entry in sorted(candidates, key=self._rank_tuple, reverse=True) if not entry.fixed]
        if not ranked:
            return []
        target = min(len(ranked), max(1, self.keep_top_n + self.keep_diverse_n))
        return ranked[:target]

    def _make_spinoff(self, anchor: LeagueEntry, spinoff_idx: int) -> LeagueEntry:
        noise = self.spinoff_noise
        aggression = self._clamp(anchor.profile.aggression + random.uniform(-noise, noise), 0.0, 2.0)
        teching = self._clamp(anchor.profile.teching + random.uniform(-noise, noise), 0.0, 2.0)
        defense = self._clamp(anchor.profile.defense + random.uniform(-noise, noise), 0.0, 2.0)
        archetype = self._archetype_from_axes(aggression=aggression, teching=teching, defense=defense)
        codename = f"{anchor.profile.codename} Evo{spinoff_idx + 1}"
        use_checkpoint = self.use_checkpoint_opponents and bool(anchor.checkpoint_path)
        checkpoint_path = anchor.checkpoint_path if use_checkpoint else ""
        profile = StrategyProfile(
            archetype=archetype,
            codename=codename,
            aggression=aggression,
            teching=teching,
            defense=defense,
            action_mix=dict(anchor.profile.action_mix),
        )
        novelty = max(anchor.novelty, abs(aggression - anchor.profile.aggression) + abs(teching - anchor.profile.teching) + abs(defense - anchor.profile.defense))
        return LeagueEntry(
            checkpoint_path=checkpoint_path,
            steps=anchor.steps,
            elo=self._clamp(anchor.elo + random.uniform(-35.0, 35.0), 800.0, 1800.0),
            winrate_vs_smart=self._clamp(anchor.winrate_vs_smart + random.uniform(-0.08, 0.08), 0.0, 1.0),
            profile=profile,
            novelty=float(novelty),
            promoted=False,
            source="spinoff",
            use_checkpoint=use_checkpoint,
            difficulty=None,
            fixed=False,
        )

    def _archetype_from_axes(self, aggression: float, teching: float, defense: float) -> str:
        if aggression > teching + 0.12 and aggression > defense + 0.1:
            return "raider"
        if teching > aggression + 0.12 and teching > defense:
            return "techer"
        if defense > aggression + 0.1 and defense > teching:
            return "fortress"
        return "balanced"

    def _clamp(self, value: float, min_value: float, max_value: float) -> float:
        return max(min_value, min(max_value, float(value)))

    def _all_entries(self) -> List[LeagueEntry]:
        active_baselines = self._active_baseline_entries()
        if not active_baselines:
            return list(self.entries)
        return [*active_baselines, *self.entries]

    def _active_baseline_entries(self) -> List[LeagueEntry]:
        if not self.baseline_entries:
            return []
        if not self.disabled_baselines:
            return list(self.baseline_entries)
        return [
            entry
            for entry in self.baseline_entries
            if not (isinstance(entry.difficulty, str) and entry.difficulty.upper() in self.disabled_baselines)
        ]

    def _prune_sample_counts(self, valid_keys: Set[str]) -> None:
        stale = [key for key in self.sample_counts.keys() if key not in valid_keys]
        for key in stale:
            self.sample_counts.pop(key, None)
        for key in valid_keys:
            self.sample_counts.setdefault(key, 0)

    def _cycle_key(self, entry: LeagueEntry) -> str:
        if entry.fixed and entry.difficulty:
            return f"baseline:{entry.difficulty}"
        if entry.source == "spinoff":
            if entry.checkpoint_path:
                return f"anchor:{entry.checkpoint_path}"
            anchor_name = entry.profile.codename.split(" Evo", 1)[0]
            return f"anchor:{anchor_name}"
        if entry.checkpoint_path:
            return f"checkpoint:{entry.checkpoint_path}"
        return f"profile:{entry.profile.codename}:{entry.source}"

    def _parse_arbiters(self) -> List[str]:
        allowed = {"EASY", "MEDIUM", "HARD", "SMART", "CHEATER"}
        parsed: List[str] = []
        for token in self.arbiters_csv.split(","):
            key = token.strip().upper()
            if not key:
                continue
            if key in allowed and key not in parsed:
                parsed.append(key)
        return parsed

    def _build_baseline_entries(self) -> List[LeagueEntry]:
        spec_map: Dict[str, Tuple[float, str, str, float, float, float]] = {
            "EASY": (860.0, "baseline_easy", "Baseline Easy", 0.30, 0.30, 0.40),
            "MEDIUM": (950.0, "baseline_medium", "Baseline Medium", 0.45, 0.45, 0.45),
            "HARD": (1025.0, "baseline_hard", "Baseline Hard", 0.58, 0.55, 0.55),
            "SMART": (1125.0, "baseline_smart", "Baseline Smart", 0.65, 0.70, 0.60),
            "CHEATER": (1250.0, "baseline_cheater", "Baseline Cheater", 0.80, 0.72, 0.62),
        }
        baseline_order = self._parse_arbiters()
        if not baseline_order:
            return []
        entries: List[LeagueEntry] = []
        for difficulty in baseline_order:
            elo, archetype, codename, aggression, teching, defense = spec_map[difficulty]
            profile = StrategyProfile(
                archetype=archetype,
                codename=codename,
                aggression=float(aggression),
                teching=float(teching),
                defense=float(defense),
                action_mix={},
            )
            entries.append(
                LeagueEntry(
                    checkpoint_path="",
                    steps=0,
                    elo=float(elo),
                    winrate_vs_smart=0.0,
                    profile=profile,
                    novelty=0.0,
                    promoted=True,
                    source="baseline",
                    use_checkpoint=False,
                    difficulty=difficulty,
                    fixed=True,
                )
            )
        return entries
