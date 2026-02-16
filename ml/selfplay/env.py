from __future__ import annotations

from abc import ABC, abstractmethod
from collections import deque
from dataclasses import dataclass, replace
import json
from pathlib import Path
import queue
import shutil
import subprocess
import threading
from typing import Dict, List, Tuple

import numpy as np

from .config import ModelConfig
from .schemas import Action, Observation, RewardComponents

ACTIONS: List[str] = [
    "WAIT",
    "RECRUIT_UNIT",
    "AGE_UP",
    "UPGRADE_MANA",
    "UPGRADE_TURRET_SLOTS",
    "BUY_TURRET_ENGINE",
    "SELL_TURRET_ENGINE",
    "REPAIR_BASE",
]


class SelfPlayEnv(ABC):
    @abstractmethod
    def reset(self, seed: int) -> Observation:
        raise NotImplementedError

    @abstractmethod
    def step(self, action: Action) -> Tuple[Observation, float, bool, Dict[str, float], RewardComponents]:
        raise NotImplementedError

    def set_opponent_profile(self, profile: Dict[str, float | str] | None) -> None:
        del profile

    def close(self) -> None:
        return None


@dataclass(slots=True)
class MockEnvState:
    tick: int = 0
    game_time: float = 0.0
    own_base_hp: float = 1000.0
    opp_base_hp: float = 1000.0
    own_units: float = 0.0
    opp_units: float = 0.0
    own_gold: float = 150.0
    own_mana: float = 0.0
    own_age: int = 1
    own_mana_level: int = 0
    own_slots_unlocked: int = 1
    own_turrets_installed: int = 0


@dataclass(slots=True)
class MockUnitSpec:
    unit_id: str
    gold_cost: float
    mana_cost: float
    min_age: int
    combat_power: float


@dataclass(slots=True)
class MockTurretSpec:
    turret_id: str
    gold_cost: float
    mana_cost: float
    min_age: int
    dps: float


MOCK_MAX_AGE = 6
MOCK_TURRET_REFUND = 0.6


