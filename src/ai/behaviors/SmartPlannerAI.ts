import {
  IAIBehavior,
  GameStateSnapshot,
  AIDecision,
  ThreatLevel,
  StrategicState,
  AIBehaviorUtils,
} from '../AIBehavior';
import { AIPersonality, AI_TUNING } from '../../config/aiConfig';
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
type WaveTag = 'tempo' | 'siege' | 'anti_swarm' | 'anti_tank' | 'defense' | 'mana_heavy';
type CostKind = 'unit' | 'turret_upgrade' | 'turret_engine';

interface WavePlan {
  id: string;
  age: number;
  name: string;
  tags: WaveTag[];
  units: string[];
}

interface ActiveWave {
  planId: string;
  goal: GoalId;
  units: string[];
  index: number;
  startedAtSec: number;
}

interface PlannerContext {
  threatLevel: ThreatLevel;
  strategicState: StrategicState;
  outnumberRatio: number;
  playerPower: number;
  enemyPower: number;
  baseHealthRatio: number;
  playerBaseHealthRatio: number;
  directPressure: number;
  laneOpportunity: number;
  swarmPressure: boolean;
  heavyPressure: boolean;
  hasFrontline: boolean;
  ageLead: number;
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

interface StageRow {
  stage: string;
  status: 'info' | 'candidate' | 'selected' | 'skipped';
  detail: string;
  action?: string;
}

const WAVE_LIBRARY: Record<number, WavePlan[]> = {
  1: [
    { id: 'a1_skirmish_line', age: 1, name: 'Skirmish Line', tags: ['tempo'], units: ['stone_clubman', 'stone_clubman', 'stone_slinger', 'stone_slinger', 'stone_slinger'] },
    { id: 'a1_dino_screen', age: 1, name: 'Dino Screen', tags: ['defense', 'anti_tank'], units: ['stone_dino', 'stone_slinger', 'stone_slinger', 'stone_slinger'] },
    { id: 'a1_pressure_mix', age: 1, name: 'Pressure Mix', tags: ['tempo', 'defense'], units: ['stone_clubman', 'stone_dino', 'stone_slinger', 'stone_slinger', 'stone_slinger', 'stone_slinger', 'stone_slinger'] },
    { id: 'a1_light_probe', age: 1, name: 'Light Probe', tags: ['tempo'], units: ['stone_clubman', 'stone_slinger', 'stone_slinger'] },
  ],
  2: [
    { id: 'a2_phalanx_arrow', age: 2, name: 'Phalanx + Arrow', tags: ['tempo'], units: ['bronze_spearman', 'bronze_spearman', 'bronze_archer', 'bronze_archer', 'bronze_archer'] },
    { id: 'a2_siege_anchor', age: 2, name: 'Siege Anchor', tags: ['siege', 'anti_swarm'], units: ['bronze_spearman', 'bronze_catapult', 'bronze_archer', 'bronze_archer'] },
    { id: 'a2_defense_spine', age: 2, name: 'Defense Spine', tags: ['defense', 'anti_tank'], units: ['bronze_spearman', 'bronze_spearman', 'bronze_spearman', 'bronze_archer'] },
    { id: 'a2_burst_probe', age: 2, name: 'Burst Probe', tags: ['tempo'], units: ['bronze_spearman', 'bronze_archer', 'bronze_archer', 'bronze_archer'] },
  ],
  3: [
    { id: 'a3_iron_wall', age: 3, name: 'Iron Wall', tags: ['defense', 'anti_tank'], units: ['iron_knight', 'iron_knight', 'iron_crossbow', 'iron_crossbow', 'battle_monk'] },
    { id: 'a3_elephant_breaker', age: 3, name: 'Elephant Breaker', tags: ['siege', 'anti_tank'], units: ['war_elephant', 'iron_crossbow', 'iron_crossbow', 'battle_monk'] },
    { id: 'a3_spell_battery', age: 3, name: 'Spell Battery', tags: ['anti_swarm', 'mana_heavy'], units: ['iron_knight', 'iron_mage', 'iron_mage', 'iron_crossbow'] },
    { id: 'a3_tempo_lance', age: 3, name: 'Tempo Lance', tags: ['tempo'], units: ['iron_knight', 'iron_crossbow', 'battle_monk', 'iron_crossbow'] },
  ],
  4: [
    { id: 'a4_steel_pivot', age: 4, name: 'Steel Pivot', tags: ['defense', 'anti_tank'], units: ['steel_tank', 'artillery', 'medic', 'heavy_cavalry'] },
    { id: 'a4_siege_column', age: 4, name: 'Siege Column', tags: ['siege', 'anti_swarm'], units: ['steel_tank', 'artillery', 'siege_engineer', 'heavy_cavalry'] },
    { id: 'a4_counter_lance', age: 4, name: 'Counter Lance', tags: ['tempo', 'defense'], units: ['heavy_cavalry', 'heavy_cavalry', 'artillery', 'medic'] },
    { id: 'a4_mixed_pressure', age: 4, name: 'Mixed Pressure', tags: ['tempo', 'siege'], units: ['steel_tank', 'heavy_cavalry', 'artillery', 'siege_engineer', 'medic'] },
  ],
  5: [
    { id: 'a5_inferno_line', age: 5, name: 'Inferno Line', tags: ['anti_swarm', 'mana_heavy'], units: ['energy_shield', 'flamethrower', 'pyro_maniac', 'gunner', 'sniper'] },
    { id: 'a5_hammer_anvil', age: 5, name: 'Hammer & Anvil', tags: ['anti_tank'], units: ['steam_mech', 'energy_shield', 'gunner', 'sniper'] },
    { id: 'a5_pressure_grid', age: 5, name: 'Pressure Grid', tags: ['tempo', 'defense'], units: ['energy_shield', 'gunner', 'gunner', 'sniper', 'medic'] },
    { id: 'a5_vampire_surge', age: 5, name: 'Vampire Surge', tags: ['mana_heavy', 'siege'], units: ['steam_mech', 'mana_vampire', 'flamethrower', 'sniper'] },
  ],
  6: [
    { id: 'a6_mech_lance', age: 6, name: 'Mech Lance', tags: ['anti_tank', 'siege'], units: ['mech_walker', 'laser_trooper', 'plasma_striker', 'burst_gunner'] },
    { id: 'a6_swarm_erase', age: 6, name: 'Swarm Erase', tags: ['anti_swarm', 'mana_heavy'], units: ['robot_soldier', 'nanoswarm', 'nanoswarm', 'dark_cultist'] },
    { id: 'a6_titan_push', age: 6, name: 'Titan Push', tags: ['siege', 'anti_tank'], units: ['titan_mech', 'laser_trooper', 'burst_gunner', 'cyber_assassin'] },
    { id: 'a6_tempo_hunt', age: 6, name: 'Tempo Hunt', tags: ['tempo'], units: ['robot_soldier', 'cyber_assassin', 'laser_trooper', 'plasma_striker'] },
  ],
};

export class SmartPlannerAI implements IAIBehavior {
  private name = 'SmartPlannerAI';
  private lastAgeUpTime = 0;
  private activeWave: ActiveWave | null = null;
  private pendingTurretReplacement: { slotIndex: number; turretId: string } | null = null;
  private debugData: Record<string, any> = {};

