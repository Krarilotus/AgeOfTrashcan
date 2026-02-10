/**
 * AI Behavior Interface
 * Defines the contract for pluggable AI behaviors
 * Allows different strategies and ML-based behaviors
 */

import { AIPersonality, AttackGroup, AI_TUNING } from '../config/aiConfig';
import { UnitDef, UNIT_DEFS, getUnitsForAge } from '../config/units';

/**
 * Game state snapshot for AI decision making
 * Comprehensive snapshot with all data needed for sophisticated AI decisions
 */
export interface GameStateSnapshot {
  // Time
  tick: number;
  gameTime: number; // Game time in seconds
  
  // Player economy & progression
  playerGold: number;
  playerMana: number;
  playerAge: number;
  playerAgeCost: number;
  playerManaLevel: number;
  playerGoldIncome: number; // Gold per second
  playerManaIncome: number; // Mana per second
  
  // Enemy economy & progression (AI's own state)
  enemyGold: number;
  enemyMana: number;
  enemyAge: number;
  enemyAgeCost: number;
  enemyManaLevel: number;
  enemyGoldIncome: number;
  enemyManaIncome: number;
  
  // Player base & defenses
  playerBaseHealth: number;
  playerBaseMaxHealth: number;
  playerTurretLevel: number;
  playerTurretDps: number;
  playerTurretMaxRange: number;
  playerTurretAvgRange: number;
  playerTurretProtectionMultiplier: number;
  playerTurretSlotsUnlocked: number;
  playerTurretInstalledCount: number;
  playerTurretSlots: Array<{
    slotIndex: number;
    turretId: string | null;
    cooldownRemaining: number;
  }>;
  
  // Enemy base & defenses (AI's own base)
  enemyBaseHealth: number;
  enemyBaseMaxHealth: number;
  enemyTurretLevel: number;
  enemyTurretDps: number;
  enemyTurretMaxRange: number;
  enemyTurretAvgRange: number;
  enemyTurretProtectionMultiplier: number;
  enemyTurretSlotsUnlocked: number;
  enemyTurretInstalledCount: number;
  enemyTurretSlots: Array<{
    slotIndex: number;
    turretId: string | null;
    cooldownRemaining: number;
  }>;
  
  // Units
  playerUnitCount: number;
  enemyUnitCount: number;
  playerUnits: Array<{
    unitId: string;
    health: number;
    maxHealth: number;
    position: number;
    damage: number;
    range: number;
  }>;
  enemyUnits: Array<{
    unitId: string;
    health: number;
    maxHealth: number;
    position: number;
    damage: number;
    range: number;
  }>;
  
  // Queues
  playerQueueSize: number;
  enemyQueueSize: number;
  playerTurretQueueCount: number;
  enemyTurretQueueCount: number;
  
  // Battlefield
  battlefieldWidth: number;
  playerBaseX: number;
  enemyBaseX: number;
  
  // Tactical analysis
  playerUnitsNearEnemyBase: number;
  enemyUnitsNearPlayerBase: number;
  lastEnemyBaseAttackTime: number; // Time in seconds when enemy base was last attacked
  
  // Difficulty
  difficulty: 'EASY' | 'MEDIUM' | 'HARD' | 'SMART' | 'SMART_ML' | 'CHEATER';
}

/**
 * AI decision output
 */
export interface AIDecision {
  action: AIAction;
  parameters?: any;
  confidence?: number; // For ML: confidence in this decision (0.0 to 1.0)
  reasoning?: string; // For debugging/explanation
}

export type AIAction =
  | 'WAIT' // Do nothing this tick
  | 'RECRUIT_UNIT' // Recruit a specific unit
  | 'AGE_UP' // Advance to next age
  | 'UPGRADE_MANA' // Upgrade mana generation
  | 'UPGRADE_TURRET_SLOTS'
  | 'BUY_TURRET_ENGINE'
  | 'SELL_TURRET_ENGINE'
  | 'REPAIR_BASE' // Repair base health using mana (Age 6+)
  | 'ACTIVATE_SKILL' // Use a unit skill
  | 'EXECUTE_ATTACK_GROUP'; // Execute a coordinated attack group

/**
 * Parameters for RECRUIT_UNIT action
 */
export interface RecruitUnitParams {
  unitType: string;
  count?: number; // Optional: recruit multiple at once
  priority?: 'low' | 'normal' | 'high' | 'emergency';
}

/**
 * Parameters for EXECUTE_ATTACK_GROUP action
 */
export interface AttackGroupParams {
  group: AttackGroup;
  goldBudget: number;
  units: string[]; // Specific unit types to recruit
}

/**
 * Base interface for AI behaviors
 */
export interface IAIBehavior {
  /**
   * Get the name/type of this behavior
   */
  getName(): string;
  
  /**
   * Make a decision based on current game state
   */
  decide(state: GameStateSnapshot, personality: AIPersonality): AIDecision;
  
  /**
   * Update internal state (for learning behaviors)
   */
  update?(state: GameStateSnapshot, reward?: number): void;
  
  /**
   * Reset behavior state (for new game)
   */
  reset?(): void;
  
  /**
   * Get current strategy parameters (for debugging/tuning)
   */
  getParameters?(): Record<string, any>;
  
  /**
   * Set strategy parameters (for ML training)
   */
  setParameters?(params: Record<string, any>): void;
}

/**
 * Threat assessment levels
 */