class MockSelfPlayEnv(SelfPlayEnv):
    def __init__(self, model_cfg: ModelConfig, max_ticks: int = 2400) -> None:
        self.model_cfg = model_cfg
        self.max_ticks = max_ticks
        self.rng = np.random.default_rng(0)
        self.unit_specs = self._build_unit_specs(self.model_cfg.unit_dim)
        self.turret_specs = self._build_turret_specs(self.model_cfg.turret_dim)
        self.turret_slots: List[int] = [-1 for _ in range(self.model_cfg.slot_dim)]
        self.state = MockEnvState()
        self.last_damage_to_opp = 0.0
        self.last_damage_to_self = 0.0
        self.opponent_strength = 1.0
        self.own_base_milestones_awarded: set[float] = set()
        self.opp_base_milestones_awarded: set[float] = set()

    def set_opponent_profile(self, profile: Dict[str, float | str] | None) -> None:
        if not profile:
            self.opponent_strength = 1.0
            return
        winrate = float(profile.get("winrate_vs_smart", 0.5) or 0.5)
        elo = float(profile.get("elo", 1000.0) or 1000.0)
        scaled = 1.0 + (winrate - 0.5) * 0.5 + (elo - 1000.0) / 2000.0
        self.opponent_strength = float(np.clip(scaled, 0.8, 1.6))

    def reset(self, seed: int) -> Observation:
        self.rng = np.random.default_rng(seed)
        self.state = MockEnvState()
        self.turret_slots = [-1 for _ in range(self.model_cfg.slot_dim)]
        self.last_damage_to_opp = 0.0
        self.last_damage_to_self = 0.0
        self.own_base_milestones_awarded = set()
        self.opp_base_milestones_awarded = set()
        return self._build_observation()

    def step(self, action: Action) -> Tuple[Observation, float, bool, Dict[str, float], RewardComponents]:
        prev = replace(self.state)
        mask = self._build_mask()
        action_index = ACTIONS.index(action.action_type) if action.action_type in ACTIONS else 0
        legal = mask["action_type"][action_index] > 0

        unit_idx = -1
        turret_idx = -1
        buy_slot_idx = -1
        sell_slot_idx = -1
        if legal and action.action_type == "RECRUIT_UNIT":
            unit_idx = self._parse_indexed_id(action.unit_id, "unit", len(self.unit_specs))
            legal = unit_idx >= 0 and unit_idx < len(mask["unit"]) and mask["unit"][unit_idx] > 0
        elif legal and action.action_type == "BUY_TURRET_ENGINE":
            turret_idx = self._parse_indexed_id(action.turret_id, "turret", len(self.turret_specs))
            buy_slot_idx = self._pick_buy_slot(action.slot_index)
            legal = (
                turret_idx >= 0
                and buy_slot_idx >= 0
                and turret_idx < len(mask["turret"])
                and buy_slot_idx < len(mask["buy_slot"])
                and mask["turret"][turret_idx] > 0
                and mask["buy_slot"][buy_slot_idx] > 0
            )
        elif legal and action.action_type == "SELL_TURRET_ENGINE":
            sell_slot_idx = int(action.slot_index) if action.slot_index is not None else -1
            legal = (
                0 <= sell_slot_idx < len(mask["sell_slot"]) and mask["sell_slot"][sell_slot_idx] > 0
            )

        illegal_penalty = 0.0 if legal else -0.5

        if legal and action.action_type == "RECRUIT_UNIT":
            unit = self.unit_specs[unit_idx]
            self.state.own_gold -= unit.gold_cost
            self.state.own_mana -= unit.mana_cost
            self.state.own_units += unit.combat_power + self.state.own_age * 0.15
        elif legal and action.action_type == "AGE_UP":
            cost = 350 + self.state.own_age * 180
            self.state.own_gold -= cost
            self.state.own_age += 1
        elif legal and action.action_type == "UPGRADE_MANA":
            cost = 120 + self.state.own_mana_level * 80
            self.state.own_gold -= cost
            self.state.own_mana_level += 1
        elif legal and action.action_type == "UPGRADE_TURRET_SLOTS":
            cost = 180 + self.state.own_slots_unlocked * 220
            self.state.own_gold -= cost
            self.state.own_slots_unlocked = min(self.model_cfg.slot_dim, self.state.own_slots_unlocked + 1)
        elif legal and action.action_type == "BUY_TURRET_ENGINE":
            turret = self.turret_specs[turret_idx]
            self.state.own_gold -= turret.gold_cost
            self.state.own_mana -= turret.mana_cost
            self.turret_slots[buy_slot_idx] = turret_idx
            self._refresh_turret_count()
        elif legal and action.action_type == "SELL_TURRET_ENGINE":
            turret_idx = self.turret_slots[sell_slot_idx]
            turret = self.turret_specs[turret_idx]
            self.turret_slots[sell_slot_idx] = -1
            self.state.own_gold += turret.gold_cost * MOCK_TURRET_REFUND
            self._refresh_turret_count()
        elif legal and action.action_type == "REPAIR_BASE":
            self.state.own_mana -= 120
            self.state.own_base_hp = min(1000.0, self.state.own_base_hp + 70)

        self._simulate_opponent_policy()
        self._simulate_battle()

        self.state.tick += 1
        self.state.game_time = self.state.tick * 0.5
        self.state.own_gold += 8 + self.state.own_age * 1.4
        self.state.own_mana += self.state.own_mana_level * 0.8

        enemy_base_bonus = self._one_time_base_milestones(
            prev.opp_base_hp / max(1.0, 1000.0),
            self.state.opp_base_hp / max(1.0, 1000.0),
            self.opp_base_milestones_awarded,
            (2.0, 4.0, 8.0),
        )
        own_base_penalty = self._one_time_base_milestones(
            prev.own_base_hp / max(1.0, 1000.0),
            self.state.own_base_hp / max(1.0, 1000.0),
            self.own_base_milestones_awarded,
            (2.0, 4.0, 8.0),
        )
        reward_components = RewardComponents(
            enemy_unit_kill_value=0.0,
            own_unit_loss_value=0.0,
            enemy_base_damage=enemy_base_bonus,
            own_base_damage=-own_base_penalty,
            safe_age_up_bonus=1.2 if self.state.own_age > prev.own_age and self.state.own_base_hp > 500 else 0.0,
            lane_control_delta=0.0,
            illegal_action_penalty=illegal_penalty,
            terminal_outcome=0.0,
        )
        reward = (
            reward_components.enemy_unit_kill_value
            + reward_components.own_unit_loss_value
            + reward_components.enemy_base_damage
            + reward_components.own_base_damage
            + reward_components.safe_age_up_bonus
            + reward_components.lane_control_delta
            + reward_components.illegal_action_penalty
            + reward_components.terminal_outcome
        )

        done = self.state.own_base_hp <= 0 or self.state.opp_base_hp <= 0 or self.state.tick >= self.max_ticks
        if done:
            if self.state.opp_base_hp <= 0 and self.state.own_base_hp > 0:
                reward_components.terminal_outcome = 40.0
            elif self.state.own_base_hp <= 0 and self.state.opp_base_hp > 0:
                reward_components.terminal_outcome = -40.0
            else:
                delta = (self.state.own_base_hp - self.state.opp_base_hp) / 1000.0
                reward_components.terminal_outcome = float(np.clip(delta * 10.0, -10.0, 10.0))
            reward += reward_components.terminal_outcome

        info = {
            "own_base_hp": self.state.own_base_hp,
            "opp_base_hp": self.state.opp_base_hp,
            "own_units": self.state.own_units,
            "opp_units": self.state.opp_units,
            "own_gold": self.state.own_gold,
            "own_mana": self.state.own_mana,
        }
        return self._build_observation(), reward, done, info, reward_components

    def _one_time_base_milestones(
        self,
        prev_ratio: float,
        next_ratio: float,
        awarded: set[float],
        rewards: tuple[float, float, float],
    ) -> float:
        thresholds = (0.75, 0.5, 0.25)
        bonus = 0.0
        for idx, threshold in enumerate(thresholds):
            if prev_ratio > threshold and next_ratio <= threshold and threshold not in awarded:
                awarded.add(threshold)
                bonus += float(rewards[idx])
        return bonus

    def _simulate_opponent_policy(self) -> None:
        pressure = (0.8 + self.rng.uniform(0.0, 0.7)) * self.opponent_strength
        self.state.opp_units += pressure
        if self.state.tick % 240 == 0:
            self.state.opp_units += 2.0 * self.opponent_strength

    def _simulate_battle(self) -> None:
        turret_dps = sum(
            self.turret_specs[idx].dps
            for idx in self.turret_slots[: min(self.state.own_slots_unlocked, self.model_cfg.slot_dim)]
            if idx >= 0
        ) * (1.0 + self.state.own_age * 0.08)
        clash = min(self.state.own_units, self.state.opp_units)
        self.state.own_units = max(0.0, self.state.own_units - clash * 0.55)
        self.state.opp_units = max(0.0, self.state.opp_units - clash * (0.55 + turret_dps * 0.02))
        self.last_damage_to_opp = max(
            0.0,
            self.state.own_units * (1.25 + self.state.own_age * 0.03) - self.state.opp_units * 0.35,
        )
        self.last_damage_to_self = max(
            0.0,
            self.state.opp_units * 1.2 - self.state.own_units * 0.32 - turret_dps * 0.22,
        )
        self.state.opp_base_hp = max(0.0, self.state.opp_base_hp - self.last_damage_to_opp)
        self.state.own_base_hp = max(0.0, self.state.own_base_hp - self.last_damage_to_self)

    def _build_mask(self) -> Dict[str, List[int]]:
        age_cost = 350 + self.state.own_age * 180
        mana_upgrade_cost = 120 + self.state.own_mana_level * 80
        slot_upgrade_cost = 180 + self.state.own_slots_unlocked * 220
        unlocked_slots = min(self.state.own_slots_unlocked, self.model_cfg.slot_dim)
        has_open_slot = any(self.turret_slots[idx] < 0 for idx in range(unlocked_slots))
        can_sell = any(self.turret_slots[idx] >= 0 for idx in range(unlocked_slots))
        can_repair = self.state.own_age >= 4 and self.state.own_mana >= 120 and self.state.own_base_hp < 995

        unit_mask = [
            1
            if spec.min_age <= self.state.own_age
            and self.state.own_gold >= spec.gold_cost
            and self.state.own_mana >= spec.mana_cost
            else 0
            for spec in self.unit_specs
        ]
        turret_mask = [
            1
            if has_open_slot
            and spec.min_age <= self.state.own_age
            and self.state.own_gold >= spec.gold_cost
            and self.state.own_mana >= spec.mana_cost
            else 0
            for spec in self.turret_specs
        ]
        buy_slot_mask = [
            1 if idx < unlocked_slots and self.turret_slots[idx] < 0 else 0
            for idx in range(self.model_cfg.slot_dim)
        ]
        sell_slot_mask = [
            1 if idx < unlocked_slots and self.turret_slots[idx] >= 0 else 0
            for idx in range(self.model_cfg.slot_dim)
        ]

        action_type_mask = [
            1,
            1 if any(unit_mask) else 0,
            1 if self.state.own_age < MOCK_MAX_AGE and self.state.own_gold >= age_cost else 0,
            1 if self.state.own_gold >= mana_upgrade_cost else 0,
            1 if self.state.own_slots_unlocked < self.model_cfg.slot_dim and self.state.own_gold >= slot_upgrade_cost else 0,
            1 if any(turret_mask) and any(buy_slot_mask) else 0,
            1 if can_sell else 0,
            1 if can_repair else 0,
        ]
        return {
            "action_type": action_type_mask,
            "unit": unit_mask,
            "turret": turret_mask,
            "buy_slot": buy_slot_mask,
            "sell_slot": sell_slot_mask,
        }

    def _refresh_turret_count(self) -> None:
        unlocked_slots = min(self.state.own_slots_unlocked, self.model_cfg.slot_dim)
        self.state.own_turrets_installed = sum(
            1 for idx in self.turret_slots[:unlocked_slots] if idx >= 0
        )

    def _pick_buy_slot(self, requested_slot: int | None) -> int:
        unlocked_slots = min(self.state.own_slots_unlocked, self.model_cfg.slot_dim)
        if requested_slot is None:
            for idx in range(unlocked_slots):
                if self.turret_slots[idx] < 0:
                    return idx
            return -1
        idx = int(requested_slot)
        if 0 <= idx < unlocked_slots and self.turret_slots[idx] < 0:
            return idx
        return -1

    def _parse_indexed_id(self, raw: str | None, prefix: str, upper_bound: int) -> int:
        if not raw:
            return -1
        if not raw.startswith(f"{prefix}_"):
            return -1
        suffix = raw[len(prefix) + 1 :]
        if not suffix.isdigit():
            return -1
        idx = int(suffix)
        return idx if 0 <= idx < upper_bound else -1

    def _build_unit_specs(self, dim: int) -> List[MockUnitSpec]:
        templates = [
            ("stone_clubman", 25.0, 0.0, 1, 1.1),
            ("bronze_spearman", 42.0, 0.0, 1, 1.45),
            ("slinger", 55.0, 10.0, 2, 1.75),
            ("shield_bearer", 78.0, 12.0, 2, 2.2),
            ("knight", 125.0, 24.0, 3, 3.1),
            ("war_mage", 162.0, 60.0, 3, 3.6),
            ("siege_golem", 240.0, 85.0, 4, 5.2),
            ("assassin", 215.0, 72.0, 4, 4.7),
            ("mech_titan", 335.0, 120.0, 5, 6.9),
            ("archangel", 430.0, 165.0, 6, 8.1),
        ]
        units: List[MockUnitSpec] = []
        for idx in range(max(0, dim)):
            if idx < len(templates):
                name, gold, mana, age, power = templates[idx]
                units.append(
                    MockUnitSpec(
                        unit_id=name,
                        gold_cost=float(gold),
                        mana_cost=float(mana),
                        min_age=int(age),
                        combat_power=float(power),
                    )
                )
            else:
                units.append(
                    MockUnitSpec(
                        unit_id=f"locked_unit_{idx}",
                        gold_cost=1e9,
                        mana_cost=1e9,
                        min_age=MOCK_MAX_AGE + 1,
                        combat_power=0.0,
                    )
                )
        return units

    def _build_turret_specs(self, dim: int) -> List[MockTurretSpec]:
        templates = [
            ("ballista", 95.0, 0.0, 1, 0.35),
            ("cannon", 165.0, 20.0, 2, 0.55),
            ("flame", 235.0, 40.0, 3, 0.82),
            ("tesla", 315.0, 75.0, 4, 1.1),
            ("plasma", 425.0, 110.0, 5, 1.36),
            ("quantum", 570.0, 145.0, 6, 1.65),
        ]
        turrets: List[MockTurretSpec] = []
        for idx in range(max(0, dim)):
            if idx < len(templates):
                name, gold, mana, age, dps = templates[idx]
                turrets.append(
                    MockTurretSpec(
                        turret_id=name,
                        gold_cost=float(gold),
                        mana_cost=float(mana),
                        min_age=int(age),
                        dps=float(dps),
                    )
                )
            else:
                turrets.append(
                    MockTurretSpec(
                        turret_id=f"locked_turret_{idx}",
                        gold_cost=1e9,
                        mana_cost=1e9,
                        min_age=MOCK_MAX_AGE + 1,
                        dps=0.0,
                    )
                )
        return turrets

    def _build_observation(self) -> Observation:
        static = np.zeros((self.model_cfg.static_dim,), dtype=np.float32)
        static[0] = np.clip(self.state.game_time / 900.0, 0.0, 1.0)
        static[1] = np.clip(self.state.tick / max(1, self.max_ticks), 0.0, 1.0)
        static[2] = np.clip(self.state.own_gold / 12000.0, 0.0, 1.0)
        static[3] = np.clip(self.state.own_mana / 5000.0, 0.0, 1.0)
        static[4] = np.clip(self.state.own_age / 6.0, 0.0, 1.0)
        static[5] = np.clip(self.state.own_mana_level / 40.0, 0.0, 1.0)
        static[6] = np.clip(self.state.own_units / 50.0, 0.0, 1.0)
        static[7] = np.clip(self.state.opp_units / 50.0, 0.0, 1.0)
        static[8] = np.clip(self.state.own_base_hp / 1000.0, 0.0, 1.0)
        static[9] = np.clip(self.state.opp_base_hp / 1000.0, 0.0, 1.0)
        static[10] = np.clip((self.state.own_units - self.state.opp_units) / 60.0, -1.0, 1.0)
        static[11] = np.clip((self.state.own_base_hp - self.state.opp_base_hp) / 1000.0, -1.0, 1.0)
        static[12] = np.clip(self.state.own_slots_unlocked / max(1, self.model_cfg.slot_dim), 0.0, 1.0)
        static[13] = np.clip(self.state.own_turrets_installed / max(1, self.model_cfg.slot_dim), 0.0, 1.0)

        sequence = np.zeros((self.model_cfg.sequence_len, self.model_cfg.token_dim), dtype=np.float32)
        sequence[-1, 0] = 2.0 / 3.0
        sequence[-1, 1] = float(ACTIONS.index("WAIT") + 1) / float(len(ACTIONS) + 1)
        sequence[-1, 5] = 0.25
        sequence[-1, 6] = np.clip((self.last_damage_to_opp - self.last_damage_to_self) / 25.0, -1.0, 1.0)
        sequence[-1, 7] = np.clip(self.last_damage_to_opp / 220.0, 0.0, 1.0)

        masks = self._build_mask()
        return Observation(
            tick=self.state.tick,
            game_time=self.state.game_time,
            static_state=static.tolist(),
            event_sequence=sequence.tolist(),
            action_type_mask=masks["action_type"],
            unit_mask=masks["unit"],
            turret_mask=masks["turret"],
            buy_slot_mask=masks["buy_slot"],
            sell_slot_mask=masks["sell_slot"],
        )