  getName(): string {
    return this.name;
  }

  getParameters(): Record<string, any> {
    return {
      ...this.debugData,
      lastAgeUpTime: this.lastAgeUpTime,
      activeWave: this.activeWave,
      pendingTurretReplacement: this.pendingTurretReplacement,
    };
  }

  setParameters(params: Record<string, any>): void {
    if (typeof params.lastAgeUpTime === 'number') this.lastAgeUpTime = params.lastAgeUpTime;
    if (params.activeWave) this.activeWave = params.activeWave;
    if (params.pendingTurretReplacement) this.pendingTurretReplacement = params.pendingTurretReplacement;
  }

  reset(): void {
    this.lastAgeUpTime = 0;
    this.activeWave = null;
    this.pendingTurretReplacement = null;
    this.debugData = {};
  }

  decide(state: GameStateSnapshot, personality: AIPersonality): AIDecision {
    const stages: StageRow[] = [];
    const pushStage = (stage: string, status: StageRow['status'], detail: string, action?: string) => {
      stages.push({ stage, status, detail, action });
    };

    const ctx = this.buildContext(state);
    const warchest = AIBehaviorUtils.calculateWarchest(state, state.gameTime - this.lastAgeUpTime, state.difficulty);
    const emergencyUnlock = ctx.baseHealthRatio < 0.42 && ctx.directPressure > 0;
    const ageReserve = emergencyUnlock ? 0 : Math.min(state.enemyAgeCost, warchest);
    const spendableGold = Math.max(0, state.enemyGold - ageReserve);

    pushStage(
      '1) Situation',
      'info',
      `Threat ${ctx.threatLevel}, Outnumber ${ctx.outnumberRatio.toFixed(2)}x, Base ${Math.round(ctx.baseHealthRatio * 100)}%, Spendable ${Math.floor(spendableGold)}g`
    );

    const goalScores = this.scoreGoals(state, ctx);
    const goalSummary = goalScores.map((g) => `${g.goal}:${g.score.toFixed(1)}`).join(' | ');
    pushStage('2) Goal Priorities', 'info', goalSummary);

    const candidates: Candidate[] = [];
    for (const goal of goalScores) {
      this.addGoalCandidates(goal.goal, state, ctx, spendableGold, personality, candidates);
    }

    if (candidates.length === 0) {
      const fallback = this.pickAnyAffordableFrontline(state, state.enemyGold);
      if (fallback) {
        const decision: AIDecision = {
          action: 'RECRUIT_UNIT',
          parameters: { unitType: fallback, priority: 'emergency' },
          reasoning: `Failsafe frontline deploy: ${fallback}`,
        };
        this.commitDecision(state, decision, stages, 'Fallback anti-passive recruit');
        return decision;
      }
      const waitDecision: AIDecision = {
        action: 'WAIT',
        reasoning: 'Planner found no affordable high-value action this tick',
      };
      this.commitDecision(state, waitDecision, stages, 'No feasible candidates');
      return waitDecision;
    }

    for (const c of candidates) {
      pushStage(
        `${c.goal} -> ${c.stage}`,
        'candidate',
        `${c.detail} | utility ${c.utility.toFixed(1)} | risk ${c.risk.toFixed(1)}`,
        c.decision.action
      );
    }

    candidates.sort((a, b) => (b.utility - b.risk * 0.6) - (a.utility - a.risk * 0.6));
    const chosen = candidates[0];
    pushStage(`${chosen.goal} -> ${chosen.stage}`, 'selected', chosen.detail, chosen.decision.action);
    this.commitDecision(state, chosen.decision, stages, chosen.detail);
    return chosen.decision;
  }

