from __future__ import annotations

from dataclasses import asdict
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
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
        run_name: str | None = None,
        milestone_steps: List[int] | None = None,
    ) -> None:
        self.cfg = cfg
        runtime = cfg.runtime
        self.device = torch.device(runtime.device if torch.cuda.is_available() else "cpu")
        self.run_name = run_name or Path(runtime.save_dir).name
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
        self.best_eval_winrate = float("-inf")
        self.milestone_steps = sorted({int(step) for step in (milestone_steps or []) if int(step) > 0})
        self.saved_milestone_steps: set[int] = set()
        self.manifest_path = Path(runtime.save_dir) / "run_manifest.json"
        self.manifest: Dict[str, object] = {}

        Path(runtime.save_dir).mkdir(parents=True, exist_ok=True)
        self._load_or_init_manifest()
        self.obs: List[Observation] = [
            env.reset(runtime.seed + env_idx) for env_idx, env in enumerate(self.envs)
        ]

    def train(self) -> None:
        runtime = self.cfg.runtime
        while self.global_step < runtime.total_steps:
            previous_step = self.global_step
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
                checkpoint = self._save_checkpoint(kind="periodic")
                self.last_good_checkpoint = checkpoint

            self._save_crossed_milestones(previous_step, self.global_step)

            if self.global_step % runtime.eval_every == 0:
                winrate = self.evaluate(runtime.eval_matches)
                if self.last_good_checkpoint:
                    entry = self.league.add_checkpoint(self.last_good_checkpoint, self.global_step, winrate)
                    self.league.promote_if_qualified(
                        entry,
                        [member.winrate_vs_smart for member in self.league.top(3)],
                    )
                if winrate > self.best_eval_winrate:
                    self.best_eval_winrate = winrate
                    best_path = self._save_checkpoint(
                        kind="best",
                        metrics={"winrate_vs_mock": float(winrate)},
                    )
                    self._write_alias(best_path, "best.pt")
                print(f"[eval] step={self.global_step} winrate_vs_mock={winrate:.3f}")

        print("[done] training complete")

    def get_global_step(self) -> int:
        return int(self.global_step)

    def set_milestone_steps(self, steps: List[int]) -> None:
        self.milestone_steps = sorted({int(step) for step in steps if int(step) > 0})
        self._persist_manifest()

    def resume_from_checkpoint(self, checkpoint_path: str) -> None:
        path = Path(checkpoint_path)
        if not path.exists():
            raise FileNotFoundError(f"Checkpoint not found: {checkpoint_path}")
        state = torch.load(path, map_location=self.device)
        self.model.load_state_dict(state["model"])
        optimizer_state = state.get("optimizer")
        if optimizer_state:
            self.optimizer.load_state_dict(optimizer_state)
        self.global_step = int(state.get("step", 0))
        self.last_good_checkpoint = str(path)
        print(f"[resume] loaded checkpoint={path} step={self.global_step}")

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

    def _save_checkpoint(
        self,
        kind: str,
        metrics: Dict[str, float] | None = None,
        milestone_target_step: int | None = None,
    ) -> str:
        runtime = self.cfg.runtime
        timestamp = datetime.now(timezone.utc).isoformat()
        safe_kind = kind.replace(" ", "_")
        if milestone_target_step is not None:
            filename = (
                f"{safe_kind}_target_{int(milestone_target_step):09d}"
                f"_step_{int(self.global_step):09d}.pt"
            )
        else:
            filename = f"{safe_kind}_step_{int(self.global_step):09d}.pt"

        path = Path(runtime.save_dir) / filename
        payload = {
            "step": self.global_step,
            "kind": kind,
            "timestamp_utc": timestamp,
            "run_name": self.run_name,
            "metrics": metrics or {},
            "model": self.model.state_dict(),
            "optimizer": self.optimizer.state_dict(),
            "config": {
                "runtime": asdict(self.cfg.runtime),
                "ppo": asdict(self.cfg.ppo),
                "model": asdict(self.cfg.model),
            },
        }
        torch.save(payload, path)
        self._write_alias(str(path), "latest.pt")
        self._record_checkpoint(
            checkpoint_path=str(path),
            kind=kind,
            metrics=metrics or {},
            milestone_target_step=milestone_target_step,
        )
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

    def _save_crossed_milestones(self, previous_step: int, current_step: int) -> None:
        if not self.milestone_steps:
            return
        for target_step in self.milestone_steps:
            if target_step in self.saved_milestone_steps:
                continue
            if previous_step < target_step <= current_step:
                milestone_path = self._save_checkpoint(
                    kind="milestone",
                    metrics={},
                    milestone_target_step=target_step,
                )
                self.last_good_checkpoint = milestone_path
                self.saved_milestone_steps.add(target_step)
                print(
                    f"[milestone] reached target={target_step} actual_step={current_step}"
                )

    def _write_alias(self, checkpoint_path: str, alias_name: str) -> None:
        alias_path = Path(self.cfg.runtime.save_dir) / alias_name
        shutil.copy2(checkpoint_path, alias_path)

    def _record_checkpoint(
        self,
        checkpoint_path: str,
        kind: str,
        metrics: Dict[str, float],
        milestone_target_step: int | None = None,
    ) -> None:
        checkpoints = self.manifest.setdefault("checkpoints", [])
        if not isinstance(checkpoints, list):
            checkpoints = []
            self.manifest["checkpoints"] = checkpoints

        checkpoints.append(
            {
                "path": str(Path(checkpoint_path).name),
                "absolute_path": str(Path(checkpoint_path).resolve()),
                "step": int(self.global_step),
                "kind": kind,
                "timestamp_utc": datetime.now(timezone.utc).isoformat(),
                "metrics": metrics,
                "milestone_target_step": int(milestone_target_step) if milestone_target_step else None,
            }
        )
        if kind == "best":
            self.manifest["best_checkpoint"] = str(Path(checkpoint_path).name)
            self.manifest["best_eval_winrate"] = float(self.best_eval_winrate)

        self.manifest["last_step"] = int(self.global_step)
        self.manifest["last_updated_utc"] = datetime.now(timezone.utc).isoformat()
        self.manifest["saved_milestone_steps"] = sorted(
            {int(step) for step in self.saved_milestone_steps}
        )
        self._persist_manifest()

    def _load_or_init_manifest(self) -> None:
        if self.manifest_path.exists():
            try:
                with self.manifest_path.open("r", encoding="utf-8") as handle:
                    self.manifest = json.load(handle)
                saved = self.manifest.get("saved_milestone_steps", [])
                if isinstance(saved, list):
                    self.saved_milestone_steps = {int(step) for step in saved if int(step) > 0}
                best_winrate = self.manifest.get("best_eval_winrate", float("-inf"))
                if best_winrate is None:
                    self.best_eval_winrate = float("-inf")
                else:
                    self.best_eval_winrate = float(best_winrate)
                return
            except Exception:
                self.manifest = {}

        self.manifest = {
            "run_name": self.run_name,
            "created_utc": datetime.now(timezone.utc).isoformat(),
            "last_updated_utc": datetime.now(timezone.utc).isoformat(),
            "save_dir": str(Path(self.cfg.runtime.save_dir).resolve()),
            "last_step": 0,
            "best_checkpoint": None,
            "best_eval_winrate": None,
            "saved_milestone_steps": [],
            "milestone_steps": self.milestone_steps,
            "config": {
                "runtime": asdict(self.cfg.runtime),
                "ppo": asdict(self.cfg.ppo),
                "model": asdict(self.cfg.model),
            },
            "checkpoints": [],
        }
        self._persist_manifest()

    def _persist_manifest(self) -> None:
        self.manifest["milestone_steps"] = self.milestone_steps
        self.manifest["run_name"] = self.run_name
        self.manifest["last_updated_utc"] = datetime.now(timezone.utc).isoformat()
        with self.manifest_path.open("w", encoding="utf-8") as handle:
            json.dump(self.manifest, handle, indent=2)
