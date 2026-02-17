import type { AIDecision, GameStateSnapshot, IAIBehavior } from '../AIBehavior';
import type { AIPersonality } from '../../config/aiConfig';
import { SmartPlannerAI } from './SmartPlannerAI';
import { getActionTypeIndex, getTurretIndex, getUnitIndex } from '../ml/actionCatalog';
import { MLHistoryBuffer } from '../ml/historyBuffer';
import { buildLegalActionMask } from '../ml/legalActionMask';
import { encodeObservation, summarizeActionMask } from '../ml/observationEncoder';
import { decodePolicyOutput, HybridRemotePolicy, type IMLPolicy } from '../ml/policy';

interface MLSelfPlayBehaviorOptions {
  policy?: IMLPolicy;
  fallbackBehavior?: IAIBehavior;
  policyEnabled?: boolean;
  sequenceLength?: number;
  modelVersionOverride?: string;
  selectedCheckpointId?: string;
  requireCheckpointInference?: boolean;
  antiIdleEnabled?: boolean;
  antiIdleWaitThreshold?: number;
}

interface MLDecisionDebugState {
  policyName: string;
  policyEnabled: boolean;
  policySource: string;
  modelVersion: string;
  checkpointStrictMode: boolean;
  checkpointSelected: boolean;
  checkpointId: string | null;
  checkpointInferenceActive: boolean;
  checkpointInactiveReason: string;
  fallbackUsed: boolean;
  lastFallbackReason: string;
  fallbackRate: number;
  antiIdleEnabled: boolean;
  antiIdleWaitThreshold: number;
  passiveWaitStreak: number;
  antiIdleOverrides: number;
  policyDecisions: number;
  fallbackDecisions: number;
  lastAction: string;
  lastConfidence: number;
  legalSummary: Record<string, number>;
  valueEstimate?: number;
}

export class MLSelfPlayBehavior implements IAIBehavior {
  private readonly name = 'MLSelfPlayBehavior';
  private readonly policy: IMLPolicy;
  private readonly fallbackBehavior: IAIBehavior;
  private readonly history = new MLHistoryBuffer({ horizonSeconds: 120 });
  private readonly sequenceLength: number;
  private policyEnabled: boolean;
  private modelVersionOverride: string | null;
  private selectedCheckpointId: string | null;
  private requireCheckpointInference: boolean;
  private antiIdleEnabled: boolean;
  private antiIdleWaitThreshold: number;
  private passiveWaitStreak = 0;
  private antiIdleOverrides = 0;
  private totalDecisions = 0;
  private fallbackDecisions = 0;
  private policyDecisions = 0;
  private lastDebug: MLDecisionDebugState;

  constructor(options: MLSelfPlayBehaviorOptions = {}) {
    this.policy = options.policy ?? new HybridRemotePolicy();
    this.fallbackBehavior = options.fallbackBehavior ?? new SmartPlannerAI();
    this.policyEnabled = options.policyEnabled ?? true;
    this.modelVersionOverride = options.modelVersionOverride ?? null;
    this.selectedCheckpointId = options.selectedCheckpointId ?? null;
    this.requireCheckpointInference = options.requireCheckpointInference ?? false;
    this.antiIdleEnabled = options.antiIdleEnabled ?? true;
    this.antiIdleWaitThreshold = Math.max(1, options.antiIdleWaitThreshold ?? 8);
    this.sequenceLength = options.sequenceLength ?? 240;
    this.lastDebug = {
      policyName: this.policy.getName(),
      policyEnabled: this.policyEnabled,
      policySource: 'none',
      modelVersion: 'n/a',
      checkpointStrictMode: false,
      checkpointSelected: false,
      checkpointId: null,
      checkpointInferenceActive: false,
      checkpointInactiveReason: '',
      fallbackUsed: false,
      lastFallbackReason: '',
      fallbackRate: 0,
      antiIdleEnabled: this.antiIdleEnabled,
      antiIdleWaitThreshold: this.antiIdleWaitThreshold,
      passiveWaitStreak: 0,
      antiIdleOverrides: 0,
      policyDecisions: 0,
      fallbackDecisions: 0,
      lastAction: 'WAIT',
      lastConfidence: 0,
      legalSummary: {
        legalActionTypes: 0,
        legalUnits: 0,
        legalTurrets: 0,
        legalBuySlots: 0,
        legalSellSlots: 0,
        totalActionTypes: 0,
      },
    };
  }