class GameBridgeEnv(SelfPlayEnv):
    _bundle_lock = threading.Lock()
    _bundle_ready = False
    _bundle_path: Path | None = None

    def __init__(
        self,
        model_cfg: ModelConfig,
        opponent_difficulty: str = "SMART",
        self_difficulty: str = "SMART_ML",
        episode_seconds: int = 1200,
        decision_frames: int = 30,
    ) -> None:
        self.model_cfg = model_cfg
        self.opponent_difficulty = opponent_difficulty
        self.self_difficulty = self_difficulty
        self.episode_seconds = int(max(60, episode_seconds))
        self.decision_frames = int(max(1, decision_frames))
        self.repo_root = Path(__file__).resolve().parents[2]
        bundle_path = self._ensure_bundle(self.repo_root)
        self._stderr_tail: deque[str] = deque(maxlen=120)
        self._responses: queue.Queue[dict] = queue.Queue(maxsize=2048)
        self.process = subprocess.Popen(
            ["node", str(bundle_path)],
            cwd=str(self.repo_root),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        if not self.process.stdin or not self.process.stdout or not self.process.stderr:
            raise RuntimeError("Failed to create bridge process pipes")
        self._stdout_thread = threading.Thread(target=self._stdout_reader, daemon=True)
        self._stderr_thread = threading.Thread(target=self._stderr_reader, daemon=True)
        self._stdout_thread.start()
        self._stderr_thread.start()
        self._request(
            {
                "cmd": "init",
                "model": {
                    "static_dim": self.model_cfg.static_dim,
                    "sequence_len": self.model_cfg.sequence_len,
                    "token_dim": self.model_cfg.token_dim,
                    "action_dim": self.model_cfg.action_dim,
                    "unit_dim": self.model_cfg.unit_dim,
                    "turret_dim": self.model_cfg.turret_dim,
                    "slot_dim": self.model_cfg.slot_dim,
                },
                "options": {
                    "self_difficulty": self.self_difficulty,
                    "opponent_difficulty": self.opponent_difficulty,
                    "episode_seconds": self.episode_seconds,
                    "decision_frames": self.decision_frames,
                },
            }
        )

    @classmethod
    def _ensure_bundle(cls, repo_root: Path) -> Path:
        with cls._bundle_lock:
            out_path = repo_root / "ml" / "bridge" / "dist" / "game_bridge_server.cjs"
            if cls._bundle_ready and cls._bundle_path and cls._bundle_path.exists():
                return cls._bundle_path
            out_path.parent.mkdir(parents=True, exist_ok=True)
            npx_cmd = shutil.which("npx") or shutil.which("npx.cmd")
            if npx_cmd:
                command = [
                    npx_cmd,
                    "esbuild",
                    "ml/bridge/game_bridge_server.ts",
                    "--bundle",
                    "--platform=node",
                    "--format=cjs",
                    "--target=node20",
                    "--outfile=ml/bridge/dist/game_bridge_server.cjs",
                    "--log-level=warning",
                ]
            else:
                npm_cmd = shutil.which("npm") or shutil.which("npm.cmd")
                if not npm_cmd:
                    raise RuntimeError("Neither npx nor npm found in PATH for game bridge build")
                command = [
                    npm_cmd,
                    "exec",
                    "--",
                    "esbuild",
                    "ml/bridge/game_bridge_server.ts",
                    "--bundle",
                    "--platform=node",
                    "--format=cjs",
                    "--target=node20",
                    "--outfile=ml/bridge/dist/game_bridge_server.cjs",
                    "--log-level=warning",
                ]
            subprocess.run(
                command,
                cwd=str(repo_root),
                check=True,
                capture_output=True,
                text=True,
            )
            cls._bundle_ready = True
            cls._bundle_path = out_path
            return out_path

    def _stdout_reader(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            raw = line.strip()
            if not raw:
                continue
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError as exc:
                payload = {"ok": False, "error": f"Invalid bridge JSON: {exc}: {raw}"}
            self._responses.put(payload)

    def _stderr_reader(self) -> None:
        assert self.process.stderr is not None
        for line in self.process.stderr:
            raw = line.rstrip()
            if raw:
                self._stderr_tail.append(raw)

    def _request(self, payload: Dict[str, object], timeout_s: float = 60.0) -> Dict[str, object]:
        if self.process.poll() is not None:
            raise RuntimeError(
                "Bridge process exited unexpectedly. "
                + "stderr tail: "
                + " | ".join(self._stderr_tail)
            )
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps(payload) + "\n")
        self.process.stdin.flush()
        try:
            response = self._responses.get(timeout=timeout_s)
        except queue.Empty as exc:
            raise TimeoutError(
                f"Timed out waiting for bridge response for cmd={payload.get('cmd')}. "
                + "stderr tail: "
                + " | ".join(self._stderr_tail)
            ) from exc
        if not bool(response.get("ok", False)):
            raise RuntimeError(
                f"Bridge command failed for cmd={payload.get('cmd')}: {response.get('error')}. "
                + "stderr tail: "
                + " | ".join(self._stderr_tail)
            )
        return response

    def _parse_observation(self, payload: Dict[str, object]) -> Observation:
        def as_list(name: str) -> List:
            raw = payload.get(name)
            if not isinstance(raw, list):
                raise RuntimeError(f"Bridge observation field `{name}` missing or not a list")
            return raw

        static_state = [float(v) for v in as_list("static_state")]
        event_sequence_raw = as_list("event_sequence")
        event_sequence: List[List[float]] = []
        for token in event_sequence_raw:
            if not isinstance(token, list):
                raise RuntimeError("Bridge observation token is not a list")
            event_sequence.append([float(v) for v in token])
        return Observation(
            tick=int(payload.get("tick", 0)),
            game_time=float(payload.get("game_time", 0.0)),
            static_state=static_state,
            event_sequence=event_sequence,
            action_type_mask=[int(v) for v in as_list("action_type_mask")],
            unit_mask=[int(v) for v in as_list("unit_mask")],
            turret_mask=[int(v) for v in as_list("turret_mask")],
            buy_slot_mask=[int(v) for v in as_list("buy_slot_mask")],
            sell_slot_mask=[int(v) for v in as_list("sell_slot_mask")],
        )

    def reset(self, seed: int) -> Observation:
        response = self._request({"cmd": "reset", "seed": int(seed)}, timeout_s=20.0)
        observation_payload = response.get("observation")
        if not isinstance(observation_payload, dict):
            raise RuntimeError("Bridge reset response missing observation payload")
        return self._parse_observation(observation_payload)

    def step(self, action: Action) -> Tuple[Observation, float, bool, Dict[str, float], RewardComponents]:
        response = self._request(
            {
                "cmd": "step",
                "action": {
                    "action_type": action.action_type,
                    "unit_id": action.unit_id,
                    "turret_id": action.turret_id,
                    "slot_index": action.slot_index,
                    "confidence": action.confidence,
                },
            },
            timeout_s=20.0,
        )
        observation_payload = response.get("observation")
        if not isinstance(observation_payload, dict):
            raise RuntimeError("Bridge step response missing observation payload")
        observation = self._parse_observation(observation_payload)
        reward = float(response.get("reward", 0.0))
        done = bool(response.get("done", False))
        raw_info = response.get("info")
        info: Dict[str, float] = {}
        if isinstance(raw_info, dict):
            for key, value in raw_info.items():
                if isinstance(value, (int, float)):
                    info[key] = float(value)
        raw_components = response.get("reward_components")
        if not isinstance(raw_components, dict):
            raise RuntimeError("Bridge step response missing reward components")
        components = RewardComponents(
            enemy_unit_kill_value=float(raw_components.get("enemy_unit_kill_value", 0.0)),
            own_unit_loss_value=float(raw_components.get("own_unit_loss_value", 0.0)),
            enemy_base_damage=float(raw_components.get("enemy_base_damage", 0.0)),
            own_base_damage=float(raw_components.get("own_base_damage", 0.0)),
            safe_age_up_bonus=float(raw_components.get("safe_age_up_bonus", 0.0)),
            lane_control_delta=float(raw_components.get("lane_control_delta", 0.0)),
            illegal_action_penalty=float(raw_components.get("illegal_action_penalty", 0.0)),
            terminal_outcome=float(raw_components.get("terminal_outcome", 0.0)),
        )
        return observation, reward, done, info, components

    def set_opponent_profile(self, profile: Dict[str, float | str] | None) -> None:
        payload: Dict[str, object] = {"cmd": "set_opponent_profile"}
        if profile is not None:
            payload["profile"] = profile
        self._request(payload, timeout_s=10.0)

    def close(self) -> None:
        if getattr(self, "process", None) is None:
            return
        process = self.process
        self.process = None  # type: ignore[assignment]
        if process.poll() is None:
            try:
                self._request({"cmd": "close"}, timeout_s=3.0)
            except Exception:
                pass
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3.0)
            except subprocess.TimeoutExpired:
                process.kill()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass
