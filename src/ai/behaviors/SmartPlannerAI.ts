import {
  IAIBehavior,
  GameStateSnapshot,
  AIDecision,
  ThreatLevel,
  StrategicState,
  AIBehaviorUtils,
} from '../AIBehavior';
import { AIPersonality } from '../../config/aiConfig';
import { UNIT_DEFS, UnitDef, getUnitsForAge } from '../../config/units';
import { getManaCost } from '../../config/gameBalance';
import {
  estimateEngineDps,
  getTurretEngineDef,
  getTurretEnginesForAge,
  getTurretSlotUnlockCost,
  TurretEngineDef,
} from '../../config/turrets';

type GoalId = 'SURVIVE' | 'STABILIZE' | 'PRESS' | 'TECH';
type CostKind = 'unit' | 'turret_upgrade' | 'turret_engine';

interface StageRow {
  stage: string;
  status: 'info' | 'candidate' | 'selected' | 'skipped';
  detail: string;
  action?: string;
}

interface GoalScore {
  goal: GoalId;
  score: number;
  reason: string;
}

interface Candidate {
  goal: GoalId;
  stage: string;
  utility: number;
  risk: number;
  decision: AIDecision;
  detail: string;
}

interface RoleWeights {
  frontline: number;
  ranged: number;
  support: number;
  siege: number;
  tank: number;
}

interface UnitArchetype {
  unitId: string;
  count: number;
  totalHealth: number;
  avgHealth: number;
  avgRange: number;
  avgSpeed: number;
  avgPosition: number;
  totalDps: number;
  totalBurstDps: number;
  totalAoeDps: number;
  frontlineWeight: number;
  rangedWeight: number;
  supportWeight: number;
  siegeWeight: number;
  tankWeight: number;
  weightedThreat: number;
}

interface ArmySnapshot {
  unitCount: number;
  totalHealth: number;
  averageHealth: number;
  sustainedDps: number;
  burstDps: number;
  aoeDps: number;
  combatPower: number;
  frontlineShare: number;
  rangedShare: number;
  supportShare: number;
  siegeShare: number;
  tankShare: number;
  averageRange: number;
  averageSpeed: number;
  proximityThreat: number;
  centerX: number;
  spread: number;
  isSwarm: boolean;
  isHeavy: boolean;
  rangedMass: boolean;
  archetypes: UnitArchetype[];
}

interface CompositionTarget {
  frontline: number;
  ranged: number;
  support: number;
  siege: number;
}

interface CompositionNeeds {
  frontline: number;
  ranged: number;
  support: number;
  siege: number;
}

interface PlannerContext {
  threatLevel: ThreatLevel;
  strategicState: StrategicState;
  ownArmy: ArmySnapshot;
  enemyArmy: ArmySnapshot;
  baseHealthRatio: number;
  playerBaseHealthRatio: number;
  baseRisk: number;
  offensiveWindow: number;
  powerAdvantage: number;
  formationStability: number;
  compositionTarget: CompositionTarget;
  compositionNeeds: CompositionNeeds;
  enemyComboThreat: number;
  immediatePressure: number;
  laneOpportunity: number;
  ageLead: number;
}

interface ReservePolicy {
  warchest: number;
  reserveTarget: number;
  protectedReserve: number;
  releasedReserve: number;
  spendableGold: number;
  digRatio: number;
  reason: string;
}

interface UnitProfile {
  unitId: string;
  cost: number;
  manaCost: number;
  trainingSec: number;
  health: number;
  dps: number;
  burstDps: number;
  aoeDps: number;
  range: number;
  speed: number;
  frontlineWeight: number;
  rangedWeight: number;
  supportWeight: number;
  siegeWeight: number;
  tankWeight: number;
  combatValue: number;
}

interface UnitCandidateScore {
  unitId: string;
  utility: number;
  risk: number;
  detail: string;
}

interface TurretOption {
  decision: AIDecision;
  utility: number;
  risk: number;
  detail: string;
}

interface PairContext {
  rangedBacklinePair: boolean;
  heavyPair: boolean;
  swarmPair: boolean;
}

const AGE_FORMATION_TEMPLATES: Record<number, CompositionTarget> = {
  1: { frontline: 0.58, ranged: 0.37, support: 0.0, siege: 0.05 },
  2: { frontline: 0.52, ranged: 0.38, support: 0.0, siege: 0.1 },
  3: { frontline: 0.44, ranged: 0.36, support: 0.1, siege: 0.1 },
  4: { frontline: 0.44, ranged: 0.28, support: 0.12, siege: 0.16 },
  5: { frontline: 0.41, ranged: 0.31, support: 0.14, siege: 0.14 },
  6: { frontline: 0.38, ranged: 0.34, support: 0.13, siege: 0.15 },
};

