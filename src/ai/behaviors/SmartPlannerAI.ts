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
type HtnTaskId = 'THREAT_CONTAIN' | 'FORMATION_RECOVER' | 'PRESS_WINDOW' | 'TECH_TRANSITION';
type ComboTag = 'anti_swarm' | 'anti_tank' | 'frontline_screen' | 'tempo' | 'siege' | 'mana_enabled';

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
  screenedBacklineThreat: boolean;
  immediatePressure: number;
  laneOpportunity: number;
  ageLead: number;
  economicEdge: number;
  manaEdge: number;
  queueDelta: number;
  turretCoverageDelta: number;
  timeSinceEnemyBaseHit: number;
  battlefieldScale: number;
  techDebt: number;
  turretLevelGap: number;
  turretInstallGap: number;
  enemyTurretSlotFill: number;
  playerTurretSlotFill: number;
  decisionPulse: number;
  stallPressure: number;
}

interface ReservePolicy {
  warchest: number;
  reserveTarget: number;
  protectedReserve: number;
  releasedReserve: number;
  spendableGold: number;
  minLiquidityGold: number;
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

interface HtnTask {
  id: HtnTaskId;
  goal: GoalId;
  priority: number;
  methods: string[];
}

interface ComboTemplate {
  id: string;
  age: number;
  units: string[];
  tags: ComboTag[];
  requiredManaLevel?: number;
}

interface ActiveComboPlan {
  id: string;
  goal: GoalId;
  units: string[];
  index: number;
  startedAtSec: number;
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

const COMBO_LIBRARY: Record<number, ComboTemplate[]> = {
  1: [
    { id: 'a1_dino_slinger_screen', age: 1, units: ['stone_dino', 'stone_slinger', 'stone_slinger', 'stone_slinger'], tags: ['frontline_screen', 'tempo'] },
    { id: 'a1_double_club_triple_sling', age: 1, units: ['stone_clubman', 'stone_clubman', 'stone_slinger', 'stone_slinger', 'stone_slinger'], tags: ['frontline_screen', 'tempo'] },
  ],
  2: [
    { id: 'a2_double_spear_triple_archer', age: 2, units: ['bronze_spearman', 'bronze_spearman', 'bronze_archer', 'bronze_archer', 'bronze_archer'], tags: ['frontline_screen', 'tempo', 'mana_enabled'], requiredManaLevel: 1 },
    { id: 'a2_siege_screen', age: 2, units: ['bronze_spearman', 'bronze_spearman', 'bronze_catapult', 'bronze_archer'], tags: ['anti_swarm', 'siege'] },
  ],
  3: [
    { id: 'a3_knight_crossbow_core', age: 3, units: ['iron_knight', 'iron_knight', 'iron_crossbow', 'iron_crossbow', 'battle_monk'], tags: ['frontline_screen', 'anti_tank', 'mana_enabled'], requiredManaLevel: 2 },
    { id: 'a3_elephant_break', age: 3, units: ['war_elephant', 'iron_crossbow', 'iron_crossbow', 'iron_mage'], tags: ['anti_tank', 'siege', 'mana_enabled'], requiredManaLevel: 2 },
  ],
  4: [
    { id: 'a4_tank_artillery_line', age: 4, units: ['steel_tank', 'steel_tank', 'artillery', 'medic', 'heavy_cavalry'], tags: ['frontline_screen', 'anti_swarm', 'siege', 'mana_enabled'], requiredManaLevel: 3 },
    { id: 'a4_counter_lance', age: 4, units: ['heavy_cavalry', 'heavy_cavalry', 'artillery', 'siege_engineer'], tags: ['tempo', 'anti_tank', 'siege', 'mana_enabled'], requiredManaLevel: 3 },
  ],
  5: [
    { id: 'a5_inferno_wall', age: 5, units: ['energy_shield', 'steam_mech', 'flamethrower', 'pyro_maniac', 'sniper'], tags: ['frontline_screen', 'anti_swarm', 'anti_tank', 'mana_enabled'], requiredManaLevel: 5 },
    { id: 'a5_gunner_pressure', age: 5, units: ['energy_shield', 'gunner', 'gunner', 'sniper', 'mana_vampire'], tags: ['tempo', 'anti_tank', 'mana_enabled'], requiredManaLevel: 4 },
  ],
  6: [
    { id: 'a6_titan_spearhead', age: 6, units: ['titan_mech', 'laser_trooper', 'plasma_striker', 'burst_gunner', 'cyber_assassin'], tags: ['anti_tank', 'siege', 'mana_enabled'], requiredManaLevel: 8 },
    { id: 'a6_nanoswarm_cover', age: 6, units: ['robot_soldier', 'mech_walker', 'nanoswarm', 'nanoswarm', 'dark_cultist'], tags: ['anti_swarm', 'frontline_screen', 'mana_enabled'], requiredManaLevel: 8 },
  ],
};

export class SmartPlannerAI implements IAIBehavior {
  private name = 'SmartPlannerAI';
  private lastAgeUpTime = 0;
  private pendingTurretReplacement: { slotIndex: number; turretId: string } | null = null;
  private activeGoal: GoalId = 'STABILIZE';
  private activeComboPlan: ActiveComboPlan | null = null;
  private recentRecruitHistory: string[] = [];
  private debugData: Record<string, unknown> = {};

  getName(): string {
    return this.name;
  }

  reset(): void {
    this.lastAgeUpTime = 0;
    this.pendingTurretReplacement = null;
    this.activeGoal = 'STABILIZE';
    this.activeComboPlan = null;
    this.recentRecruitHistory = [];
    this.debugData = {};
  }

