import type { AIAction } from '../AIBehavior';
import { MAX_TURRET_SLOTS, TURRET_ENGINES } from '../../config/turrets';
import { UNIT_DEFS } from '../../config/units';

export const ML_ACTION_TYPES: AIAction[] = [
  'WAIT',
  'RECRUIT_UNIT',
  'AGE_UP',
  'UPGRADE_MANA',
  'UPGRADE_TURRET_SLOTS',
  'BUY_TURRET_ENGINE',
  'SELL_TURRET_ENGINE',
  'REPAIR_BASE',
];

export const ML_UNIT_IDS = Object.keys(UNIT_DEFS).sort();
export const ML_TURRET_IDS = Object.keys(TURRET_ENGINES).sort();
export const ML_SLOT_INDICES = Array.from({ length: MAX_TURRET_SLOTS }, (_, idx) => idx);

const ACTION_INDEX = new Map<AIAction, number>(
  ML_ACTION_TYPES.map((action, index) => [action, index])
);
const UNIT_INDEX = new Map<string, number>(ML_UNIT_IDS.map((unitId, index) => [unitId, index]));
const TURRET_INDEX = new Map<string, number>(
  ML_TURRET_IDS.map((turretId, index) => [turretId, index])
);

export function getActionTypeIndex(action: AIAction): number {
  return ACTION_INDEX.get(action) ?? 0;
}

export function getUnitIndex(unitId: string | undefined): number {
  if (!unitId) return -1;
  return UNIT_INDEX.get(unitId) ?? -1;
}

export function getTurretIndex(turretId: string | undefined): number {
  if (!turretId) return -1;
  return TURRET_INDEX.get(turretId) ?? -1;
}

export function normalizeDiscreteIndex(index: number, totalSize: number): number {
  if (index < 0 || totalSize <= 0) return 0;
  return (index + 1) / (totalSize + 1);
}
