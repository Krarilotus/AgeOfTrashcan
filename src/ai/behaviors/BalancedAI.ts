/**
 * Balanced AI Behavior
 * A well-rounded strategy that adapts to situations
 * Balances economy, military, and aggression
 */

import {
  IAIBehavior,
  GameStateSnapshot,
  AIDecision,
  AIBehaviorUtils,
  ThreatLevel,
  StrategicState,
  RecruitUnitParams,
  AttackGroupParams,
} from '../AIBehavior';
import { AIPersonality, AI_TUNING, ATTACK_GROUPS } from '../../config/aiConfig';
import { UNIT_DEFS, getUnitsForAge, UnitDef } from '../../config/units';
import { getManaCost } from '../../config/gameBalance';
import {
  estimateEngineDps,
  getTurretEngineDef,
  getTurretEnginesForAge,
  getTurretSlotUnlockCost,
  type TurretEngineDef,
} from '../../config/turrets';

/**
 * Balanced AI - intelligent, adaptive strategy with warchest system
 */
export class BalancedAI implements IAIBehavior {
  private name = 'BalancedAI';
  private lastAttackGroupTime = 0;
  private lastAgeUpTime = 0; // Track when we last aged up
  private currentGroupPlan: { name: string; units: string[]; index: number } | null = null; // Track multi-unit composition
  private lastStrategySwitch = 0; // Track when we last changed strategy
  private currentStrategy: 'DEFENSIVE' | 'BALANCED' | 'AGGRESSIVE' = 'BALANCED'; // Current stance
  private consecutiveDefenseFrames = 0; // Track defensive urgency
  private currentWarchest = 0; // DEBUG: Current accumulated warchest
  private debugMetrics: any = {}; // Store calculation details for debug UI
  private lastRecruitmentDecision: string = ""; // DEBUG: Store detailed reasoning
  private lastRejectedUnits: string = ""; // DEBUG: Store rejection reasons
  private pendingTurretReplacement: { slotIndex: number; turretId: string } | null = null;

  getName(): string {
    return this.name;
  }

  getParameters(): Record<string, any> {
      let planDescription = 'Analysis';
      
      if (this.currentGroupPlan) {
          const nextUnit = this.currentGroupPlan.units[this.currentGroupPlan.index] || 'Done';
          planDescription = `Group ${this.currentGroupPlan.index+1}/${this.currentGroupPlan.units.length} >> ${nextUnit}`;
      } else {
          // Provide context on what Dynamic Recruitment is thinking
          planDescription = `Dynamic: ${this.lastRecruitmentDecision}`;
      }
      
      return {
          strategy: this.currentStrategy,
          warchest: Math.floor(this.currentWarchest),
          plan: planDescription,
          rejected: this.lastRejectedUnits,
          currentGroupPlan: this.currentGroupPlan, // Expose raw plan for Debug UI
          ...this.debugMetrics,
          lastAgeUp: this.lastAgeUpTime.toFixed(1),
          pendingTurretReplacement: this.pendingTurretReplacement,
          // Persistable State (Raw Values)
          _lastAgeUpTime: this.lastAgeUpTime,
          _lastStrategySwitch: this.lastStrategySwitch,
          // Expose Rich Metrics
          ...this.debugMetrics
      };
  }

  setParameters(params: Record<string, any>): void {
      if (params._lastAgeUpTime !== undefined) {
          this.lastAgeUpTime = Number(params._lastAgeUpTime);
      } else if (params.lastAgeUp) {
          // Fallback for older saves
          this.lastAgeUpTime = Number(params.lastAgeUp);
      }

      if (params._lastStrategySwitch !== undefined) {
          this.lastStrategySwitch = Number(params._lastStrategySwitch);
      }
      
      if (params.strategy) {
          this.currentStrategy = params.strategy;
      }

      if (params.currentGroupPlan) {
          this.currentGroupPlan = params.currentGroupPlan;
      }
      if (params.pendingTurretReplacement) {
          this.pendingTurretReplacement = params.pendingTurretReplacement;
      }
  }
  
  // Method to manually update lastAgeUpTime when loaded from save
  // This ensures warchest calculation is correct after reload
  public setLastAgeUpTime(time: number): void {
    this.lastAgeUpTime = time; 
  }

  private scoreTurretEngine(engine: TurretEngineDef, threat: ThreatLevel): number {
    const dpsWeight = threat >= ThreatLevel.HIGH ? 1.6 : 1.2;
    const protectionWeight = threat >= ThreatLevel.HIGH ? 1800 : 1200;
    const rangeWeight = threat >= ThreatLevel.LOW ? 14 : 10;
    const efficiencyWeight = threat >= ThreatLevel.HIGH ? 4200 : 3000;
    const protectionValue = (1 - engine.protectionMultiplier) * protectionWeight;
    const rawDps = estimateEngineDps(engine);
    const dpsPerGold = rawDps / Math.max(1, engine.cost);
    return rawDps * dpsWeight + dpsPerGold * efficiencyWeight + engine.range * rangeWeight + protectionValue;
  }

  private getTargetSlotsByAge(age: number, gameTime: number): number {
    if (age <= 2) return 1;
    if (age <= 4) return 2;
    if (age === 5) return 3;
    if (gameTime < 90) return 3;
    return 4;
  }

  private getEnemyDiscountedCost(baseCost: number, difficulty: 'EASY' | 'MEDIUM' | 'HARD' | 'CHEATER'): number {
    let finalCost = baseCost;
    if (difficulty === 'MEDIUM') finalCost *= 0.8;
    else if (difficulty === 'HARD') finalCost *= 0.65;
    else if (difficulty === 'CHEATER') finalCost *= 0.5;
    return Math.floor(finalCost);
  }

  private buildForeseeablePlan(
    state: GameStateSnapshot,
    threat: ThreatLevel,
    strategicState: StrategicState,
    warchest: number,
    spendableGold: number
  ): string[] {
    const plan: string[] = [];

    if (state.enemyQueueSize > 0) {
      plan.push(`Queue: ${state.enemyQueueSize} item(s) pending before instant execution.`);
    } else {
      plan.push('Queue: empty, next decision can execute immediately.');
    }

    if (state.enemyAge < 6) {
      const ageShortfall = Math.max(0, state.enemyAgeCost - state.enemyGold);
      if (ageShortfall <= 0) {
        plan.push(`Tech: ready to age up to Age ${state.enemyAge + 1} now.`);
      } else {
        plan.push(`Tech: save ${Math.ceil(ageShortfall)}g for Age ${state.enemyAge + 1} (warchest ${Math.floor(warchest)}g).`);
      }
    } else {
      plan.push('Tech: max age reached, convert surplus to military and turret upgrades.');
    }

    const unlocked = state.enemyTurretSlotsUnlocked ?? 1;
    const slots = state.enemyTurretSlots ?? [];
    const targetSlots = this.getTargetSlotsByAge(state.enemyAge, state.gameTime);
    const availableEngines = Object.values(getTurretEnginesForAge(state.enemyAge));

    if (this.pendingTurretReplacement) {
      const pendingDef = getTurretEngineDef(this.pendingTurretReplacement.turretId);
      if (pendingDef) {
        plan.push(`Turrets: replace slot ${this.pendingTurretReplacement.slotIndex + 1} with ${pendingDef.name}.`);
      }
    } else if (unlocked < targetSlots) {
      const nextSlotCost = getTurretSlotUnlockCost(unlocked);
      plan.push(`Turrets: unlock slot ${unlocked + 1}/${targetSlots} for ${nextSlotCost}g.`);
    } else {
      const emptySlot = slots.find((s) => s.slotIndex < unlocked && !s.turretId);
      if (emptySlot && availableEngines.length > 0) {
        const bestAffordable = [...availableEngines]
          .filter((def) =>
            this.getEnemyDiscountedCost(def.cost, state.difficulty) <= spendableGold &&
            (def.manaCost ?? 0) <= state.enemyMana
          )
          .sort((a, b) => this.scoreTurretEngine(b, threat) - this.scoreTurretEngine(a, threat))[0];
        if (bestAffordable) {
          plan.push(`Turrets: mount ${bestAffordable.name} on slot ${emptySlot.slotIndex + 1}.`);
        } else {
          plan.push(`Turrets: slot ${emptySlot.slotIndex + 1} is empty, waiting for gold/mana.`);
        }
      } else {
        plan.push('Turrets: all unlocked slots filled, evaluate upgrades/replacements.');
      }
    }

    if (this.currentGroupPlan) {
      const nextIdx = this.currentGroupPlan.index;
      const nextUnit = this.currentGroupPlan.units[nextIdx] || 'done';
      plan.push(`Army: ${this.currentGroupPlan.name} ${Math.min(nextIdx + 1, this.currentGroupPlan.units.length)}/${this.currentGroupPlan.units.length}, next ${nextUnit}.`);
    } else {
      const stance =
        strategicState === StrategicState.DEFENDING
          ? 'frontline defense'
          : strategicState === StrategicState.PUSHING
            ? 'offensive pressure'
            : 'balanced recruitment';
      plan.push(`Army: ${stance} using ${Math.floor(spendableGold)}g spendable budget.`);
    }

    const targetManaLevel = AI_TUNING.manaUpgrades.targetLevelsByAge[state.enemyAge] || 0;
    if (state.enemyAge === 1) {
      plan.push('Mana: defer upgrades in Age 1.');
    } else if (state.enemyManaLevel < targetManaLevel) {
      const manaCost = getManaCost(state.enemyManaLevel);
      plan.push(`Mana: upgrade to Lv ${state.enemyManaLevel + 1} for ${manaCost}g (target Lv ${targetManaLevel}).`);
    } else {
      plan.push(`Mana: at/above target (Lv ${state.enemyManaLevel}, target ${targetManaLevel}).`);
    }

    return plan.slice(0, 6);
  }

  private considerTurretSlotsAndEngines(
    state: GameStateSnapshot,
    threat: ThreatLevel,
    spendableGold: number
  ): AIDecision | null {
    const unlocked = state.enemyTurretSlotsUnlocked ?? 1;
    const slots = state.enemyTurretSlots ?? [];
    const available = Object.values(getTurretEnginesForAge(state.enemyAge));
    if (available.length === 0) return null;
    const targetSlots = this.getTargetSlotsByAge(state.enemyAge, state.gameTime);
    const hasEmptyUnlockedSlot = slots.some((s) => s.slotIndex < unlocked && !s.turretId);
    const coreDefenseNeeds =
      unlocked < targetSlots ||
      hasEmptyUnlockedSlot ||
      (state.enemyTurretInstalledCount ?? 0) < Math.max(1, unlocked);

    // Keep warchest behavior for normal spending, but allow tower baseline progression
    // to use available treasury so AI does not stall with no turret development.
    const turretGoldBudget = coreDefenseNeeds
      ? Math.max(spendableGold, Math.max(0, state.enemyGold - 25))
      : spendableGold;

    const canAffordEngine = (def: TurretEngineDef) =>
      this.getEnemyDiscountedCost(def.cost, state.difficulty) <= turretGoldBudget &&
      (def.manaCost ?? 0) <= state.enemyMana;

    const sortedByPower = [...available].sort((a, b) => this.scoreTurretEngine(b, threat) - this.scoreTurretEngine(a, threat));

    if (this.pendingTurretReplacement) {
      const slot = slots.find((s) => s.slotIndex === this.pendingTurretReplacement!.slotIndex);
      if (slot && !slot.turretId) {
        const target = getTurretEngineDef(this.pendingTurretReplacement.turretId);
        if (target && canAffordEngine(target)) {
          return {
            action: 'BUY_TURRET_ENGINE',
            parameters: { slotIndex: slot.slotIndex, turretId: target.id },
            reasoning: `Rebuild turret ${target.name} on slot ${slot.slotIndex + 1}`,
          };
        }
      }
      this.pendingTurretReplacement = null;
    }

    // Fill empty slots first with strongest affordable engine.
    for (let i = 0; i < unlocked; i++) {
      const slot = slots.find((s) => s.slotIndex === i);
      if (!slot || slot.turretId) continue;
      const pick = sortedByPower.find((def) => canAffordEngine(def));
      if (pick) {
        return {
          action: 'BUY_TURRET_ENGINE',
          parameters: { slotIndex: i, turretId: pick.id },
          reasoning: `Mount ${pick.name} on empty slot ${i + 1}`,
        };
      }
      return null;
    }

    // Replace weak engines only in late game or under heavy threat.
    const canReplace = state.enemyAge >= 4 && (threat >= ThreatLevel.MODERATE || state.enemyAge >= 6);
    if (canReplace) {
      let weakestSlotIndex = -1;
      let weakestScore = Infinity;
      let weakestTurretId: string | null = null;

      for (let i = 0; i < unlocked; i++) {
        const slot = slots.find((s) => s.slotIndex === i);
        if (!slot?.turretId) continue;
        const def = getTurretEngineDef(slot.turretId);
        if (!def) continue;
        const score = this.scoreTurretEngine(def, threat);
        if (score < weakestScore) {
          weakestScore = score;
          weakestSlotIndex = i;
          weakestTurretId = def.id;
        }
      }

      const betterOption = sortedByPower.find((def) => canAffordEngine(def) && this.scoreTurretEngine(def, threat) > weakestScore * 1.2 && def.id !== weakestTurretId);
      if (weakestSlotIndex >= 0 && betterOption) {
        this.pendingTurretReplacement = { slotIndex: weakestSlotIndex, turretId: betterOption.id };
        return {
          action: 'SELL_TURRET_ENGINE',
          parameters: { slotIndex: weakestSlotIndex },
          reasoning: `Sell weak slot ${weakestSlotIndex + 1} turret for ${betterOption.name}`,
        };
      }
    }

    // Unlock next slot once existing slots are meaningfully equipped.
    if (unlocked < targetSlots) {
      const filledUnlocked = slots.filter((slot) => slot.slotIndex < unlocked && !!slot.turretId).length;
      if (filledUnlocked >= Math.max(1, unlocked)) {
        const nextCost = getTurretSlotUnlockCost(unlocked);
        if (turretGoldBudget >= nextCost) {
          return {
            action: 'UPGRADE_TURRET_SLOTS',
            reasoning: `Unlock turret slot ${unlocked + 1}`,
          };
        }
      }
    }

    return null;
  }

