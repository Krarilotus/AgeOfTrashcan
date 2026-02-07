import { Entity, GameState } from '../GameEngine';
import {
  calculateTurretProtectionReductionPercent,
  calculateTurretRange,
} from '../config/turretConfig';

export class CombatUtils {
  // TOWER PROTECTION: Units inside their own tower range get defensive bonus
  public static getTowerProtectionMultiplier(entity: Entity, state: GameState): number {
    const base = entity.owner === 'PLAYER' ? state.playerBase : state.enemyBase;
    const turretLevel = base.turretLevel;
    
    // Calculate turret range
    const nominalRange = calculateTurretRange(turretLevel);
    const maxRange = state.battlefield.width / 2;
    const turretRange = Math.min(nominalRange, maxRange);
    
    // Check if entity is within tower range
    const distanceToBase = Math.abs(entity.transform.x - base.x);
    if (distanceToBase <= turretRange) {
      // Inside tower range: calculate reduction based on cumulative diminishing returns
      // Level 1: 10%, Level 2: +9%, Level 3: +8% ... Level 10: +1% => Max 55%
      const reductionPercent = calculateTurretProtectionReductionPercent(turretLevel);
      
      return 1.0 - (reductionPercent / 100);
    }
    
    return 1.0; // No protection
  }
}
