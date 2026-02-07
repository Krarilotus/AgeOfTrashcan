import { Entity, GameState } from '../GameEngine';
import { getProtectionMultiplierAtDistance } from '../config/turrets';

export class CombatUtils {
  // Turret protection now comes from mounted turret engines and stacks multiplicatively.
  public static getTowerProtectionMultiplier(entity: Entity, state: GameState): number {
    const base = entity.owner === 'PLAYER' ? state.playerBase : state.enemyBase;
    const distanceToBase = Math.abs(entity.transform.x - base.x);
    return getProtectionMultiplierAtDistance(base, distanceToBase);
  }
}
