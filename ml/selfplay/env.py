from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
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


class MockSelfPlayEnv(SelfPlayEnv):
    def __init__(self, model_cfg: ModelConfig, max_ticks: int = 2400) -> None:
        self.model_cfg = model_cfg
        self.max_ticks = max_ticks
        self.rng = np.random.default_rng(0)
        self.state = MockEnvState()
        self.last_damage_to_opp = 0.0
        self.last_damage_to_self = 0.0

    def reset(self, seed: int) -> Observation:
        self.rng = np.random.default_rng(seed)
        self.state = MockEnvState()
        self.last_damage_to_opp = 0.0
        self.last_damage_to_self = 0.0
        return self._build_observation()

    def step(self, action: Action) -> Tuple[Observation, float, bool, Dict[str, float], RewardComponents]:
        prev = MockEnvState(**self.state.__dict__)
        illegal_penalty = 0.0

        if action.action_type == "RECRUIT_UNIT":
            cost = 25.0
            if self.state.own_gold >= cost:
                self.state.own_gold -= cost
                self.state.own_units += 1.25
            else:
                illegal_penalty -= 0.2
        elif action.action_type == "AGE_UP":
            cost = 350 + self.state.own_age * 180
            if self.state.own_age < 6 and self.state.own_gold >= cost:
                self.state.own_gold -= cost
                self.state.own_age += 1
            else:
                illegal_penalty -= 0.2
        elif action.action_type == "UPGRADE_MANA":
            cost = 120 + self.state.own_mana_level * 80
            if self.state.own_gold >= cost:
                self.state.own_gold -= cost
                self.state.own_mana_level += 1
            else:
                illegal_penalty -= 0.2
        elif action.action_type == "REPAIR_BASE":
            if self.state.own_mana >= 120:
                self.state.own_mana -= 120
                self.state.own_base_hp = min(1000.0, self.state.own_base_hp + 65)
            else:
                illegal_penalty -= 0.2

        self._simulate_opponent_policy()
        self._simulate_battle()

        self.state.tick += 1
        self.state.game_time = self.state.tick * 0.5
        self.state.own_gold += 8 + self.state.own_age * 1.4
        self.state.own_mana += self.state.own_mana_level * 0.8

        reward_components = RewardComponents(
            enemy_unit_kill_value=max(0.0, prev.opp_units - self.state.opp_units) * 0.12,
            own_unit_loss_value=-max(0.0, prev.own_units - self.state.own_units) * 0.1,
            enemy_base_damage=max(0.0, prev.opp_base_hp - self.state.opp_base_hp) * 0.02,
            own_base_damage=-max(0.0, prev.own_base_hp - self.state.own_base_hp) * 0.02,
            safe_age_up_bonus=0.2 if self.state.own_age > prev.own_age and self.state.own_base_hp > 550 else 0.0,
            lane_control_delta=(self.state.own_units - self.state.opp_units) * 0.01,
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
        )

        done = self.state.own_base_hp <= 0 or self.state.opp_base_hp <= 0 or self.state.tick >= self.max_ticks
        if done:
            if self.state.opp_base_hp <= 0 and self.state.own_base_hp > 0:
                reward_components.terminal_outcome = 2.0
            elif self.state.own_base_hp <= 0 and self.state.opp_base_hp > 0:
                reward_components.terminal_outcome = -2.0
            reward += reward_components.terminal_outcome

        info = {
            "own_base_hp": self.state.own_base_hp,
            "opp_base_hp": self.state.opp_base_hp,
            "own_units": self.state.own_units,
            "opp_units": self.state.opp_units,
        }
        return self._build_observation(), reward, done, info, reward_components

    def _simulate_opponent_policy(self) -> None:
        self.state.opp_units += 0.7 + self.rng.uniform(0.0, 0.6)
        if self.state.tick % 240 == 0:
            self.state.opp_units += 3.0

    def _simulate_battle(self) -> None:
        clash = min(self.state.own_units, self.state.opp_units)
        self.state.own_units = max(0.0, self.state.own_units - clash * 0.55)
        self.state.opp_units = max(0.0, self.state.opp_units - clash * 0.6)
        self.last_damage_to_opp = max(0.0, self.state.own_units * 1.4 - self.state.opp_units * 0.4)
        self.last_damage_to_self = max(0.0, self.state.opp_units * 1.2 - self.state.own_units * 0.35)
        self.state.opp_base_hp = max(0.0, self.state.opp_base_hp - self.last_damage_to_opp)
        self.state.own_base_hp = max(0.0, self.state.own_base_hp - self.last_damage_to_self)

    def _build_observation(self) -> Observation:
        static = np.zeros((self.model_cfg.static_dim,), dtype=np.float32)
        static[0] = np.clip(self.state.game_time / 600.0, 0.0, 1.0)
        static[1] = np.clip(self.state.tick / 36000.0, 0.0, 1.0)
        static[2] = np.clip(self.state.own_gold / 10000.0, 0.0, 1.0)
        static[3] = np.clip(self.state.own_mana / 5000.0, 0.0, 1.0)
        static[4] = np.clip(self.state.own_age / 6.0, 0.0, 1.0)
        static[5] = np.clip(self.state.own_mana_level / 40.0, 0.0, 1.0)
        static[6] = np.clip(self.state.own_units / 40.0, 0.0, 1.0)
        static[7] = np.clip(self.state.opp_units / 40.0, 0.0, 1.0)
        static[8] = np.clip(self.state.own_base_hp / 1000.0, 0.0, 1.0)
        static[9] = np.clip(self.state.opp_base_hp / 1000.0, 0.0, 1.0)
        static[10] = np.clip((self.state.own_units - self.state.opp_units) / 50.0, -1.0, 1.0)
        static[11] = np.clip((self.state.own_base_hp - self.state.opp_base_hp) / 1000.0, -1.0, 1.0)

        sequence = np.zeros((self.model_cfg.sequence_len, self.model_cfg.token_dim), dtype=np.float32)
        sequence[-1, 0] = 2.0 / 3.0
        sequence[-1, 1] = float(ACTIONS.index("WAIT") + 1) / float(len(ACTIONS) + 1)
        sequence[-1, 5] = 0.25
        sequence[-1, 6] = np.clip((self.last_damage_to_opp - self.last_damage_to_self) / 20.0, -1.0, 1.0)
        sequence[-1, 7] = np.clip(self.last_damage_to_opp / 200.0, 0.0, 1.0)

        action_type_mask = [1, 1, 1 if self.state.own_age < 6 else 0, 1, 1, 1, 0, 1 if self.state.own_mana >= 120 else 0]
        unit_mask = [1] * self.model_cfg.unit_dim
        turret_mask = [1] * self.model_cfg.turret_dim
        buy_slot_mask = [1] * self.model_cfg.slot_dim
        sell_slot_mask = [0] * self.model_cfg.slot_dim

        return Observation(
            tick=self.state.tick,
            game_time=self.state.game_time,
            static_state=static.tolist(),
            event_sequence=sequence.tolist(),
            action_type_mask=action_type_mask,
            unit_mask=unit_mask,
            turret_mask=turret_mask,
            buy_slot_mask=buy_slot_mask,
            sell_slot_mask=sell_slot_mask,
        )


class GameBridgeEnv(SelfPlayEnv):
    def reset(self, seed: int) -> Observation:
        raise NotImplementedError(
            "GameBridgeEnv is a contract point. Wire it to the headless game bridge to train against real matches."
        )

    def step(self, action: Action) -> Tuple[Observation, float, bool, Dict[str, float], RewardComponents]:
        raise NotImplementedError(
            "GameBridgeEnv is a contract point. Wire it to the headless game bridge to train against real matches."
        )