  decide(state: GameStateSnapshot, personality: AIPersonality): AIDecision {
    // Dynamic strategy switching based on battlefield situation
    this.updateStrategy(state);
    
    // Apply strategy bias to personality
    // This makes the "random state changes" actually affect decision making
    const biasedPersonality = { ...personality };
    if (this.currentStrategy === 'AGGRESSIVE') {
      biasedPersonality.aggression = Math.min(1.0, biasedPersonality.aggression + 0.3);
      biasedPersonality.meleePreference = Math.min(1.0, biasedPersonality.meleePreference + 0.2);
      biasedPersonality.fastPreference = Math.min(1.0, biasedPersonality.fastPreference + 0.2);
      biasedPersonality.turretPreference = Math.max(0.0, biasedPersonality.turretPreference - 0.2);
    } else if (this.currentStrategy === 'DEFENSIVE') {
      biasedPersonality.aggression = Math.max(0.0, biasedPersonality.aggression - 0.3);
      biasedPersonality.rangedPreference = Math.min(1.0, biasedPersonality.rangedPreference + 0.2);
      biasedPersonality.tankPreference = Math.min(1.0, biasedPersonality.tankPreference + 0.2);
      biasedPersonality.turretPreference = Math.min(1.0, biasedPersonality.turretPreference + 0.3);
    }
    
    // Calculate warchest - gold reserved for age upgrades
    const timeSinceLastAgeUp = state.gameTime - this.lastAgeUpTime;
    const warchest = AIBehaviorUtils.calculateWarchest(state, timeSinceLastAgeUp, state.difficulty);
    this.currentWarchest = warchest; // DEBUG: Update stored value
    
    // Assess situation first
    const threat = AIBehaviorUtils.assessThreat(state);
    
    // Check Offensive Difficulty (User Request: "gamestate evaluation ... to assess if we should mount an attack")
    const attackStatus = AIBehaviorUtils.evaluateAttackFeasibility(state);
    
    const strategicState = AIBehaviorUtils.getStrategicState(state, threat);

    // Dynamic Economy: Calculate real-time thresholds
    const thresholds = AIBehaviorUtils.calculateDynamicThresholds(state);
    
    // Effective Reserve: Warchest + Dynamic Safety Buffer
    const totalReserved = warchest + thresholds.minimumReserve;

    // Spendable Gold: Strictly what we have above our reserves
    let spendableGold = Math.max(0, state.enemyGold - totalReserved);
    
    // STRICT RULE: Warchest is SACRED. 
    // It is ONLY unlocked if the base is physically dying (<25% HP AND taking damage).
    // User Requirement: "respect the warchest mechnic, ... make this 100% priority over all else"
    
    const timeSinceLastHitScore = state.gameTime - state.lastEnemyBaseAttackTime; // Renamed to avoid confusion if variable exists
    const baseCriticalScore = (state.enemyBaseHealth / state.enemyBaseMaxHealth) < 0.25;
    
    // STRICTER RULE: "immediately after base isnt getting attacked anymore"
    // Changed from 2.0s to 0.4s (effectively immediate given tick rate)
    const isBaseUnderAttackScore = timeSinceLastHitScore < 0.4;

    let isWarchestUnlocked = false;
    if (baseCriticalScore && isBaseUnderAttackScore) {
        spendableGold = state.enemyGold; // EMERGENCY: Unlock everything to survive
        isWarchestUnlocked = true;
    } 
    // Otherwise, spendableGold remains strictly (Gold - Reserve).
    // Even if Threat is CRITICAL, we do NOT spend the warchest. We save for the next Age to turn the tide.
    
    // DEBUG METRICS UPDATE
    const baseTax = AI_TUNING.warchest.baseTaxRate || 0.35;
    const diffMultiplier = (AI_TUNING.warchest as any).difficultyTaxMultipliers?.[state.difficulty] || 1.0;
    const taxRate = baseTax * diffMultiplier;

    // Format composition plan for debug
    let compInfo = "Dynamic";
    if (this.currentGroupPlan) {
        const nextIdx = this.currentGroupPlan.index;
        const total = this.currentGroupPlan.units.length;
        const nextUnit = this.currentGroupPlan.units[nextIdx] || "Done";
        compInfo = `${nextIdx}/${total} >> ${nextUnit}`;
    }
    
    this.debugMetrics = {
        difficulty: state.difficulty,
        income: state.enemyGoldIncome.toFixed(1),
        taxRate: (taxRate * 100).toFixed(0) + '%',
        timeSinceAge: timeSinceLastAgeUp.toFixed(1) + 's',
        wcTarget: state.enemyAgeCost,
        threat: threat,
        state: strategicState,
        gold: `${Math.floor(spendableGold)} / ${Math.floor(state.enemyGold)}`,
        reserved: `${Math.floor(Math.min(state.enemyGold, totalReserved))} / ${Math.floor(totalReserved)}`,
        comp: compInfo,
        pushEst: `${attackStatus.feasibility.toFixed(2)} (${Math.floor(attackStatus.requiredMeatShield)}hp)`,
        turret: state.enemyTurretLevel,
        manaLvl: state.enemyManaLevel,
        futurePlan: this.buildForeseeablePlan(state, threat, strategicState, warchest, spendableGold),
        nextAction: 'ANALYZE',
        nextReason: 'Evaluating priorities',
    };

    const finalizeDecision = (decision: AIDecision): AIDecision => {
      this.debugMetrics.nextAction = decision.action;
      this.debugMetrics.nextReason = decision.reasoning || decision.action;
      return decision;
    };
    
    // Check for base emergency (< 25% health AND attacked within last 3 seconds)
    const isEmergency = AIBehaviorUtils.isBaseEmergency(
      state.enemyBaseHealth, 
      state.enemyBaseMaxHealth,
      state.lastEnemyBaseAttackTime,
      state.gameTime
    );
    
    // Gold allocation:
    // - Emergency: use ALL gold (ignore warchest and reserves completely)
    // - Normal recruitment: use spendableGold (strictly surplus)
    // - Age upgrades: can use full gold pool (if decision logic allows)
    const emergencyGold = state.enemyGold;
    const recruitmentGold = spendableGold;
    const ageUpgradeGold = state.enemyGold; // Age up can always use full gold

    const turretPlanDecision = this.considerTurretSlotsAndEngines(state, threat, recruitmentGold);
    if (turretPlanDecision) {
      this.lastRecruitmentDecision = turretPlanDecision.reasoning || turretPlanDecision.action;
      return finalizeDecision(turretPlanDecision);
    }
    
    // CONCURRENT DECISION-MAKING: Can do multiple actions per decision with randomization
    const urgentActions: AIDecision[] = [];
    
    // Priority 1: Desperate defense (use all gold, but ONLY when truly desperate)
    // Must have LOW health AND recent attack, or severely outnumbered
    // FIX logic: Only panic if BASE IS ACTUALLY ATTACKED (taking damage now) OR imminent threat (enemy near base).
    // Just having low HP is not enough if the enemy is far away.
    const enemyAtGates = state.playerUnitsNearEnemyBase > 0;
    
    // Strict Panic Condition: Emergency means Warchest is already unlocked.
    // If enemy is just "At Gates" but handled by turret or not attacking base yet, we still respect warchest.
    // We only trigger desperate defense (ignoring personality) here if we are TRULY dying.
    const isPanicSituation = isWarchestUnlocked; 
    
    // We only trigger desperate defense if we are actually under siege.
    if ((strategicState === StrategicState.DESPERATE && isPanicSituation) && this.consecutiveDefenseFrames < 5) {
      this.consecutiveDefenseFrames++;
      // Desperate defense overrides personality anyway (picks strongest unit)
      return finalizeDecision(this.desperateDefense(state, personality, threat));
    } else {
      this.consecutiveDefenseFrames = 0; // Clear after 5 frames or when not desperate
    }
    
    // Priority 1.5: Empty Field Defense (Smart Meat Shield)
    // If we have no units on the field and none in queue, we must maintain presence.
    // User Request: "detect that when it has nothing on its side and can recruit a single unit, it should do so... and use the best one it finds in budget for price to HP pool"
    const isFieldEmpty = state.enemyUnitCount === 0 && state.enemyQueueSize === 0;
    
    if (isFieldEmpty && state.enemyTurretLevel > 0) {
        
        // Triggers only if Player units have crossed into our territory ( > 50% field width)
        // User Request: "only does it when an enemy unit is already on the half of the battle field on its side"
        const encroachingUnits = state.playerUnits.some(u => u.position > state.battlefieldWidth * 0.5);

        if (encroachingUnits) {
            
            const availableUnits = getUnitsForAge(state.enemyAge);
            
            // Allow dipping into savings slightly if threat is HIGH, otherwise strict budget
            const goldBudget = (threat >= ThreatLevel.HIGH) ? state.enemyGold : recruitmentGold;
            
            let bestUnitId: string | null = null;
            let maxHpPerGold = -1;

            for (const [id, def] of Object.entries(availableUnits)) {
                if (def.cost > goldBudget) continue;
                if (def.teleporter) continue; // Don't use teleporters as meatShields
                if (def.skill?.type === 'heal' && state.enemyUnitCount === 0) continue; // Don't send solo medic
                
                // Calculate Efficiency: HP per Gold
                const hpPerGold = def.health / def.cost;
                
                if (hpPerGold > maxHpPerGold) {
                    maxHpPerGold = hpPerGold;
                    bestUnitId = id;
                }
            }
            
            if (bestUnitId) {
                 const reason = `Empty Field Defense: Recruiting ${bestUnitId} (Encroaching Enemy, Best HP/Gold: ${maxHpPerGold.toFixed(1)})`;
                 this.lastRecruitmentDecision = reason;
                 return finalizeDecision({
                     action: 'RECRUIT_UNIT',
                     parameters: { unitType: bestUnitId, priority: 'normal' }, // Normal priority
                     reasoning: reason
                 });
            }
        }
    }

    // CONCURRENT PLANNING: Consider multiple actions and pick best one
    // Age up consideration (can use full gold)
    const ageDecision = this.considerAging(state, biasedPersonality, threat, warchest, ageUpgradeGold);
    if (ageDecision) urgentActions.push(ageDecision);

    // OP Unit consideration (Super Weapon - Cheater Only)
    const opUnitDecision = this.considerOpUnit(state, ageUpgradeGold);
    if (opUnitDecision) urgentActions.push(opUnitDecision);

    // CYBER ASSASSIN MANA BONUS TRIGGER (Age 6)
    // Attempt to trigger the 6k and 12k mana bonuses by spawning an assassin in the window.
    // The GameEngine handles the actual "10x HP" logic and "Once" check.
    // We just ensure we spawn one when we cross the threshold.
    if (state.enemyAge === 6) {
        let shouldForceAssassin = false;
        // Window for 6k trigger (e.g. 6000-6500)
        if (state.enemyMana > 6000 && state.enemyMana < 6500 && state.enemyQueueSize < 2) {
             shouldForceAssassin = true;
        }
        // Window for 12k trigger (e.g. 12000-12500)
        if (state.enemyMana > 12000 && state.enemyMana < 12500 && state.enemyQueueSize < 2) {
             shouldForceAssassin = true;
        }
        
        if (shouldForceAssassin) {
             urgentActions.push({
                 action: 'RECRUIT_UNIT',
                 parameters: { unitType: 'cyber_assassin', priority: 'emergency' },
                 reasoning: `Mana Threshold Trigger (${Math.floor(state.enemyMana)}): Deploying Cyber Assassin for Potential Bonus`
             });
        }
    }
    
    // AGE 6 EMERGENCY DEFENSE (User Request: "placeholder in between")
    // If enemy is at our gates and we have no units, spawn a cheap tank even if saving.
    if (state.enemyAge === 6 && state.playerUnitsNearEnemyBase > 0 && state.enemyUnitCount < 3) {
        const emergencyDecision = this.considerAge6Defense(state, recruitmentGold);
        if (emergencyDecision) urgentActions.push(emergencyDecision);
    }
    
    // BASE REPAIR (Age 6 Excess Mana)
    // User Request: "if the ai has 20k mana it should start repairing its base with the excess"
    if (state.enemyAge === 6 && state.enemyMana > 20000 && state.enemyBaseHealth < state.enemyBaseMaxHealth) {
         // Check if damaged
         const missingHP = state.enemyBaseMaxHealth - state.enemyBaseHealth;
         if (missingHP > 10) { // Don't spam for 1 HP
             this.lastRecruitmentDecision = "Excess Mana: Repairing Base";
             urgentActions.push({
                 action: 'REPAIR_BASE',
                 reasoning: `Excess Mana Repair (>20k): 500 Mana -> 200 HP`,
             });
         }
    }

    // Mana upgrades (Smart Projected Mana Needs)
    // We want to upgrade mana if we PLAN to use mana-heavy units, not just if we have low mana.
    // Calculate projected mana consumption for preferred units
    const projectedManaNeed = AIBehaviorUtils.calculateProjectedManaNeed(state, biasedPersonality);
    const manaDecision = this.considerManaUpgrade(state, biasedPersonality, threat, recruitmentGold, projectedManaNeed);
    if (manaDecision) urgentActions.push(manaDecision);
    
    // If we have multiple urgent actions, pick one based on priority and randomness
    if (urgentActions.length > 0) {
      // Age up is usually highest priority (60%)
      const ageAction = urgentActions.find(a => a.action === 'AGE_UP');
      if (ageAction && Math.random() < 0.6) {
        this.lastAgeUpTime = state.gameTime;
        this.lastRecruitmentDecision = ageAction.reasoning || 'Age Up'; // Update reasoning
        return finalizeDecision(ageAction);
      }
      
      // Otherwise, randomly pick from available actions
      const randomAction = urgentActions[Math.floor(Math.random() * urgentActions.length)];
      if (randomAction.action === 'AGE_UP') {
        this.lastAgeUpTime = state.gameTime;
      }
      this.lastRecruitmentDecision = randomAction.reasoning || randomAction.action; // Update reasoning
      return finalizeDecision(randomAction);
    }
    
    // Priority: Recruit units (use flexible gold - includes partial warchest)
    const recruitDecision = this.considerRecruitment(state, biasedPersonality, threat, strategicState, recruitmentGold);
    if (recruitDecision) return finalizeDecision(recruitDecision);
    
    // Default: wait (accumulating warchest)
    const waitReason = `[${this.currentStrategy}] Accumulating warchest (${Math.floor(warchest)}g / ${state.enemyAgeCost}g for age)`;
    this.lastRecruitmentDecision = waitReason;
    
    return finalizeDecision({
      action: 'WAIT',
      reasoning: waitReason,
    });
  }
  
