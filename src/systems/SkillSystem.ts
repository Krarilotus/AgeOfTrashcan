import { Entity, GameState } from '../GameEngine';
import { UNIT_DEFS, UnitSkill } from '../config/units';

/**
 * Skill System
 * Handles the execution logic for all unit skills/abilities.
 * Separates "how skills work" from the core GameEngine loop.
 */

export class SkillSystem {
  private static nextVfxId = 10000; // Start high to avoid conflicts if sharing space, or manage properly

  /**
   * Execute a unit's skill if available and conditions are met.
   * @returns boolean True if skill was executed, false otherwise
   */
  public static executeSkill(
    entity: Entity,
    state: GameState,
    deltaSeconds: number, 
    callbacks: { 
      getTowerProtectionMultiplier: (target: Entity) => number,
      addVfx: (vfx: any) => void 
    }
  ): boolean {
    const def = UNIT_DEFS[entity.unitId];
    if (!def || !def.skill) return false;

    // 1. Cooldown Management
    entity.skillCooldownRemaining = (entity.skillCooldownRemaining ?? 0) - deltaSeconds;
    
    // 2. Resource & Cooldown Check
    const ownerEcon = entity.owner === 'PLAYER' ? state.economy.player : state.economy.enemy;
    if ((entity.skillCooldownRemaining ?? 0) > 0 || ownerEcon.mana < def.skill.manaCost) {
      return false;
    }

    // 3. Target Acquisition & Execution
    let executed = false;

    if (def.skill.type === 'direct') {
      executed = this.executeDirectSkill(entity, def.skill, state, callbacks);
    } else if (def.skill.type === 'aoe') {
      executed = this.executeAoeSkill(entity, def.skill, state, callbacks);
    } else if (def.skill.type === 'flamethrower') {
      executed = this.executeFlamethrowerSkill(entity, def.skill, state, callbacks);
    } else if (def.skill.type === 'heal') {
      executed = this.executeHealSkill(entity, def.skill, state, callbacks);
    }

    // 4. Cost & Reset (if successful)
    if (executed) {
      ownerEcon.mana -= def.skill.manaCost;
      entity.skillCooldownRemaining = def.skill.cooldownMs / 1000;
    }

    return executed;
  }

  /**
   * Logic for 'direct' target skills (e.g. Snipe, Heal)
   */
  private static executeDirectSkill(
    entity: Entity,
    skill: UnitSkill,
    state: GameState,
    callbacks: { getTowerProtectionMultiplier: (target: Entity) => number, addVfx: (vfx: any) => void }
  ): boolean {
    let best: Entity | null = null;
    let bestDist = Infinity;
    const isHealing = skill.power < 0;

    // Find target
    for (const other of state.entities.values()) {
      const d = Math.abs(other.transform.x - entity.transform.x);
      // Use skill range, fallback to power (legacy behavior), fallback to 5
      const range = skill.range ?? (skill.power > 0 ? skill.power : 5); 
      
      if (d > range) continue;

      // TARGETING LOGIC FIX:
      // Healing (power < 0) -> Target FRIENDLY units that are hurt
      // Damage (power > 0) -> Target ENEMY units
      
      if (isHealing) {
          // Must be same owner
          if (other.owner !== entity.owner) continue;
          // Must be missing health to be a "best" target (or just closest friendly)
          if (other.health.current >= other.health.max) continue;
      } else {
          // Must be enemy
          if (other.owner === entity.owner) continue;
      }

      if (d < bestDist) {
        bestDist = d;
        best = other;
      }
    }

    if (!best) return false;

    // Apply Effect
    const protectionMultiplier = callbacks.getTowerProtectionMultiplier(best);
    let actualDamage = skill.power * protectionMultiplier;

    // Teleporter reduction
    const bestDef = UNIT_DEFS[best.unitId];
    if (bestDef?.teleporter) {
      actualDamage *= (1 - bestDef.teleporter.damageReduction);
    }

    // MANA SHIELD (Simulated)
    if (bestDef?.manaShield && actualDamage > 0) {
      const targetEcon = best.owner === 'PLAYER' ? state.economy.player : state.economy.enemy;
      const shieldableDamage = Math.floor(actualDamage * 0.9);
      const manaNeeded = Math.ceil(shieldableDamage / 2);
      const manaUsed = Math.min(manaNeeded, targetEcon.mana);
      const damageAbsorbed = manaUsed * 2;
      targetEcon.mana -= manaUsed;
      actualDamage = Math.max(1, actualDamage - damageAbsorbed);
    }

    // HEALING HANDLING: "Damage" is negative. 
    // protectionMultiplier reduces damage. Should it reduce healing? 
    // Usually no, healing ignores defense.
    if (isHealing) {
        // Reset actualDamage to raw power (negative) to ignore defense logic
        actualDamage = skill.power; 
    }

    best.health.current -= actualDamage;
    
    // Clamp HP
    if (best.health.current > best.health.max) best.health.current = best.health.max;

    // Mana Leech (if definition on unit says so - not skill param usually, but let's check unit def)
    const unitDef = UNIT_DEFS[entity.unitId]; 
    // Actually, manaLeech is on the UnitDef, not the SkillDef usually. 
    // The previous code checked `def.manaLeech`. 
    // Wait, `def` in `executeSkill` is `UNIT_DEFS[entity.unitId]`.
    if (unitDef?.manaLeech) {
      const ownerEcon = entity.owner === 'PLAYER' ? state.economy.player : state.economy.enemy;
      ownerEcon.mana += actualDamage * unitDef.manaLeech;
    }
    
    // Stats update
    if (entity.owner === 'PLAYER') state.stats.damageDealt.player += actualDamage;
    else state.stats.damageDealt.enemy += actualDamage;

    // Death check handled by main loop cleanup, but we can flag dead? 
    // Main loop `toRemove` architecture might be hard to replicate here without return list.
    // Instead dependencies usually modify health, main loop filters dead units.

    // VFX
    const age = entity.owner === 'PLAYER' ? state.progression.player.age : state.progression.enemy.age;
    callbacks.addVfx({
      type: 'ability_cast',
      x: entity.transform.x,
      y: entity.transform.laneY,
      age,
      lifeMs: 600,
      data: { skillType: 'direct', unitId: entity.unitId },
    });
    callbacks.addVfx({
      type: 'ability_impact',
      x: best.transform.x,
      y: best.transform.laneY, // Fixed: was using entity lane
      age,
      lifeMs: 400,
      data: { damage: skill.power },
    });

    return true;
  }

