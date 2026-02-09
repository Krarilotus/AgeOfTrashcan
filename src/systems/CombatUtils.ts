import { Entity, GameState } from '../GameEngine';
import { getProtectionMultiplierAtDistance, getTurretEngineDef } from '../config/turrets';

export class CombatUtils {
  // Turret protection now comes from mounted turret engines and stacks multiplicatively.
  public static getTowerProtectionMultiplier(entity: Entity, state: GameState): number {
    const base = entity.owner === 'PLAYER' ? state.playerBase : state.enemyBase;
    const distanceToBase = Math.abs(entity.transform.x - base.x);
    return getProtectionMultiplierAtDistance(base, distanceToBase);
  }

  public static applyDamageToBase(
    state: GameState,
    targetOwner: 'PLAYER' | 'ENEMY',
    rawDamage: number
  ): { actualDamage: number; manaUsed: number } {
    const base = targetOwner === 'PLAYER' ? state.playerBase : state.enemyBase;
    const econ = targetOwner === 'PLAYER' ? state.economy.player : state.economy.enemy;

    if (rawDamage <= 0) {
      return { actualDamage: 0, manaUsed: 0 };
    }

    let shieldRatio = 0;
    let manaPerDamage = 0.5; // 1 mana protects 2 hp

    for (const slot of base.turretSlots ?? []) {
      if (!slot.turretId) continue;
      const engine = getTurretEngineDef(slot.turretId);
      const shield = engine?.baseShield;
      if (!shield) continue;
      shieldRatio = Math.max(shieldRatio, shield.damageToManaRatio ?? 0);
      if (typeof shield.manaPerDamage === 'number' && shield.manaPerDamage > 0) {
        manaPerDamage = shield.manaPerDamage;
      }
    }

    let actualDamage = rawDamage;
    let manaUsed = 0;

    if (shieldRatio > 0 && econ.mana > 0) {
      const shieldableDamage = rawDamage * Math.max(0, Math.min(1, shieldRatio));
      const manaNeeded = shieldableDamage * manaPerDamage;
      manaUsed = Math.min(econ.mana, manaNeeded);
      econ.mana -= manaUsed;
      const absorbedDamage = manaUsed / Math.max(0.0001, manaPerDamage);
      actualDamage = Math.max(0, rawDamage - absorbedDamage);
    }

    base.health = Math.max(0, base.health - actualDamage);
    base.lastAttackTime = state.tick * (1000 / 60) / 1000;

    return { actualDamage, manaUsed };
  }
}