export class SmartPlannerAI implements IAIBehavior {
  private name = 'SmartPlannerAI';
  private lastAgeUpTime = 0;
  private pendingTurretReplacement: { slotIndex: number; turretId: string } | null = null;
  private activeGoal: GoalId = 'STABILIZE';
  private debugData: Record<string, unknown> = {};

  getName(): string {
    return this.name;
  }

  reset(): void {
    this.lastAgeUpTime = 0;
    this.pendingTurretReplacement = null;
    this.activeGoal = 'STABILIZE';
    this.debugData = {};
  }

  getParameters(): Record<string, unknown> {
    return {
      ...this.debugData,
      lastAgeUpTime: this.lastAgeUpTime,
      activeGoal: this.activeGoal,
      pendingTurretReplacement: this.pendingTurretReplacement,
    };
  }

  setParameters(params: Record<string, unknown>): void {
    const maybeAgeUp = params.lastAgeUpTime;
    if (typeof maybeAgeUp === 'number') this.lastAgeUpTime = maybeAgeUp;

    const maybeGoal = params.activeGoal;
    if (maybeGoal === 'SURVIVE' || maybeGoal === 'STABILIZE' || maybeGoal === 'PRESS' || maybeGoal === 'TECH') {
      this.activeGoal = maybeGoal;
    }

    const pending = params.pendingTurretReplacement as { slotIndex: number; turretId: string } | undefined;
    if (pending && typeof pending.slotIndex === 'number' && typeof pending.turretId === 'string') {
      this.pendingTurretReplacement = pending;
    }
  }

  decide(state: GameStateSnapshot, _personality: AIPersonality): AIDecision {
    const stages: StageRow[] = [];
    const pushStage = (stage: string, status: StageRow['status'], detail: string, action?: string) => {
      stages.push({ stage, status, detail, action });
    };

    const ctx = this.buildContext(state);
    const reserve = this.computeReservePolicy(state, ctx);
    const goalScores = this.scoreGoals(state, ctx);
    const goalScoreMap = new Map(goalScores.map((g) => [g.goal, g.score]));

    pushStage(
      '1) Situation',
      'info',
      [
        `Threat=${ctx.threatLevel}`,
        `BaseRisk=${ctx.baseRisk.toFixed(2)}`,
        `PowerAdv=${ctx.powerAdvantage.toFixed(2)}`,
        `Formation=${ctx.formationStability.toFixed(2)}`,
        `Spendable=${Math.floor(reserve.spendableGold)}g`,
        `Reserve=${Math.floor(reserve.protectedReserve)}g`,
      ].join(' | ')
    );

    pushStage(
      '2) Goals',
      'info',
      goalScores.map((g) => `${g.goal}:${g.score.toFixed(1)}`).join(' | ')
    );

    const candidates: Candidate[] = [];
    for (const goal of goalScores) {
      this.addGoalCandidates(goal.goal, state, ctx, reserve, candidates);
    }

    if (candidates.length === 0) {
      const fallback = this.pickEmergencyFallback(state, state.enemyGold, ctx);
      if (fallback) {
        const decision: AIDecision = {
          action: 'RECRUIT_UNIT',
          parameters: { unitType: fallback, priority: 'emergency' },
          reasoning: `Fallback recruit ${fallback} during planner dead-end`,
        };
        this.commitDecision(state, decision, stages, reserve, goalScores, ctx, 'Fallback anti-passive recruit');
        return decision;
      }

      const waitDecision: AIDecision = {
        action: 'WAIT',
        reasoning: 'No high-value affordable action this tick',
      };
      this.commitDecision(state, waitDecision, stages, reserve, goalScores, ctx, 'No feasible candidate');
      return waitDecision;
    }

    for (const c of candidates) {
      pushStage(
        `${c.goal} -> ${c.stage}`,
        'candidate',
        `${c.detail} | U=${c.utility.toFixed(1)} R=${c.risk.toFixed(1)}`,
        c.decision.action
      );
    }

    candidates.sort((a, b) => {
      const aGoal = goalScoreMap.get(a.goal) ?? 0;
      const bGoal = goalScoreMap.get(b.goal) ?? 0;
      const aScore = a.utility - a.risk * 0.62 + aGoal * 0.16;
      const bScore = b.utility - b.risk * 0.62 + bGoal * 0.16;
      return bScore - aScore;
    });

    const chosen = candidates[0];
    this.activeGoal = chosen.goal;
    pushStage(`${chosen.goal} -> ${chosen.stage}`, 'selected', chosen.detail, chosen.decision.action);
    this.commitDecision(state, chosen.decision, stages, reserve, goalScores, ctx, chosen.detail);
    return chosen.decision;
  }