  getName(): string {
    return this.name;
  }

  decide(state: GameStateSnapshot, personality: AIPersonality): AIDecision {
    this.totalDecisions += 1;
    this.history.ingestState(state);

    const legalMask = buildLegalActionMask(state);
    const checkpointSelected = this.hasSelectedCheckpoint();
    const checkpointStrictMode = this.requireCheckpointInference || checkpointSelected;
    const observation = encodeObservation(state, this.history.getRecentTokens(), legalMask, {
      sequenceLength: this.sequenceLength,
    });

    let selectedDecision: AIDecision | null = null;
    let fallbackUsed = false;
    let fallbackReason = '';
    let policySource = 'none';
    let modelVersion = 'n/a';
    let valueEstimate: number | undefined;

    if (checkpointStrictMode && !checkpointSelected) {
      fallbackUsed = true;
      fallbackReason = 'checkpoint not selected';
      selectedDecision = {
        action: 'WAIT',
        reasoning: this.buildStrictCheckpointFailureReason(fallbackReason),
      };
    } else if (this.policyEnabled) {
      const policyOutput = this.policy.infer({
        observation,
        rawState: state,
        deterministic: true,
        checkpointId: this.selectedCheckpointId ?? undefined,
      });
      if (policyOutput) {
        policySource = policyOutput.inferenceSource ?? 'unknown';
        modelVersion = policyOutput.modelVersion ?? 'unknown';
        valueEstimate = policyOutput.valueEstimate;
        let decoded = decodePolicyOutput(policyOutput, legalMask);
        if (
          decoded &&
          decoded.decision.action === 'WAIT' &&
          this.antiIdleEnabled &&
          this.hasLegalNonWaitAction(legalMask)
        ) {
          const nextStreak = this.passiveWaitStreak + 1;
          if (nextStreak >= this.antiIdleWaitThreshold) {
            const forced = decodePolicyOutput(policyOutput, legalMask, { disallowWait: true });
            if (forced && forced.decision.action !== 'WAIT' && this.isDecisionLegal(forced.decision, legalMask)) {
              decoded = forced;
              this.passiveWaitStreak = 0;
              this.antiIdleOverrides += 1;
            } else {
              this.passiveWaitStreak = nextStreak;
            }
          } else {
            this.passiveWaitStreak = nextStreak;
          }
        } else if (decoded && decoded.decision.action !== 'WAIT') {
          this.passiveWaitStreak = 0;
        } else if (decoded && decoded.decision.action === 'WAIT') {
          this.passiveWaitStreak = 0;
        }
        if (decoded && this.isDecisionLegal(decoded.decision, legalMask)) {
          selectedDecision = {
            ...decoded.decision,
            reasoning: decoded.decision.reasoning ?? `[ML:${this.policy.getName()}] ${decoded.debug.selectedAction}`,
          };
        } else {
          fallbackUsed = true;
          fallbackReason = decoded ? 'policy decision failed legality check' : 'policy decode returned null';
          if (checkpointStrictMode) {
            selectedDecision = {
              action: 'WAIT',
              reasoning: this.buildStrictCheckpointFailureReason(fallbackReason),
            };
          }
        }
      } else {
        fallbackUsed = true;
        fallbackReason = 'policy returned null output';
        if (checkpointStrictMode) {
          selectedDecision = {
            action: 'WAIT',
            reasoning: this.buildStrictCheckpointFailureReason(fallbackReason),
          };
        }
      }
    } else {
      fallbackUsed = true;
      fallbackReason = 'policy disabled by configuration';
      if (checkpointStrictMode) {
        selectedDecision = {
          action: 'WAIT',
          reasoning: this.buildStrictCheckpointFailureReason(fallbackReason),
        };
      }
    }

    if (this.modelVersionOverride) {
      modelVersion = this.modelVersionOverride;
    }

    if (!selectedDecision) {
      if (checkpointStrictMode) {
        fallbackUsed = true;
        if (!fallbackReason) fallbackReason = 'checkpoint inference unavailable';
        selectedDecision = {
          action: 'WAIT',
          reasoning: this.buildStrictCheckpointFailureReason(fallbackReason),
        };
      } else {
        selectedDecision = this.fallbackBehavior.decide(state, personality);
        if (!this.isDecisionLegal(selectedDecision, legalMask)) {
          selectedDecision = { action: 'WAIT', reasoning: 'Fallback decision illegal under current mask' };
        } else if (fallbackUsed) {
          selectedDecision = {
            ...selectedDecision,
            reasoning: `[ML->RuleFallback] ${selectedDecision.reasoning ?? selectedDecision.action}`,
          };
        }
      }
    }

    if (fallbackUsed) {
      this.fallbackDecisions += 1;
    } else {
      this.policyDecisions += 1;
    }

    const checkpointInferenceActive =
      checkpointStrictMode && checkpointSelected && policySource === 'remote_http' && !fallbackUsed;
    const checkpointInactiveReason =
      checkpointStrictMode && !checkpointInferenceActive
        ? fallbackReason || (checkpointSelected ? 'checkpoint inference inactive' : 'checkpoint not selected')
        : '';

    this.history.recordDecision(state, selectedDecision);
    this.lastDebug = {
      policyName: this.policy.getName(),
      policyEnabled: this.policyEnabled,
      policySource,
      modelVersion,
      checkpointStrictMode,
      checkpointSelected,
      checkpointId: this.selectedCheckpointId,
      checkpointInferenceActive,
      checkpointInactiveReason,
      fallbackUsed,
      lastFallbackReason: fallbackReason,
      fallbackRate: this.fallbackDecisions / Math.max(1, this.totalDecisions),
      antiIdleEnabled: this.antiIdleEnabled,
      antiIdleWaitThreshold: this.antiIdleWaitThreshold,
      passiveWaitStreak: this.passiveWaitStreak,
      antiIdleOverrides: this.antiIdleOverrides,
      policyDecisions: this.policyDecisions,
      fallbackDecisions: this.fallbackDecisions,
      lastAction: selectedDecision.action,
      lastConfidence: selectedDecision.confidence ?? 0,
      legalSummary: summarizeActionMask(legalMask),
      valueEstimate,
    };

    return selectedDecision;
  }