export enum ThreatLevel {
  MINIMAL = 'MINIMAL', // Enemy very weak
  LOW = 'LOW', // Enemy weaker than us
  MODERATE = 'MODERATE', // Enemy about equal
  HIGH = 'HIGH', // Enemy stronger than us
  CRITICAL = 'CRITICAL', // Enemy overwhelming
}

/**
 * Strategic state the AI is in
 */
export enum StrategicState {
  EARLY_GAME = 'EARLY_GAME', // Ages 1-2
  MID_GAME = 'MID_GAME', // Ages 3-4
  LATE_GAME = 'LATE_GAME', // Ages 5-6
  ECONOMY = 'ECONOMY', // Building economy, aging up
  MILITARY = 'MILITARY', // Building army
  PUSHING = 'PUSHING', // Active offense
  DEFENDING = 'DEFENDING', // Active defense
  DESPERATE = 'DESPERATE', // Last stand
}

/**
 * Threat Details Breakdown
 */
export interface ThreatDetails {
  level: ThreatLevel;
  playerScore: number;
  enemyScore: number;
  ratio: number;
   FACTORS: {
    unitScoreP: number;
    unitScoreE: number;
    goldThreat: number;
    turretThreatP: number;
    turretThreatE: number;
  }
}

/**
 * Helper utilities for AI behaviors
 */
export class AIBehaviorUtils {
  static assessThreat(state: GameStateSnapshot): ThreatLevel {
    return this.assessThreatDetails(state).level;
  }

  static assessThreatDetails(state: GameStateSnapshot): ThreatDetails {
    // Calculate relative army strength based on combat power (health + damage)
    // For enemy AI: player is threat, enemy is our forces
    
    let playerArmyStrength = 0;
    let enemyArmyStrength = 0;
    
    // Components for Debug
    let pUnitScore = 0;
    let eUnitScore = 0;
    let goldScore = 0;
    let pTurretScore = 0;
    let eTurretScore = 0;

    // Calculate player (threat) army strength
    for (const unit of state.playerUnits) {
      let combatValue = unit.health + (unit.damage * 10);
      
      // Proximity Threat: Units past the midfield (closer to our base) are more dangerous
      // We are at X=Width. Player starts at X=0.
      // Unit.position is X. High X = Close to us.
      const proximityScore = unit.position / state.battlefieldWidth; // 0.0 (Far) -> 1.0 (In our face)
      
      if (proximityScore > 0.6) combatValue *= 1.5; // Past midfield
      if (proximityScore > 0.8) combatValue *= 2.0; // Knocking on door
      
      playerArmyStrength += combatValue;
    }
    pUnitScore = playerArmyStrength;

    // Calculate enemy (our) army strength - FIXED MISSING LOOP
    for (const unit of state.enemyUnits) {
        let combatValue = unit.health + (unit.damage * 10);
        // Base defense bonus? No, let's keep it raw for now.
        enemyArmyStrength += combatValue;
    }
    eUnitScore = enemyArmyStrength;
    
    // Economic Threat Calculation (Tiered Diminishing Returns)
    // User Request: Gold disadvantage shouldn't scale indefinitely. 
    // It scales 100% up to AgeCost/4, then 50% up to AgeCost/2, then 25% up to AgeCost. Capped after that.
    
    // We compare net gold status.
    const goldDiff = state.playerGold - state.enemyGold;
    const isPlayerRich = goldDiff > 0;
    const absoluteDeficit = Math.abs(goldDiff);
    
    // Determine the "Economy Scale" of the current game phase
    // If Age 6 (Max), we use a fixed high value (e.g. 10000) or last age cost
    const economyScale = state.enemyAgeCost > 0 ? state.enemyAgeCost : 10000;
    
    const tier1 = economyScale * 0.25; // 25% of Age Cost
    const tier2 = economyScale * 0.50; // 50% of Age Cost
    const tier3 = economyScale * 1.00; // 100% of Age Cost
    
    let effectiveGoldDiff = 0;
    
    if (absoluteDeficit <= tier1) {
        effectiveGoldDiff = absoluteDeficit;
    } else if (absoluteDeficit <= tier2) {
        effectiveGoldDiff = tier1 + (absoluteDeficit - tier1) * 0.5;
    } else if (absoluteDeficit <= tier3) {
        effectiveGoldDiff = tier1 + (tier2 - tier1) * 0.5 + (absoluteDeficit - tier2) * 0.25;
    } else {
        // Capped at tier 3 total
        effectiveGoldDiff = tier1 + (tier2 - tier1) * 0.5 + (tier3 - tier2) * 0.25;
    }
    
    // Apply the effective gold difference to the stronger side
    // REDUCED MULTIPLIER: Gold is potential, not kinetic. 
    // 1 Gold was 5 Value. Now 0.5 Value. (Recruiting takes time).
    const goldValue = effectiveGoldDiff * 0.5;
    if (isPlayerRich) {
        playerArmyStrength += goldValue;
        goldScore = goldValue; // Positive means Player Advantage
    } else {
        enemyArmyStrength += goldValue;
        goldScore = -goldValue; // Negative means Enemy Advantage
    }
    
    // Factor in turret strength as defensive power
    const playerTurretPower = state.playerTurretDps * 6 + state.playerTurretMaxRange * 5;
    const enemyTurretPower = state.enemyTurretDps * 6 + state.enemyTurretMaxRange * 5;
    
    // Add turret power ONLY if it helps defense. 
    // We EXCLUDE the Player's turret from the "Survival Threat" calculation. 
    // The Player's turret cannot march across the map and kill us. It only prevents us from winning.
    // Logic: High Threat = "I am going to die". Player Turret != "I am going to die".
    
    if (state.playerUnitsNearEnemyBase > 0) {
      enemyArmyStrength += enemyTurretPower; // Our turret helps defend us
      eTurretScore = enemyTurretPower;
    }
    
    // REMOVED: playerTurretPower adding to playerArmyStrength.
    // This previously made the AI think "The enemy is strong" just because they had a turret.
    // This caused the AI to panic/retreat when it was actually pushing effectively.
    
    // Calculate threat ratio (how much stronger is the threat vs our forces)
    let ratio = playerArmyStrength / Math.max(enemyArmyStrength, 1);
    
    // OVERRIDE: If player has NO units on the field, threat cannot be Critical/High based on gold alone.
    // Unless they have a turret near us (captured ground).
    if (state.playerUnitCount === 0 && state.enemyUnitsNearPlayerBase === 0) {
        ratio = Math.min(ratio, 1.1); // Cap at Moderate/Low
    }

    let level = ThreatLevel.MINIMAL;
    // Use dynamic thresholds based on actual strength
    if (ratio > 2.5) level = ThreatLevel.CRITICAL;  // Vastly outnumbered
    else if (ratio > 1.8) level = ThreatLevel.HIGH;      // Significantly outnumbered
    else if (ratio > 1.2) level = ThreatLevel.MODERATE;  // Somewhat outnumbered
    else if (ratio > 0.8) level = ThreatLevel.LOW;       // Roughly equal
    
    return {
        level,
        playerScore: playerArmyStrength,
        enemyScore: enemyArmyStrength,
        ratio,
        FACTORS: {
            unitScoreP: pUnitScore,
            unitScoreE: eUnitScore,
            goldThreat: goldScore,
            turretThreatP: pTurretScore,
            turretThreatE: eTurretScore
        }
    };
  }
  
