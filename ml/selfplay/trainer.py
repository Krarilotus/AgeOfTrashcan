from __future__ import annotations

from dataclasses import asdict
from pathlib import Path
from typing import Callable, Dict, List, Tuple

import numpy as np
import torch
from torch.optim import AdamW

from .config import OvernightConfig
from .env import ACTIONS, MockSelfPlayEnv, SelfPlayEnv
from .league import LeaguePool
from .model import TransformerActorCritic
from .ppo import PPOUpdater, RolloutBatch, compute_gae
from .schemas import Action, Observation


class SelfPlayTrainer:
    def __init__(
        self,
        cfg: OvernightConfig,
        env_factory: Callable[[], SelfPlayEnv] | None = None,
    ) -> None:
        self.cfg = cfg
        runtime = cfg.runtime
        self.device = torch.device(runtime.device if torch.cuda.is_available() else "cpu")
        self.model = TransformerActorCritic(cfg.model).to(self.device)
        self.optimizer = AdamW(
            self.model.parameters(),
            lr=cfg.ppo.learning_rate,
            weight_decay=cfg.ppo.weight_decay,
        )
        self.ppo = PPOUpdater(self.model, self.optimizer, cfg.ppo, self.device)
        self.league = LeaguePool(keep_top_n=8)

        factory = env_factory or (lambda: MockSelfPlayEnv(cfg.model))
        self.envs: List[SelfPlayEnv] = [factory() for _ in range(runtime.num_envs)]
        self.global_step = 0
        self.last_good_checkpoint: str | None = None

        Path(runtime.save_dir).mkdir(parents=True, exist_ok=True)
        self.obs: List[Observation] = [
            env.reset(runtime.seed + env_idx) for env_idx, env in enumerate(self.envs)
        ]

    def train(self) -> None:
        runtime = self.cfg.runtime
        while self.global_step < runtime.total_steps:
            batch = self._collect_rollout()
            metrics = self.ppo.update(batch)
            self._anneal_entropy()
            self.global_step += runtime.rollout_horizon * runtime.num_envs

            if any(np.isnan(v) or np.isinf(v) for v in metrics.values()):
                self._rollback_checkpoint()
                continue

            if self.global_step % runtime.log_interval == 0:
                print(
                    f"[step={self.global_step}] policy={metrics['policy_loss']:.4f} "
                    f"value={metrics['value_loss']:.4f} entropy={metrics['entropy']:.4f} "
                    f"kl={metrics['kl']:.5f}"
                )
                if metrics["entropy"] < runtime.entropy_floor_alert:
                    print(
                        f"[alert] entropy floor breached ({metrics['entropy']:.5f} < {runtime.entropy_floor_alert:.5f})"
                    )

            if self.global_step % runtime.checkpoint_every == 0:
                checkpoint = self._save_checkpoint()
                self.last_good_checkpoint = checkpoint

            if self.global_step % runtime.eval_every == 0:
                winrate = self.evaluate(runtime.eval_matches)
                if self.last_good_checkpoint:
                    entry = self.league.add_checkpoint(self.last_good_checkpoint, self.global_step, winrate)
                    self.league.promote_if_qualified(
                        entry,
                        [member.winrate_vs_smart for member in self.league.top(3)],
                    )
                print(f"[eval] step={self.global_step} winrate_vs_mock={winrate:.3f}")

        print("[done] training complete")

    def evaluate(self, matches: int) -> float:
        wins = 0
        for idx in range(matches):
            env = MockSelfPlayEnv(self.cfg.model)
            obs = env.reset(self.cfg.runtime.seed + 500_000 + idx)
            done = False
            final_info: Dict[str, float] = {}
            while not done:
                static_t, seq_t, masks = self._obs_batch_to_tensors([obs])
                with torch.no_grad():
                    outputs = self.model(static_t, seq_t)
                    sampled = self.model.sample_action(outputs, masks, deterministic=True)
                action = self._indices_to_action(sampled, 0)
                obs, _, done, info, _ = env.step(action)
                final_info = info
            if final_info.get("opp_base_hp", 1.0) <= final_info.get("own_base_hp", 0.0):
                wins += 1
        return wins / max(1, matches)

    def _collect_rollout(self) -> RolloutBatch:
        runtime = self.cfg.runtime
        horizon = runtime.rollout_horizon
        num_envs = runtime.num_envs
        model_cfg = self.cfg.model

        static_np = np.zeros((horizon, num_envs, model_cfg.static_dim), dtype=np.float32)
        seq_np = np.zeros((horizon, num_envs, model_cfg.sequence_len, model_cfg.token_dim), dtype=np.float32)
        rewards_np = np.zeros((horizon, num_envs), dtype=np.float32)
        dones_np = np.zeros((horizon, num_envs), dtype=np.float32)
        values_np = np.zeros((horizon, num_envs), dtype=np.float32)
        old_log_probs_np = np.zeros((horizon, num_envs), dtype=np.float32)

        action_indices = {
            "action": np.zeros((horizon, num_envs), dtype=np.int64),
            "unit": np.zeros((horizon, num_envs), dtype=np.int64),
            "turret": np.zeros((horizon, num_envs), dtype=np.int64),
            "buy_slot": np.zeros((horizon, num_envs), dtype=np.int64),
            "sell_slot": np.zeros((horizon, num_envs), dtype=np.int64),
        }
        mask_np = {
            "action_type": np.zeros((horizon, num_envs, model_cfg.action_dim), dtype=np.float32),
            "unit": np.zeros((horizon, num_envs, model_cfg.unit_dim), dtype=np.float32),
            "turret": np.zeros((horizon, num_envs, model_cfg.turret_dim), dtype=np.float32),
            "buy_slot": np.zeros((horizon, num_envs, model_cfg.slot_dim), dtype=np.float32),
            "sell_slot": np.zeros((horizon, num_envs, model_cfg.slot_dim), dtype=np.float32),
        }

        for t in range(horizon):
            static_t, seq_t, masks_t = self._obs_batch_to_tensors(self.obs)
            with torch.no_grad():
                outputs = self.model(static_t, seq_t)
                sampled = self.model.sample_action(outputs, masks_t, deterministic=False)

            static_np[t] = static_t.detach().cpu().numpy()
            seq_np[t] = seq_t.detach().cpu().numpy()
            values_np[t] = sampled["value"].detach().cpu().numpy()
            old_log_probs_np[t] = sampled["combined_log_prob"].detach().cpu().numpy()

            mask_np["action_type"][t] = masks_t["action_type"].detach().cpu().numpy()
            mask_np["unit"][t] = masks_t["unit"].detach().cpu().numpy()
            mask_np["turret"][t] = masks_t["turret"].detach().cpu().numpy()
            mask_np["buy_slot"][t] = masks_t["buy_slot"].detach().cpu().numpy()
            mask_np["sell_slot"][t] = masks_t["sell_slot"].detach().cpu().numpy()

            for key in action_indices:
                action_indices[key][t] = sampled[key].detach().cpu().numpy()

            for env_idx, env in enumerate(self.envs):
                action = self._indices_to_action(sampled, env_idx)
                next_obs, reward, done, _, _ = env.step(action)
                rewards_np[t, env_idx] = reward
                dones_np[t, env_idx] = float(done)
                if done:
                    next_obs = env.reset(self.cfg.runtime.seed + self.global_step + t * num_envs + env_idx + 1)
                self.obs[env_idx] = next_obs

        with torch.no_grad():
            next_static, next_seq, _ = self._obs_batch_to_tensors(self.obs)
            next_values = self.model(next_static, next_seq).value.detach().cpu().numpy()

        advantages_np, returns_np = compute_gae(
            rewards_np,
            values_np,
            dones_np,
            next_values,
            self.cfg.ppo.gamma,
            self.cfg.ppo.gae_lambda,
        )

        def flatten(arr: np.ndarray) -> np.ndarray:
            return arr.reshape(horizon * num_envs, *arr.shape[2:])

        flat_masks = {name: torch.tensor(flatten(value), device=self.device) for name, value in mask_np.items()}
        flat_actions = {
            name: torch.tensor(value.reshape(horizon * num_envs), device=self.device, dtype=torch.long)
            for name, value in action_indices.items()
        }

        return RolloutBatch(
            static_state=torch.tensor(flatten(static_np), device=self.device),
            event_sequence=torch.tensor(flatten(seq_np), device=self.device),
            masks=flat_masks,
            actions=flat_actions,
            old_log_probs=torch.tensor(old_log_probs_np.reshape(horizon * num_envs), device=self.device),
            old_values=torch.tensor(values_np.reshape(horizon * num_envs), device=self.device),
            rewards=torch.tensor(rewards_np.reshape(horizon * num_envs), device=self.device),
            dones=torch.tensor(dones_np.reshape(horizon * num_envs), device=self.device),
            advantages=torch.tensor(advantages_np.reshape(horizon * num_envs), device=self.device),
            returns=torch.tensor(returns_np.reshape(horizon * num_envs), device=self.device),
        )

    def _obs_batch_to_tensors(
        self, obs_batch: List[Observation]
    ) -> Tuple[torch.Tensor, torch.Tensor, Dict[str, torch.Tensor]]:
        static_state = torch.tensor(
            np.asarray([obs.static_state for obs in obs_batch], dtype=np.float32),
            device=self.device,
        )
        event_sequence = torch.tensor(
            np.asarray([obs.event_sequence for obs in obs_batch], dtype=np.float32),
            device=self.device,
        )
        masks = {
            "action_type": torch.tensor(np.asarray([obs.action_type_mask for obs in obs_batch], dtype=np.float32), device=self.device),
            "unit": torch.tensor(np.asarray([obs.unit_mask for obs in obs_batch], dtype=np.float32), device=self.device),
            "turret": torch.tensor(np.asarray([obs.turret_mask for obs in obs_batch], dtype=np.float32), device=self.device),
            "buy_slot": torch.tensor(np.asarray([obs.buy_slot_mask for obs in obs_batch], dtype=np.float32), device=self.device),
            "sell_slot": torch.tensor(np.asarray([obs.sell_slot_mask for obs in obs_batch], dtype=np.float32), device=self.device),
        }
        return static_state, event_sequence, masks

    def _indices_to_action(self, sampled: Dict[str, torch.Tensor], env_idx: int) -> Action:
        action_idx = int(sampled["action"][env_idx].item())
        action_type = ACTIONS[action_idx] if 0 <= action_idx < len(ACTIONS) else "WAIT"
        unit_idx = int(sampled["unit"][env_idx].item())
        turret_idx = int(sampled["turret"][env_idx].item())
        buy_slot_idx = int(sampled["buy_slot"][env_idx].item())
        sell_slot_idx = int(sampled["sell_slot"][env_idx].item())
        confidence = float(torch.sigmoid(sampled["action_log_prob"][env_idx]).item())

        if action_type == "RECRUIT_UNIT":
            return Action(action_type=action_type, unit_id=f"unit_{unit_idx}", confidence=confidence)
        if action_type == "BUY_TURRET_ENGINE":
            return Action(
                action_type=action_type,
                turret_id=f"turret_{turret_idx}",
                slot_index=buy_slot_idx,
                confidence=confidence,
            )
        if action_type == "SELL_TURRET_ENGINE":
            return Action(action_type=action_type, slot_index=sell_slot_idx, confidence=confidence)
        return Action(action_type=action_type, confidence=confidence)

    def _save_checkpoint(self) -> str:
        path = Path(self.cfg.runtime.save_dir) / f"checkpoint_{self.global_step}.pt"
        payload = {
            "step": self.global_step,
            "model": self.model.state_dict(),
            "optimizer": self.optimizer.state_dict(),
            "config": {
                "runtime": asdict(self.cfg.runtime),
                "ppo": asdict(self.cfg.ppo),
                "model": asdict(self.cfg.model),
            },
        }
        torch.save(payload, path)
        print(f"[checkpoint] saved {path}")
        return str(path)

    def _rollback_checkpoint(self) -> None:
        if not self.last_good_checkpoint:
            print("[guard] NaN detected but no checkpoint available yet; continuing")
            return
        state = torch.load(self.last_good_checkpoint, map_location=self.device)
        self.model.load_state_dict(state["model"])
        self.optimizer.load_state_dict(state["optimizer"])
        print(f"[guard] NaN/Inf detected. Rolled back to {self.last_good_checkpoint}")

    def _anneal_entropy(self) -> None:
        ppo = self.cfg.ppo
        progress = min(1.0, self.global_step / max(1, ppo.entropy_anneal_steps))
        ppo.entropy_coef = ppo.entropy_coef * (1.0 - progress) + ppo.entropy_coef_min * progress