  /**
   * Dynamically update strategy based on battlefield conditions
   */
  private updateStrategy(state: GameStateSnapshot): void {
    const timeSinceSwitch = state.gameTime - this.lastStrategySwitch;
    
    // Don't switch too frequently (min 5 seconds between switches)
    if (timeSinceSwitch < 5.0) return;
    
    // Calculate relative strength
    let ourStrength = 0;
    let theirStrength = 0;
    for (const unit of state.enemyUnits) {
      ourStrength += unit.health + (unit.damage * 10);
    }
    for (const unit of state.playerUnits) {
      theirStrength += unit.health + (unit.damage * 10);
    }
    const strengthRatio = ourStrength / Math.max(theirStrength, 1);
    
    // Consider base health urgency
    const baseHealthRatio = state.enemyBaseHealth / state.enemyBaseMaxHealth;
    const theirBaseHealthRatio = state.playerBaseHealth / state.playerBaseMaxHealth;
    
    let newStrategy: 'DEFENSIVE' | 'BALANCED' | 'AGGRESSIVE' = 'BALANCED';
    
    // DEFENSIVE: We're weak or base is low health
    if (strengthRatio < 0.6 || baseHealthRatio < 0.4 || state.enemyUnitsNearPlayerBase > 3) {
      newStrategy = 'DEFENSIVE';
    }
    // AGGRESSIVE: We're much stronger and enemy base is vulnerable
    else if (strengthRatio > 1.8 && theirBaseHealthRatio < 0.7 && state.playerUnitsNearEnemyBase > 2) {
      newStrategy = 'AGGRESSIVE';
    }
    // Add randomness: 10% chance to switch strategy anyway for unpredictability
    else if (Math.random() < 0.1) {
      newStrategy = ['DEFENSIVE', 'BALANCED', 'AGGRESSIVE'][Math.floor(Math.random() * 3)] as any;
    }
    
    if (newStrategy !== this.currentStrategy) {
      this.currentStrategy = newStrategy;
      this.lastStrategySwitch = state.gameTime;
      // Cancel current group plan when strategy changes
      this.currentGroupPlan = null;
    }
  }
  
  /**
   * Desperate defense - recruit STRONGEST possible unit immediately
   * Constraints:
   * 1. Only recruit if queue is empty (don't clog queue)
   * 2. Recruit the strongest unit money can buy right now
   */
  private desperateDefense(
    state: GameStateSnapshot,
    personality: AIPersonality,
    threat: ThreatLevel
  ): AIDecision {
    // Constraint: Do not clog up the build queue. Only add one unit at a time.
    if (state.enemyQueueSize >= 1) {
      return {
        action: 'WAIT',
        reasoning: 'Emergency Queue Limit (1 unit max)',
      };
    }
    
    // Find strongest affordable unit
    const availableUnits = getUnitsForAge(state.enemyAge);
    let bestUnit: string | null = null;
    let maxStrength = -1;
    
    for (const [unitType, unitDef] of Object.entries(availableUnits)) {
       // Apply Difficulty Cost Multiplier for Check
       // We MUST replicate the discount logic here for the check to be accurate, 
       // but we don't have access to game difficulty here directly in parameters sometimes.
       // Although wait, IAIBehavior inputs don't usually include config.
       // However, the AI Controller handles 'RECRUIT_UNIT' execution which checks funds.
       // Prudent behavior: assume full price to be safe, or just check 'state.enemyGold'.
       
       // If the Engine applies discount, we should probably know about it.
       // But BalancedAI is "Game Logic Agnostic".
       // Let's assume standard cost here. If we fail to buy because we thought it was expensive but it was cheap, that's fine (conservative).
       // If we try to buy because we thought it was cheap (discounted) but it wasn't... AI fails.
       // Since we implemented the discount in GameEngine queueUnit, the actual cost IS lower.
       // So the AI might "think" it can't afford something when it actually can.
       // This makes the AI slightly more conservative/stupid on lower difficulties unless we update this check.
       // But 'Easy' is 100% cost, so it matches. 'Cheater' is 50%, so it can actually buy MORE than it thinks.
       // That is safer than the reverse.
       
      // Must be affordable
      if (unitDef.cost > state.enemyGold) continue;
      if ((unitDef.manaCost ?? 0) > state.enemyMana) continue;
      
      // metric: Strength = Cost (proxy for power) + Combat Stats
      // We want the biggest immediate impact.
      const combatPower = (unitDef.damage * 10) + unitDef.health;
      
      if (combatPower > maxStrength) {
        maxStrength = combatPower;
        bestUnit = unitType;
      }
    }
    
    if (bestUnit) {
      const reason = `EMERGENCY: Recruiting strongest unit (${bestUnit})!`;
      this.lastRecruitmentDecision = reason;
      return {
        action: 'RECRUIT_UNIT',
        parameters: { unitType: bestUnit, priority: 'emergency' },
        reasoning: reason,
      };
    }
    
    this.lastRecruitmentDecision = 'Emergency: No affordable units';
    return {
      action: 'WAIT',
      reasoning: 'No affordable units for emergency defense',
    };
  }

  /**
   * Consider building the OP Unit (Void Reaper) at Age 6
   * This is a special "Super Age Up" equivalent.
   */
  private considerOpUnit(state: GameStateSnapshot, totalGold: number): AIDecision | null {
      // Age 6, and if we have the money
      if (state.enemyAge < 6) return null;
      // if (state.enemyManaLevel < 12) return null; // Relaxed: Don't strictly force mana maxing

      // Cost of Void Reaper is 10000
      const OP_UNIT_COST = 10000;
      
      if (totalGold >= OP_UNIT_COST) {
          return {
              action: 'RECRUIT_UNIT',
              parameters: { unitType: 'void_reaper', priority: 'emergency' }, // High priority
              reasoning: 'UNLEASH THE VOID REAPER (Max Out Age 6)',
          };
      }
      return null;
  }
  
  /**
   * Emergency Age 6 Defense
   * Spawns a quick-building, high-HP unit (Robot Soldier) to stall enemies
   * allowing the main plan (Void Reaper/Mana) to continue afterwards.
   */
  private considerAge6Defense(state: GameStateSnapshot, availableGold: number): AIDecision | null {
      // Robot Soldier is the best candidate: 180g, 850HP, 5s build time.
      // It's much faster/cheaper than the Mech Walker (350g, 8s) or Titan (11s).
      const DEFENDER_TYPE = 'robot_soldier'; 
      const def = UNIT_DEFS[DEFENDER_TYPE];
      
      if (!def) return null; // Should not happen
      
      if (availableGold >= def.cost) {
           return {
               action: 'RECRUIT_UNIT',
               parameters: { unitType: DEFENDER_TYPE, priority: 'emergency' },
               reasoning: 'Age 6 Emergency: Deploying Robot Soldier to hold the line',
           };
      }
      return null;
  }
  
  /**
   * Consider aging up (can use full gold including warchest)
   * Uses intelligent timing based on battlefield state
   */
  private considerAging(
    state: GameStateSnapshot,
    personality: AIPersonality,
    threat: ThreatLevel,
    warchest: number,
    availableGold: number
  ): AIDecision | null {
    if (state.enemyAge >= 6) return null; // Max age
    
    const ageCost = state.enemyAgeCost;
    const totalGold = availableGold; // Full gold pool
    
    // Calculate relative strength
    let ourStrength = state.enemyUnitCount * 100 + state.enemyTurretLevel * 150;
    let theirStrength = state.playerUnitCount * 100 + state.playerTurretLevel * 150;
    const strengthRatio = ourStrength / Math.max(theirStrength, 1);
    
    // Don't age up if critically threatened
    if (threat === ThreatLevel.CRITICAL) return null;
    
    // STRICT check: Do we have enough gold?
    // We remove the "100g reserve" requirement because aging up is critical
    if (totalGold < ageCost) return null;
    
    // Age gap urgency: if player is ahead AT ALL, prioritize catching up
    const ageGap = state.playerAge - state.enemyAge;
    const isUrgentCatchup = ageGap >= 1; // Any age deficit is urgent if we have funds
    
    // If we're dominating (2x stronger) OR behind in age, age up aggressively
    if (strengthRatio > 2.0 || isUrgentCatchup) {
      const reason = isUrgentCatchup ? 
          `Urgent age catchup (${ageGap} ages behind)` :
          `Aggressive age up (dominating: ${strengthRatio.toFixed(1)}x)`;
      this.lastRecruitmentDecision = reason;
      return {
        action: 'AGE_UP',
        reasoning: reason,
      };
    }
    
    // Normal age up: Just do it if we have the money (Warchest logic ensures we saved for it)
    const reason = `Age ${state.enemyAge} → ${state.enemyAge + 1} (funds secured: ${Math.floor(totalGold)}g)`;
    this.lastRecruitmentDecision = reason;
    return {
      action: 'AGE_UP',
      reasoning: reason,
    };
  }
  