  /**
   * Evaluate the feasibility of an attack (Offensive Analysis)
   * This IS where the Player's Turret matters.
   * A high Attack Resistance means we need a bigger meat shield.
   */
  static evaluateAttackFeasibility(state: GameStateSnapshot): { feasibility: number; requiredMeatShield: number } {
     // 1. Calculate Enemy Static Defense (Turret)
     const turretDps = state.playerTurretDps;
     const turretHealth = state.playerBaseHealth;
     
     // 2. Calculate Enemy Defending Units
     let defendingStrength = 0;
     for (const unit of state.playerUnits) {
         // Units near their own base count double for defense
         // state.battlefieldWidth is 'our' base X (usually 100 or something). Player base is 0.
         // Wait, battlefield config says: basePositions: { player: 0, enemy: 50 } (from App.tsx)
         // So player base is 0. Enemy base acts as max X.
         // Player Units: High Position = Near Enemy. Low Position = Near Player.
         
         const distToPlayerBase = unit.position; 
         if (distToPlayerBase < 20) { // Near player base (arbitrary 20 range)
             defendingStrength += (unit.health + unit.damage * 10);
         }
     }
     
     // Base Resistance Score
     const auraResistance = (1 - (state.playerTurretProtectionMultiplier || 1)) * 1200;
     const resistance = (turretDps * 50) + defendingStrength + auraResistance; // Turret + aura resistance
     
     // Our available pushing power (current units)
     let pushingPower = 0;
     let totalHealth = 0;
     for (const unit of state.enemyUnits) {
         pushingPower += (unit.damage * 10);
         totalHealth += unit.health;
     }

     // Ratio > 1.0 means we can likely push
     const feasibility = pushingPower / Math.max(resistance, 1);
     
     // Meat Shield Calculation: 
     // We need enough HP to survive Turret DPS for X seconds while dealing damage.
     // Estimate time to kill base = BaseHealth / TotalDPS.
     // Est. Incoming Damage = Time * TurretDPS.
     
     const estimatedKillTime = turretHealth / Math.max(pushingPower / 10, 10); // Div 10 because Power = Dmg*10 above
     const incomingDamage = estimatedKillTime * turretDps;
     
     return {
         feasibility,
         requiredMeatShield: incomingDamage * 1.5 // 50% safety margin
     };
  }

  /**
   * Determine strategic state based on game progression
   */
  static getStrategicState(state: GameStateSnapshot, threat: ThreatLevel): StrategicState {
    // Desperate situation
    if (state.enemyBaseHealth < state.enemyBaseMaxHealth * 0.3) {
      return StrategicState.DESPERATE;
    }
    
    // Defending when threatened
    if (threat === ThreatLevel.HIGH || threat === ThreatLevel.CRITICAL) {
      return StrategicState.DEFENDING;
    }
    
    // Pushing when strong
    if (threat === ThreatLevel.MINIMAL && state.enemyUnitCount > 3) {
      return StrategicState.PUSHING;
    }
    
    // Game phase
    if (state.enemyAge <= 2) return StrategicState.EARLY_GAME;
    if (state.enemyAge <= 4) return StrategicState.MID_GAME;
    return StrategicState.LATE_GAME;
  }