  private commitDecision(
    state: GameStateSnapshot,
    decision: AIDecision,
    decisionStages: StageRow[],
    reserve: ReservePolicy,
    goals: GoalScore[],
    ctx: PlannerContext,
    summary: string
  ): void {
    if (decision.action === 'AGE_UP') {
      this.lastAgeUpTime = state.gameTime;
    }

    if (decision.action === 'BUY_TURRET_ENGINE') {
      this.pendingTurretReplacement = null;
    }

    const nextSlotsTarget = this.getTargetSlotsByAge(state.enemyAge, state.enemyMana, state.gameTime);
    this.debugData = {
      activeGoal: this.activeGoal,
      goals,
      reservePolicy: reserve,
      context: {
        baseRisk: Number(ctx.baseRisk.toFixed(3)),
        offensiveWindow: Number(ctx.offensiveWindow.toFixed(3)),
        powerAdvantage: Number(ctx.powerAdvantage.toFixed(3)),
        formationStability: Number(ctx.formationStability.toFixed(3)),
        enemyComboThreat: Number(ctx.enemyComboThreat.toFixed(2)),
      },
      compositionTarget: ctx.compositionTarget,
      compositionNeeds: ctx.compositionNeeds,
      ownArmy: {
        units: ctx.ownArmy.unitCount,
        dps: Math.round(ctx.ownArmy.sustainedDps),
        ehp: Math.round(ctx.ownArmy.totalHealth),
      },
      enemyArmy: {
        units: ctx.enemyArmy.unitCount,
        dps: Math.round(ctx.enemyArmy.sustainedDps),
        ehp: Math.round(ctx.enemyArmy.totalHealth),
      },
      turretPlan: {
        currentSlots: state.enemyTurretSlotsUnlocked,
        targetSlots: nextSlotsTarget,
        pendingReplacement: this.pendingTurretReplacement,
      },
      decisionStages,
      nextAction: decision.action,
      nextReason: decision.reasoning,
      decisionOutcome: {
        action: decision.action,
        reason: decision.reasoning ?? summary,
      },
    };
  }

  private buildContext(state: GameStateSnapshot): PlannerContext {
    const threat = AIBehaviorUtils.assessThreat(state);

    const ownArmy = this.analyzeArmy(state.enemyUnits, state.playerBaseX, state.enemyBaseX);
    const enemyArmy = this.analyzeArmy(state.playerUnits, state.enemyBaseX, state.playerBaseX);

    const baseHealthRatio = state.enemyBaseHealth / Math.max(1, state.enemyBaseMaxHealth);
    const playerBaseHealthRatio = state.playerBaseHealth / Math.max(1, state.playerBaseMaxHealth);

    const ownDefensePower = ownArmy.sustainedDps + ownArmy.burstDps * 0.45 + state.enemyTurretDps * 1.05 + ownArmy.totalHealth * 0.04;
    const incomingThreatPower = enemyArmy.proximityThreat + enemyArmy.sustainedDps * 7 + enemyArmy.burstDps * 5 + enemyArmy.aoeDps * 3 + state.playerMana * 0.11;

    const baseRisk = this.clamp(
      this.sigmoid((incomingThreatPower - ownDefensePower) / 650) * 0.75 +
        (1 - baseHealthRatio) * 0.35 +
        (state.playerUnitsNearEnemyBase / Math.max(6, state.enemyUnitCount + 1)) * 0.3,
      0,
      1
    );

    const offensivePower = ownArmy.sustainedDps * 8 + ownArmy.burstDps * 4 + ownArmy.aoeDps * 2.8 + ownArmy.totalHealth * 0.03;
    const enemyDefensePower = enemyArmy.sustainedDps * 6 + enemyArmy.burstDps * 3.5 + state.playerTurretDps * 1.1 + enemyArmy.totalHealth * 0.04;
    const offensiveWindow = this.clamp(
      this.sigmoid((offensivePower - enemyDefensePower) / 900) * 0.72 +
        (1 - playerBaseHealthRatio) * 0.2 +
        (state.enemyUnitsNearPlayerBase / Math.max(6, state.playerUnitCount + 1)) * 0.3 -
        baseRisk * 0.28,
      0,
      1
    );

    const compositionTarget = this.getAdjustedCompositionTarget(state.enemyAge, enemyArmy, ownArmy, baseRisk, offensiveWindow);
    const compositionNeeds = this.computeCompositionNeeds(ownArmy, compositionTarget, enemyArmy);

    const formationStability = this.computeFormationStability(state.enemyUnits, state.playerBaseX);

    const ownPower = ownArmy.combatPower + state.enemyTurretDps * 5;
    const enemyPower = enemyArmy.combatPower + state.playerTurretDps * 5;
    const powerAdvantage = (ownPower - enemyPower) / Math.max(220, ownPower + enemyPower);

    return {
      threatLevel: threat,
      strategicState: AIBehaviorUtils.getStrategicState(state, threat),
      ownArmy,
      enemyArmy,
      baseHealthRatio,
      playerBaseHealthRatio,
      baseRisk,
      offensiveWindow,
      powerAdvantage,
      formationStability,
      compositionTarget,
      compositionNeeds,
      enemyComboThreat: this.evaluateArchetypeCombinationThreat(enemyArmy.archetypes),
      immediatePressure: state.playerUnitsNearEnemyBase,
      laneOpportunity: state.enemyUnitsNearPlayerBase,
      ageLead: state.enemyAge - state.playerAge,
    };
  }

