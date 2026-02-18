from __future__ import annotations

from dataclasses import asdict
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
import json
import math
import os
from pathlib import Path
import shutil
import sys
import textwrap
import time
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
from torch.optim import AdamW

from .config import OvernightConfig
from .env import ACTIONS, MockSelfPlayEnv, SelfPlayEnv
from .league import LeagueEntry, LeaguePool, StrategyProfile
from .model import TransformerActorCritic
from .ppo import PPOUpdater, RolloutBatch, compute_gae
from .resource_monitor import ResourceMonitor, ResourceSample
from .schemas import Action, Observation, RewardComponents

AUTOSCALE_INF_CAP = 1_000_000


class SelfPlayTrainer:
    def __init__(
        self,
        cfg: OvernightConfig,
        env_factory: Callable[[], SelfPlayEnv] | None = None,
        eval_env_factory: Callable[[], SelfPlayEnv] | None = None,
        run_name: str | None = None,
        milestone_steps: List[int] | None = None,
        on_checkpoint_saved: Callable[[], None] | None = None,
        allow_manifest_signature_mismatch: bool = False,
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
            arbiters_csv=runtime.league_arbiters,
            min_games_per_agent=runtime.league_min_games_per_agent,
            elo_random_factor=runtime.league_elo_random_factor,
            use_checkpoint_opponents=runtime.league_use_checkpoint_opponents,
            spinoffs_per_anchor=runtime.league_spinoffs_per_anchor,
            spinoff_noise=runtime.league_spinoff_noise,
        )
        self.league_configured_arbiters = self._parse_arbiter_csv(runtime.league_arbiters)
        configured_phaseout_order = self._parse_arbiter_csv(runtime.league_arbiter_phaseout_order)
        if configured_phaseout_order:
            self.league_arbiter_phaseout_order = [
                item for item in configured_phaseout_order if item in set(self.league_configured_arbiters)
            ]
        else:
            self.league_arbiter_phaseout_order = list(self.league_configured_arbiters)
        self._last_disabled_arbiters: set[str] = set()
        self.telemetry_color_enabled = self._resolve_telemetry_color_enabled()
        self.telemetry_width = self._resolve_telemetry_width()

        self.autoscale_enabled = bool(runtime.smart_env_autoscale)
        self.autoscale_min_envs = max(1, int(runtime.smart_env_min_envs))
        self.autoscale_unbounded = int(getattr(runtime, "smart_env_max_envs", 0)) <= 0
        self.autoscale_max_envs = self._resolve_smart_env_max(runtime)
        self.last_autoscale_adjust_perf = time.perf_counter() - max(
            0.0, float(runtime.smart_env_adjust_cooldown_sec)
        )
        self.resource_monitor: Optional[ResourceMonitor] = None
        self.env_factory = env_factory or (lambda: MockSelfPlayEnv(cfg.model))
        self.eval_env_factory = eval_env_factory or self.env_factory
        self.last_autoscale_status_log_perf = 0.0
        if self.autoscale_enabled:
            # In autoscale mode, bootstrap from min and let scaler add capacity.
            initial_envs = max(1, self.autoscale_min_envs)
        else:
            initial_envs = int(runtime.num_envs)
        self.envs: List[SelfPlayEnv] = [self.env_factory() for _ in range(max(1, initial_envs))]
        self.env_step_pool = ThreadPoolExecutor(max_workers=len(self.envs)) if len(self.envs) > 1 else None
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
        self.last_rollout_telemetry_line = ""
        self.last_rollout_resource_sample: Optional[ResourceSample] = None
        self.last_log_perf = self.train_start_perf
        self.update_count = 0
        self.live_match_count = 0
        self.live_match_win_sum = 0.0
        self.checkpoint_include_env_state = self._env_flag("CHECKPOINT_INCLUDE_ENV_STATE", False)
        self.resume_restore_env_state = self._env_flag(
            "RESUME_RESTORE_ENV_STATE",
            self.checkpoint_include_env_state,
        )
        self.dead_row_streaks: Dict[str, np.ndarray] = {}
        self.dead_revival_layers = self._resolve_dead_revival_layers()
        self.on_checkpoint_saved = on_checkpoint_saved
        self.allow_manifest_signature_mismatch = bool(allow_manifest_signature_mismatch)

        Path(runtime.save_dir).mkdir(parents=True, exist_ok=True)
        self._load_or_init_manifest()
        self._refresh_league_baseline_phaseout(force_log=True)
        self.obs: List[Observation] = [
            env.reset(runtime.seed + env_idx) for env_idx, env in enumerate(self.envs)
        ]
        if self.autoscale_enabled:
            self.resource_monitor = ResourceMonitor(
                sample_hz=runtime.smart_env_sample_hz,
                gpu_probe_hz=runtime.smart_env_gpu_probe_hz,
                enable_gpu=(self.device.type == "cuda"),
                history_sec=max(20.0, float(runtime.smart_env_gpu_sustain_sec) + 2.0),
            )
            self.resource_monitor.start()
            max_label = "inf" if self.autoscale_unbounded else str(self.autoscale_max_envs)
            print(
                f"[autoscale] enabled target={runtime.smart_env_target_util_percent:.1f}% "
                f"down_trigger={runtime.smart_env_scale_down_trigger_percent:.1f}% "
                f"gpu_sustain={runtime.smart_env_gpu_sustain_sec:.1f}s "
                f"env_range={self.autoscale_min_envs}-{max_label}"
            )

    def train(self) -> None:
        runtime = self.cfg.runtime
        try:
            while self.global_step < runtime.total_steps:
                self._maybe_autoscale_envs()
                previous_step = self.global_step
                active_envs = len(self.envs)
                batch = self._collect_rollout()
                metrics = self.ppo.update(batch)
                self.update_count += 1
                self._maybe_revive_dead_units()
                self._anneal_entropy()
                self.global_step += runtime.rollout_horizon * active_envs

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
                        self._format_step_log(
                            step=self.global_step,
                            progress_pct=progress_pct,
                            envs=active_envs,
                            policy=metrics["policy_loss"],
                            value=metrics["value_loss"],
                            entropy=metrics["entropy"],
                            kl=metrics["kl"],
                            dense_scale=dense_scale,
                            terminal_scale=terminal_scale,
                            steps_per_sec=steps_per_sec,
                            eta_seconds=eta_seconds,
                        )
                    )
                    if self.last_rollout_telemetry_line:
                        print(self.last_rollout_telemetry_line)
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
                    live_winrate = self._current_live_winrate()
                    self.league.add_checkpoint(
                        checkpoint,
                        self.global_step,
                        live_winrate,
                        profile=self.last_rollout_profile,
                    )

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
                        best_metrics: Dict[str, float | str] = {
                            "winrate_vs_eval_opponent": float(winrate),
                            # Backward-compatible alias for older consumers.
                            "winrate_vs_mock": float(winrate),
                        }
                        best_metrics.update(self._strategy_metrics(self.last_rollout_profile))
                        best_path = self._save_checkpoint(
                            kind="best",
                            metrics=best_metrics,
                        )
                        self._write_alias(best_path, "best.pt")
                    roster = self.league.roster()
                    roster_summary_all = self._format_league_roster_summary(roster, top_n=4)
                    learned = self.league.top(4)
                    roster_summary_ml = self._format_league_roster_summary(learned, top_n=4)
                    print(
                        f"[eval] step={self.global_step} winrate_vs_eval_opponent={winrate:.3f} "
                        f"strategy={self.last_rollout_profile.archetype}/{self.last_rollout_profile.codename} "
                        f"league_size={len(roster)} "
                        f"top_all={roster_summary_all or 'n/a'} "
                        f"top_ml={roster_summary_ml or 'n/a'}"
                    )
            print("[done] training complete")
        finally:
            self.close()

    def get_global_step(self) -> int:
        return int(self.global_step)

    def close(self) -> None:
        if self.resource_monitor is not None:
            self.resource_monitor.stop()
            self.resource_monitor = None
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

    def _resolve_smart_env_max(self, runtime) -> int:
        explicit_max = int(getattr(runtime, "smart_env_max_envs", 0))
        if explicit_max > 0:
            return max(self.autoscale_min_envs, explicit_max)
        return max(self.autoscale_min_envs, AUTOSCALE_INF_CAP)

    def _rebuild_env_step_pool(self) -> None:
        if self.env_step_pool is not None:
            self.env_step_pool.shutdown(wait=True, cancel_futures=False)
            self.env_step_pool = None
        if len(self.envs) > 1:
            self.env_step_pool = ThreadPoolExecutor(max_workers=len(self.envs))

    def _resize_envs(self, target_count: int) -> None:
        target = max(1, int(target_count))
        if self.autoscale_enabled:
            target = max(self.autoscale_min_envs, min(self.autoscale_max_envs, target))
        current = len(self.envs)
        if target == current:
            return

        if target > current:
            added_envs: List[SelfPlayEnv] = []
            added_obs: List[Observation] = []
            try:
                for idx in range(current, target):
                    env = self.env_factory()
                    seed = int(self.cfg.runtime.seed + self.global_step + (idx + 1) * 977)
                    obs = env.reset(seed)
                    added_envs.append(env)
                    added_obs.append(obs)
            except Exception:
                for env in added_envs:
                    try:
                        env.close()
                    except Exception:
                        pass
                raise
            self.envs.extend(added_envs)
            self.obs.extend(added_obs)
        else:
            remove_count = current - target
            for _ in range(remove_count):
                env = self.envs.pop()
                self.obs.pop()
                try:
                    env.close()
                except Exception:
                    pass

        self._rebuild_env_step_pool()

    def _can_scale_up(self, sample: ResourceSample) -> bool:
        target = float(self.cfg.runtime.smart_env_target_util_percent)
        # Scale-up decisions are CPU/RAM-driven to avoid reacting to short GPU bursts.
        _, peak_util = self._peak_utilization(sample, include_gpu=False, include_gpu_mem=False)
        return peak_util < target

    def _scale_down_reason(self, cpu_ram_sample: ResourceSample, live_sample: ResourceSample) -> str | None:
        threshold = float(self.cfg.runtime.smart_env_scale_down_trigger_percent)
        if float(cpu_ram_sample.cpu_percent) >= threshold:
            return "cpu_rollout"
        if float(cpu_ram_sample.ram_percent) >= threshold:
            return "ram_rollout"
        # GPU memory is safety-critical and should react quickly.
        if live_sample.gpu_mem_percent is not None and float(live_sample.gpu_mem_percent) >= threshold:
            return "gpu_mem"
        # GPU utilization only counts if sustained high for a long window.
        if live_sample.gpu_util_percent is not None and self.resource_monitor is not None:
            window_sec = max(1.0, float(self.cfg.runtime.smart_env_gpu_sustain_sec))
            if self.resource_monitor.sustained_gpu_util_over(
                threshold_percent=threshold,
                window_sec=window_sec,
                min_ratio=0.9,
            ):
                return f"gpu_util_sustained_{window_sec:.0f}s"
        return None

    def _peak_utilization(
        self,
        sample: ResourceSample,
        *,
        include_gpu: bool = True,
        include_gpu_mem: bool = True,
    ) -> Tuple[str, float]:
        candidates: List[Tuple[str, float]] = [
            ("cpu", float(sample.cpu_percent)),
            ("ram", float(sample.ram_percent)),
        ]
        if include_gpu and sample.gpu_util_percent is not None:
            candidates.append(("gpu", float(sample.gpu_util_percent)))
        if include_gpu_mem and sample.gpu_mem_percent is not None:
            candidates.append(("gpu_mem", float(sample.gpu_mem_percent)))
        return max(candidates, key=lambda item: item[1])

    def _projected_scale_up_target(self, sample: ResourceSample, old_count: int) -> int:
        runtime = self.cfg.runtime
        min_step = max(1, int(runtime.smart_env_scale_step))
        _, peak_util = self._peak_utilization(sample, include_gpu=False, include_gpu_mem=False)
        target_util = float(runtime.smart_env_target_util_percent)
        desired_util = max(1.0, target_util * 0.95)

        # If utilization sensors are near-zero, still move forward conservatively.
        if peak_util <= 1e-6:
            return min(self.autoscale_max_envs, old_count + max(2, min_step))

        if peak_util >= target_util:
            return old_count

        projected = int(math.ceil(old_count * (desired_util / peak_util)))
        projected = max(projected, old_count + max(2, min_step))

        # Prevent unstable one-shot explosions while still allowing strong jumps.
        projected_cap_for_tick = old_count + max(old_count, max(2, min_step))
        projected = min(projected, projected_cap_for_tick)
        projected = min(projected, self.autoscale_max_envs)
        if projected <= old_count:
            projected = min(self.autoscale_max_envs, old_count + max(2, min_step))
        return projected

    def _sample_to_text(self, sample: ResourceSample) -> str:
        gpu_util = "n/a" if sample.gpu_util_percent is None else f"{sample.gpu_util_percent:.1f}"
        gpu_mem = "n/a" if sample.gpu_mem_percent is None else f"{sample.gpu_mem_percent:.1f}"
        gpu_source = sample.gpu_source or "n/a"
        return (
            f"cpu={sample.cpu_percent:.1f}% "
            f"ram={sample.ram_percent:.1f}% "
            f"gpu={gpu_util}% "
            f"gpu_mem={gpu_mem}% "
            f"gpu_src={gpu_source}"
        )

    def _cpu_ram_autoscale_sample(self, live_sample: ResourceSample) -> Tuple[ResourceSample, str]:
        if self.last_rollout_resource_sample is not None:
            return self.last_rollout_resource_sample, "rollout_window"
        return live_sample, "live_1s_fallback"

    def _autoscale_hold_log(self, now: float, reason: str, env_count: int, sample: ResourceSample) -> None:
        # Avoid log spam: emit hold reasons at most once every 10 seconds.
        if (now - self.last_autoscale_status_log_perf) < 10.0:
            return
        self.last_autoscale_status_log_perf = now
        print(
            f"[autoscale-hold] envs={env_count} reason={reason} "
            f"{self._sample_to_text(sample)}"
        )

    def _maybe_autoscale_envs(self) -> None:
        if not self.autoscale_enabled:
            return
        if self.resource_monitor is None:
            return

        now = time.perf_counter()
        # Keep autoscale stable: one adjustment decision per second.
        cooldown = max(1.0, float(self.cfg.runtime.smart_env_adjust_cooldown_sec))
        if (now - self.last_autoscale_adjust_perf) < cooldown:
            return

        # Live sample is used for GPU-based safeguards/logging.
        live_sample = self.resource_monitor.averaged(window_sec=1.0)
        if live_sample is None:
            return
        # CPU/RAM autoscale inputs come from the previous rollout window.
        cpu_ram_sample, cpu_ram_source = self._cpu_ram_autoscale_sample(live_sample)
        old_count = len(self.envs)
        scale_down_reason = self._scale_down_reason(cpu_ram_sample, live_sample)
        if scale_down_reason is not None:
            if old_count <= self.autoscale_min_envs:
                self._autoscale_hold_log(
                    now,
                    f"at_min_envs({self.autoscale_min_envs})_while_over_down_trigger_{scale_down_reason}_cpu_src={cpu_ram_source}",
                    old_count,
                    live_sample,
                )
                self.last_autoscale_adjust_perf = now
                return
            # Scale down gradually to avoid oscillation.
            target = max(self.autoscale_min_envs, old_count - 1)
            self._resize_envs(target)
            self.last_autoscale_adjust_perf = now
            print(
                f"[autoscale-down] envs={old_count}->{len(self.envs)} "
                f"reason={scale_down_reason} "
                f"avg_1s_high_trigger={self.cfg.runtime.smart_env_scale_down_trigger_percent:.1f}% "
                f"cpu_src={cpu_ram_source} cpu={cpu_ram_sample.cpu_percent:.1f}% ram={cpu_ram_sample.ram_percent:.1f}% "
                f"{self._sample_to_text(live_sample)}"
            )
            return

        if old_count >= self.autoscale_max_envs:
            max_label = "inf" if self.autoscale_unbounded else str(self.autoscale_max_envs)
            self._autoscale_hold_log(now, f"at_max_envs({max_label})_cpu_src={cpu_ram_source}", old_count, live_sample)
            self.last_autoscale_adjust_perf = now
            return

        if not self._can_scale_up(cpu_ram_sample):
            peak_name, peak_util = self._peak_utilization(cpu_ram_sample, include_gpu=False, include_gpu_mem=False)
            target_util = float(self.cfg.runtime.smart_env_target_util_percent)
            self._autoscale_hold_log(
                now,
                f"peak_{peak_name}={peak_util:.1f}%_>=_target_{target_util:.1f}%_(cpu_ram_mode)_cpu_src={cpu_ram_source}",
                old_count,
                live_sample,
            )
            self.last_autoscale_adjust_perf = now
            return

        peak_name, peak_util = self._peak_utilization(cpu_ram_sample, include_gpu=False, include_gpu_mem=False)
        target = self._projected_scale_up_target(cpu_ram_sample, old_count)
        if target <= old_count:
            self._autoscale_hold_log(now, f"projection_no_growth_cpu_src={cpu_ram_source}", old_count, live_sample)
            return

        self._resize_envs(target)
        self.last_autoscale_adjust_perf = now
        print(
            f"[autoscale] envs={old_count}->{len(self.envs)} "
            f"avg_1s_target={self.cfg.runtime.smart_env_target_util_percent:.1f}% "
            f"peak(cpu_ram@{cpu_ram_source})={peak_name}:{peak_util:.1f}% "
            f"cpu={cpu_ram_sample.cpu_percent:.1f}% ram={cpu_ram_sample.ram_percent:.1f}% "
            f"{self._sample_to_text(live_sample)}"
        )

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
        current_signature = self._training_signature()
        if isinstance(checkpoint_signature, dict):
            if not self._core_signature_compatible(checkpoint_signature, current_signature):
                raise ValueError(
                    "Checkpoint training signature mismatch in core settings (model/PPO). "
                    "Resume with matching settings or start a fresh run directory."
                )
            if checkpoint_signature != current_signature:
                print(
                    "[resume] warning: non-core training signature differs "
                    "(reward/league/runtime knobs changed). Continuing resume."
                )
        self.model.load_state_dict(state["model"])
        optimizer_state = state.get("optimizer")
        if optimizer_state:
            self.optimizer.load_state_dict(optimizer_state)
        ppo_state = state.get("ppo_state")
        if isinstance(ppo_state, dict) and bool(self.ppo.use_amp):
            scaler_state = ppo_state.get("scaler")
            if isinstance(scaler_state, dict):
                try:
                    self.ppo.scaler.load_state_dict(scaler_state)
                except Exception as exc:
                    print(f"[resume] warning: failed to restore AMP scaler state: {exc}")
        self.league.import_state(state.get("league_state"))
        self.global_step = int(state.get("step", 0))
        trainer_state = state.get("trainer_state")
        if isinstance(trainer_state, dict):
            try:
                self.live_match_count = max(0, int(trainer_state.get("live_match_count", 0)))
            except (TypeError, ValueError):
                self.live_match_count = 0
            try:
                self.live_match_win_sum = max(0.0, float(trainer_state.get("live_match_win_sum", 0.0)))
            except (TypeError, ValueError):
                self.live_match_win_sum = 0.0
        else:
            self.live_match_count = 0
            self.live_match_win_sum = 0.0
        if self.resume_restore_env_state:
            restored_envs = self._restore_env_runtime_state(state.get("env_runtime_state"))
            if restored_envs > 0:
                print(f"[resume] restored running env episodes={restored_envs}")
        quantum = max(1, self.cfg.runtime.rollout_horizon * max(1, len(self.envs)))
        self.update_count = max(0, self.global_step // quantum)
        self.last_good_checkpoint = str(path)
        self.train_start_perf = time.perf_counter()
        self.train_start_step = self.global_step
        self.last_log_perf = self.train_start_perf
        print(f"[resume] loaded checkpoint={path} step={self.global_step}")

    def evaluate(self, matches: int) -> float:
        if matches <= 0:
            return 0.0

        was_training = self.model.training
        self.model.eval()
        try:
            total_matches = int(matches)
            learner_label = self._current_eval_learner_label()
            benchmarks = self._resolve_eval_benchmarks()
            if not benchmarks:
                benchmarks = [("MOCK_RANDOM", {"difficulty": "MOCK_RANDOM"})]

            aggregate_wins, aggregate_losses, aggregate_draws, primary_winrate = self._evaluate_learner_suite(
                learner_label=learner_label,
                benchmarks=benchmarks,
                total_matches=total_matches,
                seed_base=int(self.cfg.runtime.seed) + 500_000,
                source_label="current_training_policy",
            )

            aggregate_total = max(1, aggregate_wins + aggregate_losses + aggregate_draws)
            print(
                f"[eval-summary] wins={aggregate_wins} losses={aggregate_losses} draws={aggregate_draws} "
                f"winrate={aggregate_wins / aggregate_total:.3f} primary_winrate={primary_winrate:.3f}"
            )
            self._evaluate_league_panel(
                seed_base=int(self.cfg.runtime.seed) + 9_000_000,
                total_matches=total_matches,
                default_benchmarks=benchmarks,
            )
            return primary_winrate
        finally:
            if was_training:
                self.model.train()

    def _evaluate_learner_suite(
        self,
        learner_label: str,
        benchmarks: List[Tuple[str, Dict[str, float | str]]],
        total_matches: int,
        seed_base: int,
        source_label: str,
    ) -> Tuple[int, int, int, float]:
        base_matches = total_matches // len(benchmarks)
        remainder = total_matches % len(benchmarks)
        aggregate_wins = 0
        aggregate_losses = 0
        aggregate_draws = 0
        primary_winrate = 0.0
        print(
            f"[eval-plan] total_matches={total_matches} benchmarks={len(benchmarks)} "
            f"labels={','.join(label for label, _ in benchmarks)} "
            f"learner_source={source_label} learner={learner_label}"
        )
        for bench_idx, (label, profile) in enumerate(benchmarks):
            bench_matches = base_matches + (1 if bench_idx < remainder else 0)
            if bench_matches <= 0:
                continue
            bench_seed = seed_base + bench_idx * 1_000_000
            result = self._run_eval_benchmark(
                benchmark_label=label,
                benchmark_profile=profile,
                matches=bench_matches,
                seed_base=bench_seed,
                learner_label=learner_label,
            )
            if bench_idx == 0:
                primary_winrate = float(result["winrate"])
            aggregate_wins += int(result["wins"])
            aggregate_losses += int(result["losses"])
            aggregate_draws += int(result["draws"])
            print(
                f"[eval-benchmark] matchup={learner_label}_vs_{label} "
                f"matches={bench_matches} wins={int(result['wins'])} losses={int(result['losses'])} "
                f"draws={int(result['draws'])} winrate={float(result['winrate']):.3f}"
            )
            print(
                f"[eval-benchmark-stats] matchup={learner_label}_vs_{label} "
                f"highest_age_avg={float(result['avg_highest_age']):.2f} "
                f"avg_game_duration={float(result['avg_game_duration_sec']):.1f}s"
                f"({float(result['avg_game_duration_sec']) / 60.0:.2f}m) "
                f"gold_spent_avg={float(result['avg_gold_spent']):.1f} "
                f"mana_spent_avg={float(result['avg_mana_spent']):.1f} "
                f"highest_turret_count_avg={float(result['avg_highest_turrets']):.2f}"
            )
            print(
                f"[eval-benchmark-units] matchup={learner_label}_vs_{label} "
                f"top_units={str(result['top_units_text'])} "
                f"strongest_tower_engines={str(result['strongest_engines_text'])}"
            )
        return aggregate_wins, aggregate_losses, aggregate_draws, primary_winrate

    def _evaluate_league_panel(
        self,
        seed_base: int,
        total_matches: int,
        default_benchmarks: List[Tuple[str, Dict[str, float | str]]],
    ) -> None:
        raw_panel_benchmarks = os.getenv("EVAL_LEAGUE_BENCHMARKS", "").strip()
        panel_benchmarks = (
            self._parse_eval_benchmarks(raw_panel_benchmarks)
            if raw_panel_benchmarks
            else list(default_benchmarks)
        )
        if not panel_benchmarks:
            print("[eval-league] skipped: no valid benchmarks")
            return
        matches_per_benchmark = max(1, int(os.getenv("EVAL_LEAGUE_MATCHES_PER_BENCHMARK", "1")))
        per_learner_matches = matches_per_benchmark * len(panel_benchmarks)
        budget_cap = max(0, int(total_matches))
        if budget_cap <= 0:
            print("[eval-league] skipped: match budget is zero")
            return

        max_learners = budget_cap // per_learner_matches
        if max_learners <= 0:
            print(
                "[eval-league] skipped: insufficient budget "
                f"(budget={budget_cap}, required_per_learner={per_learner_matches})"
            )
            return
        candidates = [
            item
            for item in self.league.top(max_learners)
            if isinstance(item.checkpoint_path, str) and item.checkpoint_path.strip()
        ]
        if not candidates:
            print("[eval-league] skipped: no learned checkpoint candidates")
            return
        selected = candidates

        baseline_state = {key: value.detach().cpu().clone() for key, value in self.model.state_dict().items()}
        print(
            f"[eval-league-plan] learners={len(selected)} derived_top_k={max_learners} "
            f"matches_per_benchmark={matches_per_benchmark} per_learner_matches={per_learner_matches} "
            f"budget={budget_cap} "
            f"benchmarks={','.join(label for label, _ in panel_benchmarks)}"
        )
        try:
            for learner_idx, learner in enumerate(selected):
                checkpoint_path = Path(str(learner.checkpoint_path))
                if not checkpoint_path.exists():
                    print(f"[eval-league] skipped learner={learner.profile.codename}: checkpoint missing")
                    continue
                try:
                    state = torch.load(checkpoint_path, map_location=self.device)
                    model_state = state.get("model")
                    if not isinstance(model_state, dict):
                        print(f"[eval-league] skipped learner={learner.profile.codename}: invalid model state")
                        continue
                    self.model.load_state_dict(model_state, strict=False)
                except Exception as exc:
                    print(f"[eval-league] skipped learner={learner.profile.codename}: load failed ({exc})")
                    continue

                learner_label = self._league_entry_eval_label(learner, checkpoint_path)
                wins, losses, draws, _ = self._evaluate_learner_suite(
                    learner_label=learner_label,
                    benchmarks=panel_benchmarks,
                    total_matches=per_learner_matches,
                    seed_base=seed_base + learner_idx * 2_000_000,
                    source_label="league_top_checkpoint",
                )
                total = max(1, wins + losses + draws)
                print(
                    f"[eval-league-summary] learner={learner_label} "
                    f"wins={wins} losses={losses} draws={draws} winrate={wins / total:.3f}"
                )
        finally:
            self.model.load_state_dict(baseline_state, strict=False)

    def _resolve_eval_benchmarks(self) -> List[Tuple[str, Dict[str, float | str]]]:
        raw = os.getenv("EVAL_BENCHMARKS", "MOCK_RANDOM,MEDIUM,HARD,SMART,CHEATER")
        return self._parse_eval_benchmarks(raw)

    def _parse_eval_benchmarks(self, raw: str) -> List[Tuple[str, Dict[str, float | str]]]:
        allowed = {"EASY", "MEDIUM", "HARD", "SMART", "SMART_ML", "CHEATER", "MOCK_RANDOM"}
        seen: set[str] = set()
        benchmarks: List[Tuple[str, Dict[str, float | str]]] = []
        for token in str(raw).split(","):
            label = token.strip().upper()
            if not label or label in seen:
                continue
            seen.add(label)
            if label in allowed:
                benchmarks.append((label, {"difficulty": label}))
        return benchmarks

    def _league_entry_eval_label(self, entry: LeagueEntry, checkpoint_path: Path) -> str:
        codename = str(entry.profile.codename or "unknown")
        step = int(entry.steps)
        stem = checkpoint_path.stem
        return f"{codename}@{step}<{stem}>"

    def _run_eval_benchmark(
        self,
        benchmark_label: str,
        benchmark_profile: Dict[str, float | str],
        matches: int,
        seed_base: int,
        learner_label: str,
    ) -> Dict[str, object]:
        eval_workers = self._resolve_eval_workers(matches)
        total_matches = int(matches)
        completed = 0
        wins = 0
        losses = 0
        draws = 0
        next_match_idx = 0
        eval_start_perf = time.perf_counter()
        last_progress_print_perf = eval_start_perf
        completed_game_stats: List[Dict[str, object]] = []

        envs: List[SelfPlayEnv] = []
        observations: List[Observation] = []
        for _ in range(min(eval_workers, total_matches)):
            env = self.eval_env_factory()
            try:
                env.set_opponent_profile(dict(benchmark_profile))
            except Exception:
                pass
            match_idx = next_match_idx
            next_match_idx += 1
            obs = env.reset(seed_base + match_idx)
            envs.append(env)
            observations.append(obs)

        print(
            f"[eval-start] matchup={learner_label}_vs_{benchmark_label} "
            f"matches={total_matches} workers={len(envs)}"
        )
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
                        next_obs, _, done, info, reward_components = results[idx]
                        if not done:
                            observations[idx] = next_obs
                            continue

                        parsed_done_stats = self._parse_rollout_game_stats(info)
                        if parsed_done_stats is not None:
                            completed_game_stats.append(parsed_done_stats)
                        outcome = self._infer_eval_outcome(info, reward_components)
                        if outcome == "win":
                            wins += 1
                        elif outcome == "loss":
                            losses += 1
                        else:
                            draws += 1
                        completed += 1

                        now = time.perf_counter()
                        if (now - last_progress_print_perf >= 2.0) or (completed == total_matches):
                            elapsed = max(1e-6, now - eval_start_perf)
                            mps = completed / elapsed
                            remaining = max(0, total_matches - completed)
                            eta = remaining / max(1e-6, mps)
                            print(
                                f"[eval-progress] matchup={learner_label}_vs_{benchmark_label} "
                                f"done={completed}/{total_matches} "
                                f"({(completed / total_matches) * 100:.1f}%) mps={mps:.2f} "
                                f"eta={self._format_eta(eta)}"
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

        avg_highest_age = 0.0
        avg_game_duration_sec = 0.0
        avg_gold_spent = 0.0
        avg_mana_spent = 0.0
        avg_highest_turrets = 0.0
        top_units_text = "n/a"
        strongest_engines_text = "n/a"
        if completed_game_stats:
            sample_count = float(len(completed_game_stats))
            avg_highest_age = float(
                np.mean([float(sample.get("highest_age", 0.0)) for sample in completed_game_stats])
            )
            avg_game_duration_sec = float(
                np.mean([float(sample.get("game_duration_sec", 0.0)) for sample in completed_game_stats])
            )
            avg_gold_spent = float(
                np.mean([float(sample.get("total_gold_spent", 0.0)) for sample in completed_game_stats])
            )
            avg_mana_spent = float(
                np.mean([float(sample.get("total_mana_spent", 0.0)) for sample in completed_game_stats])
            )
            avg_highest_turrets = float(
                np.mean([float(sample.get("highest_turret_count", 0.0)) for sample in completed_game_stats])
            )

            unit_totals: Dict[str, float] = {}
            turret_buy_totals: Dict[str, float] = {}
            turret_strength: Dict[str, float] = {}
            for sample in completed_game_stats:
                unit_counts = sample.get("unit_build_counts", {})
                if isinstance(unit_counts, dict):
                    for unit_id, count in unit_counts.items():
                        if isinstance(unit_id, str):
                            unit_totals[unit_id] = unit_totals.get(unit_id, 0.0) + float(count)
                turret_counts = sample.get("turret_buy_counts", {})
                if isinstance(turret_counts, dict):
                    for turret_id, count in turret_counts.items():
                        if isinstance(turret_id, str):
                            turret_buy_totals[turret_id] = turret_buy_totals.get(turret_id, 0.0) + float(count)
                turret_scores = sample.get("turret_strength_scores", {})
                if isinstance(turret_scores, dict):
                    for turret_id, score in turret_scores.items():
                        if isinstance(turret_id, str):
                            turret_strength[turret_id] = max(turret_strength.get(turret_id, 0.0), float(score))

            unit_avg = {unit_id: total / sample_count for unit_id, total in unit_totals.items()}
            top_units = sorted(unit_avg.items(), key=lambda item: (item[1], item[0]), reverse=True)[:5]
            top_units_text = ", ".join(f"{unit_id}:{count:.1f}" for unit_id, count in top_units) or "n/a"

            turret_avg = {turret_id: total / sample_count for turret_id, total in turret_buy_totals.items()}
            strongest_engines = sorted(
                turret_avg.items(),
                key=lambda item: (turret_strength.get(item[0], 0.0), item[1], item[0]),
                reverse=True,
            )[:3]
            strongest_engines_text = ", ".join(
                f"{turret_id}:{count:.1f}" for turret_id, count in strongest_engines
            ) or "n/a"

        return {
            "wins": wins,
            "losses": losses,
            "draws": draws,
            "winrate": wins / max(1, total_matches),
            "avg_highest_age": avg_highest_age,
            "avg_game_duration_sec": avg_game_duration_sec,
            "avg_gold_spent": avg_gold_spent,
            "avg_mana_spent": avg_mana_spent,
            "avg_highest_turrets": avg_highest_turrets,
            "top_units_text": top_units_text,
            "strongest_engines_text": strongest_engines_text,
        }

    def _current_eval_learner_label(self) -> str:
        profile = self.last_rollout_profile
        archetype = str(getattr(profile, "archetype", "unknown") or "unknown")
        codename = str(getattr(profile, "codename", "unknown") or "unknown")
        return f"{self.run_name}@{int(self.global_step)}[{archetype}/{codename}]"

    def _infer_eval_outcome(
        self,
        info: Dict[str, float | str],
        reward_components: RewardComponents,
    ) -> str:
        terminal_cause_raw = info.get("terminal_cause")
        if isinstance(terminal_cause_raw, str):
            terminal_cause = terminal_cause_raw.strip().lower()
            if terminal_cause == "player_win":
                return "win"
            if terminal_cause == "enemy_win":
                return "loss"
            if terminal_cause == "timeout":
                return "draw"

        own_base = float(info.get("own_base_hp", float("nan")))
        opp_base = float(info.get("opp_base_hp", float("nan")))
        if np.isfinite(own_base) and np.isfinite(opp_base):
            if own_base > opp_base:
                return "win"
            if own_base < opp_base:
                return "loss"
            return "draw"

        terminal = float(reward_components.terminal_outcome)
        if terminal > 0.0:
            return "win"
        if terminal < 0.0:
            return "loss"
        return "draw"

    def _collect_rollout(self) -> RolloutBatch:
        runtime = self.cfg.runtime
        rollout_start_perf = time.perf_counter()
        horizon = runtime.rollout_horizon
        num_envs = len(self.envs)
        if num_envs <= 0:
            raise RuntimeError("No active environments available for rollout")
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
        env_opponents: List[LeagueEntry | None] = [None for _ in range(num_envs)]
        for env_idx in range(num_envs):
            self._assign_env_opponent(env_idx, env_opponents, current_checkpoint)

        action_counts = np.zeros((len(ACTIONS),), dtype=np.float64)
        reward_sums = {
            "enemy_base_damage": 0.0,
            "own_base_damage": 0.0,
            "safe_age_up_bonus": 0.0,
            "age_up_delay_penalty": 0.0,
            "action_discovery_bonus": 0.0,
            "illegal_action_penalty": 0.0,
            "terminal_outcome": 0.0,
        }
        env_latest_info: List[Dict[str, float] | None] = [None for _ in range(num_envs)]
        completed_game_stats: List[Dict[str, object]] = []

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

            for env_idx, (next_obs, reward, done, info, reward_components) in enumerate(step_results):
                progress_step = self.global_step + t * num_envs + env_idx
                shaped_reward = self._compose_reward(reward_components, progress_step)
                rewards_np[t, env_idx] = shaped_reward if np.isfinite(shaped_reward) else reward
                dones_np[t, env_idx] = float(done)
                env_latest_info[env_idx] = info
                reward_sums["enemy_base_damage"] += float(reward_components.enemy_base_damage)
                reward_sums["own_base_damage"] += float(reward_components.own_base_damage)
                reward_sums["safe_age_up_bonus"] += float(reward_components.safe_age_up_bonus)
                reward_sums["age_up_delay_penalty"] += float(reward_components.age_up_delay_penalty)
                reward_sums["action_discovery_bonus"] += float(reward_components.action_discovery_bonus)
                reward_sums["illegal_action_penalty"] += float(reward_components.illegal_action_penalty)
                reward_sums["terminal_outcome"] += float(reward_components.terminal_outcome)
                if done:
                    parsed_done_stats = self._parse_rollout_game_stats(info)
                    if parsed_done_stats is not None:
                        completed_game_stats.append(parsed_done_stats)
                    learner_score = self._infer_learner_score(info, reward_components)
                    if learner_score is not None:
                        self.live_match_count += 1
                        self.live_match_win_sum += float(learner_score)
                        self.league.record_training_match(env_opponents[env_idx], learner_score)
                    self._assign_env_opponent(env_idx, env_opponents, current_checkpoint)
                    env_latest_info[env_idx] = None
                    next_obs = self.envs[env_idx].reset(
                        self.cfg.runtime.seed + self.global_step + t * num_envs + env_idx + 1
                    )
                self.obs[env_idx] = next_obs

        env_latest_game_stats: List[Dict[str, object] | None] = [
            self._parse_rollout_game_stats(sample) if sample is not None else None
            for sample in env_latest_info
        ]
        latest_count = sum(1 for sample in env_latest_game_stats if sample is not None)
        self.last_rollout_profile = self._build_strategy_profile(action_counts, reward_sums)
        self.last_rollout_telemetry_line = self._format_rollout_telemetry_line(
            completed_game_stats,
            latest_count,
        )

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

        if self.autoscale_enabled and self.resource_monitor is not None:
            rollout_end_perf = time.perf_counter()
            rollout_sample = self.resource_monitor.averaged_between(
                rollout_start_perf,
                rollout_end_perf,
            )
            if rollout_sample is None:
                rollout_sample = self.resource_monitor.averaged(window_sec=1.0)
            if rollout_sample is not None:
                self.last_rollout_resource_sample = rollout_sample

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

    def _parse_rollout_game_stats(self, info: Dict[str, float | str]) -> Dict[str, object] | None:
        if not info:
            return None
        highest_age = float(info.get("highest_age", info.get("own_age", 0.0)))
        game_duration_sec = float(info.get("game_time", 0.0))
        total_gold_spent = float(info.get("total_gold_spent", 0.0))
        total_mana_spent = float(info.get("total_mana_spent", 0.0))
        highest_turret_count = float(info.get("highest_turret_count", 0.0))
        if not np.isfinite(highest_age):
            highest_age = 0.0
        if not np.isfinite(game_duration_sec):
            game_duration_sec = 0.0
        if not np.isfinite(total_gold_spent):
            total_gold_spent = 0.0
        if not np.isfinite(total_mana_spent):
            total_mana_spent = 0.0
        if not np.isfinite(highest_turret_count):
            highest_turret_count = 0.0

        unit_build_counts: Dict[str, float] = {}
        turret_buy_counts: Dict[str, float] = {}
        turret_strength_scores: Dict[str, float] = {}
        for key, value in info.items():
            if not isinstance(value, (int, float)):
                continue
            numeric_value = float(value)
            if key.startswith("unit_build__"):
                unit_id = key[len("unit_build__") :]
                if unit_id:
                    unit_build_counts[unit_id] = max(0.0, numeric_value)
            elif key.startswith("turret_buy__"):
                turret_id = key[len("turret_buy__") :]
                if turret_id:
                    turret_buy_counts[turret_id] = max(0.0, numeric_value)
            elif key.startswith("turret_strength__"):
                turret_id = key[len("turret_strength__") :]
                if turret_id:
                    turret_strength_scores[turret_id] = max(0.0, numeric_value)

        return {
            "highest_age": highest_age,
            "game_duration_sec": max(0.0, game_duration_sec),
            "total_gold_spent": total_gold_spent,
            "total_mana_spent": total_mana_spent,
            "highest_turret_count": highest_turret_count,
            "unit_build_counts": unit_build_counts,
            "turret_buy_counts": turret_buy_counts,
            "turret_strength_scores": turret_strength_scores,
        }

    def _assign_env_opponent(
        self,
        env_idx: int,
        env_opponents: List[LeagueEntry | None],
        current_checkpoint: str | None,
    ) -> None:
        self._refresh_league_baseline_phaseout()
        opponent = self.league.sample_opponent(current_checkpoint)
        env_opponents[env_idx] = opponent
        env = self.envs[env_idx]
        if opponent is None:
            env.set_opponent_profile(None)
            return
        opponent_payload: Dict[str, float | str] = {
            "elo": float(opponent.elo),
            "winrate_vs_smart": float(opponent.winrate_vs_smart),
            "steps": float(opponent.steps),
            "archetype": str(opponent.profile.archetype),
            "aggression": float(opponent.profile.aggression),
            "teching": float(opponent.profile.teching),
            "defense": float(opponent.profile.defense),
        }
        if isinstance(opponent.difficulty, str) and opponent.difficulty:
            opponent_payload["difficulty"] = opponent.difficulty
        if (
            opponent.use_checkpoint
            and isinstance(opponent.checkpoint_path, str)
            and opponent.checkpoint_path.strip()
        ):
            opponent_payload["checkpoint_id"] = str(opponent.checkpoint_path)
        env.set_opponent_profile(opponent_payload)

    def _parse_arbiter_csv(self, raw_csv: str) -> List[str]:
        allowed = {"EASY", "MEDIUM", "HARD", "SMART", "CHEATER"}
        parsed: List[str] = []
        for token in str(raw_csv or "").split(","):
            key = token.strip().upper()
            if not key:
                continue
            if key in allowed and key not in parsed:
                parsed.append(key)
        return parsed

    def _phaseout_disabled_arbiters(self) -> set[str]:
        order = self.league_arbiter_phaseout_order
        if not order:
            return set()
        runtime = self.cfg.runtime
        start = float(np.clip(runtime.league_arbiter_phaseout_start_progress, 0.0, 1.0))
        end = float(np.clip(runtime.league_arbiter_phaseout_end_progress, 0.0, 1.0))
        progress = float(np.clip(self.global_step / max(1, runtime.total_steps), 0.0, 1.0))
        if progress < start:
            return set()
        if end <= start:
            return set(order)

        disabled: set[str] = set()
        total = len(order)
        for idx, arbiter in enumerate(order):
            threshold = start + (end - start) * (idx / max(1, total - 1))
            if progress + 1e-9 >= threshold:
                disabled.add(arbiter)
        return disabled

    def _refresh_league_baseline_phaseout(self, force_log: bool = False) -> None:
        disabled = self._phaseout_disabled_arbiters()
        self.league.set_disabled_baselines(disabled)
        if force_log or disabled != self._last_disabled_arbiters:
            progress = float(np.clip(self.global_step / max(1, self.cfg.runtime.total_steps), 0.0, 1.0))
            disabled_text = ",".join(sorted(disabled)) if disabled else "none"
            active = [arb for arb in self.league_configured_arbiters if arb not in disabled]
            active_text = ",".join(active) if active else "none"
            print(self._format_phaseout_log(progress, disabled_text, active_text))
            self._last_disabled_arbiters = set(disabled)

    def _infer_learner_score(
        self,
        info: Dict[str, float | str],
        reward_components: RewardComponents,
    ) -> float | None:
        terminal_cause_raw = info.get("terminal_cause")
        if isinstance(terminal_cause_raw, str):
            terminal_cause = terminal_cause_raw.strip().lower()
            if terminal_cause == "player_win":
                return 1.0
            if terminal_cause == "enemy_win":
                return 0.0
            if terminal_cause == "timeout":
                own_base = float(info.get("own_base_hp", float("nan")))
                opp_base = float(info.get("opp_base_hp", float("nan")))
                if np.isfinite(own_base) and np.isfinite(opp_base):
                    if own_base > opp_base:
                        return 1.0
                    if own_base < opp_base:
                        return 0.0
                return 0.5

        own_base = float(info.get("own_base_hp", float("nan")))
        opp_base = float(info.get("opp_base_hp", float("nan")))
        if np.isfinite(own_base) and np.isfinite(opp_base):
            if own_base > opp_base:
                return 1.0
            if own_base < opp_base:
                return 0.0
        terminal = float(reward_components.terminal_outcome)
        if terminal > 0.0:
            return 1.0
        if terminal < 0.0:
            return 0.0
        return 0.5

    def _current_live_winrate(self) -> float:
        if self.live_match_count <= 0:
            return 0.5
        return float(self.live_match_win_sum / max(1, self.live_match_count))

    def _resolve_telemetry_color_enabled(self) -> bool:
        forced = os.getenv("TELEMETRY_COLOR")
        if forced is not None:
            return str(forced).strip().lower() in {"1", "true", "yes", "on"}
        if os.getenv("NO_COLOR") is not None:
            return False
        try:
            return bool(sys.stdout.isatty())
        except Exception:
            return False

    def _resolve_telemetry_width(self) -> int:
        forced = os.getenv("TELEMETRY_WIDTH")
        if forced:
            try:
                return max(80, min(260, int(forced)))
            except ValueError:
                pass
        detected = shutil.get_terminal_size(fallback=(150, 24)).columns
        return max(100, min(220, int(detected)))

    def _colorize(self, text: str, color: str | None = None, bold: bool = False) -> str:
        if not self.telemetry_color_enabled:
            return text
        palette = {
            "red": "31",
            "green": "32",
            "yellow": "33",
            "blue": "34",
            "magenta": "35",
            "cyan": "36",
            "gray": "90",
        }
        codes: List[str] = []
        if bold:
            codes.append("1")
        if color and color in palette:
            codes.append(palette[color])
        if not codes:
            return text
        return f"\x1b[{';'.join(codes)}m{text}\x1b[0m"

    def _tag(self, name: str, color: str = "cyan") -> str:
        return self._colorize(f"[{name}]", color=color, bold=True)

    def _wrap_section(self, section: str, body: str, section_color: str | None = "gray") -> str:
        section_label = f"  {section:<14}"
        wrapper = textwrap.TextWrapper(
            width=self.telemetry_width,
            initial_indent=section_label + " ",
            subsequent_indent=" " * (len(section_label) + 1),
            break_long_words=False,
            break_on_hyphens=False,
        )
        lines = wrapper.wrap(body if body else "n/a")
        if not lines:
            lines = [section_label + " n/a"]
        if section_color:
            lines[0] = lines[0].replace(
                section_label,
                self._colorize(section_label, color=section_color, bold=True),
                1,
            )
        return "\n".join(lines)

    def _format_phaseout_log(self, progress: float, disabled_text: str, active_text: str) -> str:
        lines = [
            f"{self._tag('league-phaseout', 'magenta')} progress={progress:.3f}",
            self._wrap_section("disabled", disabled_text, section_color="yellow"),
            self._wrap_section("active", active_text, section_color="green"),
        ]
        return "\n".join(lines)

    def _format_step_log(
        self,
        *,
        step: int,
        progress_pct: float,
        envs: int,
        policy: float,
        value: float,
        entropy: float,
        kl: float,
        dense_scale: float,
        terminal_scale: float,
        steps_per_sec: float,
        eta_seconds: float,
    ) -> str:
        lines = [
            f"{self._tag('step', 'cyan')} step={step} progress={progress_pct:.1f}% envs={envs}",
            self._wrap_section(
                "losses",
                f"policy={policy:.4f}  value={value:.4f}  entropy={entropy:.4f}  kl={kl:.5f}",
                section_color="yellow",
            ),
            self._wrap_section(
                "throughput",
                f"sps={steps_per_sec:.1f}  eta={self._format_eta(eta_seconds)}",
                section_color="green",
            ),
            self._wrap_section(
                "reward_scale",
                f"dense={dense_scale:.3f}  terminal={terminal_scale:.3f}",
                section_color="magenta",
            ),
        ]
        return "\n".join(lines)

    def _format_rollout_telemetry_line(
        self,
        completed_games: List[Dict[str, object]],
        latest_count: int,
    ) -> str:
        if not completed_games:
            return "\n".join(
                [
                    f"{self._tag('batch-telemetry', 'blue')} games=0 completed=0 latest={int(latest_count)}",
                    self._wrap_section("status", "waiting_for_completed_games", section_color="yellow"),
                ]
            )

        game_samples: List[Dict[str, object]] = completed_games
        sample_count = len(game_samples)
        completed_count = sample_count
        avg_highest_age = float(np.mean([float(sample.get("highest_age", 0.0)) for sample in game_samples]))
        avg_game_duration_sec = float(
            np.mean([float(sample.get("game_duration_sec", 0.0)) for sample in game_samples])
        )
        avg_gold_spent = float(np.mean([float(sample.get("total_gold_spent", 0.0)) for sample in game_samples]))
        avg_mana_spent = float(np.mean([float(sample.get("total_mana_spent", 0.0)) for sample in game_samples]))
        avg_highest_turrets = float(np.mean([float(sample.get("highest_turret_count", 0.0)) for sample in game_samples]))

        unit_totals: Dict[str, float] = {}
        turret_buy_totals: Dict[str, float] = {}
        turret_strength: Dict[str, float] = {}
        for sample in game_samples:
            unit_counts = sample.get("unit_build_counts", {})
            if isinstance(unit_counts, dict):
                for unit_id, count in unit_counts.items():
                    if isinstance(unit_id, str):
                        unit_totals[unit_id] = unit_totals.get(unit_id, 0.0) + float(count)
            turret_counts = sample.get("turret_buy_counts", {})
            if isinstance(turret_counts, dict):
                for turret_id, count in turret_counts.items():
                    if isinstance(turret_id, str):
                        turret_buy_totals[turret_id] = turret_buy_totals.get(turret_id, 0.0) + float(count)
            turret_scores = sample.get("turret_strength_scores", {})
            if isinstance(turret_scores, dict):
                for turret_id, score in turret_scores.items():
                    if isinstance(turret_id, str):
                        turret_strength[turret_id] = max(turret_strength.get(turret_id, 0.0), float(score))

        unit_avg = {unit_id: total / sample_count for unit_id, total in unit_totals.items()}
        top_units = sorted(unit_avg.items(), key=lambda item: (item[1], item[0]), reverse=True)[:5]
        top_units_text = ", ".join(f"{unit_id}:{count:.1f}" for unit_id, count in top_units) or "n/a"

        turret_avg = {turret_id: total / sample_count for turret_id, total in turret_buy_totals.items()}
        strongest_engines = sorted(
            turret_avg.items(),
            key=lambda item: (turret_strength.get(item[0], 0.0), item[1], item[0]),
            reverse=True,
        )[:3]
        strongest_engines_text = ", ".join(
            f"{turret_id}:{count:.1f}" for turret_id, count in strongest_engines
        ) or "n/a"
        league_top_text = self._format_league_top_telemetry(top_n=4)
        league_top_ml_text = self._format_league_top_telemetry(top_n=4, learned_only=True)
        league_top_ckpt_text = self._format_league_top_telemetry(top_n=4, checkpoints_only=True)

        lines = [
            f"{self._tag('batch-telemetry', 'blue')} games={sample_count} completed={completed_count} latest={latest_count}",
            self._wrap_section(
                "core",
                f"highest_age_avg={avg_highest_age:.2f}  avg_game_duration={avg_game_duration_sec:.1f}s({avg_game_duration_sec / 60.0:.2f}m)",
                section_color="cyan",
            ),
            self._wrap_section(
                "economy",
                f"gold_spent_avg={avg_gold_spent:.1f}  mana_spent_avg={avg_mana_spent:.1f}  highest_turret_count_avg={avg_highest_turrets:.2f}",
                section_color="green",
            ),
            self._wrap_section("top_units", top_units_text, section_color="yellow"),
            self._wrap_section("engines", strongest_engines_text, section_color="yellow"),
            self._wrap_section("league_top", league_top_text, section_color="magenta"),
            self._wrap_section("league_top_ml", league_top_ml_text, section_color="magenta"),
            self._wrap_section("league_top_ckpt", league_top_ckpt_text, section_color="magenta"),
        ]
        return "\n".join(lines)

    def _format_league_top_telemetry(
        self,
        top_n: int = 4,
        *,
        learned_only: bool = False,
        checkpoints_only: bool = False,
    ) -> str:
        if checkpoints_only:
            learned_ranked = self.league.top(max(1, len(self.league.entries)))
            roster = [item for item in learned_ranked if item.source == "checkpoint"]
        elif learned_only:
            roster = self.league.top(max(1, top_n))
        else:
            roster = self.league.roster()
        if not roster:
            return "n/a"
        selected = roster[: max(1, top_n)]
        codename_counts: Dict[str, int] = {}
        for item in roster:
            codename = str(item.profile.codename or "unknown")
            codename_counts[codename] = codename_counts.get(codename, 0) + 1
        entries = []
        for item in selected:
            codename = str(item.profile.codename or "unknown")
            display_name = codename
            if codename_counts.get(codename, 0) > 1:
                short_tag = self._checkpoint_short_tag(item)
                if short_tag:
                    display_name = f"{codename}@{short_tag}"
            entries.append(
                f"{display_name}(wr={float(item.winrate_vs_smart):.2f},elo={float(item.elo):.0f})"
            )
        return "; ".join(entries) if entries else "n/a"

    def _format_league_roster_summary(self, roster: List[object], top_n: int = 4) -> str:
        if not roster:
            return "n/a"
        selected = roster[: max(1, top_n)]
        codename_counts: Dict[str, int] = {}
        for item in roster:
            codename = str(getattr(getattr(item, "profile", object()), "codename", "unknown") or "unknown")
            codename_counts[codename] = codename_counts.get(codename, 0) + 1

        entries: List[str] = []
        for item in selected:
            codename = str(getattr(getattr(item, "profile", object()), "codename", "unknown") or "unknown")
            display_name = codename
            if codename_counts.get(codename, 0) > 1:
                short_tag = self._checkpoint_short_tag(item)
                if short_tag:
                    display_name = f"{codename}@{short_tag}"
            winrate = float(getattr(item, "winrate_vs_smart", 0.0) or 0.0)
            entries.append(f"{display_name}:{winrate:.2f}")
        return ", ".join(entries) if entries else "n/a"

    def _checkpoint_short_tag(self, item: object) -> str:
        steps = int(getattr(item, "steps", 0) or 0)
        if steps > 0:
            return str(steps)
        checkpoint_path = getattr(item, "checkpoint_path", None)
        if isinstance(checkpoint_path, str) and checkpoint_path:
            stem = Path(checkpoint_path).stem
            for token in reversed(stem.split("_")):
                numeric = token.lstrip("0")
                if numeric.isdigit() and numeric:
                    return numeric
            return stem
        difficulty = getattr(item, "difficulty", None)
        if isinstance(difficulty, str) and difficulty:
            return difficulty.lower()
        return ""

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
                "dense_min": self.cfg.runtime.reward_dense_min_scale,
                "dense_decay_interval": self.cfg.runtime.reward_dense_decay_interval,
                "dense_decay_factor": self.cfg.runtime.reward_dense_decay_factor,
                "terminal_start": self.cfg.runtime.reward_terminal_scale_start,
                "terminal_end": self.cfg.runtime.reward_terminal_scale_end,
                "curriculum_steps": self.cfg.runtime.reward_curriculum_steps,
                "unit_curriculum_end_progress": self.cfg.runtime.reward_unit_curriculum_end_progress,
                "unit_curriculum_start_scale": self.cfg.runtime.reward_unit_curriculum_start_scale,
                "unit_curriculum_end_scale": self.cfg.runtime.reward_unit_curriculum_end_scale,
                "dense_cutoff_progress": self.cfg.runtime.reward_dense_cutoff_progress,
                "keep_enemy_base_milestone_after_dense_cutoff": (
                    self.cfg.runtime.reward_keep_enemy_base_milestone_after_dense_cutoff
                ),
                "reward_normalize": self.cfg.runtime.reward_normalize,
                "reward_clip_abs": self.cfg.runtime.reward_clip_abs,
                "bridge_reward_profile": self.cfg.runtime.bridge_reward_profile,
            },
            "league": {
                "keep_top_n": self.cfg.runtime.league_keep_top_n,
                "keep_diverse_n": self.cfg.runtime.league_keep_diverse_n,
                "max_agents": self.cfg.runtime.league_max_agents,
                "min_promote_winrate": self.cfg.runtime.league_min_promote_winrate,
                "archetype_winrate_floor": self.cfg.runtime.league_archetype_winrate_floor,
                "arbiters": self.cfg.runtime.league_arbiters,
                "arbiter_phaseout_start_progress": self.cfg.runtime.league_arbiter_phaseout_start_progress,
                "arbiter_phaseout_end_progress": self.cfg.runtime.league_arbiter_phaseout_end_progress,
                "arbiter_phaseout_order": self.cfg.runtime.league_arbiter_phaseout_order,
                "min_games_per_agent": self.cfg.runtime.league_min_games_per_agent,
                "elo_random_factor": self.cfg.runtime.league_elo_random_factor,
                "use_checkpoint_opponents": self.cfg.runtime.league_use_checkpoint_opponents,
                "spinoffs_per_anchor": self.cfg.runtime.league_spinoffs_per_anchor,
                "spinoff_noise": self.cfg.runtime.league_spinoff_noise,
            },
            "dead_unit_revival": {
                "enabled": self.cfg.runtime.dead_unit_revival_enabled,
                "check_every": self.cfg.runtime.dead_unit_check_every,
                "zero_epsilon": self.cfg.runtime.dead_unit_zero_epsilon,
                "streak": self.cfg.runtime.dead_unit_streak,
            },
        }

    def _core_signature_compatible(
        self,
        saved_signature: Dict[str, object],
        current_signature: Dict[str, object],
    ) -> bool:
        saved_model = saved_signature.get("model")
        current_model = current_signature.get("model")
        if isinstance(saved_model, dict) and isinstance(current_model, dict):
            if saved_model != current_model:
                return False

        saved_ppo = saved_signature.get("ppo_core")
        current_ppo = current_signature.get("ppo_core")
        if isinstance(saved_ppo, dict) and isinstance(current_ppo, dict):
            for key in ("gamma", "gae_lambda", "clip_epsilon"):
                if key in saved_ppo and key in current_ppo:
                    if float(saved_ppo[key]) != float(current_ppo[key]):
                        return False
        return True

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
            "ppo_state": {
                "use_amp": bool(self.ppo.use_amp),
                "scaler": self.ppo.scaler.state_dict() if bool(self.ppo.use_amp) else None,
            },
            "league_state": self.league.export_state(),
            "trainer_state": {
                "live_match_count": int(self.live_match_count),
                "live_match_win_sum": float(self.live_match_win_sum),
            },
            "config": {
                "runtime": asdict(self.cfg.runtime),
                "ppo": asdict(self.cfg.ppo),
                "model": asdict(self.cfg.model),
            },
        }
        if self.checkpoint_include_env_state:
            env_runtime_state = self._snapshot_env_runtime_state()
            if env_runtime_state is not None:
                payload["env_runtime_state"] = env_runtime_state
            else:
                print("[checkpoint] env runtime state capture skipped (unsupported by backend)")
        torch.save(payload, path)
        self._write_alias(str(path), "latest.pt")
        self._record_checkpoint(
            checkpoint_path=str(path),
            kind=kind,
            metrics=metrics or {},
            milestone_target_step=milestone_target_step,
        )
        print(f"[checkpoint] saved {path}")
        if self.on_checkpoint_saved is not None:
            try:
                self.on_checkpoint_saved()
            except Exception as exc:
                print(f"[registry] live export failed after checkpoint save: {exc}")
        return str(path)

    def _rollback_checkpoint(self) -> None:
        if not self.last_good_checkpoint:
            print("[guard] NaN detected but no checkpoint available yet; continuing")
            return
        state = torch.load(self.last_good_checkpoint, map_location=self.device)
        self.model.load_state_dict(state["model"])
        self.optimizer.load_state_dict(state["optimizer"])
        ppo_state = state.get("ppo_state")
        if isinstance(ppo_state, dict) and bool(self.ppo.use_amp):
            scaler_state = ppo_state.get("scaler")
            if isinstance(scaler_state, dict):
                try:
                    self.ppo.scaler.load_state_dict(scaler_state)
                except Exception as exc:
                    print(f"[guard] warning: failed to restore AMP scaler state: {exc}")
        self.league.import_state(state.get("league_state"))
        trainer_state = state.get("trainer_state")
        if isinstance(trainer_state, dict):
            self.live_match_count = max(0, int(trainer_state.get("live_match_count", 0) or 0))
            self.live_match_win_sum = max(0.0, float(trainer_state.get("live_match_win_sum", 0.0) or 0.0))
        print(f"[guard] NaN/Inf detected. Rolled back to {self.last_good_checkpoint}")

    def _anneal_entropy(self) -> None:
        ppo = self.cfg.ppo
        progress = min(1.0, self.global_step / max(1, ppo.entropy_anneal_steps))
        ppo.entropy_coef = ppo.entropy_coef * (1.0 - progress) + ppo.entropy_coef_min * progress

    def _env_flag(self, name: str, default: bool = False) -> bool:
        raw = os.getenv(name)
        if raw is None:
            return bool(default)
        return str(raw).strip().lower() in {"1", "true", "yes", "on"}

    def _snapshot_env_runtime_state(self) -> Dict[str, object] | None:
        env_states: List[Dict[str, object]] = []
        for env in self.envs:
            try:
                state = env.export_runtime_state()
            except Exception:
                return None
            if not isinstance(state, dict):
                return None
            env_states.append(state)
        return {
            "version": 1,
            "env_count": len(env_states),
            "states": env_states,
        }

    def _restore_env_runtime_state(self, payload: object) -> int:
        if not isinstance(payload, dict):
            return 0
        raw_states = payload.get("states")
        if not isinstance(raw_states, list):
            return 0
        if len(raw_states) != len(self.envs):
            return 0

        restored_obs: List[Observation] = []
        for env, raw_state in zip(self.envs, raw_states):
            if not isinstance(raw_state, dict):
                return 0
            try:
                obs = env.import_runtime_state(raw_state)
            except Exception:
                return 0
            if obs is None:
                return 0
            restored_obs.append(obs)
        self.obs = restored_obs
        return len(restored_obs)

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
        auto = max(1, min(matches, max(1, len(self.envs))))
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
        dense_cutoff_progress = float(np.clip(runtime.reward_dense_cutoff_progress, 0.0, 1.0))
        dense_min_scale = max(0.0, float(runtime.reward_dense_min_scale))
        if progress >= dense_cutoff_progress:
            dense_scale = dense_min_scale
        return float(dense_scale), float(terminal_scale)

    def _unit_curriculum_scale(self, progress: float) -> float:
        runtime = self.cfg.runtime
        end_progress = float(np.clip(runtime.reward_unit_curriculum_end_progress, 0.0, 1.0))
        start_scale = float(max(0.0, runtime.reward_unit_curriculum_start_scale))
        end_scale = float(max(0.0, runtime.reward_unit_curriculum_end_scale))
        if end_progress <= 0.0:
            return end_scale
        ratio = float(np.clip(progress / end_progress, 0.0, 1.0))
        return float(start_scale + (end_scale - start_scale) * ratio)

    def _compose_reward(self, components: RewardComponents, step: int) -> float:
        runtime = self.cfg.runtime
        progress = self._reward_progress(step)
        dense_scale, terminal_scale = self._reward_scales(step)
        unit_scale = self._unit_curriculum_scale(progress)
        unit_curriculum_reward = (
            components.enemy_unit_kill_value + components.own_unit_loss_value
        ) * unit_scale
        dense_non_milestone = (
            components.own_base_damage
            + components.safe_age_up_bonus
            + components.age_up_delay_penalty
            + components.action_discovery_bonus
            + components.lane_control_delta
            + components.illegal_action_penalty
        )
        enemy_base_milestone = components.enemy_base_damage

        dense_cutoff_progress = float(np.clip(runtime.reward_dense_cutoff_progress, 0.0, 1.0))
        in_terminal_phase = progress >= dense_cutoff_progress
        dense_reward = unit_curriculum_reward + dense_non_milestone
        if not in_terminal_phase or runtime.reward_keep_enemy_base_milestone_after_dense_cutoff:
            dense_reward += enemy_base_milestone
        dense_reward *= dense_scale

        return dense_reward + components.terminal_outcome * terminal_scale

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
                    if self.allow_manifest_signature_mismatch:
                        print(
                            "[resume] warning: run manifest signature differs from current settings. "
                            "Proceeding because resume mode is enabled."
                        )
                    else:
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