  /**
   * Calculate dynamic economic thresholds based on game state
   * Replaces hardcoded values in aiConfig with "in-depth strategizing" logic
   */
  static calculateDynamicThresholds(state: GameStateSnapshot): {
    minimumReserve: number;
    emergencyUnitCost: number;
    turretBuffer: number;
  } {
    // 1. Dynamic Reserve: Minimal "Pocket Change"
    // User Complaint: "Permanent reserve of 148g" (due to previous 3s income buffer).
    // Fix: Reduced to a flat, minimal safety net.
    // We just want to avoid hitting exactly 0 so we can always buy a cheap unit if desperate.
    // 25g is enough for an Age 1 Slinger/Clubman.
    const minimumReserve = 25;

    // 2. Emergency Threshold: Context-Aware Unit Cost
    // Find the cheapest unit we can ACTUALLY buy right now
    const availableUnits = getUnitsForAge(state.enemyAge);
    let minUnitCost = Infinity;
    for (const def of Object.values(availableUnits)) {
       // Filter out mana units if we have no mana
       if ((def.manaCost || 0) > state.enemyMana) continue;
       minUnitCost = Math.min(minUnitCost, def.cost);
    }
    // Fallback if all units require mana we don't have: just use raw cheapest
    if (minUnitCost === Infinity) {
        for (const def of Object.values(availableUnits)) {
            minUnitCost = Math.min(minUnitCost, def.cost);
        }
    }
    const emergencyUnitCost = minUnitCost === Infinity ? 100 : minUnitCost;

    // 3. Turret Buffer: Army-Relative Cost
    // Don't buy a turret if it prevents us from buying at least 2 units immediately after
    const turretBuffer = emergencyUnitCost * 2.0;

    return { minimumReserve, emergencyUnitCost, turretBuffer };
  }
  
  /**
   * Calculate available budget considering reserves and savings
   */
  static calculateAvailableBudget(
    gold: number,
    savingsRate: number,
    minimumReserve: number
  ): number {
    const spendableGold = Math.max(0, gold - minimumReserve);
    return spendableGold * (1.0 - savingsRate);
  }
  
