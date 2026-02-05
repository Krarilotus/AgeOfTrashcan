import { Entity, GameState } from '../GameEngine';

export class CombatUtils {
  // TOWER PROTECTION: Units inside their own tower range get defensive bonus
  public static getTowerProtectionMultiplier(entity: Entity, state: GameState): number {
    const base = entity.owner === 'PLAYER' ? state.playerBase : state.enemyBase;
    const turretLevel = base.turretLevel;
    
    // Calculate turret range
    const baseRange = 10;
    const rangeBonus = turretLevel <= 3 ? turretLevel * 4 : 
                       turretLevel <= 6 ? 12 + (turretLevel - 3) * 2 :
                       18 + (turretLevel - 6) * 1;
    const maxRange = state.battlefield.width / 2;
    const turretRange = Math.min(baseRange + rangeBonus, maxRange);
    
    // Check if entity is within tower range
    const distanceToBase = Math.abs(entity.transform.x - base.x);
    if (distanceToBase <= turretRange) {
      // Inside tower range: calculate reduction based on cumulative diminishing returns
      // Level 1: 10%, Level 2: +9%, Level 3: +8% ... Level 10: +1% => Max 55%
      const effectiveLevel = Math.min(Math.max(0, turretLevel), 10);
      const reductionPercent = (11 * effectiveLevel) - (effectiveLevel * (effectiveLevel + 1)) / 2;
      
      return 1.0 - (reductionPercent / 100);
    }
    
    return 1.0; // No protection
  }
}
