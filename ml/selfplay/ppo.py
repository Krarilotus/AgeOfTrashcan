from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Tuple

import numpy as np
import torch
import torch.nn.functional as F
from torch import nn

from .config import PPOConfig
from .model import TransformerActorCritic


@dataclass(slots=True)
class RolloutBatch:
    static_state: torch.Tensor
    event_sequence: torch.Tensor
    masks: Dict[str, torch.Tensor]
    actions: Dict[str, torch.Tensor]
    old_log_probs: torch.Tensor
    old_values: torch.Tensor
    rewards: torch.Tensor
    dones: torch.Tensor
    advantages: torch.Tensor
    returns: torch.Tensor


def compute_gae(
    rewards: np.ndarray,
    values: np.ndarray,
    dones: np.ndarray,
    next_value: np.ndarray,
    gamma: float,
    gae_lambda: float,
) -> Tuple[np.ndarray, np.ndarray]:
    horizon, num_envs = rewards.shape
    advantages = np.zeros((horizon, num_envs), dtype=np.float32)
    last_gae = np.zeros((num_envs,), dtype=np.float32)
    for step in reversed(range(horizon)):
        non_terminal = 1.0 - dones[step]
        value_next = next_value if step == horizon - 1 else values[step + 1]
        delta = rewards[step] + gamma * value_next * non_terminal - values[step]
        last_gae = delta + gamma * gae_lambda * non_terminal * last_gae
        advantages[step] = last_gae
    returns = advantages + values
    return advantages, returns


class PPOUpdater:
    def __init__(
        self,
        model: TransformerActorCritic,
        optimizer: torch.optim.Optimizer,
        cfg: PPOConfig,
        device: torch.device,
    ) -> None:
        self.model = model
        self.optimizer = optimizer
        self.cfg = cfg
        self.device = device

    def _masked_logprob_entropy(
        self, logits: torch.Tensor, mask: torch.Tensor, actions: torch.Tensor
    ) -> Tuple[torch.Tensor, torch.Tensor]:
        masked_logits = torch.where(mask > 0, logits, torch.full_like(logits, torch.finfo(logits.dtype).min))
        dist = torch.distributions.Categorical(logits=masked_logits)
        return dist.log_prob(actions), dist.entropy()

    def update(self, batch: RolloutBatch) -> Dict[str, float]:
        batch_size = batch.returns.shape[0]
        advantages = batch.advantages
        advantages = (advantages - advantages.mean()) / (advantages.std() + 1e-8)

        metrics = {
            "policy_loss": 0.0,
            "value_loss": 0.0,
            "entropy": 0.0,
            "kl": 0.0,
            "clips": 0.0,
            "updates": 0.0,
        }

        for _ in range(self.cfg.ppo_epochs):
            indices = torch.randperm(batch_size, device=self.device)
            for start in range(0, batch_size, self.cfg.minibatch_size):
                mb_idx = indices[start : start + self.cfg.minibatch_size]
                outputs = self.model(batch.static_state[mb_idx], batch.event_sequence[mb_idx])

                action_logp, action_ent = self._masked_logprob_entropy(
                    outputs.action_logits,
                    batch.masks["action_type"][mb_idx],
                    batch.actions["action"][mb_idx],
                )
                unit_logp, unit_ent = self._masked_logprob_entropy(
                    outputs.unit_logits,
                    batch.masks["unit"][mb_idx],
                    batch.actions["unit"][mb_idx],
                )
                turret_logp, turret_ent = self._masked_logprob_entropy(
                    outputs.turret_logits,
                    batch.masks["turret"][mb_idx],
                    batch.actions["turret"][mb_idx],
                )
                buy_slot_logp, buy_slot_ent = self._masked_logprob_entropy(
                    outputs.buy_slot_logits,
                    batch.masks["buy_slot"][mb_idx],
                    batch.actions["buy_slot"][mb_idx],
                )
                sell_slot_logp, sell_slot_ent = self._masked_logprob_entropy(
                    outputs.sell_slot_logits,
                    batch.masks["sell_slot"][mb_idx],
                    batch.actions["sell_slot"][mb_idx],
                )

                new_log_prob = action_logp + unit_logp + turret_logp + buy_slot_logp + sell_slot_logp
                old_log_prob = batch.old_log_probs[mb_idx]
                ratio = torch.exp(new_log_prob - old_log_prob)

                unclipped = ratio * advantages[mb_idx]
                clipped = torch.clamp(ratio, 1.0 - self.cfg.clip_epsilon, 1.0 + self.cfg.clip_epsilon) * advantages[mb_idx]
                policy_loss = -torch.mean(torch.min(unclipped, clipped))

                value_pred = outputs.value
                value_target = batch.returns[mb_idx]
                value_loss = F.mse_loss(value_pred, value_target)

                entropy = torch.mean(action_ent + unit_ent + turret_ent + buy_slot_ent + sell_slot_ent)
                loss = policy_loss + self.cfg.value_coef * value_loss - self.cfg.entropy_coef * entropy

                self.optimizer.zero_grad(set_to_none=True)
                loss.backward()
                nn.utils.clip_grad_norm_(self.model.parameters(), self.cfg.grad_clip_norm)
                self.optimizer.step()

                with torch.no_grad():
                    approx_kl = torch.mean(old_log_prob - new_log_prob).item()
                    clip_fraction = torch.mean((torch.abs(ratio - 1.0) > self.cfg.clip_epsilon).float()).item()

                metrics["policy_loss"] += float(policy_loss.item())
                metrics["value_loss"] += float(value_loss.item())
                metrics["entropy"] += float(entropy.item())
                metrics["kl"] += approx_kl
                metrics["clips"] += clip_fraction
                metrics["updates"] += 1.0

                if approx_kl > self.cfg.kl_hard_stop:
                    break

            if metrics["updates"] > 0 and (metrics["kl"] / metrics["updates"]) > self.cfg.kl_target:
                break

        if metrics["updates"] > 0:
            scale = metrics["updates"]
            metrics["policy_loss"] /= scale
            metrics["value_loss"] /= scale
            metrics["entropy"] /= scale
            metrics["kl"] /= scale
            metrics["clips"] /= scale
        return metrics
