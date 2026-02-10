import type { AIDecision, GameStateSnapshot } from '../AIBehavior';
import { estimateEngineDps, getTurretEngineDef } from '../../config/turrets';
import { UNIT_DEFS } from '../../config/units';
import { ML_ACTION_TYPES, ML_SLOT_INDICES, ML_TURRET_IDS, ML_UNIT_IDS, getActionTypeIndex } from './actionCatalog';
import type { MLLegalActionMask } from './legalActionMask';
import type { EncodedMLObservation } from './observationEncoder';

export interface MLPolicyInput {
  observation: EncodedMLObservation;
  rawState: GameStateSnapshot;
  deterministic?: boolean;
  temperature?: number;
}

export interface MLPolicyOutput {
  actionTypeLogits: number[];
  unitLogits?: number[];
  turretLogits?: number[];
  buySlotLogits?: number[];
  sellSlotLogits?: number[];
  valueEstimate?: number;
  modelVersion?: string;
}

export interface DecodedPolicyDecision {
  decision: AIDecision;
  debug: {
    selectedActionIndex: number;
    selectedAction: string;
    confidence: number;
  };
}

export interface IMLPolicy {
  getName(): string;
  infer(input: MLPolicyInput): MLPolicyOutput | null;
  reset?(): void;
  getMetadata?(): Record<string, unknown>;
}

function maskedArgmax(logits: number[], mask: number[]): number {
  let bestIndex = -1;
  let bestLogit = -Infinity;
  for (let index = 0; index < mask.length; index++) {
    if (mask[index] <= 0) continue;
    const logit = logits[index] ?? -Infinity;
    if (logit > bestLogit) {
      bestLogit = logit;
      bestIndex = index;
    }
  }
  if (bestIndex >= 0) return bestIndex;
  return mask.findIndex((item) => item > 0);
}

function approximateConfidence(logits: number[], selectedIndex: number, legalMask: number[]): number {
  if (selectedIndex < 0) return 0;
  const legalLogits = legalMask
    .map((maskValue, index) => (maskValue > 0 ? logits[index] ?? -Infinity : -Infinity))
    .filter((value) => Number.isFinite(value));
  if (legalLogits.length === 0) return 0.5;
  const sorted = [...legalLogits].sort((a, b) => b - a);
  const top = sorted[0];
  const second = sorted[1] ?? top - 1;
  const margin = top - second;
  return Math.max(0, Math.min(1, 1 / (1 + Math.exp(-margin))));
}

function selectIndex(logits: number[] | undefined, mask: number[]): number {
  if (!logits || logits.length === 0) {
    return mask.findIndex((item) => item > 0);
  }
  return maskedArgmax(logits, mask);
}

export function decodePolicyOutput(
  output: MLPolicyOutput,
  legalMask: MLLegalActionMask
): DecodedPolicyDecision | null {
  const actionIndex = maskedArgmax(output.actionTypeLogits, legalMask.actionTypeMask);
  if (actionIndex < 0) return null;

  const action = ML_ACTION_TYPES[actionIndex] ?? 'WAIT';
  const confidence = approximateConfidence(output.actionTypeLogits, actionIndex, legalMask.actionTypeMask);

  if (action === 'RECRUIT_UNIT') {
    const unitIndex = selectIndex(output.unitLogits, legalMask.unitMask);
    if (unitIndex < 0) return null;
    const unitType = ML_UNIT_IDS[unitIndex];
    if (!unitType) return null;
    return {
      decision: {
        action,
        confidence,
        parameters: { unitType, priority: 'normal' as const },
      },
      debug: { selectedActionIndex: actionIndex, selectedAction: action, confidence },
    };
  }

  if (action === 'BUY_TURRET_ENGINE') {
    const turretIndex = selectIndex(output.turretLogits, legalMask.turretMask);
    const slotIndex = selectIndex(output.buySlotLogits, legalMask.buySlotMask);
    if (turretIndex < 0 || slotIndex < 0) return null;
    const turretId = ML_TURRET_IDS[turretIndex];
    if (!turretId) return null;
    return {
      decision: {
        action,
        confidence,
        parameters: { turretId, slotIndex },
      },
      debug: { selectedActionIndex: actionIndex, selectedAction: action, confidence },
    };
  }

  if (action === 'SELL_TURRET_ENGINE') {
    const slotIndex = selectIndex(output.sellSlotLogits, legalMask.sellSlotMask);
    if (slotIndex < 0) return null;
    return {
      decision: {
        action,
        confidence,
        parameters: { slotIndex },
      },
      debug: { selectedActionIndex: actionIndex, selectedAction: action, confidence },
    };
  }

  return {
    decision: { action, confidence },
    debug: { selectedActionIndex: actionIndex, selectedAction: action, confidence },
  };
}

