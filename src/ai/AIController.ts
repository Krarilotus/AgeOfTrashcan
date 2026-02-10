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
import type { GameDifficulty } from '../config/gameBalance';
import {
  IAIBehavior,
  GameStateSnapshot,
  AIDecision,
  ThreatLevel,
  StrategicState,
  AIBehaviorUtils,
  ThreatDetails,
} from './AIBehavior';
import { IAIEndpoint, RuleBehaviorEndpoint } from './endpoints';

/**
 * AI Controller Configuration
 */
export interface AIControllerConfig {
  difficulty: GameDifficulty;
  personality: AIPersonality;
  endpoint: IAIEndpoint;
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
  endpointName: string;
  lastEndpointLatencyMs: number;
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
      endpointName: config.endpoint.getName(),
      lastEndpointLatencyMs: 0,
    };
  }
  
  /**
   * Main decision loop - called every AI tick
   */
  public makeDecision(gameState: GameStateSnapshot, currentTime: number): AIDecision {
    // Update strategic assessment
    this.updateStrategicState(gameState);

    // Delegate to modular endpoint (rule-based or ML)
    const startMs = Date.now();
    const decision = this.config.endpoint.decide({
      state: gameState,
      difficulty: this.config.difficulty,
      personality: this.config.personality,
      currentTime,
    });
    this.state.lastEndpointLatencyMs = Math.max(0, Date.now() - startMs);
    this.state.endpointName = this.config.endpoint.getName();
    
    // Track decision for learning
    this.state.recentActions.push(decision);
    if (this.state.recentActions.length > 100) {
      this.state.recentActions.shift();
    }
    
    this.lastDecisionTime = currentTime;
    return decision;
  }
  
  public getDebugInfo(): any {
    const endpointParams = this.config.endpoint.getParameters ? this.config.endpoint.getParameters() : {};
    const behaviorParams = endpointParams.behaviorParams ?? {};
    const visibleActions = this.state.recentActions
      .filter((a) => a.action !== 'WAIT')
      .slice(-8)
      .map((a) => `${a.action}${a.reasoning ? ` - ${a.reasoning}` : ''}`);
    
    // Fallback: If AIController has no group (legacy path), check if Behavior has one defined
    let activeGroup = this.state.plannedAttackGroup;
    if (!activeGroup && behaviorParams.currentGroupPlan) {
      activeGroup = behaviorParams.currentGroupPlan;
    }

    return {
      ...this.state,
      recentActions: visibleActions,
      lastDecision: this.state.recentActions.length > 0 ? this.state.recentActions[this.state.recentActions.length - 1] : null,
      plannedAttackGroup: activeGroup ? {
        name: activeGroup.name,
        units: activeGroup.units
      } : null,
      endpoint: this.config.endpoint.getName(),
      behavior: endpointParams.behavior ?? 'n/a',
      behaviorParams,
      endpointParams,
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
    const maybeRuleBehavior = this.getRuleBehavior();
    if (maybeRuleBehavior?.update && this.config.enableLearning) {
      // Provide average recent reward as signal
      const avgReward =
        this.state.recentRewards.reduce((a, b) => a + b, 0) /
        this.state.recentRewards.length;
      
      maybeRuleBehavior.update(null as any, avgReward);
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
      endpointName: this.config.endpoint.getName(),
      lastEndpointLatencyMs: 0,
    };
    this.config.endpoint.reset?.();
  }
  
  /**
   * Get current AI state (for debugging)
   */
  public getState(): Readonly<AIState> & { behaviorParams?: any } {
    const endpointParams = this.config.endpoint.getParameters ? this.config.endpoint.getParameters() : {};
    return { ...this.state, behaviorParams: endpointParams.behaviorParams ?? {} };
  }

  /**
   * Restore AI state from save
   */
  public restoreState(savedState: AIState & { behaviorParams?: any }): void {
    const { behaviorParams, ...coreState } = savedState as any;
    
    // Restore core controller state
    this.state = {
      ...coreState,
      endpointName: coreState.endpointName ?? this.config.endpoint.getName(),
      lastEndpointLatencyMs: coreState.lastEndpointLatencyMs ?? 0,
    };

    // Restore behavior-specific state if available
    if (behaviorParams && this.config.endpoint.setParameters) {
      this.config.endpoint.setParameters(behaviorParams);
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
    if (this.config.endpoint instanceof RuleBehaviorEndpoint) {
      this.config.endpoint.setBehavior(behavior);
      behavior.reset?.();
      return;
    }
    this.config.endpoint = new RuleBehaviorEndpoint(behavior);
    behavior.reset?.();
  }

  public setEndpoint(endpoint: IAIEndpoint): void {
    this.config.endpoint = endpoint;
    endpoint.reset?.();
    this.state.endpointName = endpoint.getName();
  }

  private getRuleBehavior(): IAIBehavior | null {
    if (this.config.endpoint instanceof RuleBehaviorEndpoint) {
      return this.config.endpoint.getBehavior();
    }
    return null;
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
    difficulty: GameDifficulty,
    personalityName: keyof typeof AI_PERSONALITIES,
    behavior: IAIBehavior
  ): AIController {
    const personality = AI_PERSONALITIES[personalityName];
    
    return new AIController({
      difficulty,
      personality,
      endpoint: new RuleBehaviorEndpoint(behavior),
      enableLearning: false,
    });
  }
  
  /**
   * Create an adaptive AI that learns during gameplay
   */
  static createAdaptive(
    difficulty: GameDifficulty,
    behavior: IAIBehavior,
    mlConfig?: MLConfig
  ): AIController {
    const personality = AI_PERSONALITIES.ADAPTIVE;
    
    return new AIController({
      difficulty,
      personality,
      endpoint: new RuleBehaviorEndpoint(behavior),
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

