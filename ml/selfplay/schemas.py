from dataclasses import dataclass
from typing import Dict, List, Literal, Optional


ActionType = Literal[
    "WAIT",
    "RECRUIT_UNIT",
    "AGE_UP",
    "UPGRADE_MANA",
    "UPGRADE_TURRET_SLOTS",
    "BUY_TURRET_ENGINE",
    "SELL_TURRET_ENGINE",
    "REPAIR_BASE",
]


@dataclass(slots=True)
class Observation:
    tick: int
    game_time: float
    static_state: List[float]
    event_sequence: List[List[float]]
    action_type_mask: List[int]
    unit_mask: List[int]
    turret_mask: List[int]
    buy_slot_mask: List[int]
    sell_slot_mask: List[int]


@dataclass(slots=True)
class Action:
    action_type: ActionType
    unit_id: Optional[str] = None
    turret_id: Optional[str] = None
    slot_index: Optional[int] = None
    confidence: float = 0.0


@dataclass(slots=True)
class RewardComponents:
    enemy_unit_kill_value: float = 0.0
    own_unit_loss_value: float = 0.0
    enemy_base_damage: float = 0.0
    own_base_damage: float = 0.0
    safe_age_up_bonus: float = 0.0
    lane_control_delta: float = 0.0
    illegal_action_penalty: float = 0.0
    terminal_outcome: float = 0.0


@dataclass(slots=True)
class Transition:
    seed: int
    tick: int
    game_time: float
    obs: Observation
    action: Action
    reward: float
    reward_components: RewardComponents
    done: bool
    terminal_cause: Literal["none", "player_win", "enemy_win", "timeout", "error"]
    next_obs: Optional[Observation] = None
    info: Optional[Dict[str, float]] = None