  /**
   * Logic for dedicated 'heal' skills (e.g. Medic)
   */
  private static executeHealSkill(
    entity: Entity,
    skill: UnitSkill,
    state: GameState,
    callbacks: { getTowerProtectionMultiplier: (target: Entity) => number, addVfx: (vfx: any) => void }
  ): boolean {
    let best: Entity | null = null;
    let closestDist = Infinity;

    const range = skill.range ?? 5;

    for (const other of state.entities.values()) {
      // Must be same owner
      if (other.owner !== entity.owner) continue;

      // Medics should heal others, not themselves (unless they are the last one standing, maybe? No, let's strictly target allies)
      // User complaint: "seems to only heal itself" because self-dist is 0.
      if (other.entityId === entity.entityId) continue;

      // Must be missing health
      if (other.health.current >= other.health.max) continue;

      const d = Math.abs(other.transform.x - entity.transform.x);
      if (d > range) continue;

      // Selection Heuristic:
      // Prioritize lowest health percentage? Or just closest ally?
      // Closest ally is good for frontline support.
      if (d < closestDist) {
        closestDist = d;
        best = other;
      }
    }

    if (!best) return false;

    // Apply Heal
    // Use positive power directly
    const healAmount = skill.power; 

    best.health.current += healAmount;
    if (best.health.current > best.health.max) best.health.current = best.health.max;

    // VFX
    const age = entity.owner === 'PLAYER' ? state.progression.player.age : state.progression.enemy.age;
    callbacks.addVfx({
      type: 'ability_cast', // Reusing cast animation
      x: entity.transform.x,
      y: entity.transform.laneY,
      age,
      lifeMs: 600,
      data: { skillType: 'heal', unitId: entity.unitId },
    });
    
    callbacks.addVfx({
      type: 'ability_impact',
      x: best.transform.x,
      y: best.transform.laneY,
      age,
      lifeMs: 400,
      // Pass negative damage so RenderSystem draws green healing text
      data: { damage: -healAmount },
    });

    return true;
  }