  /**
   * Score a unit for recruitment based on preferences and situation
   * IMPORTANT: Balanced scoring that values unit diversity and current-age units
   */
  static scoreUnit(
    unitDef: UnitDef,
    unitType: string,
    personality: AIPersonality,
    state: GameStateSnapshot
  ): number {
    let score = 0;
    
    // Explicit Role Classification (multi-tag support)
    const roles = unitDef.role || [];
    
    // Heuristic Fallbacks if no roles defined
    const hasRole = (r: string) => roles.includes(r as any);
    
    const isRanged = roles.length > 0 ? (hasRole('RANGED_DPS') || hasRole('SUPPORT')) : (unitDef.range ?? 1) > 1.5;
    const isFast = unitDef.speed > 6.0;
    
    // Tank logic: Check 'TANK' or 'BRUISER' or fallback to HP
    const isTank = roles.length > 0 ? (hasRole('TANK') || hasRole('BRUISER')) : unitDef.health > 100;
    const requiresMana = (unitDef.manaCost ?? 0) > 0;
    
    // BASE SCORE: Combat value (damage is more important than health)
    const combatValue = unitDef.damage * 5 + unitDef.health / 10;
    score += combatValue;
    
    // Range bonus: Scales with damage, not arbitrary huge value
    // Ranged units get bonus based on their actual combat effectiveness
    if (isRanged) {
      const rangeMultiplier = Math.min((unitDef.range ?? 1) / 6.0, 2.0); // Max 2x for long range
      score += unitDef.damage * rangeMultiplier * 2; // Bonus based on damage output
    }
    
    // Apply personality preferences (moderate impact)
    // BOOSTED: If the AI specifically requested a role (e.g. Melee Pref > 2.0), 
    // we want that effectively to be a CONSTRAINT, not just a suggestion.
    if (!isRanged) score += personality.meleePreference * (personality.meleePreference > 1.5 ? 200 : 40);
    if (isRanged) score += personality.rangedPreference * (personality.rangedPreference > 1.5 ? 200 : 40);
    
    // Speed scoring
    // Supports NEGATIVE fastPreference to specifically prefer SLOW units.
    if (personality.fastPreference < 0) {
        // Prefer SLOW: Score inversely proportional to speed
        const speed = unitDef.speed || 3;
        score += Math.max(0, 10 - speed) * Math.abs(personality.fastPreference) * 10;
        
        // HARSH Penalty for actual "Fast" units (>6.0)
        if (isFast) score -= 300;
        
    } else {
        // Original: Bonus for Fast units
        if (isFast) score += personality.fastPreference * (personality.fastPreference > 1.5 ? 100 : 25);
    }
    
    if (isTank) score += personality.tankPreference * (personality.tankPreference > 1.5 ? 200 : 30);
    
    // MANA PREFERENCE FIX:
    // Only apply 'manaUnitPreference' boost/penalty if the unit is acting in a SUPPORT/CASTER role.
    const isSupportRole = hasRole('SUPPORT') || (requiresMana && (isRanged || unitDef.skill?.type === 'heal'));
    
    if (isSupportRole) {
        score += personality.manaUnitPreference * 35;
    } else if (requiresMana) {
        // Melee/Tank with Mana (Power Unit) - Flat small bonus
        score += 15; 
    }
    
    // Age bonus: STRONGLY prefer current age units
    // REDUCED from 5.0 to 2.5 to allow previous age units if they fit the Role better
    // UPDATED: Now much flatter (1.5 vs 1.0) so previous age units (e.g. good tanks) aren't discarded
    // User Request: "have ALL units of the age its in at its disposal not only the basic units"
    if (unitDef.age === state.enemyAge) {
      score *= 1.5; 
    } else if (unitDef.age === state.enemyAge - 1) {
      score *= 1.0; // No penalty for -1 age
    } else if (unitDef.age === state.enemyAge - 2) {
      score *= 0.5; // -2 age is workable
    } else {
      score *= 0.1; // Ancient units penalty
    }
    
    // Check mana availability
    // FIX warning: If unit requires mana, but we don't have it, does that mean we should NEVER buy it?
    // User says "basic units that have no mana cost" are picked too much.
    // If we have mana income, we should plan to buy it!
    // But if current mana < cost, we physically *cannot* buy it *now*.
    // However, scoreUnit isn't just about "can I buy now?", it's "do I want this?".
    // If strict check is here, 'findBestUnit' filters it out?
    // Actually findBestUnit loops: if ((unitDef.manaCost ?? 0) > state.enemyMana) continue;
    // So this penalty inside scoreUnit is redundant or double-punishing.
    // We'll remove the penalty here so high-value Mana units score well naturally.
    // (The loop in findBestUnit handles the hard "can I afford it" check)
    
    // VARIETY PENALTY (Diminishing Returns)
    // Reduce score if we already have many of this unit type on the field
    const countOnField = state.enemyUnits.filter(u => u.unitId === unitType).length;
    if (countOnField > 3) {
        score *= 0.85; // Slight penalty for spamming the same unit
        if (countOnField > 6) score *= 0.85; // Cumulative
    }

    // SIEGE/AOE BIAS
    // If unit is SIEGE type, apply situational bonus
    if (hasRole('SIEGE')) {
        const playerComp = this.analyzePlayerComposition(state);
        // Bonus if enemy is swarming or has strong turret
        if (playerComp.isSwarm) score *= 1.3; // +30% vs Swarm
        if (state.playerTurretLevel >= 3) score *= 1.1; // +10% vs Strong Turret
    }

    // COST EFFICIENCY FACTOR
    // Previous logic purely favored stats (Score) regardless of cost, leading to "Expensive = Better".
    // We blend Raw Power (50%) with Cost Efficiency (50%).
    // Use sqrt(cost) to avoid excessive bias toward cheap swarm units.
    if (unitDef.cost > 0) {
        const efficiency = combatValue / Math.sqrt(unitDef.cost);
        // Normalize efficiency to be roughly comparable to raw score
        // Raw score is approx combatValue. Efficiency is combatValue/10 roughly.
        // Multiply efficiency by 12 to bring it to same magnitude.
        const weightedEfficiency = efficiency * 12;
        
        // Blend: 60% Raw Power, 40% Efficiency
        // If we allow efficiency to dominate, we get Knight spam. 
        // If we allow Raw Power to dominate, we get Elephant spam.
        // Balanced approach:
        score = (score * 0.6) + (weightedEfficiency * 0.4);
    }

    // Cost efficiency check (Budget Ratio)
    // Penalize units that are TOO cheap (unless fodder needed)
    // But do NOT penalize expensive units if we are rich.
    // Fixed Average Cost Scaling for higher ages
    const avgCostForAge = 40 * Math.pow(1.5, state.enemyAge - 1); // 1:40, 2:60, 3:90, 4:135, 5:202, 6:303
    const costRatio = unitDef.cost / avgCostForAge;
    
    if (costRatio < 0.4) {
      score *= 0.8; // Penalty for being too weak/cheap
    } 
    
    // WEALTH ADJUSTMENT:
    // If we have > 2000g, we WANT expensive units.
    if (state.enemyGold > 2000) {
        if (costRatio > 1.5) score *= 1.5; // Bonus for expensive units
    } else {
        // Normal budget logic
        if (costRatio > 3.0) {
             score *= 0.7; // Hard to spam
        }
    }
    
    return score;
  }
  
  /**
   * Find best unit to recruit given budget and preferences
   * Now includes counter-picking logic based on player's composition
   */
  static findBestUnit(
    availableUnits: Record<string, UnitDef>,
    maxCost: number,
    personality: AIPersonality,
    state: GameStateSnapshot
  ): string | null {
    let bestUnit: string | null = null;
    let bestScore = -Infinity;
    
    // Analyze player's composition
    const playerComposition = this.analyzePlayerComposition(state);
    
    for (const [unitType, unitDef] of Object.entries(availableUnits)) {
      // Check affordability
      if (unitDef.cost > maxCost) continue;
      if ((unitDef.manaCost ?? 0) > state.enemyMana) continue;
      // Filter out Void Reaper from normal selection unless requested
      if (unitType === 'void_reaper' && personality.name !== 'Cheater') continue;

      let score = this.scoreUnit(unitDef, unitType, personality, state);
      
      // Apply counter-picking bonus
      score *= this.getCounterBonus(unitDef, playerComposition);
      
      if (score > bestScore) {
        bestScore = score;
        bestUnit = unitType;
      }
    }
    
    return bestUnit;
  }
  