  private commitDecision(state: GameStateSnapshot, decision: AIDecision, decisionStages: StageRow[], summary: string): void {
    if (decision.action === 'AGE_UP') {
      this.lastAgeUpTime = state.gameTime;
      this.activeWave = null;
    }

    if (decision.action === 'RECRUIT_UNIT') {
      const queuedUnit = (decision.parameters as any)?.unitType;
      if (this.activeWave && queuedUnit) {
        const expected = this.activeWave.units[this.activeWave.index];
        if (expected === queuedUnit) {
          this.activeWave.index += 1;
          if (this.activeWave.index >= this.activeWave.units.length) {
            this.activeWave = null;
          }
        }
      }
    }

    if (decision.action === 'SELL_TURRET_ENGINE' && this.pendingTurretReplacement) {
      // Wait for next tick to place the replacement
    } else if (decision.action === 'BUY_TURRET_ENGINE') {
      this.pendingTurretReplacement = null;
    }

    const futurePlan = this.buildFuturePlan(state);
    this.debugData = {
      strategy: this.activeWave?.goal ?? 'ADAPTIVE',
      plan: this.activeWave ? `${this.activeWave.goal}: ${this.activeWave.planId} ${this.activeWave.index}/${this.activeWave.units.length}` : 'Adaptive instant planning',
      futurePlan,
      decisionStages,
      nextAction: decision.action,
      nextReason: decision.reasoning,
      decisionOutcome: { action: decision.action, reason: decision.reasoning || summary },
      warchest: Math.floor(AIBehaviorUtils.calculateWarchest(state, state.gameTime - this.lastAgeUpTime, state.difficulty)),
      wcTarget: state.enemyAgeCost,
      pushEst: `${Math.round(this.buildContext(state).enemyPower)} vs ${Math.round(this.buildContext(state).playerPower)}`,
    };
  }