  getParameters(): Record<string, unknown> {
    return {
      ...this.debugData,
      lastAgeUpTime: this.lastAgeUpTime,
      activeGoal: this.activeGoal,
      pendingTurretReplacement: this.pendingTurretReplacement,
      activeComboPlan: this.activeComboPlan,
      recentRecruitHistory: this.recentRecruitHistory,
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

    const comboPlan = params.activeComboPlan as ActiveComboPlan | undefined;
    if (comboPlan && typeof comboPlan.id === 'string' && Array.isArray(comboPlan.units) && typeof comboPlan.index === 'number') {
      this.activeComboPlan = comboPlan;
    }

    const recent = params.recentRecruitHistory;
    if (Array.isArray(recent)) {
      this.recentRecruitHistory = recent.filter((v): v is string => typeof v === 'string').slice(-10);
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

    const htnTasks = this.buildTaskNetwork(goalScores, state, ctx);
    pushStage(
      '3) HTN Network',
      'info',
      htnTasks.map((t) => `${t.id}:${t.goal}(${t.priority.toFixed(1)})`).join(' -> ')
    );

    const candidates: Candidate[] = [];
    for (const task of htnTasks) {
      this.expandTask(task, state, ctx, reserve, candidates);
    }

    const forcedAge = this.createForcedAgeCandidate(state, ctx);
    if (forcedAge) candidates.push(forcedAge);

    const normalizedCandidates = this.dedupeRecruitCandidates(candidates);

    if (normalizedCandidates.length === 0) {
      const emergencyFallbackAllowed = ctx.baseRisk >= 0.62 || ctx.immediatePressure >= 2;
      const fallbackBudget = emergencyFallbackAllowed ? state.enemyGold : reserve.spendableGold;
      const cheapestCost = this.getCheapestAvailableUnitCost(state);

      if (fallbackBudget >= cheapestCost) {
        const fallback = this.pickEmergencyFallback(state, fallbackBudget, ctx);
        if (fallback) {
          const decision: AIDecision = {
            action: 'RECRUIT_UNIT',
            parameters: { unitType: fallback, priority: emergencyFallbackAllowed ? 'emergency' : 'normal' },
            reasoning: emergencyFallbackAllowed
              ? `Emergency fallback recruit ${fallback}`
              : `Fallback recruit ${fallback} within spendable budget`,
          };
          this.commitDecision(state, decision, stages, reserve, goalScores, ctx, 'Fallback anti-passive recruit');
          return decision;
        }
      }

      const waitDecision: AIDecision = {
        action: 'WAIT',
        reasoning: emergencyFallbackAllowed
          ? 'Emergency fallback unavailable this tick; hold and reassess'
          : `Reserve hold: spendable ${Math.floor(reserve.spendableGold)}g below actionable threshold`,
      };
      this.commitDecision(state, waitDecision, stages, reserve, goalScores, ctx, 'No feasible candidate');
      return waitDecision;
    }

    for (const c of normalizedCandidates) {
      pushStage(
        `${c.goal} -> ${c.stage}`,
        'candidate',
        `${c.detail} | U=${c.utility.toFixed(1)} R=${c.risk.toFixed(1)}`,
        c.decision.action
      );
    }

    normalizedCandidates.sort((a, b) => {
      const aGoal = goalScoreMap.get(a.goal) ?? 0;
      const bGoal = goalScoreMap.get(b.goal) ?? 0;
      const aScore = a.utility - a.risk * 0.62 + aGoal * 0.16;
      const bScore = b.utility - b.risk * 0.62 + bGoal * 0.16;
      return bScore - aScore;
    });

    const chosen = normalizedCandidates[0];
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
      this.activeComboPlan = null;
    }

    if (decision.action === 'BUY_TURRET_ENGINE') {
      this.pendingTurretReplacement = null;
    }

    if (decision.action === 'RECRUIT_UNIT') {
      const queued = (decision.parameters as { unitType?: string } | undefined)?.unitType;
      if (this.activeComboPlan && queued) {
        const expected = this.activeComboPlan.units[this.activeComboPlan.index];
        if (expected === queued) {
          this.activeComboPlan.index += 1;
          if (this.activeComboPlan.index >= this.activeComboPlan.units.length) {
            this.activeComboPlan = null;
          }
        }
      }
      if (queued) {
        this.recentRecruitHistory.push(queued);
        if (this.recentRecruitHistory.length > 10) {
          this.recentRecruitHistory.shift();
        }
      }
    }

    const nextSlotsTarget = this.getTargetSlotsByAge(state.enemyAge, state.enemyMana, state.gameTime);
    const actionSpace = this.buildActionSpaceMap(state, reserve);
    this.debugData = {
      activeGoal: this.activeGoal,
      activeComboPlan: this.activeComboPlan,
      recentRecruitHistory: this.recentRecruitHistory,
      goals,
      reservePolicy: reserve,
      context: {
        baseRisk: Number(ctx.baseRisk.toFixed(3)),
        offensiveWindow: Number(ctx.offensiveWindow.toFixed(3)),
        powerAdvantage: Number(ctx.powerAdvantage.toFixed(3)),
        formationStability: Number(ctx.formationStability.toFixed(3)),
        enemyComboThreat: Number(ctx.enemyComboThreat.toFixed(2)),
        screenedBacklineThreat: ctx.screenedBacklineThreat,
        economicEdge: Number(ctx.economicEdge.toFixed(3)),
        manaEdge: Number(ctx.manaEdge.toFixed(3)),
        queueDelta: ctx.queueDelta,
        turretCoverageDelta: Number(ctx.turretCoverageDelta.toFixed(3)),
        timeSinceEnemyBaseHit: Number(ctx.timeSinceEnemyBaseHit.toFixed(2)),
        techDebt: Number(ctx.techDebt.toFixed(3)),
        turretLevelGap: ctx.turretLevelGap,
        turretInstallGap: ctx.turretInstallGap,
        enemyTurretSlotFill: Number(ctx.enemyTurretSlotFill.toFixed(3)),
        playerTurretSlotFill: Number(ctx.playerTurretSlotFill.toFixed(3)),
        decisionPulse: Number(ctx.decisionPulse.toFixed(3)),
        stallPressure: Number(ctx.stallPressure.toFixed(3)),
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
      actionSpace,
      difficulty: state.difficulty,
      warchest: Math.floor(reserve.warchest),
      wcTarget: state.enemyAgeCost,
      gold: Math.floor(state.enemyGold),
      reserved: Math.floor(reserve.protectedReserve),
      income: Number(state.enemyGoldIncome.toFixed(1)),
      taxRate: Number((reserve.digRatio * 100).toFixed(1)) + '%',
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
    const screenedBacklineThreat = enemyArmy.archetypes.some((a) => a.frontlineWeight > 0.48 && a.count >= 1) &&
      enemyArmy.archetypes.some((a) => a.rangedWeight > 0.5 && a.count >= 2);
    const economicEdge =
      (state.enemyGoldIncome + state.enemyGold * 0.01 + state.enemyAge * 2.2) -
      (state.playerGoldIncome + state.playerGold * 0.01 + state.playerAge * 2.2);
    const manaEdge =
      (state.enemyManaIncome + state.enemyMana * 0.015 + state.enemyManaLevel * 0.5) -
      (state.playerManaIncome + state.playerMana * 0.015 + state.playerManaLevel * 0.5);
    const queueDelta = state.playerQueueSize - state.enemyQueueSize;
    const turretCoverageDelta =
      (state.playerTurretMaxRange + state.playerTurretAvgRange * 0.5 + (1 - state.playerTurretProtectionMultiplier) * 12) -
      (state.enemyTurretMaxRange + state.enemyTurretAvgRange * 0.5 + (1 - state.enemyTurretProtectionMultiplier) * 12);
    const timeSinceEnemyBaseHit = Math.max(0, state.gameTime - state.lastEnemyBaseAttackTime);
    const battlefieldScale = state.battlefieldWidth / 60;
    const enemyAgeDebt = Math.max(0, state.enemyAgeCost - state.enemyGold) / Math.max(1, state.enemyAgeCost);
    const playerAgeDebt = Math.max(0, state.playerAgeCost - state.playerGold) / Math.max(1, state.playerAgeCost);
    const techDebt = enemyAgeDebt - playerAgeDebt;
    const turretLevelGap = state.playerTurretLevel - state.enemyTurretLevel;
    const turretInstallGap = state.playerTurretInstalledCount - state.enemyTurretInstalledCount;
    const enemyTurretSlotFill =
      state.enemyTurretSlotsUnlocked > 0
        ? state.enemyTurretSlots.filter((s) => s.slotIndex < state.enemyTurretSlotsUnlocked && !!s.turretId).length / state.enemyTurretSlotsUnlocked
        : 0;
    const playerTurretSlotFill =
      state.playerTurretSlotsUnlocked > 0
        ? state.playerTurretSlots.filter((s) => s.slotIndex < state.playerTurretSlotsUnlocked && !!s.turretId).length / state.playerTurretSlotsUnlocked
        : 0;
    const ownAvgDpsPerUnit = ownArmy.sustainedDps / Math.max(1, ownArmy.unitCount);
    const lanePenetration = state.enemyUnitsNearPlayerBase / Math.max(1, ownArmy.unitCount);
    const crowding = this.clamp((ownArmy.unitCount - 10) / 24, 0, 1.2);
    const lowDpsThreshold = state.enemyAge <= 2 ? 9 : state.enemyAge <= 4 ? 16 : 24;
    const lowPerUnitDps = ownAvgDpsPerUnit < lowDpsThreshold ? 1 : 0;
    const enemyStaticDefense = state.playerTurretDps * (1 + state.playerTurretInstalledCount * 0.25);
    const stallPressure = this.clamp(
      crowding * 0.48 +
      (1 - this.clamp(lanePenetration * 1.8, 0, 1)) * 0.34 +
      lowPerUnitDps * 0.22 +
      this.clamp(enemyStaticDefense / 140, 0, 1) * 0.2,
      0,
      1.25
    );
    const decisionPulse = (state.tick % 16) / 15;

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
      screenedBacklineThreat,
      immediatePressure: state.playerUnitsNearEnemyBase,
      laneOpportunity: state.enemyUnitsNearPlayerBase,
      ageLead: state.enemyAge - state.playerAge,
      economicEdge,
      manaEdge,
      queueDelta,
      turretCoverageDelta,
      timeSinceEnemyBaseHit,
      battlefieldScale,
      techDebt,
      turretLevelGap,
      turretInstallGap,
      enemyTurretSlotFill,
      playerTurretSlotFill,
      decisionPulse,
      stallPressure,
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
      (ctx.screenedBacklineThreat ? 16 : 0) +
      Math.max(0, ctx.turretLevelGap) * 7 +
      Math.max(0, ctx.turretInstallGap) * 4 +
      Math.max(0, ctx.playerTurretSlotFill - ctx.enemyTurretSlotFill) * 12 +
      Math.max(0, ctx.queueDelta) * 3 +
      (ctx.threatLevel === ThreatLevel.CRITICAL ? 34 : ctx.threatLevel === ThreatLevel.HIGH ? 18 : 0);

    const stabilize =
      44 +
      (1 - ctx.formationStability) * 32 +
      Math.max(0, 0.25 - Math.abs(ctx.powerAdvantage)) * 90 +
      ctx.stallPressure * 28 +
      (ctx.enemyArmy.isSwarm ? 8 : 0) +
      (ctx.screenedBacklineThreat ? 12 : 0) +
      (ctx.turretCoverageDelta > 2 ? 8 : 0) +
      Math.max(0, ctx.enemyTurretSlotFill - ctx.playerTurretSlotFill) * 8 +
      Math.max(0, ctx.turretInstallGap) * 2.5 +
      (ctx.enemyArmy.rangedMass ? 8 : 0);

    const press =
      ctx.offensiveWindow * 108 +
      Math.max(0, ctx.powerAdvantage) * 55 +
      (1 - ctx.playerBaseHealthRatio) * 18 +
      Math.max(0, ctx.economicEdge) * 0.9 +
      (ctx.decisionPulse > 0.75 ? 2 : 0) +
      (ctx.timeSinceEnemyBaseHit > 12 ? 6 : 0) +
      (ctx.ageLead > 0 ? 10 : 0) -
      ctx.stallPressure * 42 -
      ctx.baseRisk * 35;

    const canAge = state.enemyAge < 6 && state.enemyGold >= state.enemyAgeCost;
    const tech =
      (state.enemyAge < 6 ? 26 : 0) +
      (state.enemyAge < state.playerAge ? 24 : 0) +
      (canAge ? 19 : 0) +
      Math.max(0, ctx.manaEdge) * 1.2 +
      Math.max(0, ctx.techDebt) * 26 +
      ctx.stallPressure * 12 +
      (ctx.queueDelta < 0 ? 6 : 0) +
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

  private buildTaskNetwork(goals: GoalScore[], state: GameStateSnapshot, ctx: PlannerContext): HtnTask[] {
    const tasks: HtnTask[] = [];

    if (ctx.baseRisk >= 0.58 || ctx.threatLevel === ThreatLevel.HIGH || ctx.threatLevel === ThreatLevel.CRITICAL) {
      tasks.push({
        id: 'THREAT_CONTAIN',
        goal: 'SURVIVE',
        priority: 100 + ctx.baseRisk * 30,
        methods: ['counter_recruit', 'turret_counter', 'repair_gate'],
      });
    }

    const topGoals = goals.slice(0, 3);
    for (const g of topGoals) {
      if (g.goal === 'SURVIVE') {
        tasks.push({
          id: 'THREAT_CONTAIN',
          goal: 'SURVIVE',
          priority: g.score,
          methods: ['counter_recruit', 'turret_counter', 'repair_gate'],
        });
      } else if (g.goal === 'STABILIZE') {
        tasks.push({
          id: 'FORMATION_RECOVER',
          goal: 'STABILIZE',
          priority: g.score,
          methods: ['formation_recruit', 'combo_recruit', 'mana_infra', 'turret_efficiency'],
        });
      } else if (g.goal === 'PRESS') {
        tasks.push({
          id: 'PRESS_WINDOW',
          goal: 'PRESS',
          priority: g.score,
          methods: ['combo_recruit', 'pressure_recruit', 'age_spike'],
        });
      } else if (g.goal === 'TECH') {
        tasks.push({
          id: 'TECH_TRANSITION',
          goal: 'TECH',
          priority: g.score,
          methods: ['age_transition', 'mana_scaling', 'tech_cover'],
        });
      }
    }

    if (state.enemyAge < state.playerAge && !tasks.some((t) => t.id === 'TECH_TRANSITION')) {
      tasks.push({
        id: 'TECH_TRANSITION',
        goal: 'TECH',
        priority: 72,
        methods: ['age_transition', 'mana_scaling', 'tech_cover'],
      });
    }

    tasks.sort((a, b) => b.priority - a.priority);

    // Deduplicate by id + goal while preserving strongest priority.
    const seen = new Set<string>();
    const unique: HtnTask[] = [];
    for (const t of tasks) {
      const key = `${t.id}:${t.goal}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(t);
    }
    return unique;
  }

  private expandTask(
    task: HtnTask,
    state: GameStateSnapshot,
    ctx: PlannerContext,
    reserve: ReservePolicy,
    candidates: Candidate[]
  ): void {
    const before = candidates.length;
    for (const method of task.methods) {
      if (method === 'combo_recruit') {
        const combo = this.planComboRecruitCandidate(state, ctx, reserve, task.goal);
        if (combo) candidates.push(combo);
        continue;
      }

      if (method === 'counter_recruit' || method === 'formation_recruit' || method === 'pressure_recruit' || method === 'tech_cover') {
        const goalForUnits =
          method === 'counter_recruit' ? 'SURVIVE' :
          method === 'pressure_recruit' ? 'PRESS' :
          method === 'tech_cover' ? 'SURVIVE' : task.goal;
        const picks = this.collectUnitCandidates(goalForUnits, state, ctx, reserve.spendableGold, 2);
        for (const pick of picks) {
          candidates.push({
            goal: task.goal,
            stage: `HTN:${method}`,
            utility: pick.utility + (method === 'counter_recruit' ? 5 : 0),
            risk: pick.risk + (method === 'pressure_recruit' ? 1 : 0),
            detail: pick.detail,
            decision: {
              action: 'RECRUIT_UNIT',
              parameters: { unitType: pick.unitId, priority: method === 'counter_recruit' ? 'emergency' : method === 'pressure_recruit' ? 'high' : 'normal' },
              reasoning: `HTN ${method}: recruit ${pick.unitId}`,
            },
          });
        }
        continue;
      }

      if (method === 'turret_counter' || method === 'turret_efficiency' || method === 'defensive_infrastructure') {
        const turretOption = this.planTurretOption(state, reserve.spendableGold, ctx, method === 'turret_counter');
        if (turretOption) {
          candidates.push({
            goal: task.goal,
            stage: `HTN:${method}`,
            utility: turretOption.utility + (method === 'turret_counter' ? 7 : 0),
            risk: turretOption.risk,
            detail: turretOption.detail,
            decision: turretOption.decision,
          });
        }
        continue;
      }

      if (method === 'mana_infra' || method === 'mana_scaling') {
        const manaUpgrade = this.planManaUpgrade(state, reserve.spendableGold, ctx);
        if (manaUpgrade) {
          candidates.push({
            goal: task.goal,
            stage: `HTN:${method}`,
            utility: manaUpgrade.utility + (method === 'mana_scaling' ? 5 : 0),
            risk: manaUpgrade.risk,
            detail: manaUpgrade.detail,
            decision: manaUpgrade.decision,
          });
        }
        continue;
      }

      if (method === 'repair_gate') {
        if (state.enemyAge >= 6 && state.enemyMana >= 500 && state.enemyBaseHealth < state.enemyBaseMaxHealth * 0.85 && ctx.baseRisk >= 0.45) {
          candidates.push({
            goal: task.goal,
            stage: 'HTN:repair_gate',
            utility: 66 + ctx.baseRisk * 18,
            risk: 7,
            detail: 'Repair base under sustained threat',
            decision: { action: 'REPAIR_BASE', reasoning: 'HTN repair gate under high threat' },
          });
        }
        continue;
      }

      if (method === 'age_spike' || method === 'age_transition') {
        if (
          state.enemyAge < 6 &&
          state.enemyGold >= state.enemyAgeCost &&
          ctx.baseRisk <= (method === 'age_spike' ? 0.56 : 0.62) &&
          ctx.immediatePressure <= 2 &&
          state.enemyQueueSize <= 2
        ) {
          candidates.push({
            goal: task.goal,
            stage: `HTN:${method}`,
            utility: (method === 'age_spike' ? 74 : 82) + (ctx.ageLead < 0 ? 8 : 0),
            risk: 10,
            detail: `Advance to Age ${state.enemyAge + 1}`,
            decision: { action: 'AGE_UP', reasoning: `HTN ${method}: age power transition` },
          });
        }
      }
    }

    // Safety fallback for any task with no expanded methods.
    if (candidates.length === before) {
      this.addGoalCandidates(task.goal, state, ctx, reserve, candidates);
    }
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
      ctx.baseRisk <= 0.56 &&
      ctx.immediatePressure <= 2 &&
      ctx.powerAdvantage >= -0.2 &&
      state.enemyQueueSize <= 2
    ) {
      const turretLock = this.isTurretLockScenario(state, ctx);
      candidates.push({
        goal: 'PRESS',
        stage: 'Age Spike',
        utility: 74 + ctx.offensiveWindow * 18 + (turretLock ? 14 : 0),
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
      ctx.baseRisk <= 0.62 &&
      ctx.immediatePressure <= 2
    ) {
      const turretLock = this.isTurretLockScenario(state, ctx);
      candidates.push({
        goal: 'TECH',
        stage: 'Age Transition',
        utility: 82 + (ctx.ageLead < 0 ? 14 : 0) + (turretLock ? 12 : 0),
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

  private planComboRecruitCandidate(
    state: GameStateSnapshot,
    ctx: PlannerContext,
    reserve: ReservePolicy,
    goal: GoalId
  ): Candidate | null {
    if (state.enemyQueueSize >= 5) return null;

    const primaryGoal = goal ?? this.activeGoal;
    const combo = this.ensureComboPlan(state, ctx, primaryGoal);
    if (!combo) return null;

    while (combo.index < combo.units.length) {
      const nextUnitId = combo.units[combo.index];
      const def = UNIT_DEFS[nextUnitId];
      if (!def || (def.age ?? 1) > state.enemyAge) {
        combo.index += 1;
        continue;
      }
      const cost = this.getDiscountedCost(def.cost, state.difficulty, 'unit');
      const manaCost = def.manaCost ?? 0;
      if (cost > reserve.spendableGold || manaCost > state.enemyMana) return null;

      const comboProgress = `${combo.index + 1}/${combo.units.length}`;
      const utilityBase =
        primaryGoal === 'PRESS' ? 79 :
        primaryGoal === 'SURVIVE' ? 76 :
        primaryGoal === 'TECH' ? 68 : 72;
      const earlyAgeBonus = state.enemyAge <= 2 ? 12 : 0;
      const antiBacklineBonus = ctx.screenedBacklineThreat ? 8 : 0;
      const swarmBonus = ctx.enemyArmy.isSwarm ? 6 : 0;
      const activePlanBonus = this.activeComboPlan ? 6 : 0;

      return {
        goal: primaryGoal,
        stage: 'HTN Combo Recruit',
        utility: utilityBase + earlyAgeBonus + antiBacklineBonus + swarmBonus + activePlanBonus,
        risk: 8 + (ctx.baseRisk > 0.62 ? 4 : 0),
        detail: `Combo ${combo.id} ${comboProgress} -> ${nextUnitId}`,
        decision: {
          action: 'RECRUIT_UNIT',
          parameters: { unitType: nextUnitId, priority: primaryGoal === 'PRESS' ? 'high' : 'normal' },
          reasoning: `HTN combo step ${comboProgress}: ${nextUnitId} (${combo.id})`,
        },
      };
    }

    this.activeComboPlan = null;
    return null;
  }

  private dedupeRecruitCandidates(candidates: Candidate[]): Candidate[] {
    const bestByUnit = new Map<string, Candidate>();
    const passthrough: Candidate[] = [];
    for (const c of candidates) {
      if (c.decision.action !== 'RECRUIT_UNIT') {
        passthrough.push(c);
        continue;
      }
      const unitType = (c.decision.parameters as { unitType?: string } | undefined)?.unitType;
      if (!unitType) {
        passthrough.push(c);
        continue;
      }
      const prev = bestByUnit.get(unitType);
      const prevScore = prev ? prev.utility - prev.risk * 0.58 : -Infinity;
      const nextScore = c.utility - c.risk * 0.58;
      if (!prev || nextScore > prevScore) {
        bestByUnit.set(unitType, c);
      }
    }
    return [...passthrough, ...bestByUnit.values()];
  }

  private ensureComboPlan(state: GameStateSnapshot, ctx: PlannerContext, goal: GoalId): ActiveComboPlan | null {
    if (
      this.activeComboPlan &&
      this.activeComboPlan.index < this.activeComboPlan.units.length &&
      state.gameTime - this.activeComboPlan.startedAtSec <= 55 &&
      (this.activeComboPlan.goal === goal || this.activeComboPlan.goal === 'SURVIVE')
    ) {
      return this.activeComboPlan;
    }
    this.activeComboPlan = null;

    const combos = COMBO_LIBRARY[state.enemyAge] ?? [];
    if (combos.length === 0) return null;

    let best: ComboTemplate | null = null;
    let bestScore = -Infinity;

    for (const combo of combos) {
      if ((combo.requiredManaLevel ?? 0) > state.enemyManaLevel) continue;

      const totalCost = combo.units.reduce((sum, id) => {
        const def = UNIT_DEFS[id];
        return sum + this.getDiscountedCost(def?.cost ?? 99999, state.difficulty, 'unit');
      }, 0);
      const affordableBias = totalCost <= state.enemyGold * 1.2 ? 1 : 0.6;

      let score = 10 * affordableBias;
      if (goal === 'SURVIVE' && combo.tags.includes('frontline_screen')) score += 28;
      if (goal === 'PRESS' && combo.tags.includes('tempo')) score += 24;
      if (goal === 'PRESS' && combo.tags.includes('siege')) score += 14;
      if (goal === 'TECH' && combo.tags.includes('mana_enabled')) score += 12;
      if (ctx.enemyArmy.isSwarm && combo.tags.includes('anti_swarm')) score += 18;
      if (ctx.enemyArmy.isHeavy && combo.tags.includes('anti_tank')) score += 18;
    if (ctx.screenedBacklineThreat && combo.tags.includes('frontline_screen')) score += 16;
    if (ctx.stallPressure > 0.58 && combo.tags.includes('siege')) score += 16;
    if (ctx.stallPressure > 0.58 && combo.tags.includes('tempo')) score -= 6;

      if (score > bestScore) {
        bestScore = score;
        best = combo;
      }
    }

    if (!best) return null;

    this.activeComboPlan = {
      id: best.id,
      goal,
      units: [...best.units],
      index: 0,
      startedAtSec: state.gameTime,
    };
    return this.activeComboPlan;
  }

  private collectUnitCandidates(
    goal: GoalId,
    state: GameStateSnapshot,
    ctx: PlannerContext,
    spendableGold: number,
    maxCount: number
  ): UnitCandidateScore[] {
    if (state.enemyQueueSize >= 5) return [];
    if (this.shouldHoldForStack(goal, state, ctx, spendableGold)) return [];

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
      profile.speed * (1.2 + ctx.battlefieldScale * 0.12) +
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
    const turretLock = this.isTurretLockScenario(state, ctx);
    const turretTooStrong = AIBehaviorUtils.isEnemyTurretTooStrong(state, def);
    const lowCommitFodder =
      cost <= Math.max(35, state.enemyAge * 24) &&
      profile.health < 220 &&
      profile.range < 3.5 &&
      profile.siegeWeight < 0.4;

    if (turretLock && lowCommitFodder && goal !== 'SURVIVE') {
      return null;
    }

    const diversityPenalty = this.computeDiversityPenalty(unitId, state, ctx, profile);

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
    if (ctx.screenedBacklineThreat && profile.frontlineWeight < 0.3 && profile.siegeWeight < 0.35) risk += 13;
    if (ctx.stallPressure > 0.6 && profile.range < 2.2 && profile.siegeWeight < 0.35) risk += 15;
    if (profile.manaCost > 0 && state.enemyMana < profile.manaCost + 25) risk += 7;
    if (profile.trainingSec > 5.5 && ctx.baseRisk > 0.62) risk += 11;
    if (state.enemyQueueSize >= 4) risk += 8;
    if (turretTooStrong) {
      risk += goal === 'SURVIVE' ? 10 : 24;
      utility -= goal === 'SURVIVE' ? 6 : 18;
    }
    if (turretLock && profile.siegeWeight < 0.35 && profile.range < Math.max(3, state.playerTurretAvgRange - 1)) {
      risk += 12;
      utility -= 10;
    }
    if (ctx.screenedBacklineThreat && (profile.siegeWeight > 0.45 || profile.frontlineWeight > 0.55)) {
      utility += 10;
    }
    if (ctx.stallPressure > 0.58 && (profile.siegeWeight > 0.35 || profile.rangedWeight > 0.5)) {
      utility += 12;
    }
    risk += diversityPenalty;
    if (diversityPenalty >= 10) utility -= diversityPenalty * 0.7;

    const detail =
      `${unitId} cost=${cost}/${manaCost} ` +
      `counter=${counterRaw.toFixed(2)} ` +
      `def=${defenseNorm.toFixed(2)} off=${offenseNorm.toFixed(2)} spam=${diversityPenalty.toFixed(1)} ` +
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

  private evaluateAgainstEnemyCombinations(profile: UnitProfile, enemyArmy: ArmySnapshot): number {
    if (enemyArmy.archetypes.length === 0) return 0.35;

    let score = 0;
    let weight = 0;

    for (const archetype of enemyArmy.archetypes) {
      const archWeight = archetype.weightedThreat + archetype.count * 20;
      score += this.scoreUnitVsArchetype(profile, archetype) * archWeight;
      weight += archWeight;
    }

    for (let i = 0; i < enemyArmy.archetypes.length; i++) {
      for (let j = i; j < enemyArmy.archetypes.length; j++) {
        const a = enemyArmy.archetypes[i];
        const b = enemyArmy.archetypes[j];
        const pairWeight = (a.count + b.count) * 8 + Math.sqrt((a.weightedThreat + 1) * (b.weightedThreat + 1));
        const pairCtx: PairContext = {
          rangedBacklinePair: (a.frontlineWeight > 0.45 && b.rangedWeight > 0.45) || (b.frontlineWeight > 0.45 && a.rangedWeight > 0.45),
          heavyPair: a.avgHealth > 320 || b.avgHealth > 320,
          swarmPair: a.count + b.count >= 5,
        };
        score += this.scoreUnitVsArchetypePair(profile, a, b, pairCtx) * pairWeight;
        weight += pairWeight;
      }
    }

    return this.clamp(score / Math.max(1, weight), -1.2, 1.2);
  }

  private scoreUnitVsArchetype(profile: UnitProfile, archetype: UnitArchetype): number {
    const enemyUnitDps = (archetype.totalDps + archetype.totalBurstDps * 0.4 + archetype.totalAoeDps * 0.25) / Math.max(1, archetype.count);
    const ownDps = profile.dps + profile.burstDps * 0.45 + profile.aoeDps * (archetype.count >= 3 ? 0.45 : 0.2);

    const rangeEdge = this.clamp((profile.range - archetype.avgRange) / 12, -1, 1);
    const speedEdge = this.clamp((profile.speed - archetype.avgSpeed) / 8, -1, 1);

    const ownTtk = profile.health / Math.max(1, enemyUnitDps * (1 - rangeEdge * 0.2));
    const enemyTtk = archetype.avgHealth / Math.max(1, ownDps * (1 + rangeEdge * 0.25 + speedEdge * 0.1));

    let duel = (ownTtk - enemyTtk) / Math.max(0.3, ownTtk + enemyTtk);

    if (profile.tankWeight > 0.5 && archetype.rangedWeight > 0.45) duel += 0.12;
    if (profile.siegeWeight > 0.45 && archetype.count >= 4) duel += 0.09;
    if (profile.range < 2.2 && archetype.rangedWeight > 0.55 && profile.speed < 5.2) duel -= 0.18;

    return this.clamp(duel, -1, 1);
  }

  private scoreUnitVsArchetypePair(
    profile: UnitProfile,
    a: UnitArchetype,
    b: UnitArchetype,
    ctx: PairContext
  ): number {
    let score = 0;

    const combinedRange = (a.avgRange + b.avgRange) * 0.5;
    const combinedCount = a.count + b.count;
    const combinedHealth = a.totalHealth + b.totalHealth;

    if (ctx.rangedBacklinePair) {
      score += profile.frontlineWeight * 0.16;
      score += profile.siegeWeight * 0.12;
      if (profile.range >= combinedRange) score += 0.1;
      if (profile.range < 2.4 && profile.speed < 5.6) score -= 0.14;
    }

    if (ctx.swarmPair) {
      score += profile.aoeDps > 0 ? 0.18 : -0.05;
      if (profile.siegeWeight > 0.4) score += 0.09;
      if (profile.frontlineWeight < 0.25) score -= 0.07;
    }

    if (ctx.heavyPair) {
      score += profile.tankWeight * 0.1;
      score += (profile.dps + profile.burstDps * 0.5) / Math.max(1, combinedHealth / Math.max(2, combinedCount)) * 0.05;
      if (profile.health < 180 && profile.frontlineWeight < 0.3) score -= 0.08;
    }

    return this.clamp(score, -0.8, 0.8);
  }

  private evaluateCandidateSurvivability(profile: UnitProfile, enemyArmy: ArmySnapshot): number {
    if (enemyArmy.unitCount === 0) return 1.1;

    const focusedEnemyDps = enemyArmy.sustainedDps * (enemyArmy.rangedMass ? 0.36 : 0.27) + enemyArmy.burstDps * 0.22;
    const exposure =
      profile.range < 2.4 && enemyArmy.rangedMass
        ? 1.2
        : profile.range >= enemyArmy.averageRange + 2
          ? 0.78
          : 1.0;

    const ttl = profile.health / Math.max(1, focusedEnemyDps * exposure);
    return this.clamp(ttl / 8.5, 0, 1.25);
  }

  private evaluateArchetypeCombinationThreat(archetypes: UnitArchetype[]): number {
    if (archetypes.length === 0) return 0;

    let threat = 0;
    let weight = 0;

    for (const a of archetypes) {
      const single =
        (a.totalDps + a.totalBurstDps * 0.4 + a.totalAoeDps * 0.25) * 0.8 +
        a.totalHealth * 0.06 +
        a.avgRange * a.count * 2.1;
      const w = a.count * 12 + a.weightedThreat * 0.08;
      threat += single * w;
      weight += w;
    }

    for (let i = 0; i < archetypes.length; i++) {
      for (let j = i + 1; j < archetypes.length; j++) {
        const a = archetypes[i];
        const b = archetypes[j];
        let synergy = 0;

        const rangedBacklinePair = (a.frontlineWeight > 0.45 && b.rangedWeight > 0.45) || (b.frontlineWeight > 0.45 && a.rangedWeight > 0.45);
        if (rangedBacklinePair) synergy += 38;
        if ((a.siegeWeight > 0.4 || b.siegeWeight > 0.4) && (a.count + b.count >= 4)) synergy += 22;
        if ((a.avgRange + b.avgRange) * 0.5 >= 8) synergy += 14;

        const pairWeight = Math.sqrt((a.count + 1) * (b.count + 1)) * 11;
        threat += synergy * pairWeight;
        weight += pairWeight;
      }
    }

    return threat / Math.max(1, weight);
  }

  private getAdjustedCompositionTarget(
    age: number,
    enemyArmy: ArmySnapshot,
    ownArmy: ArmySnapshot,
    baseRisk: number,
    offensiveWindow: number
  ): CompositionTarget {
    const base = AGE_FORMATION_TEMPLATES[age] ?? AGE_FORMATION_TEMPLATES[6];
    const target: CompositionTarget = { ...base };

    if (enemyArmy.rangedMass) {
      target.frontline += 0.08;
      target.ranged -= 0.03;
      target.siege -= 0.02;
    }
    if (enemyArmy.isSwarm) {
      target.siege += 0.08;
      target.frontline -= 0.03;
    }
    if (enemyArmy.isHeavy) {
      target.siege += 0.04;
      target.support += 0.02;
      target.frontline -= 0.02;
    }
    if (baseRisk > 0.62) {
      target.frontline += 0.1;
      target.support -= 0.03;
      target.siege -= 0.03;
    }
    if (offensiveWindow > 0.72 && ownArmy.unitCount >= enemyArmy.unitCount) {
      target.ranged += 0.04;
      target.siege += 0.03;
      target.frontline -= 0.05;
    }

    target.frontline = this.clamp(target.frontline, 0.2, 0.72);
    target.ranged = this.clamp(target.ranged, 0.15, 0.6);
    target.support = this.clamp(target.support, 0, 0.25);
    target.siege = this.clamp(target.siege, 0, 0.3);

    return target;
  }

  private computeCompositionNeeds(
    ownArmy: ArmySnapshot,
    target: CompositionTarget,
    enemyArmy: ArmySnapshot
  ): CompositionNeeds {
    const frontlineNeed = Math.max(0, target.frontline - ownArmy.frontlineShare + (enemyArmy.rangedMass ? 0.05 : 0));
    const rangedNeed = Math.max(0, target.ranged - ownArmy.rangedShare);
    const supportNeed = Math.max(0, target.support - ownArmy.supportShare);
    const siegeNeed = Math.max(0, target.siege - ownArmy.siegeShare + (enemyArmy.isSwarm ? 0.05 : 0));

    return {
      frontline: this.clamp(frontlineNeed, 0, 0.65),
      ranged: this.clamp(rangedNeed, 0, 0.55),
      support: this.clamp(supportNeed, 0, 0.35),
      siege: this.clamp(siegeNeed, 0, 0.45),
    };
  }

  private computeReservePolicy(state: GameStateSnapshot, ctx: PlannerContext): ReservePolicy {
    const warchest = AIBehaviorUtils.calculateWarchest(state, state.gameTime - this.lastAgeUpTime, state.difficulty);
    const reserveTarget = state.enemyAge < 6 ? Math.min(state.enemyAgeCost, warchest) : 0;

    let digRatio = 0;
    let reason = 'Hold reserve for age timing';

    if (ctx.baseRisk >= 0.82 || ctx.threatLevel === ThreatLevel.CRITICAL) {
      digRatio = 1.0;
      reason = 'Full reserve release: critical collapse risk';
    } else if (ctx.baseRisk >= 0.65 || ctx.immediatePressure >= 3) {
      digRatio = 0.75;
      reason = 'High pressure: release most reserve to stabilize';
    } else if (ctx.baseRisk >= 0.52) {
      digRatio = 0.45;
      reason = 'Moderate pressure: partial reserve release';
    } else if (ctx.offensiveWindow > 0.82 && ctx.ageLead >= 1) {
      digRatio = 0.25;
      reason = 'Tempo opportunity: controlled reserve release';
    }

    if (state.enemyAge < state.playerAge) {
      digRatio = Math.min(digRatio, 0.4);
      reason = 'Preserve tech catch-up reserve while behind in age';
    }
    if (ctx.techDebt > 0.22 && state.enemyAge < 6) {
      digRatio = Math.min(digRatio, 0.3);
      reason = 'Preserve reserve: own age-up debt higher than opponent';
    }
    if (ctx.economicEdge > 18 && ctx.baseRisk < 0.5) {
      digRatio = Math.max(digRatio, 0.2);
      reason = 'Economy lead allows controlled reserve release';
    }

    const moderateOrHigherThreat =
      ctx.threatLevel === ThreatLevel.MODERATE ||
      ctx.threatLevel === ThreatLevel.HIGH ||
      ctx.threatLevel === ThreatLevel.CRITICAL;
    const highThreat = ctx.threatLevel === ThreatLevel.HIGH || ctx.threatLevel === ThreatLevel.CRITICAL;
    const underPressure =
      highThreat ||
      moderateOrHigherThreat ||
      ctx.baseRisk >= 0.52 ||
      ctx.immediatePressure >= 2 ||
      ctx.stallPressure >= 0.58;
    const ageProgress = state.enemyAge < 6 ? state.enemyGold / Math.max(1, state.enemyAgeCost) : 1;
    const nearAgeWindow = state.enemyAge < 6 && ageProgress >= 0.86;
    const canAgeNow = state.enemyAge < 6 && state.enemyGold >= state.enemyAgeCost;

    if (underPressure && !nearAgeWindow) {
      const releaseFloor = highThreat || ctx.baseRisk >= 0.66 ? 0.78 : 0.55;
      if (digRatio < releaseFloor) {
        digRatio = releaseFloor;
        reason = highThreat
          ? 'Threat pressure: release reserve for immediate actions'
          : 'Pressure detected: release reserve to avoid deadlock';
      }
    }

    let releasedReserve = reserveTarget * digRatio;
    let protectedReserve = Math.max(0, reserveTarget - releasedReserve);
    const liquidBuffer = ctx.baseRisk >= 0.6 ? 8 : 20;
    const cheapestUnitCost = this.getCheapestAvailableUnitCost(state);
    const hasRecruitOption = Number.isFinite(cheapestUnitCost) && cheapestUnitCost < Number.MAX_SAFE_INTEGER;

    let minLiquidityGold = hasRecruitOption ? Math.ceil(cheapestUnitCost + 8) : 0;
    if (underPressure) {
      minLiquidityGold = Math.max(minLiquidityGold, hasRecruitOption ? Math.ceil(cheapestUnitCost * 2.0) : 120);
    }
    if (ctx.stallPressure >= 0.72) {
      minLiquidityGold = Math.max(minLiquidityGold, hasRecruitOption ? Math.ceil(cheapestUnitCost * 2.6) : 180);
    }
    if (nearAgeWindow && ctx.baseRisk < 0.45 && ctx.immediatePressure <= 1) {
      minLiquidityGold = Math.min(minLiquidityGold, hasRecruitOption ? Math.ceil(cheapestUnitCost) : 0);
    }
    if (canAgeNow && ctx.baseRisk < 0.58 && ctx.immediatePressure <= 1) {
      minLiquidityGold = 0;
    }

    const maxProtectedByLiquidity = Math.max(0, state.enemyGold - liquidBuffer - minLiquidityGold);
    if (protectedReserve > maxProtectedByLiquidity) {
      protectedReserve = maxProtectedByLiquidity;
      releasedReserve = Math.max(0, reserveTarget - protectedReserve);
      reason = `${reason}; liquidity floor release`;
    }

    let spendableGold = Math.max(0, state.enemyGold - protectedReserve - liquidBuffer);
    if (
      hasRecruitOption &&
      spendableGold < cheapestUnitCost &&
      state.enemyGold >= cheapestUnitCost + liquidBuffer &&
      protectedReserve > 0
    ) {
      const needed = cheapestUnitCost - spendableGold;
      protectedReserve = Math.max(0, protectedReserve - needed);
      releasedReserve = Math.max(0, reserveTarget - protectedReserve);
      spendableGold = Math.max(0, state.enemyGold - protectedReserve - liquidBuffer);
      reason = `${reason}; forced cheapest-action liquidity`;
    }

    return {
      warchest,
      reserveTarget,
      protectedReserve,
      releasedReserve,
      spendableGold,
      minLiquidityGold,
      digRatio,
      reason,
    };
  }

  private createForcedAgeCandidate(state: GameStateSnapshot, ctx: PlannerContext): Candidate | null {
    if (state.enemyAge >= 6 || state.enemyGold < state.enemyAgeCost) return null;
    if (state.enemyQueueSize > 1) return null;

    const turretLock = this.isTurretLockScenario(state, ctx);
    const ecoStall = state.enemyGold >= state.enemyAgeCost * 1.12 && ctx.baseRisk < 0.7;
    const noImmediateFight = ctx.enemyArmy.unitCount <= 1 && ctx.immediatePressure <= 1;
    const behindTech = ctx.ageLead < 0 && ctx.baseRisk < 0.78;

    if (!turretLock && !ecoStall && !noImmediateFight && !behindTech) return null;

    const utility = 88 + (turretLock ? 14 : 0) + (behindTech ? 8 : 0);
    return {
      goal: 'TECH',
      stage: 'Forced Age Pivot',
      utility,
      risk: 12,
      detail: `Pivot to age ${state.enemyAge + 1} to avoid low-tech attrition`,
      decision: {
        action: 'AGE_UP',
        reasoning: `HTN pivot: current action set underperforms, force tech unlock to improve action quality`,
      },
    };
  }

  private shouldHoldForStack(
    goal: GoalId,
    state: GameStateSnapshot,
    ctx: PlannerContext,
    spendableGold: number
  ): boolean {
    if (goal === 'SURVIVE') return false;
    if (state.enemyQueueSize > 0) return false;
    if (ctx.baseRisk >= 0.55) return false;

    const units = Object.values(getUnitsForAge(state.enemyAge));
    if (units.length === 0) return false;

    const discountedCosts = units.map((u) => this.getDiscountedCost(u.cost, state.difficulty, 'unit')).sort((a, b) => a - b);
    const medianCost = discountedCosts[Math.floor(discountedCosts.length / 2)] ?? 80;

    const turretLock = this.isTurretLockScenario(state, ctx);
    const stackSizeTarget = turretLock ? 5 : goal === 'PRESS' ? 4 : 3;
    let threshold = medianCost * stackSizeTarget;

    if (turretLock) threshold *= 1.35;
    if (ctx.offensiveWindow < 0.5) threshold *= 1.15;
    if (ctx.ageLead < 0) threshold *= 1.1;
    if (ctx.queueDelta > 1) threshold *= 0.9;
    if (ctx.economicEdge < -8) threshold *= 0.86;
    if (ctx.battlefieldScale > 1.5) threshold *= 1.08;
    if (ctx.stallPressure > 0.58) threshold *= 0.72;

    return spendableGold < threshold;
  }

  private isTurretLockScenario(state: GameStateSnapshot, ctx: PlannerContext): boolean {
    if (state.playerTurretDps <= 0) return false;
    const staticDefenseLead = state.playerTurretDps > Math.max(18, state.enemyTurretDps * 1.35);
    const lowEnemyArmy = ctx.enemyArmy.unitCount <= 2;
    const lowBaseRisk = ctx.baseRisk < 0.65;
    return staticDefenseLead && lowEnemyArmy && lowBaseRisk;
  }

  private planManaUpgrade(
    state: GameStateSnapshot,
    spendableGold: number,
    ctx: PlannerContext
  ): TurretOption | null {
    if (state.enemyAge <= 1) return null;
    if (ctx.baseRisk >= 0.66) return null;

    const desiredLevel = state.enemyAge >= 6
      ? (state.gameTime >= 150 ? 16 : 12)
      : state.enemyAge === 5
        ? 9
        : state.enemyAge === 4
          ? 6
          : state.enemyAge === 3
            ? 3
            : 1;

    if (state.enemyManaLevel >= desiredLevel) return null;

    const cost = getManaCost(state.enemyManaLevel);
    if (cost > spendableGold) return null;

    const manaDemand =
      ctx.ownArmy.supportShare * 180 +
      ctx.ownArmy.siegeShare * 130 +
      ctx.ownArmy.unitCount * 5 +
      (ctx.enemyArmy.rangedMass ? 25 : 0);

    const projectedMana = state.enemyMana + state.enemyManaIncome * 8;
    if (projectedMana > manaDemand * 1.5 && state.enemyManaLevel >= 4) return null;

    const utility = 50 + this.clamp(manaDemand / 120, 0, 28) + (ctx.offensiveWindow > 0.6 ? 6 : 0);
    const risk = 6 + this.clamp(cost / Math.max(1, spendableGold), 0, 14);

    return {
      decision: {
        action: 'UPGRADE_MANA',
        reasoning: `Mana upgrade to sustain skills/aoe throughput (${state.enemyManaLevel} -> ${state.enemyManaLevel + 1})`,
      },
      utility,
      risk,
      detail: `Mana level ${state.enemyManaLevel}/${desiredLevel}, demand=${manaDemand.toFixed(0)}, cost=${cost}`,
    };
  }

  private planTurretOption(
    state: GameStateSnapshot,
    spendableGold: number,
    ctx: PlannerContext,
    emergency: boolean
  ): TurretOption | null {
    const slotsUnlocked = state.enemyTurretSlotsUnlocked;
    const slots = state.enemyTurretSlots;
    const available = Object.values(getTurretEnginesForAge(state.enemyAge));
    if (available.length === 0) return null;

    const options: TurretOption[] = [];

    if (this.pendingTurretReplacement) {
      const slot = slots.find((s) => s.slotIndex === this.pendingTurretReplacement!.slotIndex);
      const target = getTurretEngineDef(this.pendingTurretReplacement.turretId);
      if (slot && !slot.turretId && target) {
        const cost = this.getDiscountedCost(target.cost, state.difficulty, 'turret_engine');
        const manaCost = target.manaCost ?? 0;
        if (cost <= spendableGold && manaCost <= state.enemyMana) {
          const utility = 76 + this.clamp(this.scoreEngineForContext(target, ctx) / Math.max(120, cost), 0, 20);
          options.push({
            decision: {
              action: 'BUY_TURRET_ENGINE',
              parameters: { slotIndex: slot.slotIndex, turretId: target.id },
              reasoning: `Finalize turret replacement with ${target.name} on slot ${slot.slotIndex + 1}`,
            },
            utility,
            risk: 5,
            detail: `Rebuild replacement ${target.id} after sell`,
          });
        }
      } else {
        this.pendingTurretReplacement = null;
      }
    }

    const targetSlots = this.getTargetSlotsByAge(state.enemyAge, state.enemyMana, state.gameTime);
    if (slotsUnlocked < targetSlots) {
      const unlockCost = this.getDiscountedCost(getTurretSlotUnlockCost(slotsUnlocked), state.difficulty, 'turret_upgrade');
      const filled = slots.filter((s) => s.slotIndex < slotsUnlocked && !!s.turretId).length;
      if (unlockCost > 0 && unlockCost <= spendableGold && filled >= Math.max(1, slotsUnlocked)) {
        const utility = 40 + (targetSlots - slotsUnlocked) * 10 + ctx.baseRisk * 16;
        const risk = 10 + this.clamp(unlockCost / Math.max(1, spendableGold), 0, 14);
        options.push({
          decision: {
            action: 'UPGRADE_TURRET_SLOTS',
            reasoning: `Unlock slot ${slotsUnlocked + 1} for improved defensive engine coverage`,
          },
          utility,
          risk,
          detail: `Slot unlock ${slotsUnlocked} -> ${slotsUnlocked + 1}, target ${targetSlots}`,
        });
      }
    }

    for (let i = 0; i < slotsUnlocked; i++) {
      const slot = slots.find((s) => s.slotIndex === i);
      if (!slot || slot.turretId) continue;

      let bestEngine: TurretEngineDef | null = null;
      let bestUtility = -Infinity;
      let bestRisk = 0;

      for (const engine of available) {
        const cost = this.getDiscountedCost(engine.cost, state.difficulty, 'turret_engine');
        const manaCost = engine.manaCost ?? 0;
        if (cost > spendableGold || manaCost > state.enemyMana) continue;

        const score = this.scoreEngineForContext(engine, ctx);
        const utility = 42 + (score / Math.max(90, cost)) * 30 + (ctx.baseRisk * 18);
        const risk = 8 + this.clamp(cost / Math.max(1, spendableGold), 0, 16) + (manaCost > state.enemyMana * 0.35 ? 2 : 0);
        if (utility - risk * 0.45 > bestUtility - bestRisk * 0.45) {
          bestEngine = engine;
          bestUtility = utility;
          bestRisk = risk;
        }
      }

      if (bestEngine) {
        options.push({
          decision: {
            action: 'BUY_TURRET_ENGINE',
            parameters: { slotIndex: i, turretId: bestEngine.id },
            reasoning: `Mount ${bestEngine.name} on slot ${i + 1}`,
          },
          utility: bestUtility,
          risk: bestRisk,
          detail: `Best engine for slot ${i + 1}: ${bestEngine.id}`,
        });
      }
    }

    const allowReplace = emergency || state.enemyAge >= 4;
    if (allowReplace) {
      let weakest: { slotIndex: number; engine: TurretEngineDef; score: number } | null = null;
      for (let i = 0; i < slotsUnlocked; i++) {
        const slot = slots.find((s) => s.slotIndex === i);
        if (!slot?.turretId) continue;
        const engine = getTurretEngineDef(slot.turretId);
        if (!engine) continue;
        const score = this.scoreEngineForContext(engine, ctx);
        if (!weakest || score < weakest.score) {
          weakest = { slotIndex: i, engine, score };
        }
      }

      if (weakest) {
        const refund = Math.floor(weakest.engine.cost * this.getSellRefundMultiplier(state.difficulty));
        const budgetAfterSell = spendableGold + refund;

        let bestReplacement: TurretEngineDef | null = null;
        let bestScore = weakest.score;
        for (const candidate of available) {
          if (candidate.id === weakest.engine.id) continue;
          const cost = this.getDiscountedCost(candidate.cost, state.difficulty, 'turret_engine');
          if (cost > budgetAfterSell || (candidate.manaCost ?? 0) > state.enemyMana) continue;
          const score = this.scoreEngineForContext(candidate, ctx);
          if (score > bestScore * (emergency ? 1.06 : 1.14)) {
            bestScore = score;
            bestReplacement = candidate;
          }
        }

        if (bestReplacement) {
          this.pendingTurretReplacement = { slotIndex: weakest.slotIndex, turretId: bestReplacement.id };
          options.push({
            decision: {
              action: 'SELL_TURRET_ENGINE',
              parameters: { slotIndex: weakest.slotIndex },
              reasoning: `Sell ${weakest.engine.name} to remount ${bestReplacement.name}`,
            },
            utility: 58 + ctx.baseRisk * 14,
            risk: 12,
            detail: `Replace slot ${weakest.slotIndex + 1} ${weakest.engine.id} -> ${bestReplacement.id}`,
          });
        }
      }
    }

    if (options.length === 0) return null;
    options.sort((a, b) => (b.utility - b.risk * 0.58) - (a.utility - a.risk * 0.58));
    return options[0];
  }

  private scoreEngineForContext(engine: TurretEngineDef, ctx: PlannerContext): number {
    const dps = estimateEngineDps(engine);
    const antiHeavy = this.scoreEngineSingleTargetPressure(engine);
    const multi = this.isMultiTargetEngine(engine);

    let score = dps * 2.1 + antiHeavy * 1.3 + engine.range * 13 + (1 - engine.protectionMultiplier) * 1750 + engine.age * 35;

    if (ctx.enemyArmy.isSwarm) score *= multi ? 1.3 : 0.82;
    if (ctx.enemyArmy.isHeavy) score *= multi ? 0.92 : 1.18;
    if (ctx.screenedBacklineThreat) score *= multi ? 1.12 : 1.04;
    if (ctx.immediatePressure > 0) score += (1 - engine.protectionMultiplier) * 900;
    if (ctx.baseRisk > 0.6) score += antiHeavy * 1.4;

    return score;
  }

  private scoreEngineSingleTargetPressure(engine: TurretEngineDef): number {
    if (engine.attackType === 'projectile' && engine.projectile) {
      return (engine.projectile.damage / Math.max(0.1, engine.fireIntervalSec)) * (1 + (engine.projectile.pierceCount ?? 0) * 0.12);
    }
    if (engine.attackType === 'chain_lightning' && engine.chainLightning) {
      return engine.chainLightning.initialDamage / Math.max(0.1, engine.chainLightning.cooldownSeconds);
    }
    if (engine.attackType === 'laser_pulse' && engine.laserPulse) {
      return engine.laserPulse.damage / Math.max(0.1, engine.laserPulse.cooldownSeconds);
    }
    if (engine.attackType === 'mana_siphon' && engine.manaSiphon) {
      return engine.manaSiphon.tickDamage * engine.manaSiphon.ticksPerSecond;
    }
    return estimateEngineDps(engine);
  }

  private isMultiTargetEngine(engine: TurretEngineDef): boolean {
    if (engine.attackType === 'chain_lightning' || engine.attackType === 'artillery_barrage' || engine.attackType === 'oil_pour' || engine.attackType === 'flamethrower') {
      return true;
    }
    if (engine.attackType !== 'projectile' || !engine.projectile) return false;
    return (engine.projectile.splashRadius ?? 0) > 0 || !!engine.projectile.splitOnImpact || (engine.projectile.pierceCount ?? 0) > 1;
  }

  private getTargetSlotsByAge(age: number, mana: number, gameTime: number): number {
    if (age < 3) return 1;
    if (age < 5) return 2;
    if (age < 6) return 3;
    if (mana < 5000 || gameTime < 150) return 3;
    return 4;
  }

  private pickEmergencyFallback(state: GameStateSnapshot, maxGold: number, ctx: PlannerContext): string | null {
    const units = getUnitsForAge(state.enemyAge);
    let bestUnit: string | null = null;
    let bestScore = -Infinity;

    for (const [unitId, def] of Object.entries(units)) {
      const cost = this.getDiscountedCost(def.cost, state.difficulty, 'unit');
      const manaCost = def.manaCost ?? 0;
      if (cost > maxGold || manaCost > state.enemyMana) continue;

      const profile = this.buildUnitProfile(unitId, def, state.difficulty);
      const onField = state.enemyUnits.filter((u) => u.unitId === unitId).length;
      const recentSame = this.recentRecruitHistory.slice(-5).filter((u) => u === unitId).length;
      const spamPenalty = onField * 3.5 + recentSame * 5.5;
      const fallbackScore =
        profile.health * 0.15 +
        profile.frontlineWeight * 34 +
        profile.dps * 0.9 +
        profile.range * 1.6 -
        cost * 0.15 -
        spamPenalty -
        (ctx.stallPressure > 0.58 && profile.range < 2.2 ? 18 : 0) +
        (ctx.enemyArmy.rangedMass && profile.range < 2.5 ? 10 : 0);

      if (fallbackScore > bestScore) {
        bestScore = fallbackScore;
        bestUnit = unitId;
      }
    }

    return bestUnit;
  }

  private getCheapestAvailableUnitCost(state: GameStateSnapshot): number {
    const units = Object.values(getUnitsForAge(state.enemyAge));
    let cheapest = Infinity;
    for (const def of units) {
      if ((def.manaCost ?? 0) > state.enemyMana) continue;
      const cost = this.getDiscountedCost(def.cost, state.difficulty, 'unit');
      if (cost < cheapest) cheapest = cost;
    }
    return Number.isFinite(cheapest) ? cheapest : Number.MAX_SAFE_INTEGER;
  }

  private computeDiversityPenalty(
    unitId: string,
    state: GameStateSnapshot,
    ctx: PlannerContext,
    profile: UnitProfile
  ): number {
    const onField = state.enemyUnits.filter((u) => u.unitId === unitId).length;
    const total = Math.max(1, state.enemyUnitCount);
    const share = onField / total;
    let penalty = 0;

    if (onField >= 2) penalty += (onField - 1) * 4;
    if (share > 0.45) penalty += (share - 0.45) * 40;

    const recentSame = this.recentRecruitHistory.slice(-4).filter((u) => u === unitId).length;
    penalty += recentSame * 3;

    // Age-1 anti-clubman spam guard: force slinger/screen diversity.
    if (state.enemyAge === 1 && unitId === 'stone_clubman') {
      const slingerCount = state.enemyUnits.filter((u) => u.unitId === 'stone_slinger').length;
      if (onField >= 2 && slingerCount < Math.max(1, Math.floor(onField / 2))) {
        penalty += 14;
      }
      if (ctx.compositionNeeds.ranged > 0.22) penalty += 8;
    }

    // If ranged coverage is needed, punish another melee-only pick.
    if (ctx.compositionNeeds.ranged > 0.2 && profile.rangedWeight < 0.4) {
      penalty += ctx.compositionNeeds.ranged * 18;
    }
    // If frontline is missing, punish pure backline picks.
    if (ctx.compositionNeeds.frontline > 0.25 && profile.frontlineWeight < 0.35) {
      penalty += ctx.compositionNeeds.frontline * 16;
    }

    return penalty;
  }

  private buildActionSpaceMap(state: GameStateSnapshot, reserve: ReservePolicy): Record<string, unknown> {
    const units = Object.values(getUnitsForAge(state.enemyAge));
    const affordableUnits = units.filter((u) => {
      const cost = this.getDiscountedCost(u.cost, state.difficulty, 'unit');
      return cost <= reserve.spendableGold && (u.manaCost ?? 0) <= state.enemyMana;
    }).length;

    const canAgeUp = state.enemyAge < 6 && state.enemyGold >= state.enemyAgeCost;
    const canManaUp = getManaCost(state.enemyManaLevel) <= reserve.spendableGold;
    const canTurretSlotUp =
      state.enemyTurretSlotsUnlocked < 4 &&
      this.getDiscountedCost(getTurretSlotUnlockCost(state.enemyTurretSlotsUnlocked), state.difficulty, 'turret_upgrade') <= reserve.spendableGold;

    const engines = Object.values(getTurretEnginesForAge(state.enemyAge));
    const affordableEngines = engines.filter((e) => {
      const cost = this.getDiscountedCost(e.cost, state.difficulty, 'turret_engine');
      return cost <= reserve.spendableGold && (e.manaCost ?? 0) <= state.enemyMana;
    }).length;

    const emptySlots = state.enemyTurretSlots
      .filter((s) => s.slotIndex < state.enemyTurretSlotsUnlocked && !s.turretId)
      .length;

    return {
      legalActions: {
        recruitUnit: affordableUnits > 0,
        ageUp: canAgeUp,
        upgradeMana: canManaUp,
        upgradeTurretSlots: canTurretSlotUp,
        buyTurret: emptySlots > 0 && affordableEngines > 0,
        sellTurret: state.enemyTurretSlots.some((s) => !!s.turretId),
        repairBase: state.enemyAge >= 6 && state.enemyMana >= 500 && state.enemyBaseHealth < state.enemyBaseMaxHealth,
      },
      counts: {
        affordableUnits,
        affordableEngines,
        emptySlots,
      },
    };
  }

  private estimateUnitDps(def: UnitDef | undefined, baseDamage: number): number {
    const atkSpeed = def?.attackSpeed ?? 1;
    return baseDamage * atkSpeed;
  }

  private estimateUnitBurstDps(def: UnitDef | undefined, baseDamage: number): number {
    if (!def) return 0;
    let burst = 0;

    if (def.burstFire) {
      const cooldown = Math.max(0.35, def.burstFire.burstCooldown / 1000);
      burst += (baseDamage * Math.max(0, def.burstFire.shots - 1)) / cooldown;
    }

    if (def.skill) {
      const cooldown = Math.max(0.3, def.skill.cooldownMs / 1000);
      if (def.skill.type === 'direct') {
        burst += Math.max(def.skill.power, def.skill.damage ?? 0) / cooldown;
      } else if (def.skill.type === 'aoe') {
        burst += Math.max(def.skill.damage ?? def.skill.power, 0) * 1.2 / cooldown;
      } else if (def.skill.type === 'flamethrower') {
        burst += Math.max(def.skill.power, 0) * 2.8;
      } else if (def.skill.type === 'heal') {
        burst += Math.max(def.skill.power, 0) * 0.45 / cooldown;
      }
    }

    return burst;
  }

  private estimateUnitAoeDps(def: UnitDef | undefined, baseDamage: number): number {
    if (!def) return 0;
    let aoe = 0;

    if (def.skill?.type === 'aoe') {
      const cooldown = Math.max(0.4, def.skill.cooldownMs / 1000);
      const dmg = def.skill.damage ?? def.skill.power;
      aoe += Math.max(0, dmg) * 0.9 / cooldown;
    }

    if (def.skill?.type === 'flamethrower') {
      aoe += Math.max(0, def.skill.power) * 1.5;
    }

    if (def.role?.includes('SIEGE')) {
      aoe += baseDamage * 0.15;
    }

    return aoe;
  }

  private getUnitRoleWeights(def: UnitDef | undefined, stateUnit: { health: number; range: number }): RoleWeights {
    const roles = def?.role ?? [];

    const has = (r: string) => roles.includes(r as any);

    const ranged = has('RANGED_DPS') || has('SUPPORT') || stateUnit.range > 2.5 ? 1 : 0;
    const frontline = has('FRONTLINE') || has('TANK') || has('BRUISER') || stateUnit.range <= 2.2 ? 1 : 0;
    const support = has('SUPPORT') || def?.skill?.type === 'heal' ? 1 : 0;
    const siege = has('SIEGE') || def?.skill?.type === 'aoe' || def?.skill?.type === 'flamethrower' ? 1 : 0;
    const tank = has('TANK') || stateUnit.health >= 320 ? 1 : 0;

    return {
      frontline,
      ranged,
      support,
      siege,
      tank,
    };
  }

  private getUnitSpeed(def: UnitDef | undefined): number {
    return Math.max(0.5, def?.speed ?? 5);
  }

  private computeFormationStability(units: GameStateSnapshot['enemyUnits'], playerBaseX: number): number {
    if (units.length === 0) return 0;

    const frontlinePositions: number[] = [];
    const rangedUnits: Array<{ position: number; range: number }> = [];

    for (const unit of units) {
      const def = UNIT_DEFS[unit.unitId];
      const roles = this.getUnitRoleWeights(def, { health: unit.health, range: unit.range });
      if (roles.frontline > 0.5) {
        frontlinePositions.push(unit.position);
      }
      if (roles.ranged > 0.5) {
        rangedUnits.push({ position: unit.position, range: unit.range });
      }
    }

    let coveredBackline = 0;
    for (const ranged of rangedUnits) {
      const hasCover = frontlinePositions.some((frontPos) => {
        const frontDistToPlayer = Math.abs(frontPos - playerBaseX);
        const rangedDistToPlayer = Math.abs(ranged.position - playerBaseX);
        return frontDistToPlayer + 1.2 < rangedDistToPlayer;
      });
      if (hasCover) coveredBackline += 1;
    }

    const coverRatio = rangedUnits.length > 0 ? coveredBackline / rangedUnits.length : frontlinePositions.length > 0 ? 1 : 0;

    const center = units.reduce((sum, u) => sum + u.position, 0) / units.length;
    const spread = Math.sqrt(
      units.reduce((sum, u) => {
        const d = u.position - center;
        return sum + d * d;
      }, 0) / units.length
    );

    const cohesion = this.clamp(1 - spread / 22, 0, 1);
    return this.clamp(coverRatio * 0.62 + cohesion * 0.38, 0, 1);
  }

  private getDiscountedCost(baseCost: number, difficulty: GameStateSnapshot['difficulty'], kind: CostKind): number {
    let mult = 1.0;
    if (difficulty === 'MEDIUM') mult = 0.8;
    else if (difficulty === 'HARD') mult = 0.65;
    else if (difficulty === 'SMART' || difficulty === 'SMART_ML') mult = kind === 'unit' ? 0.65 : 0.8;
    else if (difficulty === 'CHEATER') mult = 0.5;
    return Math.floor(baseCost * mult);
  }

  private getSellRefundMultiplier(difficulty: GameStateSnapshot['difficulty']): number {
    if (difficulty === 'EASY') return 0.5;
    if (difficulty === 'MEDIUM' || difficulty === 'SMART' || difficulty === 'SMART_ML') return 0.6;
    if (difficulty === 'HARD') return 0.8;
    return 1.0;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  private sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x));
  }
}