  /**
   * Consider mana upgrade (can use flexible gold)
   */
  private considerManaUpgrade(
    state: GameStateSnapshot,
    personality: AIPersonality,
    threat: ThreatLevel,
    availableGold: number,
    projectedManaNeed: number = 0
  ): AIDecision | null {
    // FIX: Stone Age (Age 1) has NO mana units. Do not upgrade mana.
    // Also wait until we have some units on the field before pouring money into mana.
    if (state.enemyAge === 1) return null;

    // Check max level (40 based on config)
    if (state.enemyManaLevel >= 40) return null;
    
    // Cost calculation (aligned with GameBalance)
    const cost = getManaCost(state.enemyManaLevel);
    
    // Check affordability
    if (availableGold < cost) return null;
    
    // DYNAMIC LOGIC:
    // 1. Current Mana is dangerously low (< 15)
    // 2. Projected Need is higher than Current Generation * 5s (buffer)
    // 3. We are "Rich" (Age 5+, tons of gold) - just max it out.
    
    const currentManaIncome = state.enemyManaIncome;
    const isDeficit = projectedManaNeed > currentManaIncome;
    
    // 1. Critical Low Mana
    // Ensure we can actually afford it (using availableGold which already respects warchest)
    if (state.enemyMana < 15 && availableGold >= cost) {
         const reason = `Mana Critical: Low reserves (${Math.floor(state.enemyMana)})`;
         this.lastRecruitmentDecision = reason;
         return {
            action: 'UPGRADE_MANA',
            reasoning: reason,
         };
    }

    // 2. Planned Deficit
    if (isDeficit && availableGold >= cost) {
        const reason = `Mana Planning: Need ${projectedManaNeed.toFixed(1)}/s, have ${currentManaIncome.toFixed(1)}/s`;
        this.lastRecruitmentDecision = reason;
        return {
            action: 'UPGRADE_MANA',
            reasoning: reason,
        };
    }
    
    // Fallback: Check config targets
    const targetLevel = AI_TUNING.manaUpgrades.targetLevelsByAge[state.enemyAge] || 0;
    
    // 3. Standard Progression (if rich enough)
    if (state.enemyManaLevel < targetLevel) {
       // Age 6 Adjustment: We MUST max mana eventually, but not at the cost of having 0 units.
       if (state.enemyAge === 6) {
           const minRecruitGold = AIBehaviorUtils.calculateMinimumRecruitmentGold(state, state.difficulty);
           
           // ALTERNATING LOGIC:
           // If we have a weak army, we prioritize TROOPS over Mana.
           // Only buy mana if we have a surplus AFTER reserving funds for a squad.
           // User Issue: "upgrades mana in age 6 then doesnt attack and then upgrades mana agin"
           // This happens because AI spends down to 0, then saves, then spends on Mana again.
           // We require a SOLID SURPLUS (Cost + 80% of Recruitment Target) to break the loop.
           
           const hasDecentArmy = state.enemyUnitCount >= 8 || state.enemyUnitsNearPlayerBase > 2;
           const requiredSurplus = minRecruitGold * 0.8; 
           
           if (!hasDecentArmy) {
               // We need units. Only buy mana if we are swimming in gold.
               if (availableGold < cost + requiredSurplus) return null;
           } else {
               // Even with a decent army, don't bankrupt ourselves if we are aiming for big units
               if (availableGold < cost + 500) return null;
           }
           
           // If we have a decent army and surplus, upgrade.
           if (availableGold >= cost) {
              const reason = `Age 6 Progression: Upgrading Mana (Level ${state.enemyManaLevel}->${state.enemyManaLevel+1})`;
              this.lastRecruitmentDecision = reason;
              return {
                action: 'UPGRADE_MANA',
                reasoning: reason,
              };
           }
       }

       if (availableGold > cost * 1.2) {
          const reason = `Standard Progression: Reaching target mana level ${targetLevel} for Age ${state.enemyAge}`;
          this.lastRecruitmentDecision = reason;
          return {
            action: 'UPGRADE_MANA',
            reasoning: reason,
          };
       }
    }
    
    // 4. Opportunistic upgrade if very rich
    if (availableGold > cost * 3 && state.enemyManaLevel < targetLevel + 2) {
      const reason = 'Rich: Opportunistic mana upgrade';
      this.lastRecruitmentDecision = reason;
      return {
        action: 'UPGRADE_MANA',
        reasoning: reason,
      };
    }
    
    return null;
  }
  
  /**
   * Consider recruiting units (uses spendable gold only)
   */
  private considerRecruitment(
    state: GameStateSnapshot,
    personality: AIPersonality,
    threat: ThreatLevel,
    strategicState: StrategicState,
    spendableGold: number
  ): AIDecision | null {
    // Don't recruit if queue is too full
    if (state.enemyQueueSize >= AI_TUNING.recruitment.maxStackSize) {
      this.currentGroupPlan = null; // Reset plan if queue is full
      return null;
    }
    
    // Check if we're continuing a group composition
    if (this.currentGroupPlan && this.currentGroupPlan.index < this.currentGroupPlan.units.length) {
      const nextUnit = this.currentGroupPlan.units[this.currentGroupPlan.index];
      const unitDef = getUnitsForAge(state.enemyAge)[nextUnit];
      
      // Can we afford this unit?
      if (unitDef && spendableGold >= unitDef.cost && state.enemyMana >= (unitDef.manaCost ?? 0)) {
        // CHECK: Will this unit survive the turret?
        // FIX: If we have a frontline (Meat Shield), we don't care if THIS unit is weak.
        // The weakness check usually prevents sending solo archers to die.
        const hasFrontline = state.enemyUnits.some(u => {
            const def = UNIT_DEFS[u.unitId];
            return def.health > 500 || (def.range ?? 1) < 4;
        });

        if (!hasFrontline && state.playerTurretLevel >= 3 && AIBehaviorUtils.isEnemyTurretTooStrong(state, unitDef)) {
          // Unit too weak - abandon this group plan
          this.currentGroupPlan = null;
          return {
            action: 'WAIT',
            reasoning: `Group plan abandoned: ${nextUnit} cannot survive enemy turret (lv${state.playerTurretLevel})`,
          };
        }
        
        this.currentGroupPlan.index++;
        
        // Check if this completes the group
        if (this.currentGroupPlan.index >= this.currentGroupPlan.units.length) {
          this.currentGroupPlan = null; // Group complete
        }
        
        return {
          action: 'RECRUIT_UNIT',
          parameters: {
            unitType: nextUnit,
            priority: 'normal',
          } as RecruitUnitParams,
          reasoning: `Continuing group composition: ${nextUnit} (${this.currentGroupPlan ? this.currentGroupPlan.index : 0}/${this.currentGroupPlan ? this.currentGroupPlan.units.length : 0})`,
        };
      } else {
        // Can't afford current unit, wait
        return {
          action: 'WAIT',
          reasoning: `Waiting for gold to continue group composition (need ${unitDef?.cost ?? 0}g for ${nextUnit})`,
        };
      }
    }
    
    // Calculate minimum gold needed based on actual unit costs and difficulty
    const minRecruitGold = AIBehaviorUtils.calculateMinimumRecruitmentGold(state, state.difficulty);
    
    // AGE 6 "MANA DUMP" ADJUSTMENT
    // User Issue: "waits for gold target to be 3200 after mana upgrade"
    // Fix: If we just upgraded mana (Age 6 high level), lower the gold threshold to allow spending
    // whatever is left on army, rather than waiting for 3200 again.
    let adjustedThreshold = minRecruitGold;
    if (state.enemyAge === 6 && state.enemyManaLevel > 5) {
        adjustedThreshold *= 0.5; // Halve the gold requirement
    }

    if (spendableGold < adjustedThreshold) {
      // Calculate what we are roughly saving for (Avg cost * multiplier)
      // Reverse engineer the minRecruitGold to explain "Why"
      const multiplier = (AI_TUNING.recruitment.difficultyStackMultipliers as any)?.[state.difficulty] || 2.0;
      const approxAvgCost = Math.round(minRecruitGold / multiplier);
      
      // Determine what "Plan" this reserve enables.
      // Usually it enables "Squad Flexibility" or "Tech Up ability"
      const planContext = this.currentGroupPlan 
          ? `Completing Squad (${this.currentGroupPlan.name})`
          : `Building Reserves for Flexible Response`;

      const limitDescription = `Target: ${adjustedThreshold}g (Avg Unit: ~${approxAvgCost}g)`;

      // Create specific reasoning string
      const reason = this.currentGroupPlan 
          ? `[Save] Group: Waiting for Gold (${Math.floor(spendableGold)}/${adjustedThreshold}g) - ${planContext}` 
          : `[Save] ${planContext} - ${limitDescription}. Have ${Math.floor(spendableGold)}g`;
          
      this.lastRecruitmentDecision = reason;
      
      // Return explicit WAIT to preserve the reasoning string and avoid generic overwrite
      return {
          action: 'WAIT',
          reasoning: reason
      };
    }
    
    // Decide between attack group or individual unit
    // Attack groups require more gold (full composition cost)
    // User Request: "compositions are mainly for prerecruiting troops when own troops aren'T engaged yet"
    // IMPROVED: 'isBattleActive' now means immediate threat or active engagement NEAR BASE.
    // As long as the battle is far away, we should try to build proper squads.
    const isBattleActive = state.playerUnitsNearEnemyBase > 0 || state.playerUnitCount > 3;
    
    // If battle is active (high threat), use Dynamic Reinforcement.
    // Otherwise, try to build a cohesive squad pattern.
    const shouldUseAttackGroup = 
       (!isBattleActive || state.enemyGold > 800) &&   // Reset state OR Rich
       state.enemyQueueSize === 0 &&                   // Queue empty
       Math.random() < personality.stackSizePreference;// Personality favors stacks
    
    if (shouldUseAttackGroup) {
      const groupDecision = this.planAttackGroup(state, personality, spendableGold, strategicState);
      
      // Fallback: If we can't afford a group, check if we desperately need a unit.
      // Only panic-recruit single units if we are TRULY defense-broken (0 units and enemy is close/numerous)
      if (groupDecision.action === 'WAIT' && 
          state.enemyUnitCount === 0 && 
          (state.playerUnitsNearEnemyBase > 0 || state.playerUnitCount > 2)) {
          return this.dynamicRecruitment(state, personality, spendableGold, threat);
      }
      
      return groupDecision;
    } else {
      return this.dynamicRecruitment(state, personality, spendableGold, threat);
    }
  }
  
