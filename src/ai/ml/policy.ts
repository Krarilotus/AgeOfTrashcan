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
  checkpointId?: string;
}

export interface MLPolicyOutput {
  actionTypeLogits: number[];
  unitLogits?: number[];
  turretLogits?: number[];
  buySlotLogits?: number[];
  sellSlotLogits?: number[];
  valueEstimate?: number;
  modelVersion?: string;
  inferenceSource?: 'remote_http' | 'heuristic_bootstrap';
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

interface RemoteInferResponse {
  ok: boolean;
  model_version?: string;
  value_estimate?: number;
  action_type_logits?: number[];
  unit_logits?: number[];
  turret_logits?: number[];
  buy_slot_logits?: number[];
  sell_slot_logits?: number[];
  error?: string;
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

  reset(): void {
    // Stateless policy; kept for interface compatibility.
  }

  getMetadata(): Record<string, unknown> {
    return { policy: this.getName() };
  }

  infer(input: MLPolicyInput): MLPolicyOutput {
    const state = input.rawState;
    const mask = input.observation.actionMask;
    const checkpointId = input.checkpointId ?? '';
    const checkpointHash = this.hashString(checkpointId);
    const aggressionBias = ((checkpointHash % 101) / 100) * 0.5 - 0.25;
    const economyBias = (((checkpointHash >> 8) % 101) / 100) * 0.5 - 0.25;
    const unitDiagMap = new Map((state.unitCatalogDiagnostics ?? []).map((item) => [item.unitId, item]));
    const turretDiagMap = new Map((state.turretCatalogDiagnostics ?? []).map((item) => [item.turretId, item]));
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
      actionTypeLogits[recruitIndex] = 1.2 + enemyPressure * 0.15 + aggressionBias;
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
        enemyPressure <= 1 && offensiveWindow
          ? 1.7 + economyBias
          : state.enemyGold > state.enemyAgeCost * 1.2
            ? 1.1 + economyBias
            : -0.8;
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
      const diag = unitDiagMap.get(unitId);
      const combatScore = unit.damage * 7 + unit.health * 0.8 + (unit.range ?? 1) * 4 + unit.speed * 3;
      const efficiency = combatScore / Math.max(1, unit.cost);
      const ageBias = (unit.age ?? 1) >= state.enemyAge ? 0.3 : -0.2;
      const antiSwarmBias = state.playerUnitCount > state.enemyUnitCount + 3 ? (unit.range ?? 1) * 0.2 : 0;
      const basePressureBias =
        state.enemyUnitsNearPlayerBase > state.playerUnitsNearEnemyBase ? unit.damage * 0.015 : unit.speed * 0.2;
      let diagBias = 0;
      if (diag) {
        diagBias += diag.legalNow ? 1.2 : -1.5;
        diagBias -= Math.min(2.5, diag.goldShortfall / 200);
        diagBias -= Math.min(1.8, diag.manaShortfall / 100);
        if (diag.ageLocked) diagBias -= 1.2;
        if (diag.queueBlocked) diagBias -= 0.9;
        diagBias += diag.scorePower / 800;
      }
      const checkpointDither = this.stableNoise(`${checkpointId}:${unitId}`) * 0.18;
      return efficiency * 4 + ageBias + antiSwarmBias + basePressureBias + diagBias + checkpointDither;
    });

    const turretLogits = ML_TURRET_IDS.map((turretId) => {
      const turret = getTurretEngineDef(turretId);
      if (!turret) return -10;
      const diag = turretDiagMap.get(turretId);
      const dps = estimateEngineDps(turret);
      const efficiency = dps / Math.max(1, turret.cost);
      const protectionValue = (1 - turret.protectionMultiplier) * 8;
      let diagBias = 0;
      if (diag) {
        diagBias += diag.legalNow ? 1.0 : -1.4;
        diagBias -= Math.min(2.5, diag.goldShortfall / 250);
        diagBias -= Math.min(1.8, diag.manaShortfall / 120);
        if (diag.ageLocked) diagBias -= 1.0;
        if (diag.slotBlocked) diagBias -= 1.0;
        if (diag.queueBlocked) diagBias -= 0.8;
        diagBias += diag.scorePower / 200;
      }
      const checkpointDither = this.stableNoise(`${checkpointId}:${turretId}`) * 0.14;
      return efficiency * 8 + protectionValue + turret.range * 0.08 + diagBias + checkpointDither;
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
      inferenceSource: 'heuristic_bootstrap',
    };
  }

