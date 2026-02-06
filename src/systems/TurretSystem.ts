import { GameState, Entity, Projectile } from '../GameEngine';
import { TURRET_CONSTANTS, calculateTurretDamage, calculateTurretRange } from '../config/turretConfig';
import { TURRET_VISUALS, pixelsToUnits, unitsToPixels } from '../config/renderConfig';

export class TurretSystem {
  private turretAccumPlayerMs = 0;
  private turretAccumEnemyMs = 0;

  public update(state: GameState, deltaSeconds: number, projectileSystem: any): void {
    
    // Update cooldowns
    if (state.playerBase.turretAbilityCooldown && state.playerBase.turretAbilityCooldown > 0) {
      state.playerBase.turretAbilityCooldown -= deltaSeconds;
    }
    if (state.enemyBase.turretAbilityCooldown && state.enemyBase.turretAbilityCooldown > 0) {
      state.enemyBase.turretAbilityCooldown -= deltaSeconds;
    }

    const { FIRE_INTERVAL, PROJECTILE_SPEED, BASE_HITBOX_RADIUS } = { ...TURRET_CONSTANTS, BASE_HITBOX_RADIUS: 3 };
    
    const getEffectiveTurretRange = (level: number): number => {
      const nominalRange = calculateTurretRange(level);
      const maxRange = state.battlefield.width / 2;
      return Math.min(nominalRange, maxRange);
    };

    const updateTurretForSide = (
      isPlayer: boolean,
      accumulator: number,
      projIdOffset: number
    ): number => {
      const base = isPlayer ? state.playerBase : state.enemyBase;
      const owner = isPlayer ? 'PLAYER' : 'ENEMY';
      const targetOwner = isPlayer ? 'ENEMY' : 'PLAYER';
      const age = isPlayer ? state.progression.player.age : state.progression.enemy.age;
      const turretLevel = base.turretLevel;
      const turretRange = getEffectiveTurretRange(turretLevel);
      
      const targets: Entity[] = [];
      for (const entity of state.entities.values()) {
        if (entity.owner === targetOwner) {
          const dist = Math.abs(entity.transform.x - base.x);
          if (dist <= turretRange || dist <= BASE_HITBOX_RADIUS) {
            targets.push(entity);
          }
        }
      }
      targets.sort((a, b) => Math.abs(a.transform.x - base.x) - Math.abs(b.transform.x - base.x));
      
      if (targets.length > 0) {
        accumulator += deltaSeconds;
        if (accumulator >= FIRE_INTERVAL) {
          accumulator -= FIRE_INTERVAL;
          
          const damagePerShot = calculateTurretDamage(turretLevel);
          const canUseAbility = (base.turretAbilityCooldown ?? 0) <= 0;
          
          if (turretLevel >= 9 && canUseAbility && targets.length >= 3) {
            base.turretAbilityCooldown = 18.0; // Increased cooldown (10s requested + active time)
            
            // Get Cannon Tip Position for VFX
            const cannonPos = TurretSystem.getTurretPosition(base.x, age, turretLevel);

            // Spawn 100 falling projectiles
            const barrageCount = 100;
            const barrageDuration = 3000; // 3 seconds
            const abilityRange = getEffectiveTurretRange(turretLevel);
            
            // Determine covered area (X range)
            const minX = isPlayer ? base.x : base.x - abilityRange;
            const maxX = isPlayer ? base.x + abilityRange : base.x;
            
            for (let i = 0; i < barrageCount; i++) {
                const delay = Math.random() * barrageDuration;
                const targetX = minX + Math.random() * (maxX - minX);
                const targetY = (Math.random() - 0.5) * 4; // Spread across lanes (-2 to 2)
                
                // Falling from SKY (Positive Y is Up in Projectile Render Logic)
                const startY = 25; // Start high above
                const speed = -15; // Falling DOWN (Negative VY)
                const distY = Math.abs(startY - targetY); // Distance to fall
                const travelTime = (distY / Math.abs(speed)) * 1000;
                
                state.projectiles.push({ 
                  id: (state.nextEntityId++) + projIdOffset + i, 
                  owner: owner as 'PLAYER' | 'ENEMY', 
                  x: targetX, 
                  y: startY, 
                  vx: 0, 
                  vy: speed,
                  damage: 250, 
                  lifeMs: travelTime + 500, // Life enough to hit ground
                  delayMs: delay,
                  isFalling: true,
                  targetY: targetY
                });
            }
            
            // Cast Effect at Turret (Just visual)
            state.vfx.push({
              id: state.nextVfxId++,
              type: 'ability_cast',
              x: cannonPos.x, // Use cannon tip X
              y: cannonPos.y, // Use cannon tip Y
              age,
              lifeMs: 3000,
              data: { turretAbility: 'artillery_barrage', targets: targets.length },
            });
            
          } else if (turretLevel >= 7 && canUseAbility && targets.length >= 2) {
            base.turretAbilityCooldown = 5.0;
            const maxChainTargets = 3;
            const chainPositions: {x: number, y: number}[] = [];
            
            // Get Cannon Tip
            const cannonPos = TurretSystem.getTurretPosition(base.x, age, turretLevel);

            for (let i = 0; i < Math.min(maxChainTargets, targets.length); i++) {
              const chainDamage = damagePerShot * (2.0 - i * 0.4);
              targets[i].health.current -= chainDamage;
              chainPositions.push({ x: targets[i].transform.x, y: targets[i].transform.laneY });
            }
             state.vfx.push({
              id: state.nextVfxId++,
              type: 'ability_cast',
              x: cannonPos.x, 
              y: cannonPos.y,
              age,
              lifeMs: 600, // Slightly longer for charging effect (was 500)
              data: { turretAbility: 'chain_lightning', targetPositions: chainPositions },
            });
          } else if (turretLevel >= 5 && canUseAbility && targets.length >= 2) {
            base.turretAbilityCooldown = 3.0;
            const pierceDamage = damagePerShot * 1.5;
            targets[0].health.current -= pierceDamage;
            targets[1].health.current -= pierceDamage;
            
            const cannonPos = TurretSystem.getTurretPosition(base.x, age, turretLevel);
            
            const targetPositions = [
                { x: targets[0].transform.x, y: targets[0].transform.laneY },
                { x: targets[1].transform.x, y: targets[1].transform.laneY }
            ];

             state.vfx.push({
              id: state.nextVfxId++,
              type: 'ability_cast',
              x: cannonPos.x,
              y: cannonPos.y,
              age,
              lifeMs: 600,
              data: { turretAbility: 'piercing_shot', targets: 2, targetPositions },
            });
          } else {
            const target = targets[0];
            const turretPos = TurretSystem.getTurretPosition(base.x, age, base.turretLevel);
            const projX = turretPos.x;
            const projY = turretPos.y;
            
            const dx = target.transform.x - projX;
            const dy = target.transform.laneY - projY;
            const distanceToTarget = Math.sqrt(dx * dx + dy * dy);
            const angle = Math.atan2(dy, dx);
            
            const projVx = Math.cos(angle) * PROJECTILE_SPEED;
            const projVy = Math.sin(angle) * PROJECTILE_SPEED;
            const lifeMs = (distanceToTarget / PROJECTILE_SPEED) * 1000 * 1.2;
            const projId = (state.nextEntityId++) + projIdOffset;
            
            state.projectiles.push({ 
              id: projId, 
              owner: owner as 'PLAYER' | 'ENEMY', 
              x: projX, 
              y: projY, 
              vx: projVx, 
              vy: projVy,
              damage: damagePerShot, 
              lifeMs 
            });
          }
        }
      } else {
        accumulator = 0;
      }
      return accumulator;
    };

    this.turretAccumPlayerMs = updateTurretForSide(true, this.turretAccumPlayerMs, 200000);
    this.turretAccumEnemyMs = updateTurretForSide(false, this.turretAccumEnemyMs, 300000);
  }

  // Helper methods
  public static getTurretPosition(baseX: number, age: number, turretLevel: number): { x: number; y: number } {
    const dims = TURRET_VISUALS.BASE_DIMENSIONS[age - 1] || TURRET_VISUALS.BASE_DIMENSIONS[0];
    const platformY = pixelsToUnits(dims.height) + TURRET_VISUALS.PLATFORM_OFFSET_UNITS;
    
    // Inline static calls
    const baseSize = TURRET_VISUALS.BASE_SIZE + turretLevel * TURRET_VISUALS.SIZE_PER_LEVEL;
    let ratio = 0.4;
    if (turretLevel >= 7) ratio = 0.6;
    else if (turretLevel >= 4) ratio = 0.5;
    
    const cannonOffsetPx = baseSize * ratio;
    const cannonTipY = platformY + pixelsToUnits(cannonOffsetPx);
    return { x: baseX, y: cannonTipY };
  }
}