  /**
   * Plan and execute an attack group
   */
  private planAttackGroup(
    state: GameStateSnapshot,
    personality: AIPersonality,
    budget: number,
    strategicState: StrategicState
  ): AIDecision {
    // Select appropriate attack group based on age and strategy
    let selectedGroup = ATTACK_GROUPS.BALANCED_PUSH;
    
    if (state.enemyAge <= 2) {
      selectedGroup = ATTACK_GROUPS.EARLY_RUSH;
    } else if (state.enemyAge === 3 || state.enemyAge === 4) {
      // Choose between balanced or ranged based on personality
      if (personality.rangedPreference > 0.6) {
        selectedGroup = ATTACK_GROUPS.RANGED_SIEGE;
      } else {
        selectedGroup = ATTACK_GROUPS.BALANCED_PUSH;
      }
    } else if (state.enemyAge === 5) {
      if (personality.tankPreference > 0.6) {
        selectedGroup = ATTACK_GROUPS.TANK_WAVE;
      } else {
        selectedGroup = ATTACK_GROUPS.RANGED_SIEGE;
      }
    } else {
      selectedGroup = ATTACK_GROUPS.ENDGAME_ASSAULT;
    }
    
    // Calculate actual cost of this composition
    const compositionCost = AIBehaviorUtils.calculateCompositionCost(
      state,
      selectedGroup.composition,
      selectedGroup.minUnits,
      state.difficulty
    );
    
    // Check if we have enough gold to START the composition
    // User wants "intervals" not to be big. So we require more upfront gold or ensure affordability flow.
    // If we have 70% of the cost, we can likely stream the rest as we build.
    // Previously used 40%, increasing to 65% to minimize "waiting for gold" gaps.
    // NOTE: We check against 'budget' (Spendable Gold), NOT 'enemyGold'.
    // User Requirement: "NO we DONT want the warchest budget in the recruitment"
    const hasEnoughToStart = budget >= (compositionCost * 0.65) || budget >= 500;

    if (!hasEnoughToStart) {
      return {
        action: 'WAIT',
        reasoning: `Saving for ${selectedGroup.name} (${Math.floor(budget)}g / ${Math.floor(compositionCost * 0.65)}g to start)`,
      };
    }
    
    // Recruit units according to group composition
    const unitsToRecruit: string[] = [];
    
    // SCALE THE GROUP SIZE BASED ON BUDGET
    // We strictly stick to the spendable budget.
    const avgUnitCost = compositionCost / selectedGroup.minUnits;
    const affordableUnits = Math.floor(budget / avgUnitCost);
    
    const targetGroupSize = Math.max(
        selectedGroup.minUnits,
        Math.min(AI_TUNING.recruitment.maxStackSize, affordableUnits)
    );

    const allUnits = getUnitsForAge(state.enemyAge);
    
    // SAFETY: Filter out units that cannot survive the turret
    const unitsToConsider: Record<string, UnitDef> = {};
    const shouldCheckTurret = state.playerTurretLevel >= 3;
    let validUnitCount = 0;
    
    for (const [name, def] of Object.entries(allUnits)) {
       // Filter out Void Reaper from normal recruitment flow (it has special logic)
       if (name === 'void_reaper') continue;

       if (shouldCheckTurret && AIBehaviorUtils.isEnemyTurretTooStrong(state, def)) {
         continue; 
       }
       unitsToConsider[name] = def;
       validUnitCount++;
    }
    
    // If no safe units, fall back to all units (otherwise we build nothing forever)
    const availableUnits = validUnitCount > 0 ? unitsToConsider : allUnits;
    
    // Calculate minimum cost of any unit to reserve for future slots
    // (Used to prevent buying 1 expensive unit and failing to fill the rest of the ranks)
    let minUnitCost = Infinity;
    for (const def of Object.values(availableUnits)) {
        minUnitCost = Math.min(minUnitCost, def.cost);
    }
    if (minUnitCost === Infinity) minUnitCost = 50; 

    // CALCULATE COMPOSITION RATIOS (DYNAMIC)
    // Adjust Frontline density based on enemy turret strength or DPS
    // User Request: "increase the meatshield percentage... dynamically evaluated"
    const baseFrontlineRatio = selectedGroup.composition.frontline;
    let adjustedFrontlineRatio = baseFrontlineRatio;

    // Logic: If enemy turret is strong (>2) or we are under heavy fire, increase tankiness
    if (state.playerTurretLevel >= 3) {
        adjustedFrontlineRatio += 0.15; // +15% frontline
    }
    // High Enemy DPS Check? (Simple proxy: many units)
    if (state.playerUnitCount > 4) {
        adjustedFrontlineRatio += 0.10;
    }

    // Renormalize Ranged/Support to fit new Frontline
    // If we increased frontline, we decrease ranged/support proportionally
    const ratioMultiplier = (1.0 - adjustedFrontlineRatio) / (1.0 - baseFrontlineRatio + 0.001);

    // Build full composition scaled to targetGroupSize
    // Ensure at least 1 frontline if group > 2 to prevent "Oops all Archers"
    let numFrontline = Math.floor(targetGroupSize * adjustedFrontlineRatio);
    if (targetGroupSize > 2 && numFrontline < 1) numFrontline = 1;
    
    // DEPENDENCY CHECK: Do not build support if Frontline is too weak
    // User Request: "AI needs a frontline else it won't send support"
    // Medics need at least 2 meatshields to be effective.
    const supportRatioMultiplier = (numFrontline >= 2) ? 1.0 : 0.0;
    
    let numRanged = Math.floor(targetGroupSize * selectedGroup.composition.ranged * ratioMultiplier);
    if (targetGroupSize > 2 && numRanged < 1) numRanged = 1;

    // Fill the rest with support or more ranged/melee depending on leftovers
    const assigned = numFrontline + numRanged;
    const remaining = Math.max(0, targetGroupSize - assigned);
    const numSupport = Math.floor(remaining * (selectedGroup.composition.support > 0 ? supportRatioMultiplier : 0));
    // Dump any remainder into Frontline/Ranged split
    const leftovers = remaining - numSupport;
    if (leftovers > 0) {
        if (personality.rangedPreference > 0.5) numRanged += leftovers;
        else numFrontline += leftovers;
    }
    
    let currentBudget = budget;
    const totalSlots = numFrontline + numRanged + numSupport;
    let slotsFilled = 0;

    // Helper to find unit with smart budget
    const findUnitForRole = (rolePreference: AIPersonality, slotsRemaining: number) => {
        // Reserve money for remaining slots (assuming minimal cost)
        const reserveNeeded = slotsRemaining * minUnitCost;
        // The max we can spend on THIS unit while keeping the plan alive
        const maxSpendable = Math.max(minUnitCost, currentBudget - reserveNeeded);
        
        return AIBehaviorUtils.findBestUnit(
            availableUnits,
            maxSpendable,
            rolePreference,
            state
        );
    };

    // 1. Fill Frontline (Priority: High)
    let frontlineAdded = 0;
    for (let i = 0; i < numFrontline; i++) {
        const slotsRemaining = (totalSlots - slotsFilled) - 1;
        
        // VARIETY & MEATSHIELD ORDERING:
        // First Unit (i=0): Hard Tank bias to ensure the "Point Man" is durable.
        // Subsequent Units: Lower Tank bias, higher Melee/Damage bias to mix in DPS units.
        const isPointMan = (i === 0);
        
        const rolePrefs = { 
            ...personality, 
            meleePreference: isPointMan ? 3.0 : 2.0,       // Reduced from 5.0
            tankPreference: isPointMan ? 4.0 : 1.5,        // First unit = Wall, Others = Bruisers
            rangedPreference: -1.0,
            // Point Man: Heavy Slow Preference (-3.0) -> Prefer Slowest Unit
            // Others: Slightly positive or random (0.0 to 1.0)
            fastPreference: isPointMan ? -3.0 : (personality.fastPreference + (Math.random() * 0.5)) 
        };

        const unit = findUnitForRole(rolePrefs, slotsRemaining);
        
        if (unit) {
            unitsToRecruit.push(unit);
            currentBudget -= availableUnits[unit].cost;
            frontlineAdded++;
            // Soft-exhaustion: Slightly reduce budget effectively to encourage variety? 
            // No, budget is real. 'findBestUnit' will naturally pick smaller units as budget shrinks.
        }
        slotsFilled++;
    }

    // SAFETY: If we wanted Frontline but failed to afford/find ANY, abort the whole group.
    // This prevents "Ranged Only" suicide squads when tanks are too expensive.
    if (numFrontline > 0 && frontlineAdded === 0) {
        return {
           action: 'WAIT',
           reasoning: `Group plan aborted: Could not afford any Frontline units (Budget: ${Math.floor(budget)}g)`,
        };
    }

    // 2. Fill Ranged
    for (let i = 0; i < numRanged; i++) {
        const slotsRemaining = (totalSlots - slotsFilled) - 1;
        
        // VARIETY IN RANGED UNITS:
        // Use noise in preferences to alternate between different ranged units (e.g. Archers vs Mages vs Skirmishers)
        const unit = findUnitForRole(
            { 
               ...personality, 
               rangedPreference: 5.0, 
               meleePreference: -1.0,
               manaUnitPreference: personality.manaUnitPreference + (Math.random() * 2.0 - 1.0) // +/- 1.0 jitter
            },
            slotsRemaining
        );
        
        if (unit) {
            unitsToRecruit.push(unit);
            currentBudget -= availableUnits[unit].cost;
        }
        slotsFilled++;
    }

    // 3. Fill Support 
    // SAFETY: Only add weak support if we have actual Frontline to protect them.
    // Count both what we plan to build AND what we already have.
    const plannedFrontline = numFrontline;
    let existingFrontline = 0;
    for (const unit of state.enemyUnits) {
         if (unit.health > 200 || (unit.health > 100 && state.enemyAge <= 2)) existingFrontline++;
    }
    const totalTankiness = plannedFrontline + existingFrontline;

    if (numSupport > 0 && state.enemyMana > 20) {
        // If we have minimal frontline (< 3 units), force Support count to 0 or 1 max.
        // This prevents buying 5 Medics when we only have 1 Tank.
        let actualSupportLimit = numSupport;
        if (totalTankiness < 2) actualSupportLimit = 0;
        else if (totalTankiness < 4) actualSupportLimit = Math.min(1, numSupport);

        for (let i = 0; i < actualSupportLimit; i++) {
            const slotsRemaining = (totalSlots - slotsFilled) - 1;
            const unit = findUnitForRole(
               { ...personality, manaUnitPreference: 5.0 },
               slotsRemaining
            );
             if (unit) {
                unitsToRecruit.push(unit);
                currentBudget -= availableUnits[unit].cost;
            }
            slotsFilled++;
        }
    }
    
    // SORTING: Ensure proper unit composition order (Slow/Melee first, Fast/Ranged last)
    // This allows tanks to absorb damage while ranged units deal damage from behind
    if (unitsToRecruit.length > 1) {
        unitsToRecruit.sort((a, b) => {
            const defA = availableUnits[a];
            const defB = availableUnits[b];
            if (!defA || !defB) return 0;
            
            // PRIORITY 1: RANGE (Melee = 0/1 range, always first)
            const rangeA = defA.range ?? 1;
            const rangeB = defB.range ?? 1;
            
            // If one is melee (<2) and other is ranged, melee first
            if (rangeA < 2 && rangeB >= 2) return -1;
            if (rangeB < 2 && rangeA >= 2) return 1;
            
            // PRIORITY 2: HEALTH (Tankier units first among peers)
            if (Math.abs(rangeA - rangeB) < 2) {
                return defB.health - defA.health; // Higher health first
            }
            
            // PRIORITY 3: SPEED (Slower units first)
            return defA.speed - defB.speed;
        });
    }

    // Store the full composition plan and start recruiting first unit
    if (unitsToRecruit.length > 0) {
      this.currentGroupPlan = {
        name: selectedGroup.name,
        units: unitsToRecruit,
        index: 1 // Will recruit index 0 now, continue with 1 next time
      };
      
      return {
        action: 'RECRUIT_UNIT',
        parameters: {
          unitType: unitsToRecruit[0],
          priority: 'normal',
        } as RecruitUnitParams,
        reasoning: `Attack group: ${selectedGroup.name} - recruiting ${unitsToRecruit[0]} (1/${unitsToRecruit.length})`,
      };
    }
    
    return {
      action: 'WAIT',
      reasoning: 'Could not find units for attack group',
    };
  }
  
