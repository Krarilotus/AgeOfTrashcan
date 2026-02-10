import type { AIPersonality } from '../../config/aiConfig';
import type { GameDifficulty } from '../../config/gameBalance';
import type { AIDecision, GameStateSnapshot, IAIBehavior } from '../AIBehavior';

export interface AIEndpointRequest {
  state: GameStateSnapshot;
  difficulty: GameDifficulty;
  personality: AIPersonality;
  currentTime: number;
}

export interface IAIEndpoint {
  getName(): string;
  decide(request: AIEndpointRequest): AIDecision;
  reset?(): void;
  getParameters?(): Record<string, any>;
  setParameters?(params: Record<string, any>): void;
}

export class RuleBehaviorEndpoint implements IAIEndpoint {
  constructor(private behavior: IAIBehavior) {}

  getName(): string {
    return `rule:${this.behavior.getName()}`;
  }

  decide(request: AIEndpointRequest): AIDecision {
    return this.behavior.decide(request.state, request.personality);
  }

  reset(): void {
    this.behavior.reset?.();
  }

  getParameters(): Record<string, any> {
    return {
      behavior: this.behavior.getName(),
      behaviorParams: this.behavior.getParameters ? this.behavior.getParameters() : {},
    };
  }

  setParameters(params: Record<string, any>): void {
    this.behavior.setParameters?.(params);
  }

  getBehavior(): IAIBehavior {
    return this.behavior;
  }

  setBehavior(behavior: IAIBehavior): void {
    this.behavior = behavior;
  }
}