  private buildFuturePlan(state: GameStateSnapshot): string[] {
    const plan: string[] = [];
    if (this.activeWave) {
      const nextUnit = this.activeWave.units[this.activeWave.index] ?? 'complete';
      plan.push(`Wave ${this.activeWave.planId}: next ${nextUnit}`);
    } else {
      plan.push('Select next wave based on updated battlefield pressure');
    }
    if (this.pendingTurretReplacement) {
      const def = getTurretEngineDef(this.pendingTurretReplacement.turretId);
      if (def) {
        plan.push(`Rebuild slot ${this.pendingTurretReplacement.slotIndex + 1} with ${def.name}`);
      }
    }
    const nextSlotGoal = this.getTargetSlotsByAge(state.enemyAge, state.enemyMana, state.gameTime);
    plan.push(`Turret slot objective: ${state.enemyTurretSlotsUnlocked}/${nextSlotGoal}`);
    if (state.enemyAge < 6) {
      plan.push(`Tech goal: Age ${state.enemyAge + 1} @ ${state.enemyAgeCost}g`);
    }
    return plan.slice(0, 5);
  }

  private buildContext(state: GameStateSnapshot): PlannerContext {
    const threatDetails = AIBehaviorUtils.assessThreatDetails(state);
    const baseHealthRatio = state.enemyBaseHealth / Math.max(1, state.enemyBaseMaxHealth);
    const playerBaseHealthRatio = state.playerBaseHealth / Math.max(1, state.playerBaseMaxHealth);
    const outnumberRatio = state.playerUnitCount / Math.max(1, state.enemyUnitCount);
    const avgEnemyHealth = state.playerUnits.length > 0
      ? state.playerUnits.reduce((sum, u) => sum + u.health, 0) / state.playerUnits.length
      : 0;
    const heavyPressure = state.playerUnits.filter((u) => u.health >= 320).length >= 2 || avgEnemyHealth >= 280;
    const swarmPressure = state.playerUnitCount >= Math.max(6, state.enemyUnitCount + 3) || (state.playerUnitCount >= 4 && avgEnemyHealth < 180);
    const hasFrontline = state.enemyUnits.some((u) => {
      const def = UNIT_DEFS[u.unitId];
      return !!def && ((def.range ?? 1) < 2.5 || def.health >= 220);
    });

    return {
      threatLevel: threatDetails.level,
      strategicState: AIBehaviorUtils.getStrategicState(state, threatDetails.level),
      outnumberRatio,
      playerPower: threatDetails.playerScore,
      enemyPower: threatDetails.enemyScore,
      baseHealthRatio,
      playerBaseHealthRatio,
      directPressure: state.playerUnitsNearEnemyBase,
      laneOpportunity: state.enemyUnitsNearPlayerBase,
      swarmPressure,
      heavyPressure,
      hasFrontline,
      ageLead: state.enemyAge - state.playerAge,
    };
  }

  private scoreGoals(state: GameStateSnapshot, ctx: PlannerContext): GoalScore[] {
    const survive =
      (ctx.directPressure * 28) +
      (Math.max(0, ctx.outnumberRatio - 1) * 55) +
      ((1 - ctx.baseHealthRatio) * 70) +
      (ctx.threatLevel === ThreatLevel.CRITICAL ? 80 : ctx.threatLevel === ThreatLevel.HIGH ? 35 : 0);

    const stabilize =
      40 +
      (ctx.hasFrontline ? 8 : 20) +
      (ctx.swarmPressure ? 12 : 0) +
      (ctx.heavyPressure ? 8 : 0);

    const press =
      (ctx.laneOpportunity * 18) +
      (Math.max(0, 1 - ctx.outnumberRatio) * 45) +
      ((1 - ctx.playerBaseHealthRatio) * 35) +
      (ctx.ageLead > 0 ? 20 : 0);

    const tech =
      (state.enemyAge < 6 ? 30 : 0) +
      (state.enemyAge < state.playerAge ? 35 : 0) +
      (state.enemyGold >= state.enemyAgeCost ? 25 : 0) -
      (ctx.directPressure * 15);

    const rows: GoalScore[] = [
      { goal: 'SURVIVE', score: survive, reason: 'Immediate base safety and frontline integrity' },
      { goal: 'STABILIZE', score: stabilize, reason: 'Maintain lane control with efficient mixed responses' },
      { goal: 'PRESS', score: press, reason: 'Capitalize on tempo windows and enemy weakness' },
      { goal: 'TECH', score: tech, reason: 'Secure age progression timing and economy scaling' },
    ];

    rows.sort((a, b) => b.score - a.score);
    return rows;
  }