  private analyzeArmy(
    units: GameStateSnapshot['enemyUnits'] | GameStateSnapshot['playerUnits'],
    targetBaseX: number,
    homeBaseX: number
  ): ArmySnapshot {
    if (units.length === 0) {
      return {
        unitCount: 0,
        totalHealth: 0,
        averageHealth: 0,
        sustainedDps: 0,
        burstDps: 0,
        aoeDps: 0,
        combatPower: 0,
        frontlineShare: 0,
        rangedShare: 0,
        supportShare: 0,
        siegeShare: 0,
        tankShare: 0,
        averageRange: 0,
        averageSpeed: 0,
        proximityThreat: 0,
        centerX: homeBaseX,
        spread: 0,
        isSwarm: false,
        isHeavy: false,
        rangedMass: false,
        archetypes: [],
      };
    }

    type MutableArch = {
      unitId: string;
      count: number;
      totalHealth: number;
      totalRange: number;
      totalSpeed: number;
      totalPosition: number;
      totalDps: number;
      totalBurstDps: number;
      totalAoeDps: number;
      frontlineWeight: number;
      rangedWeight: number;
      supportWeight: number;
      siegeWeight: number;
      tankWeight: number;
      weightedThreat: number;
    };

    const byType = new Map<string, MutableArch>();

    let totalHealth = 0;
    let sustainedDps = 0;
    let burstDps = 0;
    let aoeDps = 0;
    let weightedRange = 0;
    let weightedSpeed = 0;
    let totalFrontline = 0;
    let totalRanged = 0;
    let totalSupport = 0;
    let totalSiege = 0;
    let totalTank = 0;
    let proximityThreat = 0;
    let centerXAccumulator = 0;

    for (const unit of units) {
      const def = UNIT_DEFS[unit.unitId];
      const dps = this.estimateUnitDps(def, unit.damage);
      const unitBurst = this.estimateUnitBurstDps(def, unit.damage);
      const unitAoe = this.estimateUnitAoeDps(def, unit.damage);
      const speed = this.getUnitSpeed(def);
      const roles = this.getUnitRoleWeights(def, unit);

      totalHealth += unit.health;
      sustainedDps += dps;
      burstDps += unitBurst;
      aoeDps += unitAoe;
      weightedRange += unit.range;
      weightedSpeed += speed;
      totalFrontline += roles.frontline;
      totalRanged += roles.ranged;
      totalSupport += roles.support;
      totalSiege += roles.siege;
      totalTank += roles.tank;
      centerXAccumulator += unit.position;

      const distToTarget = Math.abs(unit.position - targetBaseX);
      const etaToTarget = Math.max(0, distToTarget - unit.range) / Math.max(0.5, speed);
      const imminence = this.clamp(1.4 - etaToTarget / 10, 0.15, 1.4);
      const threatValue = (dps * 10 + unitBurst * 6 + unitAoe * 4 + unit.health * 0.15) * imminence;
      proximityThreat += threatValue;

      let bucket = byType.get(unit.unitId);
      if (!bucket) {
        bucket = {
          unitId: unit.unitId,
          count: 0,
          totalHealth: 0,
          totalRange: 0,
          totalSpeed: 0,
          totalPosition: 0,
          totalDps: 0,
          totalBurstDps: 0,
          totalAoeDps: 0,
          frontlineWeight: 0,
          rangedWeight: 0,
          supportWeight: 0,
          siegeWeight: 0,
          tankWeight: 0,
          weightedThreat: 0,
        };
        byType.set(unit.unitId, bucket);
      }

      bucket.count += 1;
      bucket.totalHealth += unit.health;
      bucket.totalRange += unit.range;
      bucket.totalSpeed += speed;
      bucket.totalPosition += unit.position;
      bucket.totalDps += dps;
      bucket.totalBurstDps += unitBurst;
      bucket.totalAoeDps += unitAoe;
      bucket.frontlineWeight += roles.frontline;
      bucket.rangedWeight += roles.ranged;
      bucket.supportWeight += roles.support;
      bucket.siegeWeight += roles.siege;
      bucket.tankWeight += roles.tank;
      bucket.weightedThreat += threatValue;
    }

    const centerX = centerXAccumulator / units.length;
    const spread = Math.sqrt(
      units.reduce((acc, u) => {
        const d = u.position - centerX;
        return acc + d * d;
      }, 0) / units.length
    );

    const archetypes: UnitArchetype[] = Array.from(byType.values())
      .map((b) => ({
        unitId: b.unitId,
        count: b.count,
        totalHealth: b.totalHealth,
        avgHealth: b.totalHealth / b.count,
        avgRange: b.totalRange / b.count,
        avgSpeed: b.totalSpeed / b.count,
        avgPosition: b.totalPosition / b.count,
        totalDps: b.totalDps,
        totalBurstDps: b.totalBurstDps,
        totalAoeDps: b.totalAoeDps,
        frontlineWeight: b.frontlineWeight / b.count,
        rangedWeight: b.rangedWeight / b.count,
        supportWeight: b.supportWeight / b.count,
        siegeWeight: b.siegeWeight / b.count,
        tankWeight: b.tankWeight / b.count,
        weightedThreat: b.weightedThreat,
      }))
      .sort((a, b) => b.weightedThreat - a.weightedThreat);

    const averageHealth = totalHealth / units.length;

    const combatPower =
      sustainedDps * 10 +
      burstDps * 4 +
      aoeDps * 3 +
      totalHealth * 0.28 +
      (weightedRange / units.length) * 40 +
      (totalFrontline / units.length) * 150;

    const rangedShare = totalRanged / units.length;
    const frontlineShare = totalFrontline / units.length;

    return {
      unitCount: units.length,
      totalHealth,
      averageHealth,
      sustainedDps,
      burstDps,
      aoeDps,
      combatPower,
      frontlineShare,
      rangedShare,
      supportShare: totalSupport / units.length,
      siegeShare: totalSiege / units.length,
      tankShare: totalTank / units.length,
      averageRange: weightedRange / units.length,
      averageSpeed: weightedSpeed / units.length,
      proximityThreat,
      centerX,
      spread,
      isSwarm: units.length >= 5 && averageHealth <= 260,
      isHeavy: averageHealth >= 340 || totalTank / units.length >= 0.45,
      rangedMass: units.length >= 4 && rangedShare >= 0.55,
      archetypes,
    };
  }