  update(state: GameStateSnapshot, reward?: number): void {
    this.fallbackBehavior.update?.(state, reward);
  }

  reset(): void {
    this.history.reset();
    this.totalDecisions = 0;
    this.fallbackDecisions = 0;
    this.policyDecisions = 0;
    this.passiveWaitStreak = 0;
    this.antiIdleOverrides = 0;
    this.policy.reset?.();
    this.fallbackBehavior.reset?.();
  }

  getParameters(): Record<string, unknown> {
    return {
      behavior: this.name,
      ...this.lastDebug,
      policyMetadata: this.policy.getMetadata ? this.policy.getMetadata() : {},
      fallbackBehavior: this.fallbackBehavior.getName(),
      sequenceHorizonSeconds: 120,
      sequenceLength: this.sequenceLength,
      modelVersionOverride: this.modelVersionOverride,
      selectedCheckpointId: this.selectedCheckpointId,
      requireCheckpointInference: this.requireCheckpointInference,
      antiIdleEnabled: this.antiIdleEnabled,
      antiIdleWaitThreshold: this.antiIdleWaitThreshold,
      passiveWaitStreak: this.passiveWaitStreak,
      antiIdleOverrides: this.antiIdleOverrides,
    };
  }

  setParameters(params: Record<string, unknown>): void {
    if (typeof params.policyEnabled === 'boolean') {
      this.policyEnabled = params.policyEnabled;
    }
    if (typeof params.modelVersionOverride === 'string' && params.modelVersionOverride.trim().length > 0) {
      this.modelVersionOverride = params.modelVersionOverride;
    }
    if (typeof params.requireCheckpointInference === 'boolean') {
      this.requireCheckpointInference = params.requireCheckpointInference;
    }
    if (typeof params.antiIdleEnabled === 'boolean') {
      this.antiIdleEnabled = params.antiIdleEnabled;
    }
    if (typeof params.antiIdleWaitThreshold === 'number' && Number.isFinite(params.antiIdleWaitThreshold)) {
      this.antiIdleWaitThreshold = Math.max(1, Math.floor(params.antiIdleWaitThreshold));
    }
    if (typeof params.selectedCheckpointId === 'string') {
      const normalized = params.selectedCheckpointId.trim();
      this.selectedCheckpointId = normalized.length > 0 ? normalized : null;
    }
    if (params.selectedCheckpointId === null) {
      this.selectedCheckpointId = null;
    }
  }