  private addGoalCandidates(
    goal: GoalId,
    state: GameStateSnapshot,
    ctx: PlannerContext,
    spendableGold: number,
    personality: AIPersonality,
    candidates: Candidate[]
  ): void {
    if (goal === 'SURVIVE') {
      this.addSurvivalCandidates(state, ctx, spendableGold, candidates);
      return;
    }
    if (goal === 'TECH') {
      this.addTechCandidates(state, ctx, spendableGold, candidates);
      return;
    }
    if (goal === 'PRESS') {
      this.addPressCandidates(state, ctx, spendableGold, candidates);
      return;
    }
    this.addStabilizeCandidates(state, ctx, spendableGold, personality, candidates);
  }

  private addSurvivalCandidates(state: GameStateSnapshot, ctx: PlannerContext, spendableGold: number, candidates: Candidate[]): void {
    const fallback = this.pickBestDefensiveUnit(state, Math.max(spendableGold, state.enemyGold));
    if (fallback) {
      candidates.push({
        goal: 'SURVIVE',
        stage: 'Emergency Recruit',
        utility: 92 + (ctx.directPressure * 6),
        risk: 8,
        detail: `Recruit defensive anchor ${fallback}`,
        decision: {
          action: 'RECRUIT_UNIT',
          parameters: { unitType: fallback, priority: 'emergency' },
          reasoning: `Emergency frontline stabilization with ${fallback}`,
        },
      });
    }

    const turretAction = this.planTurretAction(state, spendableGold, ctx, true);
    if (turretAction) {
      candidates.push({
        goal: 'SURVIVE',
        stage: 'Turret Emergency',
        utility: 88,
        risk: 11,
        detail: turretAction.reasoning || 'Emergency turret response',
        decision: turretAction,
      });
    }

    if (state.enemyAge >= 6 && state.enemyMana >= 500 && state.enemyBaseHealth < state.enemyBaseMaxHealth * 0.8) {
      candidates.push({
        goal: 'SURVIVE',
        stage: 'Base Sustain',
        utility: 72,
        risk: 5,
        detail: 'Repair base while under attrition',
        decision: { action: 'REPAIR_BASE', reasoning: 'Use mana to restore base durability during pressure' },
      });
    }
  }

  private addStabilizeCandidates(
    state: GameStateSnapshot,
    ctx: PlannerContext,
    spendableGold: number,
    _personality: AIPersonality,
    candidates: Candidate[]
  ): void {
    const waveDecision = this.planWaveRecruit(state, 'STABILIZE', spendableGold, ctx);
    if (waveDecision) {
      candidates.push({
        goal: 'STABILIZE',
        stage: 'Wave Build',
        utility: 74,
        risk: 9,
        detail: waveDecision.reasoning || 'Build balanced wave',
        decision: waveDecision,
      });
    }

    const turretAction = this.planTurretAction(state, spendableGold, ctx, false);
    if (turretAction) {
      candidates.push({
        goal: 'STABILIZE',
        stage: 'Coverage Upgrade',
        utility: 63,
        risk: 10,
        detail: turretAction.reasoning || 'Improve turret coverage',
        decision: turretAction,
      });
    }

    const manaDecision = this.planManaUpgrade(state, spendableGold, ctx);
    if (manaDecision) {
      candidates.push({
        goal: 'STABILIZE',
        stage: 'Mana Scaling',
        utility: 50,
        risk: 6,
        detail: manaDecision.reasoning || 'Mana income pacing',
        decision: manaDecision,
      });
    }
  }

  private addPressCandidates(state: GameStateSnapshot, ctx: PlannerContext, spendableGold: number, candidates: Candidate[]): void {
    const waveDecision = this.planWaveRecruit(state, 'PRESS', spendableGold, ctx);
    if (waveDecision) {
      candidates.push({
        goal: 'PRESS',
        stage: 'Assault Wave',
        utility: 78 + (ctx.laneOpportunity * 3),
        risk: 12,
        detail: waveDecision.reasoning || 'Prepare pressure wave',
        decision: waveDecision,
      });
    }

    if (state.enemyAge < 6 && state.enemyGold >= state.enemyAgeCost && ctx.directPressure === 0 && ctx.outnumberRatio <= 1.05) {
      candidates.push({
        goal: 'PRESS',
        stage: 'Power Spike',
        utility: 70,
        risk: 11,
        detail: `Age up to secure higher-tech push power`,
        decision: { action: 'AGE_UP', reasoning: `Press advantage via Age ${state.enemyAge + 1} timing spike` },
      });
    }
  }

