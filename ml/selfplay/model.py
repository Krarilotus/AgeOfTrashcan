from __future__ import annotations

from dataclasses import dataclass
from typing import Dict

import torch
import torch.nn as nn

from .config import ModelConfig


class GRUGatingUnit(nn.Module):
    def __init__(self, d_model: int) -> None:
        super().__init__()
        self.gru = nn.GRUCell(d_model, d_model)

    def forward(self, x: torch.Tensor, residual: torch.Tensor) -> torch.Tensor:
        bsz, seq_len, dim = x.shape
        flat_x = x.reshape(bsz * seq_len, dim)
        flat_res = residual.reshape(bsz * seq_len, dim)
        out = self.gru(flat_x, flat_res)
        return out.reshape(bsz, seq_len, dim)


class GTrXLBlock(nn.Module):
    def __init__(self, d_model: int, n_heads: int, ffn_dim: int, dropout: float) -> None:
        super().__init__()
        self.norm_1 = nn.LayerNorm(d_model)
        self.attn = nn.MultiheadAttention(
            embed_dim=d_model,
            num_heads=n_heads,
            dropout=dropout,
            batch_first=True,
        )
        self.dropout_1 = nn.Dropout(dropout)
        self.gate_1 = GRUGatingUnit(d_model)

        self.norm_2 = nn.LayerNorm(d_model)
        self.ffn = nn.Sequential(
            nn.Linear(d_model, ffn_dim),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(ffn_dim, d_model),
        )
        self.dropout_2 = nn.Dropout(dropout)
        self.gate_2 = GRUGatingUnit(d_model)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        residual = x
        attn_in = self.norm_1(x)
        attn_out, _ = self.attn(attn_in, attn_in, attn_in, need_weights=False)
        attn_out = self.dropout_1(attn_out)
        x = self.gate_1(attn_out, residual)

        residual = x
        ffn_in = self.norm_2(x)
        ffn_out = self.ffn(ffn_in)
        ffn_out = self.dropout_2(ffn_out)
        x = self.gate_2(ffn_out, residual)
        return x


@dataclass(slots=True)
class ForwardOutput:
    action_logits: torch.Tensor
    unit_logits: torch.Tensor
    turret_logits: torch.Tensor
    buy_slot_logits: torch.Tensor
    sell_slot_logits: torch.Tensor
    value: torch.Tensor


class TransformerActorCritic(nn.Module):
    def __init__(self, cfg: ModelConfig) -> None:
        super().__init__()
        self.cfg = cfg
        self.token_proj = nn.Linear(cfg.token_dim, cfg.d_model)
        self.pos_embed = nn.Parameter(torch.zeros(1, cfg.sequence_len, cfg.d_model))
        nn.init.normal_(self.pos_embed, mean=0.0, std=0.02)

        self.blocks = nn.ModuleList(
            [GTrXLBlock(cfg.d_model, cfg.n_heads, cfg.ffn_dim, cfg.dropout) for _ in range(cfg.n_layers)]
        )
        self.final_norm = nn.LayerNorm(cfg.d_model)

        self.static_encoder = nn.Sequential(
            nn.Linear(cfg.static_dim, 512),
            nn.GELU(),
            nn.Linear(512, 256),
            nn.GELU(),
            nn.Linear(256, 256),
        )

        self.fusion = nn.Sequential(
            nn.Linear(cfg.d_model + 256, 256),
            nn.GELU(),
            nn.Linear(256, 256),
        )

        self.action_head = nn.Linear(256, cfg.action_dim)
        self.unit_head = nn.Linear(256, cfg.unit_dim)
        self.turret_head = nn.Linear(256, cfg.turret_dim)
        self.buy_slot_head = nn.Linear(256, cfg.slot_dim)
        self.sell_slot_head = nn.Linear(256, cfg.slot_dim)
        self.value_head = nn.Linear(256, 1)

    def forward(self, static_state: torch.Tensor, event_sequence: torch.Tensor) -> ForwardOutput:
        seq = self.token_proj(event_sequence) + self.pos_embed
        for block in self.blocks:
            seq = block(seq)
        seq = self.final_norm(seq)
        seq_latent = seq[:, -1]

        static_latent = self.static_encoder(static_state)
        fused = self.fusion(torch.cat([seq_latent, static_latent], dim=-1))

        return ForwardOutput(
            action_logits=self.action_head(fused),
            unit_logits=self.unit_head(fused),
            turret_logits=self.turret_head(fused),
            buy_slot_logits=self.buy_slot_head(fused),
            sell_slot_logits=self.sell_slot_head(fused),
            value=self.value_head(fused).squeeze(-1),
        )

    def masked_logits(self, logits: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        large_negative = torch.finfo(logits.dtype).min
        return torch.where(mask > 0, logits, torch.full_like(logits, large_negative))

    def sample_action(
        self,
        outputs: ForwardOutput,
        masks: Dict[str, torch.Tensor],
        deterministic: bool = False,
    ) -> Dict[str, torch.Tensor]:
        action_logits = self.masked_logits(outputs.action_logits, masks["action_type"])
        action_dist = torch.distributions.Categorical(logits=action_logits)
        action_idx = torch.argmax(action_logits, dim=-1) if deterministic else action_dist.sample()

        def sample_head(name: str, logits: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
            masked = self.masked_logits(logits, masks[name])
            dist = torch.distributions.Categorical(logits=masked)
            sampled = torch.argmax(masked, dim=-1) if deterministic else dist.sample()
            return sampled, dist.log_prob(sampled), dist.entropy()

        unit_idx, unit_log_prob, unit_entropy = sample_head("unit", outputs.unit_logits)
        turret_idx, turret_log_prob, turret_entropy = sample_head("turret", outputs.turret_logits)
        buy_slot_idx, buy_slot_log_prob, buy_slot_entropy = sample_head("buy_slot", outputs.buy_slot_logits)
        sell_slot_idx, sell_slot_log_prob, sell_slot_entropy = sample_head("sell_slot", outputs.sell_slot_logits)
        action_log_prob = action_dist.log_prob(action_idx)
        action_entropy = action_dist.entropy()

        return {
            "action": action_idx,
            "unit": unit_idx,
            "turret": turret_idx,
            "buy_slot": buy_slot_idx,
            "sell_slot": sell_slot_idx,
            "value": outputs.value,
            "action_log_prob": action_log_prob,
            "unit_log_prob": unit_log_prob,
            "turret_log_prob": turret_log_prob,
            "buy_slot_log_prob": buy_slot_log_prob,
            "sell_slot_log_prob": sell_slot_log_prob,
            "combined_log_prob": action_log_prob
            + unit_log_prob
            + turret_log_prob
            + buy_slot_log_prob
            + sell_slot_log_prob,
            "action_entropy": action_entropy
            + unit_entropy
            + turret_entropy
            + buy_slot_entropy
            + sell_slot_entropy,
        }