  /**
   * Analyze player's unit composition to enable counter-picking
   * Scans actual stats of units on the field.
   */
  static analyzePlayerComposition(state: GameStateSnapshot): {
    hasRanged: boolean;
    hasMelee: boolean;
    hasTanks: boolean;
    isSwarm: boolean;
    avgDamage: number;
    avgHealth: number;
    totalCount: number;
  } {
    if (state.playerUnits.length === 0) {
        return {
            hasRanged: false, hasMelee: false, hasTanks: false, isSwarm: false,
            avgDamage: 0, avgHealth: 0, totalCount: 0
        };
    }

    let rangedCount = 0;
    let meleeCount = 0;
    let tankCount = 0;
    let totalDmg = 0;
    let totalHp = 0;

    for (const unit of state.playerUnits) {
        if (unit.range > 2.5) rangedCount++;
        else meleeCount++;
        
        // Threshold adjusted for Age 1 Dinos (120 HP)
        if (unit.health > 100) tankCount++;
        
        totalDmg += unit.damage;
        totalHp += unit.health;
    }
    
    const count = state.playerUnits.length;
    const avgHealth = totalHp / count;
    
    // SWARM DEFINITION:
    // 1. High unit count (> 3)
    // 2. Low average health (< 200) - indicates mostly spam units
    const isSwarm = count >= 4 && avgHealth < 200;

    return {
      hasRanged: rangedCount > 1, // At least 2 to consider it a threat pattern
      hasMelee: meleeCount > 0,
      hasTanks: tankCount > 0,
      isSwarm,
      avgDamage: totalDmg / count,
      avgHealth: avgHealth,
      totalCount: count
    };
  }
  
  /**
   * Calculate counter bonus for unit selection
   * Ranged units counter melee, tanks counter ranged, fast units flank
   */
  static getCounterBonus(unitDef: UnitDef, playerComp: {
    hasRanged: boolean;
    hasMelee: boolean;
    hasTanks: boolean;
    isSwarm: boolean;
  }): number {
    let bonus = 1.0;
    
    // REDUCED HP threshold for tanks in Age 1 to work properly (100hp+)
    const roles = unitDef.role || [];
    const isRanged = (unitDef.range ?? 1) > 1.5;
    const isTank = roles.includes('TANK') || unitDef.health > 100; 
    const isFast = unitDef.speed > 6.0;
    const isSiege = roles.includes('SIEGE') || unitDef.skill?.type === 'aoe' || unitDef.skill?.type === 'flamethrower';
    
    // Ranged units counter melee swarms
    if (isRanged && playerComp.hasMelee) {
      bonus *= 1.3;
    }
    
    // Tanks counter ranged attacks
    if (isTank && playerComp.hasRanged) {
      bonus *= 1.4;
    }
    
    // Fast units flank and disrupt
    if (isFast) {
      bonus *= 1.2;
    }
    
    // High-damage units counter tanks
    if (unitDef.damage > 80 && playerComp.hasTanks) {
      bonus *= 1.3;
    }
    
    // Siege/AOE counters Swarms
    // User Request: "mix in if enemy has lots of smaller units"
    if (isSiege && playerComp.isSwarm) {
       // Strong bonus to prioritize splashing the swarm
       bonus *= 1.6;
    }
    
    return bonus;
  }

  /**
   * Calculate Projected Mana Needs based on Unit Preferences and Abilities
   * Used to plan Mana Upgrades intelligently.
   */
  static calculateProjectedManaNeed(
    state: GameStateSnapshot,
    personality: AIPersonality
  ): number {
    const units = getUnitsForAge(state.enemyAge);
    let totalManaCostPerSec = 0;
    
    // 1. Base recruitment mana (if we use mana units)
    // Assume we recruit a unit every 5 seconds roughly
    for (const unit of Object.values(units)) {
        if (unit.manaCost) {
            // Weighted by preference
            const weight = personality.manaUnitPreference; 
            totalManaCostPerSec += (unit.manaCost / 5) * weight;
        }
    }
    
    // 2. Ability Usage (Active Skills)
    // Assume units on field use skills occasionally (every ~10s)
    let abilityManaPerSec = 0;
    for (const unit of state.enemyUnits) {
        // We don't have exact unit def here easily without lookup, but we can estimate.
        // Or assume average active unit consumes 5 mana/10s = 0.5 m/s
        abilityManaPerSec += 0.5;
    }
    
    // 3. Future Age Needs (Looking ahead)
    // If we are close to next age, check if it brings high mana costs
    if (state.enemyAge < 5) {
        const nextUnits = getUnitsForAge(state.enemyAge + 1);
        for (const unit of Object.values(nextUnits)) {
            if (unit.manaCost && unit.manaCost > 50) {
                 // Expecting a mana spike
                 totalManaCostPerSec += 1.0; // Prep bonus
                 break;
            }
        }
    }

    return totalManaCostPerSec + abilityManaPerSec;
  }
  
  /**
   * Check if should age up based on personality and state
   * NOTE: Game doesn't use XP system - aging is gold-only
   */
  static shouldAgeUp(
    state: GameStateSnapshot,
    personality: AIPersonality,
    ageCost: number,
    threat: ThreatLevel
  ): boolean {
    // Don't age up if under severe threat
    if (threat === ThreatLevel.CRITICAL || threat === ThreatLevel.HIGH) {
      return false;
    }
    
    // Need enough gold (100% of cost, no XP requirement)
    const requiredGold = ageCost * AI_TUNING.aging.requireGoldPercent;
    if (state.enemyGold < requiredGold) {
      return false;
    }
    
    // Personality-based decision
    const randomFactor = Math.random();
    return randomFactor < personality.ageUpPriority;
  }
  