  private addTechCandidates(state: GameStateSnapshot, ctx: PlannerContext, spendableGold: number, candidates: Candidate[]): void {
    if (state.enemyAge < 6 && state.enemyGold >= state.enemyAgeCost && ctx.directPressure <= 1 && ctx.outnumberRatio <= 1.25) {
      candidates.push({
        goal: 'TECH',
        stage: 'Age Transition',
        utility: 84,
        risk: 10,
        detail: `Advance to Age ${state.enemyAge + 1}`,
        decision: { action: 'AGE_UP', reasoning: `Tech ladder priority: age ${state.enemyAge} -> ${state.enemyAge + 1}` },
      });
    }

    const manaDecision = this.planManaUpgrade(state, spendableGold, ctx);
    if (manaDecision) {
      candidates.push({
        goal: 'TECH',
        stage: 'Mana Infrastructure',
        utility: 62,
        risk: 8,
        detail: manaDecision.reasoning || 'Upgrade mana economy',
        decision: manaDecision,
      });
    }

    const turretAction = this.planTurretAction(state, spendableGold, ctx, false);
    if (turretAction) {
      candidates.push({
        goal: 'TECH',
        stage: 'Defensive Tech',
        utility: 58,
        risk: 9,
        detail: turretAction.reasoning || 'Tech-side turret action',
        decision: turretAction,
      });
    }
  }

  private planWaveRecruit(state: GameStateSnapshot, goal: GoalId, spendableGold: number, ctx: PlannerContext): AIDecision | null {
    if (state.enemyQueueSize >= 5) return null;

    if (!this.activeWave || this.activeWave.goal !== goal || this.activeWave.index >= this.activeWave.units.length) {
      this.activeWave = this.selectWavePlan(state, goal, ctx);
    }
    if (!this.activeWave) return null;

    while (this.activeWave && this.activeWave.index < this.activeWave.units.length) {
      const nextUnitId = this.activeWave.units[this.activeWave.index];
      const nextDef = UNIT_DEFS[nextUnitId];
      if (!nextDef || (nextDef.age ?? 1) > state.enemyAge) {
        this.activeWave.index += 1;
        continue;
      }
      const discountedCost = this.getDiscountedCost(nextDef.cost, state.difficulty, 'unit');
      if (discountedCost > spendableGold) return null;
      if ((nextDef.manaCost ?? 0) > state.enemyMana) return null;
      return {
        action: 'RECRUIT_UNIT',
        parameters: { unitType: nextUnitId, priority: goal === 'PRESS' ? 'high' : 'normal' },
        reasoning: `Wave ${this.activeWave.planId} ${this.activeWave.index + 1}/${this.activeWave.units.length}: ${nextUnitId}`,
      };
    }

    this.activeWave = null;
    return null;
  }

  private selectWavePlan(state: GameStateSnapshot, goal: GoalId, ctx: PlannerContext): ActiveWave | null {
    const plans = WAVE_LIBRARY[state.enemyAge] ?? [];
    if (plans.length === 0) return null;

    let best: WavePlan | null = null;
    let bestScore = -Infinity;

    for (const plan of plans) {
      const totalCost = plan.units.reduce((sum, id) => {
        const def = UNIT_DEFS[id];
        if (!def) return sum;
        return sum + this.getDiscountedCost(def.cost, state.difficulty, 'unit');
      }, 0);

      let score = 20;
      if (goal === 'PRESS' && plan.tags.includes('tempo')) score += 22;
      if (goal === 'PRESS' && plan.tags.includes('siege')) score += 16;
      if (goal === 'SURVIVE' && plan.tags.includes('defense')) score += 22;
      if (ctx.swarmPressure && plan.tags.includes('anti_swarm')) score += 20;
      if (ctx.heavyPressure && plan.tags.includes('anti_tank')) score += 20;
      if (state.enemyMana >= 120 && plan.tags.includes('mana_heavy')) score += 8;
      if (totalCost <= state.enemyGold * 1.3) score += 10;

      if (score > bestScore) {
        best = plan;
        bestScore = score;
      }
    }

    if (!best) return null;
    return {
      planId: best.id,
      goal,
      units: [...best.units],
      index: 0,
      startedAtSec: state.gameTime,
    };
  }