  private scoreGoals(state: GameStateSnapshot, ctx: PlannerContext): GoalScore[] {
    const survive =
      ctx.baseRisk * 125 +
      Math.max(0, -ctx.powerAdvantage) * 45 +
      (ctx.enemyComboThreat * 0.12) +
      (ctx.threatLevel === ThreatLevel.CRITICAL ? 34 : ctx.threatLevel === ThreatLevel.HIGH ? 18 : 0);

    const stabilize =
      44 +
      (1 - ctx.formationStability) * 32 +
      Math.max(0, 0.25 - Math.abs(ctx.powerAdvantage)) * 90 +
      (ctx.enemyArmy.isSwarm ? 8 : 0) +
      (ctx.enemyArmy.rangedMass ? 8 : 0);

    const press =
      ctx.offensiveWindow * 108 +
      Math.max(0, ctx.powerAdvantage) * 55 +
      (1 - ctx.playerBaseHealthRatio) * 18 +
      (ctx.ageLead > 0 ? 10 : 0) -
      ctx.baseRisk * 35;

    const canAge = state.enemyAge < 6 && state.enemyGold >= state.enemyAgeCost;
    const tech =
      (state.enemyAge < 6 ? 26 : 0) +
      (state.enemyAge < state.playerAge ? 24 : 0) +
      (canAge ? 19 : 0) +
      (ctx.offensiveWindow > 0.6 ? 8 : 0) -
      ctx.baseRisk * 46;

    const rows: GoalScore[] = [
      { goal: 'SURVIVE', score: survive, reason: 'Immediate base safety and anti-burst stabilization' },
      { goal: 'STABILIZE', score: stabilize, reason: 'Fix formation and maintain efficient lane parity' },
      { goal: 'PRESS', score: press, reason: 'Exploit tempo edge and pressure enemy base windows' },
      { goal: 'TECH', score: tech, reason: 'Secure age and mana infrastructure while stable' },
    ];

    rows.sort((a, b) => b.score - a.score);
    return rows;
  }

