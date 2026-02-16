from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

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
    profile: StrategyProfile = field(default_factory=StrategyProfile)
    novelty: float = 0.0
    promoted: bool = False


class LeaguePool:
    def __init__(
        self,
        keep_top_n: int = 5,
        keep_diverse_n: int = 5,
        max_agents: int = 10,
        min_promote_winrate: float = 0.55,
        archetype_winrate_floor: float = 0.52,
    ) -> None:
        self.keep_top_n = max(1, int(keep_top_n))
        self.keep_diverse_n = max(0, int(keep_diverse_n))
        self.max_agents = max(self.keep_top_n, int(max_agents))
        self.min_promote_winrate = float(min_promote_winrate)
        self.archetype_winrate_floor = float(archetype_winrate_floor)
        self.entries: List[LeagueEntry] = []

    def add_checkpoint(
        self,
        checkpoint_path: str,
        steps: int,
        winrate_vs_smart: float,
        profile: StrategyProfile | None = None,
    ) -> LeagueEntry:
        profile = profile or StrategyProfile()
        entry = LeagueEntry(
            checkpoint_path=checkpoint_path,
            steps=steps,
            elo=1000.0 + max(-200.0, min(250.0, (winrate_vs_smart - 0.5) * 500.0)),
            winrate_vs_smart=float(winrate_vs_smart),
            profile=profile,
        )
        entry.novelty = self._compute_novelty(entry)
        self.entries.append(entry)
        self._prune_diverse()
        return entry

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
        if not self.entries:
            return None
        candidates = [entry for entry in self.entries if entry.checkpoint_path != current_checkpoint]
        if not candidates:
            candidates = self.entries

        weights: List[float] = []
        archetype_counts: Dict[str, int] = {}
        for item in candidates:
            archetype_counts[item.profile.archetype] = archetype_counts.get(item.profile.archetype, 0) + 1

        for entry in candidates:
            archetype_count = archetype_counts.get(entry.profile.archetype, 1)
            quality = 0.7 + max(0.0, (entry.elo - 900.0) / 500.0)
            novelty = 0.6 + max(0.0, entry.novelty)
            diversity_boost = 1.0 / math.sqrt(archetype_count)
            promotion_boost = 1.15 if entry.promoted else 1.0
            weights.append(max(0.01, quality * novelty * diversity_boost * promotion_boost))
        return random.choices(candidates, weights=weights, k=1)[0]

    def ensure_path(self, path: str) -> None:
        Path(path).parent.mkdir(parents=True, exist_ok=True)

    def roster(self) -> List[LeagueEntry]:
        return sorted(self.entries, key=self._rank_tuple, reverse=True)[: self.max_agents]

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