  /**
   * Logic for 'aoe' skills (e.g. Catapult shot, Fireball)
   * Now targets the closest enemy within range, rather than firing at max range blindly.
   */
  private static executeAoeSkill(
    entity: Entity,
    skill: UnitSkill,
    state: GameState,
    callbacks: { getTowerProtectionMultiplier: (target: Entity) => number, addVfx: (vfx: any) => void }
  ): boolean {
    const direction = entity.owner === 'PLAYER' ? 1 : -1;
    const maxCastRange = skill.range ?? 6;
    const radius = skill.power; 
    
    // 1. Find Target Center
    // Scan for closest enemy within cast range to center the blast on
    let targetX: number | null = null;
    let minDist = Infinity;

    for (const other of state.entities.values()) {
        if (other.owner === entity.owner) continue;

        // Distance relative to direction (positive = in front)
        const dx = (other.transform.x - entity.transform.x) * direction;

        // Check if valid target (in front, within range)
        // We accept targets slightly inside our own hitbox (dx > -1) up to max range
        if (dx > -1 && dx <= maxCastRange) {
            if (dx < minDist) {
                minDist = dx;
                targetX = other.transform.x;
            }
        }
    }

    // If no unit target found, check base? 
    // Usually bases are large targets at the end of the lane.
    if (targetX === null) {
         const enemyBase = entity.owner === 'PLAYER' ? state.enemyBase : state.playerBase;
         const distToBase = (enemyBase.x - entity.transform.x) * direction;
         // Base is usually at 0 or Width. 
         // enemyBase x is at Width (for Player), dist is Width - x.
         // playerBase x is at 0 (for Enemy), dist is x - 0 = x.
         // Wait, Enemy entity is at x=Width, facing -1. Player Base at 0. dist = (0 - Width)*-1 = Width.
         // Let's rely on computed dist.
         
         const dx = (enemyBase.x - entity.transform.x) * direction;
         // Correction: Base hitbox is wide. If we are within range of the *edge* of the base?
         // Base x is center? No, base X is likely edge or center.
         // Typically base X is 50 or Width-50.
         
         // Basic check: is base within range?
         if (dx > 0 && dx <= maxCastRange + 3) { // +3 for base width approximation
             targetX = enemyBase.x;
         }
    }

    if (targetX === null) {
        return false; // No valid target in range
    }

    const centerX = targetX;
    
    let hitCount = 0;
    
    // Damage value: explicit skill damage > unit damage
    const damageAmount = skill.damage ?? entity.attack.damage;

    // Iterate all entities for damage
    for (const other of state.entities.values()) {
      if (other.owner === entity.owner) continue;

      const d = Math.abs(other.transform.x - centerX);
      if (d <= radius) {
        // Validation: Logic duplicated from executeDirectSkill, potential for shared helper 'applyDamage'
        
        const protectionMultiplier = callbacks.getTowerProtectionMultiplier(other);
        let aoeDmg = damageAmount * protectionMultiplier;

        const otherDef = UNIT_DEFS[other.unitId];
        if (otherDef?.teleporter) {
          aoeDmg *= (1 - otherDef.teleporter.damageReduction);
        }

        // MANA SHIELD (Simulated)
        if (otherDef?.manaShield) {
          const targetEcon = other.owner === 'PLAYER' ? state.economy.player : state.economy.enemy;
          const shieldableDamage = Math.floor(aoeDmg * 0.9);
          const manaNeeded = Math.ceil(shieldableDamage / 2);
          const manaUsed = Math.min(manaNeeded, targetEcon.mana);
          const damageAbsorbed = manaUsed * 2;
          targetEcon.mana -= manaUsed;
          aoeDmg = Math.max(1, aoeDmg - damageAbsorbed);
        }

        other.health.current -= aoeDmg;

        // Mana Leech
        const unitDef = UNIT_DEFS[entity.unitId];
        if (unitDef?.manaLeech) {
          const ownerEcon = entity.owner === 'PLAYER' ? state.economy.player : state.economy.enemy;
          ownerEcon.mana += aoeDmg * unitDef.manaLeech;
        }

        if (entity.owner === 'PLAYER') state.stats.damageDealt.player += aoeDmg;
        else state.stats.damageDealt.enemy += aoeDmg;

        hitCount++;
      }
    }

    // Check Base Hit (Skills should siege bases too)
    const targetBase = entity.owner === 'PLAYER' ? state.enemyBase : state.playerBase;
    const distToBase = Math.abs(targetBase.x - centerX);
    if (distToBase <= radius + 3) {
       targetBase.health -= damageAmount;
       hitCount++;
       if (entity.owner === 'PLAYER') state.stats.damageDealt.player += damageAmount;
       else state.stats.damageDealt.enemy += damageAmount;
    }

    // Always return true to trigger cooldown/cost even if no one hit (wasted skill)
    // OR return hitCount > 0? Typically skills fire regardless.
    // Changing to always fire to show VFX.

    // VFX
    const age = entity.owner === 'PLAYER' ? state.progression.player.age : state.progression.enemy.age;
    callbacks.addVfx({
      type: 'ability_cast',
      x: entity.transform.x,
      y: entity.transform.laneY,
      age,
      lifeMs: 800,
      data: { skillType: 'aoe', unitId: entity.unitId },
    });
    callbacks.addVfx({
      type: 'ability_impact',
      x: centerX,
      y: entity.transform.laneY,
      age,
      lifeMs: 1000,
      data: { radius, hitCount },
    });

    return true;
  }