  private addGoalCandidates(
    goal: GoalId,
    state: GameStateSnapshot,
    ctx: PlannerContext,
    reserve: ReservePolicy,
    candidates: Candidate[]
  ): void {
    if (goal === 'SURVIVE') {
      this.addSurvivalCandidates(state, ctx, reserve, candidates);
      return;
    }
    if (goal === 'PRESS') {
      this.addPressCandidates(state, ctx, reserve, candidates);
      return;
    }
    if (goal === 'TECH') {
      this.addTechCandidates(state, ctx, reserve, candidates);
      return;
    }
    this.addStabilizeCandidates(state, ctx, reserve, candidates);
  }

  private addSurvivalCandidates(
    state: GameStateSnapshot,
    ctx: PlannerContext,
    reserve: ReservePolicy,
    candidates: Candidate[]
  ): void {
    const unitPicks = this.collectUnitCandidates('SURVIVE', state, ctx, reserve.spendableGold, 3);
    for (const pick of unitPicks) {
      candidates.push({
        goal: 'SURVIVE',
        stage: 'Counter-Recruit',
        utility: pick.utility + 6,
        risk: pick.risk,
        detail: pick.detail,
        decision: {
          action: 'RECRUIT_UNIT',
          parameters: { unitType: pick.unitId, priority: 'emergency' },
          reasoning: `Emergency response: ${pick.unitId}`,
        },
      });
    }

    const turretOption = this.planTurretOption(state, reserve.spendableGold, ctx, true);
    if (turretOption) {
      candidates.push({
        goal: 'SURVIVE',
        stage: 'Turret Counterplay',
        utility: turretOption.utility + 8,
        risk: turretOption.risk,
        detail: turretOption.detail,
        decision: turretOption.decision,
      });
    }

    if (state.enemyAge >= 6 && state.enemyMana >= 500 && state.enemyBaseHealth < state.enemyBaseMaxHealth * 0.85 && ctx.baseRisk >= 0.45) {
      candidates.push({
        goal: 'SURVIVE',
        stage: 'Base Sustain',
        utility: 66 + ctx.baseRisk * 18,
        risk: 7,
        detail: 'Spend mana to avoid base collapse under focused enemy burst',
        decision: {
          action: 'REPAIR_BASE',
          reasoning: 'High-pressure lane window; convert mana into immediate HP buffer',
        },
      });
    }
  }

  private addStabilizeCandidates(
    state: GameStateSnapshot,
    ctx: PlannerContext,
    reserve: ReservePolicy,
    candidates: Candidate[]
  ): void {
    const unitPicks = this.collectUnitCandidates('STABILIZE', state, ctx, reserve.spendableGold, 2);
    for (const pick of unitPicks) {
      candidates.push({
        goal: 'STABILIZE',
        stage: 'Formation Recruit',
        utility: pick.utility,
        risk: pick.risk,
        detail: pick.detail,
        decision: {
          action: 'RECRUIT_UNIT',
          parameters: { unitType: pick.unitId, priority: 'normal' },
          reasoning: `Stabilize lane shape with ${pick.unitId}`,
        },
      });
    }

    const turretOption = this.planTurretOption(state, reserve.spendableGold, ctx, false);
    if (turretOption) {
      candidates.push({
        goal: 'STABILIZE',
        stage: 'Turret Efficiency',
        utility: turretOption.utility,
        risk: turretOption.risk,
        detail: turretOption.detail,
        decision: turretOption.decision,
      });
    }

    const manaUpgrade = this.planManaUpgrade(state, reserve.spendableGold, ctx);
    if (manaUpgrade) {
      candidates.push({
        goal: 'STABILIZE',
        stage: 'Mana Infrastructure',
        utility: manaUpgrade.utility,
        risk: manaUpgrade.risk,
        detail: manaUpgrade.detail,
        decision: manaUpgrade.decision,
      });
    }
  }