  /**
   * Dynamic Recruitment (Enhanced Single Unit Selection)
   * Prioritizes maintaining a Frontline under fire.
   * Replaces standard single unit logic when battle is active.
   */
  private dynamicRecruitment(
    state: GameStateSnapshot,
    personality: AIPersonality,
    budget: number,
    threat: ThreatLevel
  ): AIDecision | null {
     // 1. Analyze Frontline Integrity
         // Calculate Enemy DPS (approximate)
     let incomingDPS = 0;
     for (const unit of state.playerUnits) {
         incomingDPS += Math.max(5, unit.damage); 
     }

     // Add Turret DPS estimate if near base
     if (state.enemyUnitsNearPlayerBase > 0) {
         const lvl = state.playerTurretLevel;
         if (lvl > 0) incomingDPS += (4 + lvl * (5 + lvl));
     }
     
     if (incomingDPS < 10) incomingDPS = 10; // Floor

     // Calculate Our Frontline Health
     let myFrontlineHP = 0;
     let myFrontlineCount = 0;
     for (const unit of state.enemyUnits) {
         const def = UNIT_DEFS[unit.unitId]; 
         const unitAge = def ? (def.age || 1) : 1;
         const isObsolete = (unitAge < state.enemyAge) && (unit.health < 200);

         if (!isObsolete && (unit.health > 150 || unit.range < 2.5)) {
             myFrontlineHP += unit.health;
             myFrontlineCount++;
         }
     }

     const survivalTime = myFrontlineHP / incomingDPS;
     const neededSurvivalTime = 8.0; // Increased to 8s for stable front logic
     
     const myBacklineCount = state.enemyUnits.length - myFrontlineCount;
     const backlineRatio = myBacklineCount / Math.max(1, myFrontlineCount);
     const isBacklineSaturated = backlineRatio > 2.5 && myFrontlineCount < 5;

     // DECISION: Do we need Frontline?
     const needsFrontline = myFrontlineCount < 2 || survivalTime < neededSurvivalTime || isBacklineSaturated;

     if (needsFrontline) {
         const reason = isBacklineSaturated ? "Frontline Ratio Low" : "Meat Shield < 8s";
         this.lastRecruitmentDecision = `Need Frontline (${reason})`;
         
         // --- ENHANCED FRONTLINE LOGIC ---
         // 1. Calculate Deficit
         const targetHP = incomingDPS * neededSurvivalTime;
         const missingHP = Math.max(400, targetHP - myFrontlineHP); // Minimum 400hp needed
         
         // 2. Find BEST Tank (Max Health Density)
         const availableUnits = getUnitsForAge(state.enemyAge);
         let bestTankId: string | null = null;
         let bestTankHP = -1;
         
         for (const [id, def] of Object.entries(availableUnits)) {
             // Filter: Must be Frontline (Melee or Tanky)
             const isFrontline = def.range && def.range < 2.5 || def.health > 250;
             if (!isFrontline) continue;
             
             // Cap cost, but allow expensive units in Age 6 or if Cheater
             if (def.cost > 2000 && personality.name !== 'Cheater' && state.enemyAge < 6) continue; 
             
             if (def.health > bestTankHP) {
                 bestTankHP = def.health;
                 bestTankId = id;
             }
         }
         
         // 3. Plan Squad
         if (bestTankId && bestTankHP > 0) {
             const tanksNeeded = Math.ceil(missingHP / bestTankHP);
             const count = Math.min(5, tanksNeeded); // Cap at 5 to avoid infinite queues
             
             if (count > 0) {
                 const bestTankDef = availableUnits[bestTankId];
                 const totalCost = count * bestTankDef.cost;
                 
                 // Create Plan
                 const tankSquad: string[] = Array(count).fill(bestTankId);
                 
                 // If we have existing plan, overwrite it if it's not a tank plan?
                 // Usually dynamicRecruitment is called when plan is null.
                 this.currentGroupPlan = {
                     name: `Emergency Frontline (${count}x ${bestTankId})`,
                     units: tankSquad,
                     index: 0
                 };
                 
                 // Check affordability of FIRST unit immediately
                 if (budget >= bestTankDef.cost) {
                     this.currentGroupPlan.index = 1; // Advance
                     this.lastRecruitmentDecision += ` -> Recruiting ${bestTankId} (1/${count})`;
                     return {
                        action: 'RECRUIT_UNIT',
                        parameters: { unitType: bestTankId, priority: 'normal' },
                        reasoning: `Frontline Reinforcement: ${bestTankId} (1/${count})`,
                     };
                 } else {
                     // WAIT for the good unit
                     const waitReason = `Saving for ${bestTankId} (Need ${count} for ${Math.floor(missingHP)} HP wall)`;
                     this.lastRecruitmentDecision = waitReason;
                     return {
                         action: 'WAIT',
                         reasoning: waitReason
                     };
                 }
             }
         }
         
         // Fallback if no tank found
         return this.recruitSingleUnitWithRole(state, personality, budget, threat, 'FRONTLINE');
     } else {
         this.lastRecruitmentDecision = "Frontline Stable, Adding DPS/Support";
         return this.recruitSingleUnitWithRole(state, personality, budget, threat, 'RANGED_SUPPORT');
     }
  }

