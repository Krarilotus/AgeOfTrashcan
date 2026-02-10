import type { AIDecision, GameStateSnapshot } from '../AIBehavior';

export type MLHistoryActor = 'PLAYER' | 'ENEMY' | 'SYSTEM';

export interface MLHistoryToken {
  actor: MLHistoryActor;
  actionLabel: string;
  unitId?: string;
  turretId?: string;
  slotIndex?: number;
  timestampSec: number;
  deltaSec: number;
  rewardDelta: number;
  damageDelta: number;
}

interface MLHistoryBufferOptions {
  horizonSeconds?: number;
}

export class MLHistoryBuffer {
  private readonly horizonSeconds: number;
  private tokens: MLHistoryToken[] = [];
  private lastObservedState: GameStateSnapshot | null = null;

  constructor(options: MLHistoryBufferOptions = {}) {
    this.horizonSeconds = options.horizonSeconds ?? 120;
  }

  reset(): void {
    this.tokens = [];
    this.lastObservedState = null;
  }

  ingestState(state: GameStateSnapshot): void {
    const previous = this.lastObservedState;
    if (!previous) {
      this.lastObservedState = state;
      return;
    }

    const deltaSec = Math.max(0, state.gameTime - previous.gameTime);
    const enemyBaseDamage = Math.max(0, previous.enemyBaseHealth - state.enemyBaseHealth);
    const playerBaseDamage = Math.max(0, previous.playerBaseHealth - state.playerBaseHealth);
    const playerUnitDelta = state.playerUnitCount - previous.playerUnitCount;
    const enemyUnitDelta = state.enemyUnitCount - previous.enemyUnitCount;

    if (enemyBaseDamage > 0) {
      this.pushToken({
        actor: 'PLAYER',
        actionLabel: 'INFERRED_DAMAGE',
        timestampSec: state.gameTime,
        deltaSec,
        rewardDelta: -enemyBaseDamage / 100,
        damageDelta: enemyBaseDamage,
      });
    }

    if (playerBaseDamage > 0) {
      this.pushToken({
        actor: 'ENEMY',
        actionLabel: 'INFERRED_DAMAGE',
        timestampSec: state.gameTime,
        deltaSec,
        rewardDelta: playerBaseDamage / 100,
        damageDelta: playerBaseDamage,
      });
    }

    if (playerUnitDelta !== 0) {
      this.pushToken({
        actor: playerUnitDelta < 0 ? 'ENEMY' : 'PLAYER',
        actionLabel: 'INFERRED_UNIT_DELTA',
        timestampSec: state.gameTime,
        deltaSec,
        rewardDelta: playerUnitDelta < 0 ? Math.abs(playerUnitDelta) * 0.1 : -Math.abs(playerUnitDelta) * 0.1,
        damageDelta: 0,
      });
    }

    if (enemyUnitDelta !== 0) {
      this.pushToken({
        actor: enemyUnitDelta < 0 ? 'PLAYER' : 'ENEMY',
        actionLabel: 'INFERRED_UNIT_DELTA',
        timestampSec: state.gameTime,
        deltaSec,
        rewardDelta: enemyUnitDelta < 0 ? -Math.abs(enemyUnitDelta) * 0.1 : Math.abs(enemyUnitDelta) * 0.1,
        damageDelta: 0,
      });
    }

    this.lastObservedState = state;
    this.prune(state.gameTime);
  }

  recordDecision(state: GameStateSnapshot, decision: AIDecision, rewardDelta: number = 0): void {
    const parameters = (decision.parameters ?? {}) as Record<string, unknown>;
    this.pushToken({
      actor: 'ENEMY',
      actionLabel: decision.action,
      unitId: typeof parameters.unitType === 'string' ? parameters.unitType : undefined,
      turretId: typeof parameters.turretId === 'string' ? parameters.turretId : undefined,
      slotIndex: typeof parameters.slotIndex === 'number' ? parameters.slotIndex : undefined,
      timestampSec: state.gameTime,
      deltaSec:
        this.tokens.length > 0 ? Math.max(0, state.gameTime - this.tokens[this.tokens.length - 1].timestampSec) : 0,
      rewardDelta,
      damageDelta: 0,
    });
    this.prune(state.gameTime);
  }

  getRecentTokens(): MLHistoryToken[] {
    return [...this.tokens];
  }

  private pushToken(token: MLHistoryToken): void {
    this.tokens.push(token);
  }

  private prune(currentTimeSec: number): void {
    const minTimestamp = currentTimeSec - this.horizonSeconds;
    if (minTimestamp <= 0) return;
    this.tokens = this.tokens.filter((token) => token.timestampSec >= minTimestamp);
  }
}
