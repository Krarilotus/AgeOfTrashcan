/**
 * AI Controller
 * Main orchestrator for AI decision-making
 * Delegates to pluggable behavior strategies
 */

import {
  AIPersonality,
  AI_PERSONALITIES,
  AttackGroup,
  MLConfig,
  DEFAULT_ML_CONFIG,
} from '../config/aiConfig';
import {
  IAIBehavior,
  GameStateSnapshot,
  AIDecision,
  ThreatLevel,
  StrategicState,
  AIBehaviorUtils,
  ThreatDetails,
} from './AIBehavior';

/**
 * AI Controller Configuration
 */
export interface AIControllerConfig {
  difficulty: 'EASY' | 'MEDIUM' | 'HARD' | 'CHEATER';
  personality: AIPersonality;
  behavior: IAIBehavior;
  mlConfig?: MLConfig;
  enableLearning?: boolean;
}

/**
 * AI Controller State
 */
export interface AIState {
  // Current strategic state
  strategicState: StrategicState;

  threatLevel: ThreatLevel;
  threatDetails?: ThreatDetails;
  
  // Warchest (saved gold for big pushes)
  warchest: number;
  warchestStartTime: number;
  
  // Cooldowns
  lastRecruitmentTime: number;
  lastTurretTime: number;
  lastAgingTime: number;
  
  // Learning/adaptive state
  recentActions: AIDecision[];
  recentRewards: number[];
  
  // Attack group planning
  plannedAttackGroup: { name: string; units: string[] } | null;
  attackGroupProgress: number; // 0.0 to 1.0
}

/**
 * Main AI Controller
 */
export class AIController {
  private config: AIControllerConfig;
  private state: AIState;
  private lastDecisionTime: number = 0;
  
  constructor(config: AIControllerConfig) {
    this.config = config;
    this.state = {
      strategicState: StrategicState.EARLY_GAME,
      threatLevel: ThreatLevel.LOW,
      warchest: 0,
      warchestStartTime: 0,
      lastRecruitmentTime: 0,
      lastTurretTime: 0,
      lastAgingTime: 0,
      recentActions: [],
      recentRewards: [],
      plannedAttackGroup: null,
      attackGroupProgress: 0,
    };
  }
  
  /**
   * Main decision loop - called every AI tick
   */
  public makeDecision(gameState: GameStateSnapshot, currentTime: number): AIDecision {
    // Update strategic assessment
    this.updateStrategicState(gameState);
    
    // Delegate to behavior strategy
    const decision = this.config.behavior.decide(gameState, this.config.personality);
    
    // Track decision for learning
    this.state.recentActions.push(decision);
    if (this.state.recentActions.length > 100) {
      this.state.recentActions.shift();
    }
    
    this.lastDecisionTime = currentTime;
    return decision;
  }
  
  public getDebugInfo(): any {
    const behaviorParams = this.config.behavior.getParameters ? this.config.behavior.getParameters() : {};
    
    // Fallback: If AIController has no group (legacy path), check if Behavior has one defined
    let activeGroup = this.state.plannedAttackGroup;
    if (!activeGroup && behaviorParams.currentGroupPlan) {
        activeGroup = behaviorParams.currentGroupPlan;
    }

    return {
        ...this.state,
        recentActions: this.state.recentActions.slice(-5).map(a => a.action),
        plannedAttackGroup: activeGroup ? {
            name: activeGroup.name,
            units: activeGroup.units
        } : null,
        behavior: this.config.behavior.getName(),
        behaviorParams
    };
  }
  
  /**
   * Update strategic state assessment
   */
  private updateStrategicState(gameState: GameStateSnapshot): void {
    const details = AIBehaviorUtils.assessThreatDetails(gameState);
    this.state.threatLevel = details.level;
    this.state.threatDetails = details;
    
    this.state.strategicState = AIBehaviorUtils.getStrategicState(
      gameState,
      this.state.threatLevel
    );
  }
  
  /**
   * Provide reward signal for learning behaviors
   */
  public provideReward(reward: number): void {
    this.state.recentRewards.push(reward);
    if (this.state.recentRewards.length > 100) {
      this.state.recentRewards.shift();
    }
    
    // Update behavior if it supports learning
    if (this.config.behavior.update && this.config.enableLearning) {
      // Provide average recent reward as signal
      const avgReward =
        this.state.recentRewards.reduce((a, b) => a + b, 0) /
        this.state.recentRewards.length;
      
      this.config.behavior.update(null as any, avgReward);
    }
  }
  