  private addPressCandidates(
    state: GameStateSnapshot,
    ctx: PlannerContext,
    reserve: ReservePolicy,
    candidates: Candidate[]
  ): void {
    const unitPicks = this.collectUnitCandidates('PRESS', state, ctx, reserve.spendableGold, 2);
    for (const pick of unitPicks) {
      candidates.push({
        goal: 'PRESS',
        stage: 'Pressure Recruit',
        utility: pick.utility + 2,
        risk: pick.risk + 1,
        detail: pick.detail,
        decision: {
          action: 'RECRUIT_UNIT',
          parameters: { unitType: pick.unitId, priority: 'high' },
          reasoning: `Pressure window exploit via ${pick.unitId}`,
        },
      });
    }

    if (
      state.enemyAge < 6 &&
      state.enemyGold >= state.enemyAgeCost &&
      ctx.baseRisk <= 0.42 &&
      ctx.powerAdvantage >= -0.1 &&
      state.enemyQueueSize <= 2
    ) {
      candidates.push({
        goal: 'PRESS',
        stage: 'Age Spike',
        utility: 70 + ctx.offensiveWindow * 16,
        risk: 11,
        detail: `Advance to Age ${state.enemyAge + 1} for stronger pressure package`,
        decision: {
          action: 'AGE_UP',
          reasoning: `Safe tempo spike: Age ${state.enemyAge} -> ${state.enemyAge + 1}`,
        },
      });
    }
  }

  private addTechCandidates(
    state: GameStateSnapshot,
    ctx: PlannerContext,
    reserve: ReservePolicy,
    candidates: Candidate[]
  ): void {
    if (
      state.enemyAge < 6 &&
      state.enemyGold >= state.enemyAgeCost &&
      ctx.baseRisk <= 0.46 &&
      ctx.immediatePressure <= 1
    ) {
      candidates.push({
        goal: 'TECH',
        stage: 'Age Transition',
        utility: 78 + (ctx.ageLead < 0 ? 12 : 0),
        risk: 10,
        detail: `Age up now while lane pressure is controlled`,
        decision: {
          action: 'AGE_UP',
          reasoning: `Tech progression: age ${state.enemyAge} -> ${state.enemyAge + 1}`,
        },
      });
    }

    const manaUpgrade = this.planManaUpgrade(state, reserve.spendableGold, ctx);
    if (manaUpgrade) {
      candidates.push({
        goal: 'TECH',
        stage: 'Mana Scaling',
        utility: manaUpgrade.utility + 5,
        risk: manaUpgrade.risk,
        detail: manaUpgrade.detail,
        decision: manaUpgrade.decision,
      });
    }

    const turretOption = this.planTurretOption(state, reserve.spendableGold, ctx, false);
    if (turretOption) {
      candidates.push({
        goal: 'TECH',
        stage: 'Defensive Infrastructure',
        utility: turretOption.utility - 2,
        risk: turretOption.risk,
        detail: turretOption.detail,
        decision: turretOption.decision,
      });
    }

    const protectiveUnit = this.collectUnitCandidates('SURVIVE', state, ctx, reserve.spendableGold, 1)[0];
    if (protectiveUnit && ctx.baseRisk >= 0.35) {
      candidates.push({
        goal: 'TECH',
        stage: 'Tech Cover Unit',
        utility: protectiveUnit.utility,
        risk: protectiveUnit.risk,
        detail: `Cover tech timing with ${protectiveUnit.unitId}`,
        decision: {
          action: 'RECRUIT_UNIT',
          parameters: { unitType: protectiveUnit.unitId, priority: 'high' },
          reasoning: `Tech cover recruit: ${protectiveUnit.unitId}`,
        },
      });
    }
  }

  private collectUnitCandidates(
    goal: GoalId,
    state: GameStateSnapshot,
    ctx: PlannerContext,
    spendableGold: number,
    maxCount: number
  ): UnitCandidateScore[] {
    if (state.enemyQueueSize >= 5) return [];

    const units = getUnitsForAge(state.enemyAge);
    const picks: UnitCandidateScore[] = [];

    for (const [unitId, def] of Object.entries(units)) {
      if (unitId === 'void_reaper') continue;
      const score = this.evaluateUnitCandidate(goal, unitId, def, state, ctx, spendableGold);
      if (score) picks.push(score);
    }

    picks.sort((a, b) => (b.utility - b.risk * 0.58) - (a.utility - a.risk * 0.58));
    return picks.slice(0, maxCount);
  }

