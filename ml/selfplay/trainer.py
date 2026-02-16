from __future__ import annotations

from dataclasses import asdict
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import shutil
import time
from typing import Callable, Dict, List, Tuple

import numpy as np
import torch
import torch.nn as nn
from torch.optim import AdamW

from .config import OvernightConfig
from .env import ACTIONS, MockSelfPlayEnv, SelfPlayEnv
from .league import LeaguePool, StrategyProfile
from .model import TransformerActorCritic
from .ppo import PPOUpdater, RolloutBatch, compute_gae
from .schemas import Action, Observation, RewardComponents


class SelfPlayTrainer:
    def __init__(
        self,
        cfg: OvernightConfig,
        env_factory: Callable[[], SelfPlayEnv] | None = None,
        eval_env_factory: Callable[[], SelfPlayEnv] | None = None,
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
        self.ppo = PPOUpdater(
            self.model,
            self.optimizer,
            cfg.ppo,
            self.device,
            mixed_precision=cfg.runtime.mixed_precision,
        )
        self.league = LeaguePool(
            keep_top_n=runtime.league_keep_top_n,
            keep_diverse_n=runtime.league_keep_diverse_n,
            max_agents=runtime.league_max_agents,
            min_promote_winrate=runtime.league_min_promote_winrate,
            archetype_winrate_floor=runtime.league_archetype_winrate_floor,
        )

        self.env_factory = env_factory or (lambda: MockSelfPlayEnv(cfg.model))
        self.eval_env_factory = eval_env_factory or self.env_factory
        self.envs: List[SelfPlayEnv] = [self.env_factory() for _ in range(runtime.num_envs)]
        self.env_step_pool = ThreadPoolExecutor(max_workers=runtime.num_envs) if runtime.num_envs > 1 else None
        self.global_step = 0
        self.last_good_checkpoint: str | None = None
        self.best_eval_winrate = float("-inf")
        self.milestone_steps = sorted({int(step) for step in (milestone_steps or []) if int(step) > 0})
        self.saved_milestone_steps: set[int] = set()
        self.manifest_path = Path(runtime.save_dir) / "run_manifest.json"
        self.manifest: Dict[str, object] = {}
        self.train_start_perf = time.perf_counter()
        self.train_start_step = 0
        self.last_rollout_profile = StrategyProfile()
        self.last_log_perf = self.train_start_perf
        self.update_count = 0
        self.dead_row_streaks: Dict[str, np.ndarray] = {}
        self.dead_revival_layers = self._resolve_dead_revival_layers()

        Path(runtime.save_dir).mkdir(parents=True, exist_ok=True)
        self._load_or_init_manifest()
        self.obs: List[Observation] = [
            env.reset(runtime.seed + env_idx) for env_idx, env in enumerate(self.envs)
        ]

    def train(self) -> None:
        runtime = self.cfg.runtime
        try:
            while self.global_step < runtime.total_steps:
                previous_step = self.global_step
                batch = self._collect_rollout()
                metrics = self.ppo.update(batch)
                self.update_count += 1
                self._maybe_revive_dead_units()
                self._anneal_entropy()
                self.global_step += runtime.rollout_horizon * runtime.num_envs

                if any(np.isnan(v) or np.isinf(v) for v in metrics.values()):
                    self._rollback_checkpoint()
                    continue

                crossed_log_boundary = (
                    runtime.log_interval > 0
                    and (previous_step // runtime.log_interval) < (self.global_step // runtime.log_interval)
                )
                prev_progress = min(1.0, previous_step / max(1, runtime.total_steps))
                curr_progress = min(1.0, self.global_step / max(1, runtime.total_steps))
                crossed_progress_bucket = int(prev_progress * 1000) < int(curr_progress * 1000)
                now_perf = time.perf_counter()
                timed_log_fallback = (now_perf - self.last_log_perf) >= 20.0
                should_log = crossed_log_boundary or crossed_progress_bucket or timed_log_fallback
                if should_log:
                    dense_scale, terminal_scale = self._reward_scales(self.global_step)
                    elapsed_s = max(1e-6, now_perf - self.train_start_perf)
                    progressed_steps = max(0, self.global_step - self.train_start_step)
                    steps_per_sec = progressed_steps / elapsed_s
                    remaining_steps = max(0, runtime.total_steps - self.global_step)
                    eta_seconds = remaining_steps / max(1e-6, steps_per_sec)
                    progress_pct = curr_progress * 100.0
                    print(
                        f"[step={self.global_step} progress={progress_pct:.1f}%] policy={metrics['policy_loss']:.4f} "
                        f"value={metrics['value_loss']:.4f} entropy={metrics['entropy']:.4f} "
                        f"kl={metrics['kl']:.5f} reward_scale(dense={dense_scale:.3f},terminal={terminal_scale:.3f}) "
                        f"sps={steps_per_sec:.1f} eta={self._format_eta(eta_seconds)}"
                    )
                    self.last_log_perf = now_perf
                    if metrics["entropy"] < runtime.entropy_floor_alert:
                        print(
                            f"[alert] entropy floor breached ({metrics['entropy']:.5f} < {runtime.entropy_floor_alert:.5f})"
                        )

                crossed_checkpoint_boundary = (
                    runtime.checkpoint_every > 0
                    and (previous_step // runtime.checkpoint_every) < (self.global_step // runtime.checkpoint_every)
                )
                if crossed_checkpoint_boundary:
                    checkpoint = self._save_checkpoint(
                        kind="periodic",
                        metrics=self._strategy_metrics(self.last_rollout_profile),
                    )
                    self.last_good_checkpoint = checkpoint

                self._save_crossed_milestones(previous_step, self.global_step)

                crossed_eval_boundary = (
                    runtime.eval_every > 0
                    and (previous_step // runtime.eval_every) < (self.global_step // runtime.eval_every)
                )
                if crossed_eval_boundary:
                    winrate = self.evaluate(runtime.eval_matches)
                    if self.last_good_checkpoint:
                        style = self.last_rollout_profile
                        entry = self.league.add_checkpoint(
                            self.last_good_checkpoint,
                            self.global_step,
                            winrate,
                            profile=style,
                        )
                        self.league.promote_if_qualified(
                            entry,
                            [member.winrate_vs_smart for member in self.league.top(3)],
                        )
                    if winrate > self.best_eval_winrate:
                        self.best_eval_winrate = winrate
                        best_metrics: Dict[str, float | str] = {"winrate_vs_mock": float(winrate)}
                        best_metrics.update(self._strategy_metrics(self.last_rollout_profile))
                        best_path = self._save_checkpoint(
                            kind="best",
                            metrics=best_metrics,
                        )
                        self._write_alias(best_path, "best.pt")
                    roster = self.league.roster()
                    roster_summary = ", ".join(
                        f"{item.profile.codename}:{item.winrate_vs_smart:.2f}"
                        for item in roster[: min(4, len(roster))]
                    )
                    print(
                        f"[eval] step={self.global_step} winrate_vs_mock={winrate:.3f} "
                        f"strategy={self.last_rollout_profile.archetype}/{self.last_rollout_profile.codename} "
                        f"league_size={len(roster)} top={roster_summary or 'n/a'}"
                    )
            print("[done] training complete")
        finally:
            self.close()

    def get_global_step(self) -> int:
        return int(self.global_step)

    def close(self) -> None:
        for env in self.envs:
            try:
                env.close()
            except Exception:
                pass
        if self.env_step_pool is not None:
            self.env_step_pool.shutdown(wait=True, cancel_futures=False)
            self.env_step_pool = None

    def set_milestone_steps(self, steps: List[int]) -> None:
        self.milestone_steps = sorted({int(step) for step in steps if int(step) > 0})
        self._persist_manifest()

    def _compatible_checkpoint_config(self, checkpoint_cfg: Dict[str, object]) -> bool:
        model_cfg = checkpoint_cfg.get("model")
        if not isinstance(model_cfg, dict):
            return False
        current_model = asdict(self.cfg.model)
        for key in [
            "static_dim",
            "sequence_len",
            "token_dim",
            "action_dim",
            "unit_dim",
            "turret_dim",
            "slot_dim",
            "d_model",
            "n_heads",
            "n_layers",
            "ffn_dim",
        ]:
            if int(model_cfg.get(key, -1)) != int(current_model.get(key, -2)):
                return False
        return True

    def resume_from_checkpoint(self, checkpoint_path: str) -> None:
        path = Path(checkpoint_path)
        if not path.exists():
            raise FileNotFoundError(f"Checkpoint not found: {checkpoint_path}")
        state = torch.load(path, map_location=self.device)
        checkpoint_cfg = state.get("config")
        if isinstance(checkpoint_cfg, dict) and not self._compatible_checkpoint_config(checkpoint_cfg):
            raise ValueError(
                "Checkpoint architecture is incompatible with current model config. "
                "Use matching config or start a fresh run."
            )
        checkpoint_signature = state.get("training_signature")
        if isinstance(checkpoint_signature, dict) and checkpoint_signature != self._training_signature():
            raise ValueError(
                "Checkpoint training signature mismatch (PPO/reward schedule differs). "
                "Resume with matching settings or start a fresh run directory."
            )
        self.model.load_state_dict(state["model"])
        optimizer_state = state.get("optimizer")
        if optimizer_state:
            self.optimizer.load_state_dict(optimizer_state)
        self.global_step = int(state.get("step", 0))
        quantum = max(1, self.cfg.runtime.rollout_horizon * self.cfg.runtime.num_envs)
        self.update_count = max(0, self.global_step // quantum)
        self.last_good_checkpoint = str(path)
        self.train_start_perf = time.perf_counter()
        self.train_start_step = self.global_step
        self.last_log_perf = self.train_start_perf
        print(f"[resume] loaded checkpoint={path} step={self.global_step}")

    def evaluate(self, matches: int) -> float:
        if matches <= 0:
            return 0.0

        runtime = self.cfg.runtime
        eval_workers = self._resolve_eval_workers(matches)
        total_matches = int(matches)
        completed = 0
        wins = 0
        seed_base = runtime.seed + 500_000
        next_match_idx = 0
        eval_start_perf = time.perf_counter()
        last_progress_print_perf = eval_start_perf

        envs: List[SelfPlayEnv] = []
        observations: List[Observation] = []
        for _ in range(min(eval_workers, total_matches)):
            env = self.eval_env_factory()
            match_idx = next_match_idx
            next_match_idx += 1
            obs = env.reset(seed_base + match_idx)
            envs.append(env)
            observations.append(obs)

        print(f"[eval-start] matches={total_matches} workers={len(envs)}")
        try:
            with ThreadPoolExecutor(max_workers=max(1, len(envs))) as eval_pool:
                while completed < total_matches and envs:
                    static_t, seq_t, masks = self._obs_batch_to_tensors(observations)
                    with torch.no_grad():
                        outputs = self.model(static_t, seq_t)
                        sampled = self.model.sample_action(outputs, masks, deterministic=True)
                    actions = [self._indices_to_action(sampled, idx) for idx in range(len(observations))]
                    futures = [eval_pool.submit(envs[idx].step, actions[idx]) for idx in range(len(envs))]
                    results = [future.result() for future in futures]

                    for idx in range(len(envs) - 1, -1, -1):
                        next_obs, _, done, info, _ = results[idx]
                        if not done:
                            observations[idx] = next_obs
                            continue

                        if info.get("opp_base_hp", 1.0) <= info.get("own_base_hp", 0.0):
                            wins += 1
                        completed += 1

                        now = time.perf_counter()
                        if (now - last_progress_print_perf >= 2.0) or (completed == total_matches):
                            elapsed = max(1e-6, now - eval_start_perf)
                            mps = completed / elapsed
                            remaining = max(0, total_matches - completed)
                            eta = remaining / max(1e-6, mps)
                            print(
                                f"[eval-progress] done={completed}/{total_matches} "
                                f"({(completed / total_matches) * 100:.1f}%) mps={mps:.2f} eta={self._format_eta(eta)}"
                            )
                            last_progress_print_perf = now

                        if next_match_idx < total_matches:
                            replacement_match_idx = next_match_idx
                            next_match_idx += 1
                            replacement_obs = envs[idx].reset(seed_base + replacement_match_idx)
                            observations[idx] = replacement_obs
                        else:
                            envs[idx].close()
                            del envs[idx]
                            del observations[idx]
        finally:
            for env in envs:
                try:
                    env.close()
                except Exception:
                    pass

        return wins / max(1, total_matches)

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

        current_checkpoint = self.last_good_checkpoint
        for env in self.envs:
            opponent = self.league.sample_opponent(current_checkpoint)
            if opponent:
                env.set_opponent_profile(
                    {
                        "elo": float(opponent.elo),
                        "winrate_vs_smart": float(opponent.winrate_vs_smart),
                        "steps": float(opponent.steps),
                        "checkpoint_id": str(opponent.checkpoint_path),
                        "archetype": str(opponent.profile.archetype),
                        "aggression": float(opponent.profile.aggression),
                        "teching": float(opponent.profile.teching),
                        "defense": float(opponent.profile.defense),
                    }
                )
            else:
                env.set_opponent_profile(None)

        action_counts = np.zeros((len(ACTIONS),), dtype=np.float64)
        reward_sums = {
            "enemy_base_damage": 0.0,
            "own_base_damage": 0.0,
            "safe_age_up_bonus": 0.0,
            "illegal_action_penalty": 0.0,
            "terminal_outcome": 0.0,
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
            sampled_action_batch = sampled["action"].detach().cpu().numpy()
            for idx in sampled_action_batch:
                if 0 <= int(idx) < len(ACTIONS):
                    action_counts[int(idx)] += 1

            actions = [self._indices_to_action(sampled, env_idx) for env_idx in range(num_envs)]
            if self.env_step_pool is not None:
                futures = [
                    self.env_step_pool.submit(self.envs[env_idx].step, actions[env_idx])
                    for env_idx in range(num_envs)
                ]
                step_results = [future.result() for future in futures]
            else:
                step_results = [
                    self.envs[env_idx].step(actions[env_idx])
                    for env_idx in range(num_envs)
                ]

            for env_idx, (next_obs, reward, done, _, reward_components) in enumerate(step_results):
                progress_step = self.global_step + t * num_envs + env_idx
                shaped_reward = self._compose_reward(reward_components, progress_step)
                rewards_np[t, env_idx] = shaped_reward if np.isfinite(shaped_reward) else reward
                dones_np[t, env_idx] = float(done)
                reward_sums["enemy_base_damage"] += float(reward_components.enemy_base_damage)
                reward_sums["own_base_damage"] += float(reward_components.own_base_damage)
                reward_sums["safe_age_up_bonus"] += float(reward_components.safe_age_up_bonus)
                reward_sums["illegal_action_penalty"] += float(reward_components.illegal_action_penalty)
                reward_sums["terminal_outcome"] += float(reward_components.terminal_outcome)
                if done:
                    next_obs = self.envs[env_idx].reset(
                        self.cfg.runtime.seed + self.global_step + t * num_envs + env_idx + 1
                    )
                self.obs[env_idx] = next_obs

        self.last_rollout_profile = self._build_strategy_profile(action_counts, reward_sums)

        if self.cfg.runtime.reward_normalize:
            reward_mean = float(np.mean(rewards_np))
            reward_std = float(np.std(rewards_np))
            rewards_np = (rewards_np - reward_mean) / max(1e-6, reward_std)
            clip_abs = float(max(0.0, self.cfg.runtime.reward_clip_abs))
            if clip_abs > 0:
                rewards_np = np.clip(rewards_np, -clip_abs, clip_abs)

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

    def _build_strategy_profile(
        self,
        action_counts: np.ndarray,
        reward_sums: Dict[str, float],
    ) -> StrategyProfile:
        total = float(max(1.0, np.sum(action_counts)))
        action_mix: Dict[str, float] = {
            action_name: float(action_counts[idx] / total)
            for idx, action_name in enumerate(ACTIONS)
        }
        recruit = action_mix.get("RECRUIT_UNIT", 0.0)
        buy_turret = action_mix.get("BUY_TURRET_ENGINE", 0.0)
        repair = action_mix.get("REPAIR_BASE", 0.0)
        age_up = action_mix.get("AGE_UP", 0.0)
        mana_up = action_mix.get("UPGRADE_MANA", 0.0)
        slot_up = action_mix.get("UPGRADE_TURRET_SLOTS", 0.0)
        wait = action_mix.get("WAIT", 0.0)
        sell_turret = action_mix.get("SELL_TURRET_ENGINE", 0.0)

        aggression = float(np.clip(recruit * 0.75 + buy_turret * 0.15 + max(0.0, reward_sums["enemy_base_damage"]) * 0.003, 0.0, 1.5))
        teching = float(np.clip(age_up * 0.5 + mana_up * 0.35 + slot_up * 0.35 + max(0.0, reward_sums["safe_age_up_bonus"]) * 0.06, 0.0, 1.5))
        defense = float(
            np.clip(
                buy_turret * 0.35
                + repair * 0.55
                + sell_turret * 0.2
                + max(0.0, -reward_sums["own_base_damage"]) * 0.003,
                0.0,
                1.5,
            )
        )
        archetype = self._classify_archetype(aggression, teching, defense, action_mix)
        codename = self._codename_from_profile(archetype, action_mix, self.global_step)
        if wait > 0.65:
            archetype = "passive"
        return StrategyProfile(
            archetype=archetype,
            codename=codename,
            aggression=aggression,
            teching=teching,
            defense=defense,
            action_mix=action_mix,
        )

    def _classify_archetype(
        self,
        aggression: float,
        teching: float,
        defense: float,
        action_mix: Dict[str, float],
    ) -> str:
        recruit = action_mix.get("RECRUIT_UNIT", 0.0)
        buy_turret = action_mix.get("BUY_TURRET_ENGINE", 0.0)
        age_up = action_mix.get("AGE_UP", 0.0)
        mana_up = action_mix.get("UPGRADE_MANA", 0.0)
        repair = action_mix.get("REPAIR_BASE", 0.0)
        if aggression > teching + 0.12 and aggression > defense + 0.1:
            if recruit > 0.45:
                return "swarm"
            return "raider"
        if teching > aggression + 0.12 and teching > defense:
            if age_up + mana_up > 0.2:
                return "techer"
            return "scaler"
        if defense > aggression + 0.1 and defense > teching:
            if repair + buy_turret > 0.12:
                return "fortress"
            return "turtle"
        return "balanced"

    def _codename_from_profile(self, archetype: str, action_mix: Dict[str, float], step: int) -> str:
        themes = {
            "swarm": ("Swarm", ["Rush", "Flood", "Stampede", "Torrent"]),
            "raider": ("Raider", ["Spike", "Lancer", "Pouncer", "Harrier"]),
            "techer": ("Techer", ["Forge", "Ascendant", "Engineer", "Catalyst"]),
            "scaler": ("Scaler", ["Compounder", "Accumulator", "Investor", "Builder"]),
            "fortress": ("Fortress", ["Bulwark", "Bastion", "Citadel", "Rampart"]),
            "turtle": ("Turtle", ["Wall", "Shell", "Aegis", "Anchor"]),
            "passive": ("Passive", ["Drifter", "Lurker", "Sleeper", "Staller"]),
            "balanced": ("Balanced", ["Vanguard", "Hybrid", "Pivot", "Navigator"]),
        }
        prefix, options = themes.get(archetype, themes["balanced"])
        mix_hash = int(
            round(sum((idx + 1) * action_mix.get(action, 0.0) * 1000 for idx, action in enumerate(ACTIONS)))
        )
        idx = (mix_hash + int(step)) % len(options)
        return f"{prefix} {options[idx]}"

    def _strategy_metrics(self, profile: StrategyProfile) -> Dict[str, float | str]:
        return {
            "strategy_archetype": profile.archetype,
            "strategy_codename": profile.codename,
            "strategy_aggression": round(profile.aggression, 6),
            "strategy_teching": round(profile.teching, 6),
            "strategy_defense": round(profile.defense, 6),
            "action_mix_wait": round(float(profile.action_mix.get("WAIT", 0.0)), 6),
            "action_mix_recruit": round(float(profile.action_mix.get("RECRUIT_UNIT", 0.0)), 6),
            "action_mix_age_up": round(float(profile.action_mix.get("AGE_UP", 0.0)), 6),
            "action_mix_upgrade_mana": round(float(profile.action_mix.get("UPGRADE_MANA", 0.0)), 6),
            "action_mix_upgrade_slots": round(float(profile.action_mix.get("UPGRADE_TURRET_SLOTS", 0.0)), 6),
            "action_mix_buy_turret": round(float(profile.action_mix.get("BUY_TURRET_ENGINE", 0.0)), 6),
            "action_mix_sell_turret": round(float(profile.action_mix.get("SELL_TURRET_ENGINE", 0.0)), 6),
            "action_mix_repair": round(float(profile.action_mix.get("REPAIR_BASE", 0.0)), 6),
        }

    def _training_signature(self) -> Dict[str, object]:
        return {
            "model": asdict(self.cfg.model),
            "ppo_core": {
                "gamma": self.cfg.ppo.gamma,
                "gae_lambda": self.cfg.ppo.gae_lambda,
                "clip_epsilon": self.cfg.ppo.clip_epsilon,
            },
            "reward_schedule": {
                "dense_start": self.cfg.runtime.reward_dense_scale_start,
                "dense_end": self.cfg.runtime.reward_dense_scale_end,
                "dense_decay_interval": self.cfg.runtime.reward_dense_decay_interval,
                "dense_decay_factor": self.cfg.runtime.reward_dense_decay_factor,
                "terminal_start": self.cfg.runtime.reward_terminal_scale_start,
                "terminal_end": self.cfg.runtime.reward_terminal_scale_end,
                "curriculum_steps": self.cfg.runtime.reward_curriculum_steps,
                "reward_normalize": self.cfg.runtime.reward_normalize,
                "reward_clip_abs": self.cfg.runtime.reward_clip_abs,
            },
            "league": {
                "keep_top_n": self.cfg.runtime.league_keep_top_n,
                "keep_diverse_n": self.cfg.runtime.league_keep_diverse_n,
                "max_agents": self.cfg.runtime.league_max_agents,
                "min_promote_winrate": self.cfg.runtime.league_min_promote_winrate,
                "archetype_winrate_floor": self.cfg.runtime.league_archetype_winrate_floor,
            },
            "dead_unit_revival": {
                "enabled": self.cfg.runtime.dead_unit_revival_enabled,
                "check_every": self.cfg.runtime.dead_unit_check_every,
                "zero_epsilon": self.cfg.runtime.dead_unit_zero_epsilon,
                "streak": self.cfg.runtime.dead_unit_streak,
            },
        }

    def _save_checkpoint(
        self,
        kind: str,
        metrics: Dict[str, float | str] | None = None,
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
            "training_signature": self._training_signature(),
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

    def _resolve_dead_revival_layers(self) -> Dict[str, nn.Linear]:
        candidates: Dict[str, object] = {
            "action_head": getattr(self.model, "action_head", None),
            "unit_head": getattr(self.model, "unit_head", None),
            "turret_head": getattr(self.model, "turret_head", None),
            "buy_slot_head": getattr(self.model, "buy_slot_head", None),
            "sell_slot_head": getattr(self.model, "sell_slot_head", None),
            "value_head": getattr(self.model, "value_head", None),
        }
        resolved: Dict[str, nn.Linear] = {}
        for name, module in candidates.items():
            if isinstance(module, nn.Linear):
                resolved[name] = module
        return resolved

    def _maybe_revive_dead_units(self) -> None:
        runtime = self.cfg.runtime
        if not runtime.dead_unit_revival_enabled:
            return
        if runtime.dead_unit_check_every <= 0:
            return
        if self.update_count % runtime.dead_unit_check_every != 0:
            return
        eps = float(runtime.dead_unit_zero_epsilon)
        streak_target = int(runtime.dead_unit_streak)
        revived_summary: List[str] = []
        with torch.no_grad():
            for layer_name, layer in self.dead_revival_layers.items():
                row_count = int(layer.weight.shape[0])
                if row_count <= 0:
                    continue
                streak = self.dead_row_streaks.get(layer_name)
                if streak is None or streak.shape[0] != row_count:
                    streak = np.zeros((row_count,), dtype=np.int32)

                weight_rows = layer.weight.detach().reshape(row_count, -1)
                row_abs_max = weight_rows.abs().max(dim=1).values
                finite_rows = torch.isfinite(weight_rows).all(dim=1)
                if layer.bias is not None:
                    bias_abs = layer.bias.detach().abs()
                    finite_rows = finite_rows & torch.isfinite(layer.bias.detach())
                else:
                    bias_abs = torch.zeros((row_count,), device=layer.weight.device, dtype=layer.weight.dtype)

                zero_rows = (row_abs_max <= eps) & (bias_abs <= eps)
                zero_np = zero_rows.detach().cpu().numpy().astype(bool)
                finite_np = finite_rows.detach().cpu().numpy().astype(bool)
                streak[zero_np] += 1
                streak[~zero_np] = 0

                dead_zero_np = streak >= streak_target
                non_finite_np = ~finite_np
                dead_np = np.logical_or(dead_zero_np, non_finite_np)
                dead_indices = np.where(dead_np)[0]
                if dead_indices.size == 0:
                    self.dead_row_streaks[layer_name] = streak
                    continue

                revived_zero = 0
                revived_non_finite = 0
                for row_idx in dead_indices.tolist():
                    if non_finite_np[row_idx]:
                        revived_non_finite += 1
                    elif dead_zero_np[row_idx]:
                        revived_zero += 1
                    self._reinitialize_linear_row(layer, int(row_idx))
                    self._reset_optimizer_row_state(layer.weight, int(row_idx))
                    if layer.bias is not None:
                        self._reset_optimizer_row_state(layer.bias, int(row_idx))
                    streak[row_idx] = 0

                self.dead_row_streaks[layer_name] = streak
                revived_summary.append(
                    f"{layer_name}:rows={dead_indices.size}(zero={revived_zero},non_finite={revived_non_finite})"
                )
        if revived_summary:
            print(f"[revive] update={self.update_count} " + "; ".join(revived_summary))

    def _reinitialize_linear_row(self, layer: nn.Linear, row_idx: int) -> None:
        row = layer.weight[row_idx : row_idx + 1]
        nn.init.kaiming_uniform_(row, a=np.sqrt(5.0))
        if layer.bias is not None:
            fan_in = int(layer.weight.shape[1]) if layer.weight.ndim >= 2 else int(layer.weight.numel())
            bound = 1.0 / float(np.sqrt(max(1, fan_in)))
            layer.bias[row_idx].uniform_(-bound, bound)

    def _reset_optimizer_row_state(self, param: torch.Tensor, row_idx: int) -> None:
        state = self.optimizer.state.get(param)
        if not state:
            return
        for value in state.values():
            if not torch.is_tensor(value):
                continue
            if value.shape != param.shape:
                continue
            if param.ndim == 1:
                if 0 <= row_idx < value.shape[0]:
                    value[row_idx] = 0
            elif param.ndim >= 2:
                if 0 <= row_idx < value.shape[0]:
                    value[row_idx] = 0

    def _format_eta(self, eta_seconds: float) -> str:
        if not np.isfinite(eta_seconds) or eta_seconds < 0:
            return "unknown"
        total = int(round(eta_seconds))
        hours, rem = divmod(total, 3600)
        minutes, seconds = divmod(rem, 60)
        if hours > 0:
            return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
        return f"{minutes:02d}:{seconds:02d}"

    def _resolve_eval_workers(self, matches: int) -> int:
        requested = int(getattr(self.cfg.runtime, "eval_workers", 0))
        if requested > 0:
            return max(1, min(matches, requested))
        auto = max(1, min(matches, self.cfg.runtime.num_envs))
        return int(auto)

    def _reward_progress(self, step: int) -> float:
        runtime = self.cfg.runtime
        curriculum_steps = runtime.reward_curriculum_steps if runtime.reward_curriculum_steps > 0 else runtime.total_steps
        return float(np.clip(step / max(1, curriculum_steps), 0.0, 1.0))

    def _reward_scales(self, step: int) -> Tuple[float, float]:
        runtime = self.cfg.runtime
        progress = self._reward_progress(step)
        dense_scale = runtime.reward_dense_scale_start + (
            runtime.reward_dense_scale_end - runtime.reward_dense_scale_start
        ) * progress
        decay_interval = float(runtime.reward_dense_decay_interval)
        decay_factor = float(runtime.reward_dense_decay_factor)
        if decay_interval > 0 and decay_factor > 0 and decay_factor < 1:
            milestones_crossed = int(np.floor(progress / decay_interval + 1e-8))
            dense_scale *= decay_factor ** milestones_crossed
        terminal_scale = runtime.reward_terminal_scale_start + (
            runtime.reward_terminal_scale_end - runtime.reward_terminal_scale_start
        ) * progress
        return float(dense_scale), float(terminal_scale)

    def _compose_reward(self, components: RewardComponents, step: int) -> float:
        dense_scale, terminal_scale = self._reward_scales(step)
        dense_reward = (
            components.enemy_unit_kill_value
            + components.own_unit_loss_value
            + components.enemy_base_damage
            + components.own_base_damage
            + components.safe_age_up_bonus
            + components.lane_control_delta
            + components.illegal_action_penalty
        )
        return dense_reward * dense_scale + components.terminal_outcome * terminal_scale

    def _save_crossed_milestones(self, previous_step: int, current_step: int) -> None:
        if not self.milestone_steps:
            return
        for target_step in self.milestone_steps:
            if target_step in self.saved_milestone_steps:
                continue
            if previous_step < target_step <= current_step:
                milestone_path = self._save_checkpoint(
                    kind="milestone",
                    metrics=self._strategy_metrics(self.last_rollout_profile),
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
        metrics: Dict[str, float | str],
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
        self.manifest["training_signature"] = self._training_signature()
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
                manifest_sig = self.manifest.get("training_signature")
                if isinstance(manifest_sig, dict) and manifest_sig != self._training_signature():
                    raise RuntimeError(
                        "Run manifest signature mismatch in save dir. "
                        "Start with a clean run directory or resume from a compatible checkpoint."
                    )
                return
            except RuntimeError:
                raise
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
            "training_signature": self._training_signature(),
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
