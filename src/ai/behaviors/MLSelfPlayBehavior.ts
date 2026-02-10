import type { AIDecision, GameStateSnapshot, IAIBehavior } from '../AIBehavior';
import type { AIPersonality } from '../../config/aiConfig';
import { SmartPlannerAI } from './SmartPlannerAI';
import { getActionTypeIndex, getTurretIndex, getUnitIndex } from '../ml/actionCatalog';
import { MLHistoryBuffer } from '../ml/historyBuffer';
import { buildLegalActionMask } from '../ml/legalActionMask';
import { encodeObservation, summarizeActionMask } from '../ml/observationEncoder';
import { decodePolicyOutput, HeuristicBootstrapPolicy, type IMLPolicy } from '../ml/policy';

interface MLSelfPlayBehaviorOptions {
  policy?: IMLPolicy;
  fallbackBehavior?: IAIBehavior;
  policyEnabled?: boolean;
  sequenceLength?: number;
}

interface MLDecisionDebugState {
  policyName: string;
  policyEnabled: boolean;
  modelVersion: string;
  fallbackUsed: boolean;
  lastFallbackReason: string;
  fallbackRate: number;
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
  private totalDecisions = 0;
  private fallbackDecisions = 0;
  private policyDecisions = 0;
  private lastDebug: MLDecisionDebugState;

  constructor(options: MLSelfPlayBehaviorOptions = {}) {
    this.policy = options.policy ?? new HeuristicBootstrapPolicy();
    this.fallbackBehavior = options.fallbackBehavior ?? new SmartPlannerAI();
    this.policyEnabled = options.policyEnabled ?? true;
    this.sequenceLength = options.sequenceLength ?? 240;
    this.lastDebug = {
      policyName: this.policy.getName(),
      policyEnabled: this.policyEnabled,
      modelVersion: 'n/a',
      fallbackUsed: false,
      lastFallbackReason: '',
      fallbackRate: 0,
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
    const observation = encodeObservation(state, this.history.getRecentTokens(), legalMask, {
      sequenceLength: this.sequenceLength,
    });

    let selectedDecision: AIDecision | null = null;
    let fallbackUsed = false;
    let fallbackReason = '';
    let modelVersion = 'n/a';
    let valueEstimate: number | undefined;

    if (this.policyEnabled) {
      const policyOutput = this.policy.infer({
        observation,
        rawState: state,
        deterministic: true,
      });
      if (policyOutput) {
        modelVersion = policyOutput.modelVersion ?? 'unknown';
        valueEstimate = policyOutput.valueEstimate;
        const decoded = decodePolicyOutput(policyOutput, legalMask);
        if (decoded && this.isDecisionLegal(decoded.decision, legalMask)) {
          selectedDecision = {
            ...decoded.decision,
            reasoning: decoded.decision.reasoning ?? `[ML:${this.policy.getName()}] ${decoded.debug.selectedAction}`,
          };
        } else {
          fallbackUsed = true;
          fallbackReason = decoded ? 'policy decision failed legality check' : 'policy decode returned null';
        }
      } else {
        fallbackUsed = true;
        fallbackReason = 'policy returned null output';
      }
    } else {
      fallbackUsed = true;
      fallbackReason = 'policy disabled by configuration';
    }

    if (!selectedDecision) {
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

    if (fallbackUsed) {
      this.fallbackDecisions += 1;
    } else {
      this.policyDecisions += 1;
    }

    this.history.recordDecision(state, selectedDecision);
    this.lastDebug = {
      policyName: this.policy.getName(),
      policyEnabled: this.policyEnabled,
      modelVersion,
      fallbackUsed,
      lastFallbackReason: fallbackReason,
      fallbackRate: this.fallbackDecisions / Math.max(1, this.totalDecisions),
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
    };
  }

  setParameters(params: Record<string, unknown>): void {
    if (typeof params.policyEnabled === 'boolean') {
      this.policyEnabled = params.policyEnabled;
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
}