export class HeuristicBootstrapPolicy implements IMLPolicy {
  getName(): string {
    return 'HeuristicBootstrapPolicy';
  }

  infer(input: MLPolicyInput): MLPolicyOutput {
    const state = input.rawState;
    const mask = input.observation.actionMask;
    const actionTypeLogits = new Array<number>(ML_ACTION_TYPES.length).fill(-3);
    const waitIndex = getActionTypeIndex('WAIT');
    const recruitIndex = getActionTypeIndex('RECRUIT_UNIT');
    const ageUpIndex = getActionTypeIndex('AGE_UP');
    const manaIndex = getActionTypeIndex('UPGRADE_MANA');
    const slotUpgradeIndex = getActionTypeIndex('UPGRADE_TURRET_SLOTS');
    const buyTurretIndex = getActionTypeIndex('BUY_TURRET_ENGINE');
    const sellTurretIndex = getActionTypeIndex('SELL_TURRET_ENGINE');
    const repairIndex = getActionTypeIndex('REPAIR_BASE');

    actionTypeLogits[waitIndex] = 0.2;

    const enemyPressure = state.playerUnitsNearEnemyBase + Math.max(0, state.playerUnitCount - state.enemyUnitCount);
    const offensiveWindow = state.enemyUnitCount > state.playerUnitCount + 2;

    if (mask.actionTypeMask[recruitIndex] > 0) {
      actionTypeLogits[recruitIndex] = 1.2 + enemyPressure * 0.15;
    }
    if (mask.actionTypeMask[buyTurretIndex] > 0) {
      actionTypeLogits[buyTurretIndex] = 0.9 + enemyPressure * 0.2;
    }
    if (mask.actionTypeMask[slotUpgradeIndex] > 0 && state.enemyTurretSlotsUnlocked < 4) {
      actionTypeLogits[slotUpgradeIndex] = enemyPressure > 2 ? 1.1 : 0.4;
    }
    if (mask.actionTypeMask[repairIndex] > 0) {
      const healthRatio = state.enemyBaseHealth / Math.max(1, state.enemyBaseMaxHealth);
      actionTypeLogits[repairIndex] = healthRatio < 0.5 ? 2.2 : 0.3;
    }
    if (mask.actionTypeMask[ageUpIndex] > 0) {
      actionTypeLogits[ageUpIndex] =
        enemyPressure <= 1 && offensiveWindow ? 1.7 : state.enemyGold > state.enemyAgeCost * 1.2 ? 1.1 : -0.8;
    }
    if (mask.actionTypeMask[manaIndex] > 0) {
      const manaTargetByAge = [0, 0, 1, 3, 5, 8, 12];
      const target = manaTargetByAge[state.enemyAge] ?? 8;
      actionTypeLogits[manaIndex] = state.enemyManaLevel < target ? 0.8 : -0.6;
    }
    if (mask.actionTypeMask[sellTurretIndex] > 0) {
      actionTypeLogits[sellTurretIndex] = state.enemyAge >= 5 ? 0.1 : -0.9;
    }

    const unitLogits = ML_UNIT_IDS.map((unitId) => {
      const unit = UNIT_DEFS[unitId];
      if (!unit) return -10;
      const combatScore = unit.damage * 7 + unit.health * 0.8 + (unit.range ?? 1) * 4 + unit.speed * 3;
      const efficiency = combatScore / Math.max(1, unit.cost);
      const ageBias = (unit.age ?? 1) >= state.enemyAge ? 0.3 : -0.2;
      return efficiency * 4 + ageBias;
    });

    const turretLogits = ML_TURRET_IDS.map((turretId) => {
      const turret = getTurretEngineDef(turretId);
      if (!turret) return -10;
      const dps = estimateEngineDps(turret);
      const efficiency = dps / Math.max(1, turret.cost);
      const protectionValue = (1 - turret.protectionMultiplier) * 8;
      return efficiency * 8 + protectionValue + turret.range * 0.08;
    });

    const buySlotLogits = ML_SLOT_INDICES.map((slot) => -slot * 0.2);
    const sellSlotLogits = ML_SLOT_INDICES.map((slot) => slot * 0.1);

    return {
      actionTypeLogits,
      unitLogits,
      turretLogits,
      buySlotLogits,
      sellSlotLogits,
      valueEstimate: (state.enemyBaseHealth - state.playerBaseHealth) / Math.max(1, state.enemyBaseMaxHealth),
      modelVersion: 'heuristic-bootstrap-v1',
    };
  }
}