  /**
   * Logic for 'flamethrower' continuous skills
   */
  private static executeFlamethrowerSkill(
    entity: Entity,
    skill: UnitSkill,
    state: GameState,
    callbacks: { getTowerProtectionMultiplier: (target: Entity) => number, addVfx: (vfx: any) => void }
  ): boolean {
    const direction = entity.owner === 'PLAYER' ? 1 : -1;
    const range = skill.range ?? 6;
    const damage = skill.power; 
    let hitCount = 0;

    // Check for targets in cone
    for (const other of state.entities.values()) {
      if (other.owner === entity.owner) continue;

      // Check distance: must be in front and within range
      const dx = (other.transform.x - entity.transform.x) * direction;
      
      // dx > 0 means in front, dx <= range means within reach
      // Also adding a small buffer slightly behind (dx > -0.5) to catch units right on top
      if (dx > -0.5 && dx <= range) {
        
        const protectionMultiplier = callbacks.getTowerProtectionMultiplier(other);
        let finalDamage = damage * protectionMultiplier;

        // Apply Shields/Reductions
        const otherDef = UNIT_DEFS[other.unitId];
        if (otherDef?.teleporter) finalDamage *= (1 - otherDef.teleporter.damageReduction);

        if (otherDef?.manaShield) {
          const targetEcon = other.owner === 'PLAYER' ? state.economy.player : state.economy.enemy;
          const shieldableDamage = Math.floor(finalDamage * 0.9);
          const manaNeeded = Math.ceil(shieldableDamage / 2);
          const manaUsed = Math.min(manaNeeded, targetEcon.mana);
          targetEcon.mana -= manaUsed;
          finalDamage = Math.max(1, finalDamage - (manaUsed * 2));
        }

        other.health.current -= finalDamage;
        
        // Mana Leech
        const unitDef = UNIT_DEFS[entity.unitId];
        if (unitDef?.manaLeech) {
          const ownerEcon = entity.owner === 'PLAYER' ? state.economy.player : state.economy.enemy;
          ownerEcon.mana += finalDamage * unitDef.manaLeech;
        }

        if (entity.owner === 'PLAYER') state.stats.damageDealt.player += finalDamage;
        else state.stats.damageDealt.enemy += finalDamage;

        hitCount++;
      }
    }

    // Check Base Damage
    const battlefieldWidth = state.battlefield.width;
    let hitBase = false;
    const currentTime = state.tick * 16.67;

    if (entity.owner === 'PLAYER') {
        const distToBase = battlefieldWidth - entity.transform.x;
        // Range check (using -0.5 buffer as well just in case)
        if (distToBase <= range && distToBase > -2.0) {
           const damageAmt = damage; 
           state.enemyBase.health = Math.max(0, state.enemyBase.health - damageAmt);
           state.stats.damageDealt.player += damageAmt;
           state.enemyBase.lastAttackTime = currentTime;
           hitBase = true;
           hitCount++;
        }
    } else {
        const distToBase = entity.transform.x;
        if (distToBase <= range && distToBase > -2.0) {
           const damageAmt = damage;
           state.playerBase.health = Math.max(0, state.playerBase.health - damageAmt);
           state.stats.damageDealt.enemy += damageAmt;
           state.playerBase.lastAttackTime = currentTime;
           hitBase = true;
           hitCount++;
        }
    }

    if (hitCount === 0) return false;

    // VFX
    const age = entity.owner === 'PLAYER' ? state.progression.player.age : state.progression.enemy.age;
    callbacks.addVfx({
      type: 'flamethrower',
      x: entity.transform.x, 
      y: entity.transform.laneY,
      age,
      lifeMs: skill.cooldownMs + 50, 
      data: { range, direction, unitId: entity.unitId },
    });

    return true;
  }
}