  /**
   * Check if should upgrade mana
   */
  static shouldUpgradeMana(
    state: GameStateSnapshot,
    personality: AIPersonality,
    manaCost: number,
    targetLevel: number,
    threat: ThreatLevel
  ): boolean {
    // Don't upgrade mana under critical threat
    if (threat === ThreatLevel.CRITICAL) {
      return false;
    }
    
    // Check if below target level
    if (state.enemyManaLevel >= targetLevel) {
      return false;
    }
    
    // Need enough gold
    if (state.enemyGold < manaCost) {
      return false;
    }
    
    // Personality-based decision
    const randomFactor = Math.random();
    return randomFactor < personality.manaUpgradePriority;
  }
  
  /**
   * Calculate warchest - gold reserved for age upgrades
   * Logic: (time since last age up) x difficulty multiplier x current age
   * This ensures the AI consistently saves enough to age up
   */
  static calculateWarchest(
    state: GameStateSnapshot,
    timeSinceLastAgeUp: number,
    difficulty: 'EASY' | 'MEDIUM' | 'HARD' | 'SMART' | 'SMART_ML' | 'CHEATER'
  ): number {
    // No warchest needed at max age (Age 6 is max playable age)
    if (state.enemyAge >= 6) {
      // CHEATER Logic: Save for OP unit (Void Reaper, Cost 10k)
      // Only save if Mana is maxed (Level 13) to force mana upgrades first
      if (difficulty === 'CHEATER' && state.enemyManaLevel >= 12) {
        return 10000;
      }
      return 0;
    }
    
    // Difficulty multipliers for warchest accumulation
    // Now uses config-driven "Tax Rate" on income
    const baseTax = AI_TUNING.warchest.baseTaxRate || 0.35;
    const diffMultiplier = (AI_TUNING.warchest as any).difficultyTaxMultipliers?.[difficulty] || 1.0;
    
    // Effective Tax Rate: What % of income is diverted to the Future Usage Fund?
    const taxRate = baseTax * diffMultiplier;

    // Estimate steady income to avoid fluctuations
    // Base passive income is roughly 8g/s + Age bonuses + Turret kills
    // We explicitly trust the state's reported income but clamp it to a minimum 
    // to ensure the AI saves even during lulls.
    const minExpectedIncome = 8 + (state.enemyAge * 4);
    const effectiveIncome = Math.max(state.enemyGoldIncome, minExpectedIncome);

    // Warchest Integration: 
    // Total Reserved = Time * (Income * TaxRate)
    // "We should have saved X amount by now based on our tax policy"
    const warchest = timeSinceLastAgeUp * (effectiveIncome * taxRate);
    
    // Cap at the actual cost of the next age upgrade
    // If we have saved enough for the upgrade, stop taxing higher.
    return Math.min(warchest, state.enemyAgeCost);
  }
  
  /**
   * Calculate gold available for spending (total gold minus warchest)
   */
  static calculateSpendableGold(totalGold: number, warchest: number): number {
    return Math.max(0, totalGold - warchest);
  }
  
  /**
   * Calculate threat level for turret priority
   * Threat = player age + (player units / 10) rounded up
   */
  static calculateThreatLevelForTurrets(state: GameStateSnapshot): number {
    return state.playerAge + Math.ceil(state.playerUnitCount / 10);
  }
  
  /**
   * Get difficulty-based stack multiplier
   * Determines how much gold AI should accumulate before recruiting
   */
  static getStackMultiplier(difficulty: 'EASY' | 'MEDIUM' | 'HARD' | 'SMART' | 'SMART_ML' | 'CHEATER', isAggressive: boolean): number {
    const baseMultipliers = {
      EASY: { defensive: 2.0, aggressive: 2.5 },
      MEDIUM: { defensive: 2.5, aggressive: 3.0 },
      HARD: { defensive: 3.0, aggressive: 3.5 },
      SMART: { defensive: 2.6, aggressive: 3.1 },
      SMART_ML: { defensive: 2.6, aggressive: 3.1 },
      CHEATER: { defensive: 3.5, aggressive: 4.0 },
    };
    
    const multipliers = baseMultipliers[difficulty];
    return isAggressive ? multipliers.aggressive : multipliers.defensive;
  }
  
  /**
   * Check if base is in emergency state (< 25% health)
   */
  static isBaseEmergency(baseHealth: number, maxHealth: number, lastAttackTime: number, currentTime: number): boolean {
    const healthCritical = baseHealth < maxHealth * 0.25;
    // Strict 2.0s window. If lastAttackTime is 0 (start), ensure no false positive.
    const timeSinceAttack = currentTime - lastAttackTime;
    const recentlyAttacked = (lastAttackTime > 0) && (timeSinceAttack < 2.0); 
    
    // Only emergency if BOTH conditions met (Health AND active threat)
    return healthCritical && recentlyAttacked; 
  }
  
  /**
   * Calculate flexible spending pool
   * Strict adherence to warchest: Only spend gold ABOVE the warchest threshold.
   */
  static calculateFlexibleSpendingPool(state: GameStateSnapshot, warchest: number, threat: ThreatLevel): number {
    const totalGold = state.enemyGold;
    // Strict separation: Warchest is for aging up ONLY (unless emergency override elsewhere)
    return Math.max(0, totalGold - warchest);
  }
  