  private evaluateUnitCandidate(
    goal: GoalId,
    unitId: string,
    def: UnitDef,
    state: GameStateSnapshot,
    ctx: PlannerContext,
    spendableGold: number
  ): UnitCandidateScore | null {
    const cost = this.getDiscountedCost(def.cost, state.difficulty, 'unit');
    const manaCost = def.manaCost ?? 0;
    if (cost > spendableGold) return null;
    if (manaCost > state.enemyMana) return null;

    const profile = this.buildUnitProfile(unitId, def, state.difficulty);
    const counterRaw = this.evaluateAgainstEnemyCombinations(profile, ctx.enemyArmy);
    const counterNorm = this.clamp((counterRaw + 1.1) / 2.2, 0, 1.25);
    const survivability = this.evaluateCandidateSurvivability(profile, ctx.enemyArmy);

    const totalNeed =
      ctx.compositionNeeds.frontline +
      ctx.compositionNeeds.ranged +
      ctx.compositionNeeds.support +
      ctx.compositionNeeds.siege +
      0.12;

    const formationFitRaw =
      profile.frontlineWeight * ctx.compositionNeeds.frontline +
      profile.rangedWeight * ctx.compositionNeeds.ranged +
      profile.supportWeight * ctx.compositionNeeds.support +
      profile.siegeWeight * ctx.compositionNeeds.siege;
    const formationFit = this.clamp(formationFitRaw / totalNeed, 0, 1.3);

    const offenseRaw =
      profile.dps * 1.1 +
      profile.burstDps * 0.45 +
      profile.aoeDps * (ctx.enemyArmy.isSwarm ? 0.55 : 0.3) +
      profile.range * 2.2 +
      profile.speed * 1.4 +
      profile.siegeWeight * 18;
    const offenseNorm = this.clamp(offenseRaw / 180, 0, 1.3);

    const defenseRaw =
      profile.health * 0.08 +
      profile.frontlineWeight * 34 +
      profile.tankWeight * 26 +
      profile.range * 1.2 +
      counterNorm * 22;
    const defenseNorm = this.clamp(defenseRaw / 130, 0, 1.3);

    const timingNorm = this.clamp(1.2 - profile.trainingSec / 9 - ctx.baseRisk * (profile.trainingSec / 12), 0.35, 1.2);

    const economyRaw = profile.combatValue / Math.max(1, cost + manaCost * 0.7);
    const economyNorm = this.clamp(economyRaw / 3.6, 0, 1.25);

    let utility = 0;
    if (goal === 'SURVIVE') {
      utility = 48 + defenseNorm * 34 + survivability * 20 + counterNorm * 14 + formationFit * 11 + timingNorm * 8;
    } else if (goal === 'STABILIZE') {
      utility = 44 + defenseNorm * 22 + offenseNorm * 14 + formationFit * 18 + economyNorm * 12 + counterNorm * 10 + timingNorm * 8;
    } else if (goal === 'PRESS') {
      utility = 42 + offenseNorm * 30 + counterNorm * 16 + formationFit * 11 + economyNorm * 10 + timingNorm * 8;
    } else {
      utility = 36 + economyNorm * 24 + defenseNorm * 14 + formationFit * 14 + counterNorm * 8 + timingNorm * 7;
    }

    let risk = 4;
    if (ctx.baseRisk > 0.55 && profile.frontlineWeight < 0.35) risk += 16;
    if (ctx.enemyArmy.rangedMass && profile.range < 2.5 && profile.speed < 5.5 && profile.health < 200) risk += 14;
    if (profile.manaCost > 0 && state.enemyMana < profile.manaCost + 25) risk += 7;
    if (profile.trainingSec > 5.5 && ctx.baseRisk > 0.62) risk += 11;
    if (state.enemyQueueSize >= 4) risk += 8;

    const detail =
      `${unitId} cost=${cost}/${manaCost} ` +
      `counter=${counterRaw.toFixed(2)} ` +
      `def=${defenseNorm.toFixed(2)} off=${offenseNorm.toFixed(2)} ` +
      `form=${formationFit.toFixed(2)} timing=${timingNorm.toFixed(2)}`;

    return {
      unitId,
      utility,
      risk,
      detail,
    };
  }

  private buildUnitProfile(unitId: string, def: UnitDef, difficulty: GameStateSnapshot['difficulty']): UnitProfile {
    const dummyStateUnit = {
      unitId,
      health: def.health,
      maxHealth: def.health,
      position: 0,
      damage: def.damage,
      range: def.range ?? 1,
    };

    const roles = this.getUnitRoleWeights(def, dummyStateUnit);
    const cost = this.getDiscountedCost(def.cost, difficulty, 'unit');

    const dps = this.estimateUnitDps(def, def.damage);
    const burstDps = this.estimateUnitBurstDps(def, def.damage);
    const aoeDps = this.estimateUnitAoeDps(def, def.damage);

    return {
      unitId,
      cost,
      manaCost: def.manaCost ?? 0,
      trainingSec: Math.max(0.6, (def.trainingMs ?? 1800) / 1000),
      health: def.health,
      dps,
      burstDps,
      aoeDps,
      range: def.range ?? 1,
      speed: this.getUnitSpeed(def),
      frontlineWeight: roles.frontline,
      rangedWeight: roles.ranged,
      supportWeight: roles.support,
      siegeWeight: roles.siege,
      tankWeight: roles.tank,
      combatValue: dps * 9 + burstDps * 3 + aoeDps * 2 + def.health * 0.18,
    };
  }