  private hashString(text: string): number {
    let hash = 2166136261;
    for (let idx = 0; idx < text.length; idx++) {
      hash ^= text.charCodeAt(idx);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  private stableNoise(text: string): number {
    const hash = this.hashString(text);
    return ((hash % 10000) / 5000) - 1;
  }
}

interface RemoteInferencePolicyOptions {
  url?: string;
  requestTimeoutMs?: number;
  requestIntervalMs?: number;
  freshResultMs?: number;
}

export class AsyncHttpCheckpointPolicy implements IMLPolicy {
  private readonly requestTimeoutMs: number;
  private readonly requestIntervalMs: number;
  private readonly freshResultMs: number;
  private urlOverride: string | null;
  private inFlight = false;
  private lastRequestAt = 0;
  private lastFailureAt = 0;
  private lastFailureReason = '';
  private lastSuccessAt = 0;
  private lastCheckpointId = '';
  private lastOutput: MLPolicyOutput | null = null;

  constructor(options: RemoteInferencePolicyOptions = {}) {
    this.urlOverride = options.url?.trim() || null;
    this.requestTimeoutMs = Math.max(100, options.requestTimeoutMs ?? 700);
    this.requestIntervalMs = Math.max(50, options.requestIntervalMs ?? 150);
    this.freshResultMs = Math.max(100, options.freshResultMs ?? 1500);
  }

  getName(): string {
    return 'AsyncHttpCheckpointPolicy';
  }

  infer(input: MLPolicyInput): MLPolicyOutput | null {
    const checkpointId = (input.checkpointId ?? '').trim();
    const endpoint = this.resolveUrl();
    if (!endpoint || !checkpointId) {
      this.lastFailureAt = Date.now();
      if (!endpoint) {
        this.lastFailureReason = 'inference URL not configured';
      } else if (!checkpointId) {
        this.lastFailureReason = 'checkpoint_id missing';
      }
      return null;
    }

    const now = Date.now();
    if (!this.inFlight && now - this.lastRequestAt >= this.requestIntervalMs) {
      this.inFlight = true;
      this.lastRequestAt = now;
      void this.sendRequest(endpoint, checkpointId, input);
    }

    if (!this.lastOutput) return null;
    if (this.lastCheckpointId !== checkpointId) return null;
    if (now - this.lastSuccessAt > this.freshResultMs) return null;
    return this.lastOutput;
  }

  getMetadata(): Record<string, unknown> {
    return {
      url: this.resolveUrl(),
      inFlight: this.inFlight,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastFailureReason: this.lastFailureReason,
      lastCheckpointId: this.lastCheckpointId,
    };
  }

  setUrl(url: string | null): void {
    this.urlOverride = url && url.trim().length > 0 ? url.trim() : null;
  }

  private resolveUrl(): string | null {
    if (this.urlOverride) return this.urlOverride;
    const viteEnvUrl = (import.meta as any)?.env?.VITE_ML_INFERENCE_URL;
    if (typeof viteEnvUrl === 'string' && viteEnvUrl.trim().length > 0) {
      return viteEnvUrl.trim();
    }
    const globalObj = globalThis as Record<string, unknown>;
    const globalUrl = globalObj.__AOT_ML_INFERENCE_URL__;
    if (typeof globalUrl === 'string' && globalUrl.trim().length > 0) {
      return globalUrl.trim();
    }
    if (typeof window !== 'undefined') {
      const param = new URLSearchParams(window.location.search).get('mlInferenceUrl');
      if (param && param.trim().length > 0) return param.trim();
      try {
        const local = window.localStorage.getItem('aot.ml.inferenceUrl');
        if (local && local.trim().length > 0) return local.trim();
      } catch {
        return null;
      }
      const host = (window.location.hostname || '').toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1') {
        return 'http://127.0.0.1:8765';
      }
    }
    return null;
  }

  private async sendRequest(endpoint: string, checkpointId: string, input: MLPolicyInput): Promise<void> {
    const timerController = new AbortController();
    const timeout = setTimeout(() => timerController.abort(), this.requestTimeoutMs);
    try {
      const observation = input.observation;
      const payload = {
        checkpoint_id: checkpointId,
        deterministic: input.deterministic ?? true,
        observation: {
          static_state: observation.staticState,
          event_sequence: observation.eventSequence,
          action_type_mask: observation.actionMask.actionTypeMask,
          unit_mask: observation.actionMask.unitMask,
          turret_mask: observation.actionMask.turretMask,
          buy_slot_mask: observation.actionMask.buySlotMask,
          sell_slot_mask: observation.actionMask.sellSlotMask,
        },
      };
      const response = await fetch(this.normalizeUrl(endpoint), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: timerController.signal,
      });
      if (!response.ok) {
        throw new Error(`inference HTTP ${response.status}`);
      }
      const data = (await response.json()) as RemoteInferResponse;
      if (!data.ok) {
        throw new Error(data.error || 'inference server returned failure');
      }

      const actionTypeLogits = this.toNumberArray(data.action_type_logits);
      if (actionTypeLogits.length === 0) {
        throw new Error('inference response missing action logits');
      }

      this.lastOutput = {
        actionTypeLogits,
        unitLogits: this.toNumberArray(data.unit_logits),
        turretLogits: this.toNumberArray(data.turret_logits),
        buySlotLogits: this.toNumberArray(data.buy_slot_logits),
        sellSlotLogits: this.toNumberArray(data.sell_slot_logits),
        valueEstimate: typeof data.value_estimate === 'number' ? data.value_estimate : undefined,
        modelVersion: typeof data.model_version === 'string' ? data.model_version : 'remote',
        inferenceSource: 'remote_http',
      };
      this.lastCheckpointId = checkpointId;
      this.lastSuccessAt = Date.now();
      this.lastFailureReason = '';
    } catch (error) {
      this.lastFailureAt = Date.now();
      this.lastFailureReason = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timeout);
      this.inFlight = false;
    }
  }

  private normalizeUrl(baseUrl: string): string {
    const trimmed = baseUrl.trim();
    if (trimmed.endsWith('/infer')) return trimmed;
    if (trimmed.endsWith('/')) return `${trimmed}infer`;
    return `${trimmed}/infer`;
  }

  private toNumberArray(values: unknown): number[] {
    if (!Array.isArray(values)) return [];
    return values
      .map((value) => (typeof value === 'number' && Number.isFinite(value) ? value : null))
      .filter((value): value is number => value !== null);
  }
}

export class HybridRemotePolicy implements IMLPolicy {
  constructor(
    private readonly remotePolicy: AsyncHttpCheckpointPolicy = new AsyncHttpCheckpointPolicy(),
    private readonly fallbackPolicy: HeuristicBootstrapPolicy = new HeuristicBootstrapPolicy()
  ) {}

  getName(): string {
    return `HybridRemotePolicy(${this.remotePolicy.getName()}|${this.fallbackPolicy.getName()})`;
  }

  infer(input: MLPolicyInput): MLPolicyOutput | null {
    const remote = this.remotePolicy.infer(input);
    if (remote) return remote;
    const hasCheckpointSelection = typeof input.checkpointId === 'string' && input.checkpointId.trim().length > 0;
    if (hasCheckpointSelection) {
      // In checkpoint mode, do not silently route to heuristic pseudo-policy.
      return null;
    }
    return this.fallbackPolicy.infer(input);
  }

  reset(): void {
    this.fallbackPolicy.reset?.();
  }

  getMetadata(): Record<string, unknown> {
    return {
      remote: this.remotePolicy.getMetadata?.() ?? {},
      fallback: this.fallbackPolicy.getMetadata?.() ?? {},
    };
  }
}