  /**
   * Check if enemy turret is too strong for our current units to push through
   * Returns true if unit would die before reaching the base
   * Uses EXACT formula from GameEngine.ts for accuracy
   */
  static isEnemyTurretTooStrong(state: GameStateSnapshot, unitDef: UnitDef): boolean {
    const turretDPS = state.playerTurretDps;
    const turretRange = state.playerTurretMaxRange;
    if (turretDPS <= 0 || turretRange <= 0) return false; // No turret

    const unitHealth = unitDef.health;
    const unitSpeed = unitDef.speed || 1.5;
    const unitRange = unitDef.range || 1;
    
    // Distance the unit must walk UNDER FIRE
    // If unit has 5 range and turret has 20, it walks 15 units under fire.
    // If unit has 25 range and turret has 20, it walks 0 units under fire.
    const distanceUnderFire = Math.max(0, turretRange - unitRange);
    
    // How long does unit spend in turret range?
    const timeInRange = distanceUnderFire / unitSpeed;
    
    // Turret protection auras make enemy frontline survive longer near their base.
    // Model this as extra time under fire before a push can break through.
    const defensiveLineFactor = 1 / Math.max(0.45, state.playerTurretProtectionMultiplier || 1);
    const damageFromTurret = turretDPS * timeInRange * defensiveLineFactor;
    
    // Unit needs to survive crossing the range + have HP to fight
    // Add 30% safety margin (Survivable damage must be < 70% of Max HP)
    return damageFromTurret >= unitHealth * 0.7;
  }
  
  /**
   * Check if severely outnumbered (enemy has 2x our units)
   */
  static isSeverelyOutnumbered(ownUnits: number, enemyUnits: number): boolean {
    return enemyUnits > (ownUnits + 1) * 2;
  }
  
  /**
   * Calculate the actual gold cost for a unit composition based on current age
   * Returns the total cost to build the composition with actual unit prices
   */
  static calculateCompositionCost(
    state: GameStateSnapshot,
    composition: { frontline: number; ranged: number; support: number },
    minUnits: number,
    difficulty: 'EASY' | 'MEDIUM' | 'HARD' | 'SMART' | 'SMART_ML' | 'CHEATER'
  ): number {
    const availableUnits = getUnitsForAge(state.enemyAge);
    
    // Find representative units for each category
    let cheapestFrontline = Infinity;
    let cheapestRanged = Infinity;
    let cheapestSupport = Infinity;
    let averageFrontline = 0;
    let averageRanged = 0;
    let averageSupport = 0;
    let frontlineCount = 0;
    let rangedCount = 0;
    let supportCount = 0;
    
    for (const [unitId, unitDef] of Object.entries(availableUnits)) {
      const isRanged = (unitDef.range ?? 1) > 1.5;
      const isSupport = (unitDef.manaCost ?? 0) > 0;
      
      if (isSupport) {
        cheapestSupport = Math.min(cheapestSupport, unitDef.cost);
        averageSupport += unitDef.cost;
        supportCount++;
      } else if (isRanged) {
        cheapestRanged = Math.min(cheapestRanged, unitDef.cost);
        averageRanged += unitDef.cost;
        rangedCount++;
      } else {
        cheapestFrontline = Math.min(cheapestFrontline, unitDef.cost);
        averageFrontline += unitDef.cost;
        frontlineCount++;
      }
    }
    
    // Use average costs (more representative of what AI will actually build)
    const frontlineCost = frontlineCount > 0 ? averageFrontline / frontlineCount : cheapestFrontline;
    const rangedCost = rangedCount > 0 ? averageRanged / rangedCount : cheapestRanged;
    const supportCost = supportCount > 0 ? averageSupport / supportCount : cheapestSupport;
    
    // Calculate how many units of each type
    const frontlineUnits = Math.ceil(minUnits * composition.frontline);
    const rangedUnits = Math.ceil(minUnits * composition.ranged);
    const supportUnits = Math.ceil(minUnits * composition.support);
    
    // Calculate total cost
    const baseCost = 
      (frontlineUnits * frontlineCost) +
      (rangedUnits * rangedCost) +
      (supportUnits * supportCost);
    
    // Apply difficulty multiplier (harder AI waits for bigger compositions)
    const difficultyMultiplier = {
      EASY: 1.0,
      MEDIUM: 1.5,
      HARD: 2.0,
      SMART: 1.6,
      SMART_ML: 1.6,
      CHEATER: 2.5,
    }[difficulty];
    
    return Math.ceil(baseCost * difficultyMultiplier);
  }
  
  /**
   * Calculate minimum gold needed before recruiting single units
   * Based on average unit cost in current age and difficulty
   */
  static calculateMinimumRecruitmentGold(
    state: GameStateSnapshot,
    difficulty: 'EASY' | 'MEDIUM' | 'HARD' | 'SMART' | 'SMART_ML' | 'CHEATER'
  ): number {
    const availableUnits = getUnitsForAge(state.enemyAge);
    
    let totalCost = 0;
    let unitCount = 0;
    
    for (const [unitId, unitDef] of Object.entries(availableUnits)) {
      totalCost += unitDef.cost;
      unitCount++;
    }
    
    const averageCost = unitCount > 0 ? totalCost / unitCount : 50;
    
    // Difficulty determines how much gold to save before single unit recruitment
    // Use the tuned multipliers from config
    const multiplier = AI_TUNING.recruitment.difficultyStackMultipliers[difficulty] || 2.0;
    
    return Math.ceil(averageCost * multiplier);
  }
}