  private planManaUpgrade(state: GameStateSnapshot, spendableGold: number, ctx: PlannerContext): AIDecision | null {
    if (state.enemyAge <= 1) return null;
    const target = AI_TUNING.manaUpgrades.targetLevelsByAge[state.enemyAge] ?? 0;
    if (state.enemyManaLevel >= target + 1 && state.enemyMana > 100) return null;
    const cost = this.getDiscountedCost(getManaCost(state.enemyManaLevel), state.difficulty, 'unit');
    if (cost > spendableGold) return null;
    if (ctx.directPressure >= 2 && !ctx.hasFrontline) return null;
    return {
      action: 'UPGRADE_MANA',
      reasoning: `Mana infrastructure: level ${state.enemyManaLevel} -> ${state.enemyManaLevel + 1}`,
    };
  }

  private planTurretAction(
    state: GameStateSnapshot,
    spendableGold: number,
    ctx: PlannerContext,
    emergency: boolean
  ): AIDecision | null {
    const slotsUnlocked = state.enemyTurretSlotsUnlocked ?? 1;
    const slots = state.enemyTurretSlots ?? [];
    const available = Object.values(getTurretEnginesForAge(state.enemyAge));
    if (available.length === 0) return null;

    if (this.pendingTurretReplacement) {
      const slot = slots.find((s) => s.slotIndex === this.pendingTurretReplacement!.slotIndex);
      const target = getTurretEngineDef(this.pendingTurretReplacement.turretId);
      if (slot && !slot.turretId && target) {
        const engineCost = this.getDiscountedCost(target.cost, state.difficulty, 'turret_engine');
        if (engineCost <= spendableGold && (target.manaCost ?? 0) <= state.enemyMana) {
          return {
            action: 'BUY_TURRET_ENGINE',
            parameters: { slotIndex: slot.slotIndex, turretId: target.id },
            reasoning: `Re-mount ${target.name} on slot ${slot.slotIndex + 1}`,
          };
        }
      }
      this.pendingTurretReplacement = null;
    }

    const turretNeed = this.getTargetSlotsByAge(state.enemyAge, state.enemyMana, state.gameTime);
    if (slotsUnlocked < turretNeed) {
      const slotCost = this.getDiscountedCost(getTurretSlotUnlockCost(slotsUnlocked), state.difficulty, 'turret_upgrade');
      if (slotCost <= spendableGold && slots.filter((s) => s.slotIndex < slotsUnlocked && !!s.turretId).length >= Math.max(1, slotsUnlocked)) {
        return {
          action: 'UPGRADE_TURRET_SLOTS',
          reasoning: `Unlock slot ${slotsUnlocked + 1}/${turretNeed} for strategic coverage`,
        };
      }
    }

    for (let i = 0; i < slotsUnlocked; i++) {
      const slot = slots.find((s) => s.slotIndex === i);
      if (!slot || slot.turretId) continue;

      const best = [...available]
        .filter((e) => this.getDiscountedCost(e.cost, state.difficulty, 'turret_engine') <= spendableGold && (e.manaCost ?? 0) <= state.enemyMana)
        .sort((a, b) => this.scoreEngineForContext(b, ctx) - this.scoreEngineForContext(a, ctx))[0];
      if (best) {
        return {
          action: 'BUY_TURRET_ENGINE',
          parameters: { slotIndex: i, turretId: best.id },
          reasoning: `Mount ${best.name} on slot ${i + 1}`,
        };
      }
    }

    const canReplace = emergency || state.enemyAge >= 4;
    if (!canReplace) return null;

    let weakest: { slotIndex: number; score: number; turretId: string } | null = null;
    for (let i = 0; i < slotsUnlocked; i++) {
      const slot = slots.find((s) => s.slotIndex === i);
      if (!slot?.turretId) continue;
      const def = getTurretEngineDef(slot.turretId);
      if (!def) continue;
      const score = this.scoreEngineForContext(def, ctx);
      if (!weakest || score < weakest.score) {
        weakest = { slotIndex: i, score, turretId: def.id };
      }
    }
    if (!weakest) return null;

    const weakestDef = getTurretEngineDef(weakest.turretId);
    if (!weakestDef) return null;
    const refund = Math.floor(weakestDef.cost * this.getSellRefundMultiplier(state.difficulty));
    const budgetAfterSell = spendableGold + refund;
    const better = [...available]
      .filter((e) =>
        e.id !== weakest.turretId &&
        this.getDiscountedCost(e.cost, state.difficulty, 'turret_engine') <= budgetAfterSell &&
        (e.manaCost ?? 0) <= state.enemyMana
      )
      .sort((a, b) => this.scoreEngineForContext(b, ctx) - this.scoreEngineForContext(a, ctx))[0];

    if (better && this.scoreEngineForContext(better, ctx) > weakest.score * (emergency ? 1.05 : 1.15)) {
      this.pendingTurretReplacement = { slotIndex: weakest.slotIndex, turretId: better.id };
      return {
        action: 'SELL_TURRET_ENGINE',
        parameters: { slotIndex: weakest.slotIndex },
        reasoning: `Replace weak turret in slot ${weakest.slotIndex + 1} with ${better.name}`,
      };
    }

    return null;
  }