  /**
   * Recruit a single unit based on preferences AND counter-picking
   * Accepts an optional Role Override.
   */
  private recruitSingleUnitWithRole(
    state: GameStateSnapshot,
    personality: AIPersonality,
    budget: number,
    threat: ThreatLevel,
    roleOverride?: 'FRONTLINE' | 'RANGED_SUPPORT'
  ): AIDecision | null {
    const availableUnits = getUnitsForAge(state.enemyAge);

    // SAFETY CHECK: Filter out units that are too weak to survive the current turret
    const safeUnits: Record<string, UnitDef> = {};
    let hasSafeUnit = false;

    // Only apply strict turret check if turret is significant (Level 3+)
    const shouldCheckTurret = state.playerTurretLevel >= 3;
    const rejectionReasons: string[] = [];

    for (const [name, def] of Object.entries(availableUnits)) {
       // Allow expensive units in Age 6
       if (def.cost > 2000 && personality.name !== 'Cheater' && state.enemyAge < 6) continue;
       
       // SPECIFIC FIX: Cyber Assassin should NOT be recruited via normal means (only via Mana Trigger in Age 6)
       // Unless specifically requested by a plan (which shouldn't happen if role is removed)
       if (name === 'cyber_assassin') continue;

       if (shouldCheckTurret && AIBehaviorUtils.isEnemyTurretTooStrong(state, def)) {
         rejectionReasons.push(`${name}(TooWeak)`);
         continue; // Skip suicide units
       }
       safeUnits[name] = def;
       hasSafeUnit = true;
    }

    if (rejectionReasons.length > 0) {
        this.lastRejectedUnits = rejectionReasons.join(", ");
    } else {
        this.lastRejectedUnits = "None";
    }
    
    // If no units are safe, wait.
    // RELAXATION: If we are desperate (Strategy = Defensive/Emergency), we might skip this wait and just recruit anyway.
    // For now, keep it but log better reasoning.
    if (!hasSafeUnit && shouldCheckTurret) {
        // Fallback: If we really need frontline, maybe we just spam cheap units?
        // But for now, respect the safety check.
        this.lastRecruitmentDecision += " (WAIT: All units too weak for Turret)";
        return {
            action: 'WAIT',
            reasoning: `Turret too strong for current units (Lv${state.playerTurretLevel}). Saving.`,
        };
    }

    // Use safe units if any, otherwise (e.g. low level turret) use all
    let unitsToConsider = hasSafeUnit ? safeUnits : availableUnits;
    
    // ROLE FILTERING: Strictly enforce role requirements
    // This prevents "accidentally" picking a Mage as a Tank just because it was cheap or affordable.
    if (roleOverride === 'FRONTLINE') {
        const filtered: Record<string, UnitDef> = {};
        let count = 0;
        for (const [name, def] of Object.entries(unitsToConsider)) {
            // Frontline must be Short Range (< 4) OR extremely Tanky (> 250 HP)
            // Iron Mage (Range 7, HP 50) will be excluded here.
            const isRanged = (def.range ?? 1) > 3.5; 
            const isTanky = def.health > 250;
            
            if (!isRanged || isTanky) {
                // If it's a Frontline role, we discard things that don't fit.
                // But we also check "Is this unit too fast?".
                // If we want slow units first, maybe we penalize fast ones in scoreUnit.
                filtered[name] = def;
                count++;
            }
        }
        // Only apply filter if we actually have valid frontline options available
        if (count > 0) unitsToConsider = filtered;
    }

    // ADJUST PERSONALITY
    const adjustedPersonality = { ...personality };
    
    if (roleOverride === 'FRONTLINE') {
        // STRONG BIAS for surviving
        // Tank and Melee are the frontline.
        adjustedPersonality.tankPreference = 4.0; 
        adjustedPersonality.meleePreference = 3.0; // Melee is also frontline usually
        adjustedPersonality.rangedPreference = 0.0;
        adjustedPersonality.manaUnitPreference = -1.0;
    } else if (roleOverride === 'RANGED_SUPPORT') {
        // Bias for damage dealing from behind
        adjustedPersonality.rangedPreference = 3.0;
        adjustedPersonality.manaUnitPreference = 1.0; // Support often has mana
        adjustedPersonality.tankPreference = 0.1; 
        adjustedPersonality.meleePreference = 0.1;
        
        // SUPPORT SAFETY CHECK:
        // Do not pick Pure Support units (Healers/Low Dmg Buffers) if we have no frontline.
        // If we have < 2 units, force filter out units with 'heal' skill or extremely low damage.
        // REFINED: Check against effective frontline, not just unit count.
        // If we only have 2 units and they are crappy crossbomen, do not buy a medic!
        
        // Re-count EFFECTIVE frontline (HP > 150 or Tank)
        let effectiveFrontline = 0;
        for (const unit of state.enemyUnits) {
             if (unit.health > 150) effectiveFrontline++;
        }

        const filtered: Record<string, UnitDef> = {};
        let count = 0;
        for (const [name, def] of Object.entries(unitsToConsider)) {
             // Check if unit is a dedicated healer (skill.type === 'heal')
             const isHealer = def.skill?.type === 'heal';
             // Check if unit is ultra-squishy (< 60 HP) e.g. Mage
             const isGlassCannon = (def.health < 60) && (def.age ?? 1) >= 3;

             // BANS:
             // 1. Healer: Needs 3+ strong frontline units.
             // Also enforce a hard cap on healers relative to army size to prevent spam
             const healerCount = state.enemyUnits.filter(u => UNIT_DEFS[u.unitId]?.skill?.type === 'heal').length;
             // DEBUG LOG LOGIC for Healer
             // if (isHealer) console.log(`Stats ${name}: FL ${effectiveFrontline}, H ${healerCount}`);

             if (isHealer && (effectiveFrontline < 3 || healerCount >= 3)) continue;
             
             // 2. Glass Cannon (Mage): Needs 2+ strong frontline units.
             if (isGlassCannon && effectiveFrontline < 2) continue;
             
             // 3. Support Spam Prevention:
             // If this is a Support unit (Catapult/Mage/Archer) and we already have tons, skip it.
             // Allow max 3 of any specific support type unless we have a massive army
             // Using current count of THIS specific unit type
             const sameUnitCount = state.enemyUnits.filter(u => u.unitId === name).length;
             if (roleOverride === 'RANGED_SUPPORT' && sameUnitCount >= 3 && effectiveFrontline < 5) {
                // If we have 3 Catapults and < 5 Tanks, do not buy a 4th Catapult.
                continue;
             }

             filtered[name] = def;
             count++;
        }
        if (count > 0) unitsToConsider = filtered;

    } else {
        // STANDARD COUNTER LOGIC (Original 'recruitSingleUnit' logic)
        this.lastRecruitmentDecision = "Counter-Picking";
        let enemyRangedCount = 0;
        let enemyMeleeCount = 0;
        let enemyTankCount = 0;
        
        for (const unit of state.playerUnits) {
          if (unit.range > 2) enemyRangedCount++;
          else if (unit.health > 300) enemyTankCount++;
          else enemyMeleeCount++;
        }
        
        // Counter Logic
        if (threat >= ThreatLevel.HIGH || this.currentStrategy === 'DEFENSIVE') {
            if (enemyRangedCount > enemyMeleeCount) {
                adjustedPersonality.tankPreference = 0.9;
                adjustedPersonality.meleePreference = 0.8;
                adjustedPersonality.rangedPreference = 0.3;
            } else if (enemyMeleeCount + enemyTankCount > enemyRangedCount) {
                adjustedPersonality.rangedPreference = 0.9;
                adjustedPersonality.tankPreference = 0.4;
            }
        } else if (this.currentStrategy === 'AGGRESSIVE') {
            adjustedPersonality.manaUnitPreference = Math.max(0.7, personality.manaUnitPreference);
            adjustedPersonality.rangedPreference = 0.8;
        }
    }
    
    // Use the safe units filter we created earlier
    const bestUnit = AIBehaviorUtils.findBestUnit(
      unitsToConsider,
      budget,
      adjustedPersonality,
      state
    );
    
    if (bestUnit) {
      const reasonSuffix = roleOverride ? ` (${roleOverride})` : '';
      this.lastRecruitmentDecision += ` -> Picked ${bestUnit}`;
      return {
        action: 'RECRUIT_UNIT',
        parameters: {
          unitType: bestUnit,
          priority: 'normal',
        } as RecruitUnitParams,
        reasoning: `[${this.currentStrategy}] ${bestUnit}${reasonSuffix}`,
      };
    }

    // RETRY LOGIC: If we failed to find a safe unit, but we REALLY need a Frontline,
    // try looking at the unsafe units too (suicide run).
    if (roleOverride === 'FRONTLINE' && hasSafeUnit && bestUnit === null) {
         // We had safe units (likely big expensive mechs), but couldn't afford them/no mana.
         // Let's check the UNSAFE units (cheap robot soldiers) to see if we can at least send bodies.
         this.lastRecruitmentDecision += " -> Retry (Unsafe)";
         
         const desperateUnits = availableUnits; // Use ALL units, ignoring safety
         
         // Re-apply role filter to the full list
         const filtered: Record<string, UnitDef> = {};
         let count = 0;
         for (const [name, def] of Object.entries(desperateUnits)) {
            const isRanged = (def.range ?? 1) > 3.5; 
            const isTanky = def.health > 250;
            if (!isRanged || isTanky) {
                filtered[name] = def;
                count++;
            }
         }
         
         if (count > 0) {
             const desperateBest = AIBehaviorUtils.findBestUnit(filtered, budget, adjustedPersonality, state);
             if (desperateBest) {
                 this.lastRecruitmentDecision += ` -> Panic Pick ${desperateBest}`;
                 return {
                    action: 'RECRUIT_UNIT',
                    parameters: { unitType: desperateBest, priority: 'emergency' },
                    reasoning: `Desperate Frontline: ${desperateBest} (ignoring turret safety)`,
                 };
             }
         }
    }
    
    // Fallback if no unit found/affordable
    this.lastRecruitmentDecision += " -> No affordable unit found";
    return null;
  }

  
  reset(): void {
    this.lastAttackGroupTime = 0;
    this.currentGroupPlan = null;
    this.lastStrategySwitch = 0;
    this.currentStrategy = 'BALANCED';
    this.consecutiveDefenseFrames = 0;
    this.pendingTurretReplacement = null;
  }
}
