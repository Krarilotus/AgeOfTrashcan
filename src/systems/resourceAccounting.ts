import type { GameState } from '../GameEngine';

export type ManaSpendCategory = 'unit' | 'ability' | 'other';

type SideTotals = { player: number; enemy: number };

function toFiniteNonNegative(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, num);
}

function ensureSideTotals(raw: unknown): SideTotals {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    player: toFiniteNonNegative(value.player),
    enemy: toFiniteNonNegative(value.enemy),
  };
}

export function ensureManaSpendStats(state: GameState): void {
  const stats = (state.stats ?? {}) as Record<string, unknown>;
  (stats as any).manaSpent = ensureSideTotals((stats as any).manaSpent);
  (stats as any).manaSpentUnits = ensureSideTotals((stats as any).manaSpentUnits);
  (stats as any).manaSpentAbilities = ensureSideTotals((stats as any).manaSpentAbilities);
  state.stats = stats as GameState['stats'];
}

export function recordManaSpent(
  state: GameState,
  owner: 'PLAYER' | 'ENEMY',
  amount: number,
  category: ManaSpendCategory = 'other'
): number {
  const spent = toFiniteNonNegative(amount);
  if (spent <= 0) return 0;

  ensureManaSpendStats(state);
  const sideKey = owner === 'PLAYER' ? 'player' : 'enemy';
  (state.stats.manaSpent as SideTotals)[sideKey] += spent;

  if (category === 'unit') {
    (state.stats.manaSpentUnits as SideTotals)[sideKey] += spent;
  } else if (category === 'ability') {
    (state.stats.manaSpentAbilities as SideTotals)[sideKey] += spent;
  }

  return spent;
}