  private scoreEngineForContext(engine: TurretEngineDef, ctx: PlannerContext): number {
    let score = estimateEngineDps(engine) * 2.0 + engine.range * 14 + (1 - engine.protectionMultiplier) * 1700 + engine.age * 30;
    const isMulti = this.isMultiTargetEngine(engine);
    if (ctx.swarmPressure) score *= isMulti ? 1.28 : 0.83;
    if (ctx.heavyPressure) score *= isMulti ? 0.95 : 1.2;
    if (ctx.directPressure > 0) score += (1 - engine.protectionMultiplier) * 900;
    return score;
  }

  private isMultiTargetEngine(engine: TurretEngineDef): boolean {
    if (engine.attackType === 'chain_lightning' || engine.attackType === 'artillery_barrage' || engine.attackType === 'oil_pour' || engine.attackType === 'flamethrower') {
      return true;
    }
    if (engine.attackType !== 'projectile' || !engine.projectile) return false;
    return (engine.projectile.splashRadius ?? 0) > 0 || !!engine.projectile.splitOnImpact || (engine.projectile.pierceCount ?? 0) > 0;
  }

  private getTargetSlotsByAge(age: number, mana: number, gameTime: number): number {
    if (age < 3) return 1;
    if (age < 5) return 2;
    if (age < 6) return 3;
    if (mana < 5000 || gameTime < 150) return 3;
    return 4;
  }

  private pickBestDefensiveUnit(state: GameStateSnapshot, maxGold: number): string | null {
    const units = getUnitsForAge(state.enemyAge);
    let bestId: string | null = null;
    let bestScore = -Infinity;

    for (const [id, def] of Object.entries(units)) {
      const cost = this.getDiscountedCost(def.cost, state.difficulty, 'unit');
      if (cost > maxGold) continue;
      if ((def.manaCost ?? 0) > state.enemyMana) continue;
      if (def.skill?.type === 'heal' && state.enemyUnitCount < 2) continue;

      const frontline = ((def.range ?? 1) < 2.5 || def.health >= 240) ? 1 : 0;
      const value = def.health / Math.max(1, cost) * 45 + def.damage * 0.4 + frontline * 18;
      if (value > bestScore) {
        bestScore = value;
        bestId = id;
      }
    }

    return bestId;
  }

  private pickAnyAffordableFrontline(state: GameStateSnapshot, maxGold: number): string | null {
    const units = getUnitsForAge(state.enemyAge);
    let best: string | null = null;
    let bestScore = -Infinity;
    for (const [id, def] of Object.entries(units)) {
      const cost = this.getDiscountedCost(def.cost, state.difficulty, 'unit');
      if (cost > maxGold) continue;
      if ((def.manaCost ?? 0) > state.enemyMana) continue;
      const frontlineBias = (def.range ?? 1) < 2.5 ? 1.3 : 0.7;
      const score = (def.health + def.damage * 6) * frontlineBias / Math.max(1, cost);
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }
    return best;
  }

  private getDiscountedCost(baseCost: number, difficulty: GameStateSnapshot['difficulty'], kind: CostKind): number {
    let mult = 1.0;
    if (difficulty === 'MEDIUM') mult = 0.8;
    else if (difficulty === 'HARD') mult = 0.65;
    else if (difficulty === 'SMART') mult = kind === 'unit' ? 0.65 : 0.8;
    else if (difficulty === 'CHEATER') mult = 0.5;
    return Math.floor(baseCost * mult);
  }

  private getSellRefundMultiplier(difficulty: GameStateSnapshot['difficulty']): number {
    if (difficulty === 'EASY') return 0.5;
    if (difficulty === 'MEDIUM' || difficulty === 'SMART') return 0.6;
    if (difficulty === 'HARD') return 0.8;
    return 1.0;
  }
}