  private isDecisionLegal(decision: AIDecision, mask: ReturnType<typeof buildLegalActionMask>): boolean {
    const actionTypeIndex = getActionTypeIndex(decision.action);
    if (mask.actionTypeMask[actionTypeIndex] <= 0) return false;

    if (decision.action === 'RECRUIT_UNIT') {
      const parameters = (decision.parameters ?? {}) as Record<string, unknown>;
      const unitIndex = getUnitIndex(typeof parameters.unitType === 'string' ? parameters.unitType : undefined);
      return unitIndex >= 0 && mask.unitMask[unitIndex] > 0;
    }

    if (decision.action === 'BUY_TURRET_ENGINE') {
      const parameters = (decision.parameters ?? {}) as Record<string, unknown>;
      const turretIndex = getTurretIndex(typeof parameters.turretId === 'string' ? parameters.turretId : undefined);
      const slotIndex =
        typeof parameters.slotIndex === 'number' ? Math.max(0, Math.floor(parameters.slotIndex)) : -1;
      if (turretIndex < 0 || slotIndex < 0) return false;
      return mask.turretMask[turretIndex] > 0 && mask.buySlotMask[slotIndex] > 0;
    }

    if (decision.action === 'SELL_TURRET_ENGINE') {
      const parameters = (decision.parameters ?? {}) as Record<string, unknown>;
      const slotIndex =
        typeof parameters.slotIndex === 'number' ? Math.max(0, Math.floor(parameters.slotIndex)) : -1;
      if (slotIndex < 0) return false;
      return mask.sellSlotMask[slotIndex] > 0;
    }

    return true;
  }

  private hasSelectedCheckpoint(): boolean {
    return typeof this.selectedCheckpointId === 'string' && this.selectedCheckpointId.trim().length > 0;
  }

  private hasLegalNonWaitAction(mask: ReturnType<typeof buildLegalActionMask>): boolean {
    const waitIndex = getActionTypeIndex('WAIT');
    return mask.actionTypeMask.some((value, index) => index !== waitIndex && value > 0);
  }

  private buildStrictCheckpointFailureReason(baseReason: string): string {
    const metadata = this.policy.getMetadata?.() ?? {};
    const remote = (metadata as Record<string, unknown>).remote as Record<string, unknown> | undefined;
    const remoteFailure =
      typeof remote?.lastFailureReason === 'string' && remote.lastFailureReason.trim().length > 0
        ? remote.lastFailureReason.trim()
        : '';
    const checkpointId = this.selectedCheckpointId;
    const reason = remoteFailure || baseReason || 'unknown inference failure';
    if (!checkpointId) {
      return `[ML checkpoint required] checkpoint not selected: ${reason}`;
    }
    return `[ML checkpoint required] ${checkpointId} not inferred: ${reason}`;
  }
}
