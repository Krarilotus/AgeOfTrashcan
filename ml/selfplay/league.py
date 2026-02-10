from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

import random


@dataclass(slots=True)
class LeagueEntry:
    checkpoint_path: str
    steps: int
    elo: float = 1000.0
    winrate_vs_smart: float = 0.0


class LeaguePool:
    def __init__(self, keep_top_n: int = 8) -> None:
        self.keep_top_n = keep_top_n
        self.entries: List[LeagueEntry] = []

    def add_checkpoint(self, checkpoint_path: str, steps: int, winrate_vs_smart: float) -> LeagueEntry:
        entry = LeagueEntry(
            checkpoint_path=checkpoint_path,
            steps=steps,
            elo=1000.0 + max(0.0, (winrate_vs_smart - 0.5) * 400.0),
            winrate_vs_smart=winrate_vs_smart,
        )
        self.entries.append(entry)
        self.entries.sort(key=lambda item: (item.elo, item.winrate_vs_smart, item.steps), reverse=True)
        if len(self.entries) > self.keep_top_n * 3:
            self.entries = self.entries[: self.keep_top_n * 3]
        return entry

    def promote_if_qualified(self, candidate: LeagueEntry, top3_baseline: List[float]) -> bool:
        if candidate.winrate_vs_smart < 0.55:
            return False
        if top3_baseline and min(top3_baseline) > candidate.winrate_vs_smart:
            return False
        if candidate not in self.entries:
            self.entries.append(candidate)
        self.entries.sort(key=lambda item: (item.elo, item.winrate_vs_smart, item.steps), reverse=True)
        self.entries = self.entries[: max(self.keep_top_n, len(self.entries))]
        return True

    def top(self, n: int) -> List[LeagueEntry]:
        return self.entries[:n]

    def sample_opponent(self, current_checkpoint: Optional[str]) -> Optional[LeagueEntry]:
        if not self.entries:
            return None
        candidates = [entry for entry in self.entries if entry.checkpoint_path != current_checkpoint]
        if not candidates:
            candidates = self.entries

        top = candidates[: min(4, len(candidates))]
        rest = candidates[min(4, len(candidates)) :]
        roll = random.random()
        if roll < 0.6 and top:
            return random.choice(top)
        if roll < 0.85 and rest:
            return random.choice(rest)
        return random.choice(candidates)

    def ensure_path(self, path: str) -> None:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