  /**
   * Reset AI state for new game
   */
  public reset(): void {
    this.state = {
      strategicState: StrategicState.EARLY_GAME,
      threatLevel: ThreatLevel.LOW,
      warchest: 0,
      warchestStartTime: 0,
      lastRecruitmentTime: 0,
      lastTurretTime: 0,
      lastAgingTime: 0,
      recentActions: [],
      recentRewards: [],
      plannedAttackGroup: null,
      attackGroupProgress: 0,
    };
    
    if (this.config.behavior.reset) {
      this.config.behavior.reset();
    }
  }
  
  /**
   * Get current AI state (for debugging)
   */
  public getState(): Readonly<AIState> & { behaviorParams?: any } {
    const behaviorParams = this.config.behavior.getParameters ? this.config.behavior.getParameters() : {};
    return { ...this.state, behaviorParams };
  }

  /**
   * Restore AI state from save
   */
  public restoreState(savedState: AIState & { behaviorParams?: any }): void {
    const { behaviorParams, ...coreState } = savedState as any;
    
    // Restore core controller state
    this.state = { ...coreState };

    // Restore behavior-specific state if available
    if (behaviorParams && this.config.behavior.setParameters) {
        this.config.behavior.setParameters(behaviorParams);
    }
  }
  
  /**
   * Change AI personality on the fly
   */
  public setPersonality(personality: AIPersonality): void {
    this.config.personality = personality;
  }
  
  /**
   * Change AI behavior strategy
   */
  public setBehavior(behavior: IAIBehavior): void {
    this.config.behavior = behavior;
    if (behavior.reset) {
      behavior.reset();
    }
  }
  
  /**
   * Get configuration
   */
  public getConfig(): Readonly<AIControllerConfig> {
    return { ...this.config };
  }
  
  /**
   * Update warchest (save gold for big push)
   */
  public addToWarchest(amount: number, currentTime: number): void {
    if (this.state.warchest === 0) {
      this.state.warchestStartTime = currentTime;
    }
    this.state.warchest += amount;
  }
  
  /**
   * Spend warchest
   */
  public spendWarchest(amount: number): number {
    const spent = Math.min(amount, this.state.warchest);
    this.state.warchest -= spent;
    if (this.state.warchest <= 0) {
      this.state.warchest = 0;
      this.state.warchestStartTime = 0;
    }
    return spent;
  }
  
  /**
   * Plan an attack group
   */
  public planAttackGroup(group: AttackGroup): void {
    // Convert AttackGroup config to simple display object logic if needed
    // But State expectation is different. The previous modification changed state type to {name, units}
    // But planAttackGroup receives 'AttackGroup' interface from config.
    // We should probably revert state type partial or adapt here.
    // The previous error was that I changed the State interface but not the methods using it.
    
    // To match the interface defined in State:
    this.state.plannedAttackGroup = {
        name: group.name,
        units: [] // Populate with planned units if needed, or leave empty
    };
    this.state.attackGroupProgress = 0;
  }
  
  /**
   * Update attack group progress
   */
  public updateAttackGroupProgress(goldSpent: number, targetCost: number): void {
    if (this.state.plannedAttackGroup) {
      this.state.attackGroupProgress = goldSpent / targetCost;
      
      if (this.state.attackGroupProgress >= 1.0) {
        // Attack group complete
        this.state.plannedAttackGroup = null;
        this.state.attackGroupProgress = 0;
      }
    }
  }
  
  /**
   * Get current attack group plan
   */
  public getPlannedAttackGroup(): { name: string; units: string[] } | null {
    return this.state.plannedAttackGroup;
  }
}

/**
 * Factory for creating AI controllers with different configurations
 */
export class AIControllerFactory {
  /**
   * Create a standard rule-based AI
   */
  static createRuleBased(
    difficulty: 'EASY' | 'MEDIUM' | 'HARD' | 'CHEATER',
    personalityName: keyof typeof AI_PERSONALITIES,
    behavior: IAIBehavior
  ): AIController {
    const personality = AI_PERSONALITIES[personalityName];
    
    return new AIController({
      difficulty,
      personality,
      behavior,
      enableLearning: false,
    });
  }
  
  /**
   * Create an adaptive AI that learns during gameplay
   */
  static createAdaptive(
    difficulty: 'EASY' | 'MEDIUM' | 'HARD' | 'CHEATER',
    behavior: IAIBehavior,
    mlConfig?: MLConfig
  ): AIController {
    const personality = AI_PERSONALITIES.ADAPTIVE;
    
    return new AIController({
      difficulty,
      personality,
      behavior,
      mlConfig: mlConfig || DEFAULT_ML_CONFIG,
      enableLearning: true,
    });
  }
  
  /**
   * Create a custom AI with specific configuration
   */
  static createCustom(config: AIControllerConfig): AIController {
    return new AIController(config);
  }
}
