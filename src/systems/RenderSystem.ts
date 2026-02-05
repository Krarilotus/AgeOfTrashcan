import { GameState, Entity, Projectile } from '../GameEngine';
import { TURRET_VISUALS, pixelsToUnits, unitsToPixels } from '../config/renderConfig';
import { UNIT_DEFS } from '../config/units';
import { GameEngine } from '../GameEngine'; // For static helpers if needed, or better copy helper logic

export class RenderSystem {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private unitSprites: Map<string, HTMLImageElement | HTMLCanvasElement>;

  constructor(
    ctx: CanvasRenderingContext2D, 
    canvas: HTMLCanvasElement, 
    unitSprites: Map<string, HTMLImageElement | HTMLCanvasElement>
  ) {
    this.ctx = ctx;
    this.canvas = canvas;
    this.unitSprites = unitSprites;
  }

  public render(state: GameState): void {
    if (!this.ctx || !this.canvas) return;

    // Clear canvas
    this.ctx.fillStyle = '#1e293b';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Draw lane
    this.ctx.strokeStyle = '#475569';
    this.ctx.lineWidth = 1;
    this.ctx.setLineDash([10, 10]);
    this.ctx.beginPath();
    this.ctx.moveTo(0, this.canvas.height / 2);
    this.ctx.lineTo(this.canvas.width, this.canvas.height / 2);
    this.ctx.stroke();
    this.ctx.setLineDash([]);

    // Draw bases
    this.drawBase(state.playerBase, true, state.progression.player.age, state.battlefield.width);
    this.drawBase(state.enemyBase, false, state.progression.enemy.age, state.battlefield.width);

    // Draw units
    for (const entity of state.entities.values()) {
      this.drawUnit(entity, state.battlefield.width);
    }

    // Draw projectiles
    this.drawProjectiles(state.projectiles, state.battlefield.width);

    // Draw VFX
    this.drawVFX(state, state.battlefield.width);

    // Draw UI info
    this.drawHUD(state);
  }

  // Helper to match GameEngine static methods
  // We can import these from config/renderConfig directly if they match
  // The GameEngine ones just wrapped the config ones.
  // GameEngine.getTurretSize was: TURRET_VISUALS.BASE_SIZE + turretLevel * TURRET_VISUALS.SIZE_PER_LEVEL
  private getTurretSize(turretLevel: number): number {
    return TURRET_VISUALS.BASE_SIZE + turretLevel * TURRET_VISUALS.SIZE_PER_LEVEL;
  }
  
  private getCannonOffsetRatio(turretLevel: number): number {
    if (turretLevel >= 7) return 0.6;
    if (turretLevel >= 4) return 0.5;
    return 0.4;
  }

  private getTurretScreenPosition(baseX: number, baseY: number, age: number): { x: number; y: number } {
    const dims = TURRET_VISUALS.BASE_DIMENSIONS[age - 1] || TURRET_VISUALS.BASE_DIMENSIONS[0];
    const turretY = baseY - dims.height - 5; 
    return { x: baseX, y: turretY };
  }

  private drawBase(base: any, isPlayer: boolean, age: number, battlefieldWidth: number): void {
    const x = (base.x / battlefieldWidth) * this.canvas.width;
    const y = this.canvas.height / 2;
    
    const turretLevel = base.turretLevel;
    const color1 = isPlayer ? '#3b82f6' : '#ef4444';
    const color2 = isPlayer ? '#1e40af' : '#991b1b';
    const color3 = isPlayer ? '#60a5fa' : '#f87171';

    // Age-progressive designs
    if (age === 1) { // Stone Age
      const tentWidth = 35;
      const tentHeight = 30;
      this.ctx.fillStyle = '#8b7355';
      this.ctx.beginPath();
      this.ctx.moveTo(x, y - tentHeight);
      this.ctx.lineTo(x - tentWidth/2, y);
      this.ctx.lineTo(x + tentWidth/2, y);
      this.ctx.closePath();
      this.ctx.fill();
      this.ctx.strokeStyle = '#654321';
      this.ctx.lineWidth = 2;
      this.ctx.stroke();
      this.ctx.fillStyle = '#3d2817';
      this.ctx.fillRect(x - 8, y - 15, 16, 15);
    } else if (age === 2) { // Tool Age
      const tentWidth = 38;
      const tentHeight = 32;
      this.ctx.fillStyle = '#a0826d';
      this.ctx.beginPath();
      this.ctx.moveTo(x, y - tentHeight);
      this.ctx.lineTo(x - tentWidth/2, y);
      this.ctx.lineTo(x + tentWidth/2, y);
      this.ctx.closePath();
      this.ctx.fill();
      this.ctx.strokeStyle = '#654321';
      this.ctx.lineWidth = 3;
      this.ctx.beginPath();
      this.ctx.moveTo(x - tentWidth/3, y);
      this.ctx.lineTo(x, y - tentHeight);
      this.ctx.moveTo(x + tentWidth/3, y);
      this.ctx.lineTo(x, y - tentHeight);
      this.ctx.stroke();
    } else if (age === 3) { // Bronze Age
      const hutWidth = 35;
      const hutHeight = 35;
      this.ctx.fillStyle = color2;
      this.ctx.fillRect(x - hutWidth/2, y - hutHeight + 10, hutWidth, hutHeight - 10);
      this.ctx.fillStyle = '#8b4513';
      this.ctx.beginPath();
      this.ctx.moveTo(x, y - hutHeight);
      this.ctx.lineTo(x - hutWidth/2 - 5, y - hutHeight + 15);
      this.ctx.lineTo(x + hutWidth/2 + 5, y - hutHeight + 15);
      this.ctx.closePath();
      this.ctx.fill();
      this.ctx.fillStyle = '#fcd34d';
      this.ctx.fillRect(x - 6, y - 20, 12, 10);
    } else if (age === 4) { // Iron Age
      const towerWidth = 36;
      const towerHeight = 40;
      this.ctx.fillStyle = '#71717a';
      this.ctx.fillRect(x - towerWidth/2, y - towerHeight, towerWidth, towerHeight);
      this.ctx.strokeStyle = '#52525b';
      this.ctx.lineWidth = 1;
      for (let i = 0; i < 3; i++) {
        this.ctx.strokeRect(x - towerWidth/2, y - towerHeight + i * 13, towerWidth, 13);
      }
      this.ctx.fillStyle = '#52525b';
      for (let i = 0; i < 3; i++) {
        this.ctx.fillRect(x - towerWidth/2 + i * 12, y - towerHeight - 5, 8, 5);
      }
    } else if (age === 5) { // Castle Age
      const keepWidth = 40;
      const keepHeight = 42;
      const gradient = this.ctx.createLinearGradient(x, y - keepHeight, x, y);
      gradient.addColorStop(0, color1);
      gradient.addColorStop(1, color2);
      this.ctx.fillStyle = gradient;
      this.ctx.fillRect(x - keepWidth/2, y - keepHeight, keepWidth, keepHeight);
      this.ctx.fillStyle = color3;
      this.ctx.beginPath();
      this.ctx.moveTo(x - keepWidth/2 + 5, y - keepHeight - 5);
      this.ctx.lineTo(x - keepWidth/2 + 15, y - keepHeight - 8);
      this.ctx.lineTo(x - keepWidth/2 + 5, y - keepHeight - 11);
      this.ctx.closePath();
      this.ctx.fill();
      this.ctx.fillStyle = '#000';
      for (let i = 0; i < 2; i++) {
        this.ctx.fillRect(x - 12, y - keepHeight + 15 + i * 15, 3, 10);
        this.ctx.fillRect(x + 9, y - keepHeight + 15 + i * 15, 3, 10);
      }
    } else if (age === 6) { // Renaissance
      const citadelWidth = 42;
      const citadelHeight = 45;
      this.ctx.fillStyle = color2;
      this.ctx.fillRect(x - citadelWidth/2, y - citadelHeight, citadelWidth, citadelHeight);
      this.ctx.fillStyle = color1;
      this.ctx.fillRect(x - citadelWidth/2 - 4, y - citadelHeight, 8, 20);
      this.ctx.fillRect(x + citadelWidth/2 - 4, y - citadelHeight, 8, 20);
      this.ctx.fillStyle = '#fbbf24';
      for (let i = 0; i < 2; i++) {
        this.ctx.fillRect(x - 15, y - citadelHeight + 15 + i * 15, 10, 10);
        this.ctx.fillRect(x + 5, y - citadelHeight + 15 + i * 15, 10, 10);
      }
    } else { // Modern Age (7)
      const bunkerWidth = 45;
      const bunkerHeight = 48;
      const metalGradient = this.ctx.createLinearGradient(x - bunkerWidth/2, y - bunkerHeight, x + bunkerWidth/2, y);
      metalGradient.addColorStop(0, '#6b7280');
      metalGradient.addColorStop(0.5, '#9ca3af');
      metalGradient.addColorStop(1, '#4b5563');
      this.ctx.fillStyle = metalGradient;
      this.ctx.fillRect(x - bunkerWidth/2, y - bunkerHeight, bunkerWidth, bunkerHeight);
      this.ctx.fillStyle = isPlayer ? '#3b82f6' : '#ef4444';
      this.ctx.fillRect(x - bunkerWidth/2 + 5, y - bunkerHeight + 8, 12, 8);
      this.ctx.fillRect(x + bunkerWidth/2 - 17, y - bunkerHeight + 8, 12, 8);
      this.ctx.fillStyle = '#10b981';
      for (let i = 0; i < 3; i++) {
        this.ctx.beginPath();
        this.ctx.arc(x - 15 + i * 15, y - bunkerHeight + 25, 3, 0, Math.PI * 2);
        this.ctx.fill();
      }
      this.ctx.strokeStyle = '#1f2937';
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(x - bunkerWidth/2, y - bunkerHeight, bunkerWidth, bunkerHeight);
    }

    // TURRET
    if (turretLevel > 0) {
      const turretScreenPos = this.getTurretScreenPosition(x, y, age);
      const turretSize = this.getTurretSize(turretLevel);
      
      this.ctx.fillStyle = color2;
      this.ctx.fillRect(turretScreenPos.x - turretSize - 3, turretScreenPos.y, turretSize * 2 + 6, 6);
      
      if (turretLevel >= 7) {
        this.ctx.fillStyle = isPlayer ? '#fbbf24' : '#fb923c';
        this.ctx.beginPath();
        this.ctx.moveTo(turretScreenPos.x - turretSize, turretScreenPos.y);
        this.ctx.lineTo(turretScreenPos.x - turretSize/3, turretScreenPos.y - turretSize);
        this.ctx.lineTo(turretScreenPos.x + turretSize/3, turretScreenPos.y - turretSize);
        this.ctx.lineTo(turretScreenPos.x + turretSize, turretScreenPos.y);
        this.ctx.closePath();
        this.ctx.fill();
        const cannonOffset = turretSize * this.getCannonOffsetRatio(turretLevel);
        this.ctx.fillStyle = '#374151';
        this.ctx.fillRect(turretScreenPos.x - 10, turretScreenPos.y - cannonOffset, 5, 12);
        this.ctx.fillRect(turretScreenPos.x + 5, turretScreenPos.y - cannonOffset, 5, 12);
      } else if (turretLevel >= 4) {
        this.ctx.fillStyle = isPlayer ? '#8b5cf6' : '#f97316';
        this.ctx.fillRect(turretScreenPos.x - turretSize * 0.7, turretScreenPos.y - turretSize, turretSize * 1.4, turretSize);
        const cannonOffset = turretSize * this.getCannonOffsetRatio(turretLevel);
        this.ctx.fillStyle = '#374151';
        this.ctx.fillRect(turretScreenPos.x - 3, turretScreenPos.y - cannonOffset, 6, 12);
      } else {
        this.ctx.fillStyle = color1;
        this.ctx.fillRect(turretScreenPos.x - turretSize * 0.6, turretScreenPos.y - turretSize * 0.7, turretSize * 1.2, turretSize * 0.7);
        const cannonOffset = turretSize * this.getCannonOffsetRatio(turretLevel);
        this.ctx.fillStyle = '#4b5563';
        this.ctx.fillRect(turretScreenPos.x - 2, turretScreenPos.y - cannonOffset, 4, 8);
      }
    }

    // RANGE CIRCLE
    if (turretLevel > 0) {
      const baseRange = 10;
      const rangeBonus = turretLevel <= 3 ? turretLevel * 4 : 
                         turretLevel <= 6 ? 12 + (turretLevel - 3) * 2 :
                         18 + (turretLevel - 6) * 1;
      const maxRange = battlefieldWidth / 2;
      const turretRange = Math.min(baseRange + rangeBonus, maxRange);
      const rangePixels = (turretRange / battlefieldWidth) * this.canvas.width;
      
      this.ctx.strokeStyle = isPlayer ? 'rgba(96, 165, 250, 0.3)' : 'rgba(248, 113, 113, 0.3)';
      this.ctx.lineWidth = 2;
      this.ctx.setLineDash([5, 5]);
      this.ctx.beginPath();
      this.ctx.arc(x, y, rangePixels, 0, Math.PI * 2);
      this.ctx.stroke();
      this.ctx.setLineDash([]);
    }
  }

  private drawUnit(entity: Entity, battlefieldWidth: number): void {
    const x = (entity.transform.x / battlefieldWidth) * this.canvas.width;
    const y = this.canvas.height / 2 + (entity.transform.laneY * 15);

    const sprite = this.unitSprites.get(entity.unitId);
    if (sprite) {
      // Get visual scale from unit definition
      const def = UNIT_DEFS[entity.unitId];
      const scale = def?.visualScale ?? 1.0;
      
      const sw = sprite.width * scale;
      const sh = sprite.height * scale;
      
      this.ctx.save();
      if (entity.kinematics.vx < 0) {
        this.ctx.translate(x, y);
        this.ctx.scale(-1, 1);
        this.ctx.drawImage(sprite, -sw / 2, -sh / 2, sw, sh);
      } else {
        this.ctx.drawImage(sprite, x - sw / 2, y - sh / 2, sw, sh);
      }
      this.ctx.restore();
    }

    // Health indicator
    const healthPercent = Math.max(0, entity.health.current / entity.health.max);
    this.ctx.fillStyle = healthPercent > 0.5 ? '#22c55e' : healthPercent > 0.25 ? '#eab308' : '#ef4444';
    this.ctx.fillRect(x - 12, y - 33, 24 * healthPercent, 3);
  }

  private drawProjectiles(projectiles: Projectile[], battlefieldWidth: number): void {
    for (const p of projectiles) {
      const x = (p.x / battlefieldWidth) * this.canvas.width;
      const baselineY = this.canvas.height / 2;
      const y = baselineY - unitsToPixels(p.y); // Use helper

      if (p.id > 200000) {
        // Turret
        this.ctx.fillStyle = p.owner === 'PLAYER' ? '#fbbf24' : '#f87171';
        this.ctx.beginPath();
        this.ctx.arc(x, y, 6, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.strokeStyle = p.owner === 'PLAYER' ? 'rgba(251, 191, 36, 0.8)' : 'rgba(248, 113, 113, 0.8)';
        this.ctx.lineWidth = 3;
        this.ctx.stroke();
        
        this.ctx.globalAlpha = 0.5;
        this.ctx.fillStyle = p.owner === 'PLAYER' ? '#fbbf24' : '#f87171';
        this.ctx.beginPath();
        this.ctx.arc(x - p.vx * 0.05, y - p.vy * 0.05, 4, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.globalAlpha = 1.0;
      } else {
        // Unit
        this.ctx.fillStyle = p.owner === 'PLAYER' ? '#fef08a' : '#fca5a5';
        this.ctx.beginPath();
        this.ctx.arc(x, y, 4, 0, Math.PI * 2);
        this.ctx.fill();
      }
    }
  }

  private drawVFX(state: GameState, battlefieldWidth: number): void {
    for (const vfx of state.vfx) {
      const x = (vfx.x / battlefieldWidth) * this.canvas.width;
      const y = this.canvas.height / 2 + (vfx.y * 15);
      const alpha = vfx.lifeMs / (vfx.type === 'kill_reward' ? 800 : vfx.type === 'ability_cast' ? 600 : 1000);
      
      this.ctx.save();
      this.ctx.globalAlpha = alpha;
      
      if (vfx.type === 'ability_cast') {
        if (vfx.data?.turretAbility === 'chain_lightning' && vfx.data.targetPositions) {
            // Chain Lightning Visuals
            this.ctx.shadowBlur = 10;
            this.ctx.shadowColor = '#00ffff';
            this.ctx.lineCap = 'round';
            this.ctx.lineJoin = 'round';
            
            // Draw bolts from source to targets
            let startX = x; // Base position
            let startY = y;
            
            this.ctx.beginPath();
            
            for (const targetPos of vfx.data.targetPositions) {
                const tx = (targetPos.x / battlefieldWidth) * this.canvas.width;
                const ty = this.canvas.height / 2 + (targetPos.y * 15);
                
                // Draw jagged line for lightning
                const segments = 5;
                let curX = startX;
                let curY = startY;
                
                this.ctx.moveTo(startX, startY);
                
                for (let i = 1; i <= segments; i++) {
                    const progress = i / segments;
                    const nextX = startX + (tx - startX) * progress;
                    const nextY = startY + (ty - startY) * progress;
                    
                    // Jitter
                    const jitterX = (Math.random() - 0.5) * 20 * (1 - progress); // More jitter near start
                    const jitterY = (Math.random() - 0.5) * 30; // Random vertical jitter
                    
                    const drawX = (i === segments) ? tx : nextX + jitterX;
                    const drawY = (i === segments) ? ty : nextY + jitterY;
                    
                    this.ctx.lineTo(drawX, drawY);
                    
                    curX = drawX;
                    curY = drawY;
                }
                
                // Chain to next target (conceptually, though here we draw from base to all targets in parallel or series?)
                // TurretSystem logic: "chain_lightning" implies A -> B -> C. Code: "from base to targets[i]".
                // The TurretSystem logic actually hits targets[0], [1], [2] separately in current impl?
                // Wait, TurretSystem: "targets[i].health -= chainDamage".
                // Visually it looks better if it chains 0 -> 1 -> 2.
                // The targetPositions array is ordered 0, 1, 2.
                
                // Let's update start point for next bolt to create a chain effect
                startX = tx;
                startY = ty;
            }
            
            this.ctx.strokeStyle = `rgba(180, 230, 255, ${alpha})`;
            this.ctx.lineWidth = 4;
            this.ctx.stroke();
            
            this.ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
            this.ctx.lineWidth = 2;
            this.ctx.stroke();
            
            this.ctx.shadowBlur = 0;
            
        } else if (vfx.data?.turretAbility === 'artillery_barrage') {
             // Multiple rockets launching up
             const targets = vfx.data?.targets || 3;
             const phase = (1200 - vfx.lifeMs) / 1200; // 0 to 1
             
             for(let i=0; i<targets; i++) {
                 // Launch staggered
                 const myStart = i * 0.1;
                 const myEnd = myStart + 0.4;
                 
                 if (phase >= myStart && phase <= myEnd) {
                     const myPhase = (phase - myStart) / 0.4;
                     const height = myPhase * 100; // Go up 100px
                     const offsetX = (i - 1) * 10;
                     
                     // Rocket
                     this.ctx.fillStyle = '#ffaa00';
                     this.ctx.beginPath();
                     this.ctx.arc(x + offsetX, y - height, 3, 0, Math.PI * 2);
                     this.ctx.fill();
                     
                     // Smoke Trail
                     this.ctx.strokeStyle = `rgba(100, 100, 100, ${0.5 * (1-myPhase)})`;
                     this.ctx.lineWidth = 4;
                     this.ctx.beginPath();
                     this.ctx.moveTo(x + offsetX, y - height * 0.8);
                     this.ctx.lineTo(x + offsetX, y - height);
                     this.ctx.stroke();
                 }
             }

        } else {
            // Standard Cast Visuals
            const castRadius = 15 + (vfx.age * 2);
            if (vfx.age <= 2) {
                this.ctx.strokeStyle = '#fbbf24';
                this.ctx.lineWidth = 3;
                this.ctx.beginPath();
                this.ctx.arc(x, y, castRadius, 0, Math.PI * 2);
                this.ctx.stroke();
            } else if (vfx.age <= 4) {
                this.ctx.strokeStyle = '#8b5cf6';
                this.ctx.lineWidth = 2;
                for (let i = 0; i < 3; i++) {
                    this.ctx.beginPath();
                    this.ctx.arc(x, y, castRadius - i * 5, 0, Math.PI * 2);
                    this.ctx.stroke();
                }
            } else {
                const gradient = this.ctx.createRadialGradient(x, y, 0, x, y, castRadius);
                gradient.addColorStop(0, '#00ffff');
                gradient.addColorStop(0.5, '#0080ff');
                gradient.addColorStop(1, 'transparent');
                this.ctx.fillStyle = gradient;
                this.ctx.beginPath();
                this.ctx.arc(x, y, castRadius, 0, Math.PI * 2);
                this.ctx.fill();
            }
        }
      } else if (vfx.type === 'ability_impact') {
        const isArtilleryShell = vfx.data?.subtype === 'artillery_shell';
        const delay = vfx.data?.delay || 0;
        
        // Handle delayed articulation (if delay > 0, we might want to hide it, but VfxSystem doesn't handle delay logic separately)
        // Ideally we'd decrement delay in data, but we can just use lifeMs phase.
        
        if (isArtilleryShell) {
             const maxLife = 1000;
             const progress = 1.0 - (vfx.lifeMs / maxLife); // 0.0 to 1.0
             
             // Phase 1: Falling (0.0 to 0.8)
             // Phase 2: Explosion (0.8 to 1.0)
             
             if (progress < 0.8) {
                 const fallProgress = progress / 0.8; // 0 to 1
                 // Drop from height
                 const height = 300 * (1 - fallProgress * fallProgress); // Accelerate down
                 
                 this.ctx.fillStyle = '#ff4500';
                 this.ctx.beginPath();
                 this.ctx.arc(x, y - height, 4, 0, Math.PI * 2);
                 this.ctx.fill();
                 
                 // Trail
                 this.ctx.strokeStyle = `rgba(255, 100, 0, ${0.5 * (1 - fallProgress)})`;
                 this.ctx.lineWidth = 2;
                 this.ctx.beginPath();
                 this.ctx.moveTo(x, y - height - 10);
                 this.ctx.lineTo(x, y - height);
                 this.ctx.stroke();
             } else {
                 // Explosion
                 const explodeProgress = (progress - 0.8) / 0.2; // 0 to 1
                 const radius = 5 + explodeProgress * 30;
                 const alphaExp = alpha * (1 - explodeProgress);
                 
                 this.ctx.fillStyle = `rgba(255, 200, 50, ${alphaExp})`;
                 this.ctx.beginPath();
                 this.ctx.arc(x, y, radius, 0, Math.PI * 2);
                 this.ctx.fill();
                 
                 this.ctx.strokeStyle = `rgba(255, 50, 0, ${alphaExp})`;
                 this.ctx.lineWidth = 2;
                 this.ctx.beginPath();
                 this.ctx.arc(x, y, radius * 0.7, 0, Math.PI * 2);
                 this.ctx.stroke();
             }
             
             return; // Skip default impact rendering
        }

        if (vfx.data?.radius) {
            // ... (AOE rendering existing code) ...
            const impactRadius = (vfx.data.radius / battlefieldWidth) * this.canvas.width;
            this.ctx.fillStyle = vfx.age <= 2 ? `rgba(255, 140, 0, ${alpha * 0.3})` : vfx.age <= 4 ? `rgba(139, 92, 246, ${alpha * 0.4})` : `rgba(0, 255, 255, ${alpha * 0.5})`;
            this.ctx.beginPath();
            this.ctx.arc(x, y, impactRadius, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.strokeStyle = vfx.age <= 2 ? '#ff8c00' : vfx.age <= 4 ? '#a855f7' : '#00ffff';
            this.ctx.lineWidth = 3;
            // ...
        } else {
            // DIRECT IMPACT
            // Check for negative damage (Healing)
            const damage = vfx.data?.damage || 0;
            const isHealing = damage < 0;

            if (isHealing) {
                // DRAW GREEN CROSS
                const size = 15;
                this.ctx.fillStyle = '#22c55e'; // Green
                this.ctx.globalAlpha = alpha;
                
                // Draw + Shape
                this.ctx.fillRect(x - size/2, y - size/6, size, size/3); // Horiz
                this.ctx.fillRect(x - size/6, y - size/2, size/3, size); // Vert
                
                // Draw Floating Text (+Healing)
                this.ctx.globalAlpha = alpha;
                this.ctx.fillStyle = '#4ade80'; // Lighter green text
                this.ctx.font = 'bold 16px monospace';
                this.ctx.textAlign = 'center';
                this.ctx.fillText(`+${Math.abs(Math.floor(damage))}`, x, y - 25);

            } else {
                // NORMAL DAMAGE VISUALS
                const size = 10 + (damage) / 5;
                this.ctx.fillStyle = vfx.age <= 2 ? '#ff4444' : vfx.age <= 4 ? '#ff00ff' : '#00ffff';
                this.ctx.beginPath();
                this.ctx.arc(x, y, size, 0, Math.PI * 2);
                this.ctx.fill();
                if (vfx.data?.damage > 0) {
                  this.ctx.globalAlpha = alpha * 1.5;
                  this.ctx.fillStyle = '#ffffff';
                  this.ctx.font = 'bold 14px monospace';
                  this.ctx.textAlign = 'center';
                  this.ctx.fillText(`-${Math.floor(vfx.data.damage)}`, x, y - 20);
                }
            }
        }
      } else if (vfx.type === 'flamethrower') {
        const direction = vfx.data?.direction || 1;
        const range = vfx.data?.range || 4;
        const screenRange = (range / battlefieldWidth) * this.canvas.width;
        const isDarkCultist = vfx.data?.unitId === 'dark_cultist';
        
        // Use additive blending for brighter fire
        this.ctx.globalCompositeOperation = 'screen';

        const segments = 20; // Number of circles
        const step = screenRange / segments;
        
        for (let i = 0; i < segments; i++) {
           const progress = i / segments; // 0 to 1
           const dist = i * step;
           
           // Radius grows with distance
           const radius = (5 + progress * 25) * (0.8 + Math.random() * 0.4);
           
           // Wiggle (Chaotic, not just sine)
           const timeScale = (state.tick / 60) * 20;
           const wiggle = Math.sin(timeScale + i * 0.5) * (15 * progress) + Math.cos(timeScale * 1.5 + i) * 5;
           const yOffset = wiggle;
           
           const cx = x + (dist * direction);
           const cy = y + yOffset;
           
           // Alpha fades out at end
           const particleAlpha = Math.min(1.0, alpha * 2.0) * (1 - Math.pow(progress, 2));
           
           this.ctx.beginPath();
           this.ctx.arc(cx, cy, radius, 0, Math.PI * 2);
           
           if (isDarkCultist) {
              // Purple/Green fel fire (Dark Cultist)
              // Core: Cyan/White, Mid: Purple, Outer: Dark Blue/Green mist
              const r = Math.floor(50 + progress * 50); 
              const g = Math.floor(255 - progress * 200);
              const b = Math.floor(100 + progress * 155);
              
              const grad = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
              grad.addColorStop(0, `rgba(200, 255, 200, ${particleAlpha})`);
              grad.addColorStop(0.6, `rgba(${r}, ${g}, ${b}, ${particleAlpha * 0.8})`);
              grad.addColorStop(1, `rgba(0, 0, 0, 0)`);
              this.ctx.fillStyle = grad;

           } else {
              // Standard Fire: White -> Yellow -> Red -> Smoke
              const grad = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
              
              if (progress < 0.2) {
                 grad.addColorStop(0, `rgba(255, 255, 255, ${particleAlpha})`);
                 grad.addColorStop(1, `rgba(255, 200, 100, 0)`);
              } else if (progress < 0.6) {
                 grad.addColorStop(0, `rgba(255, 200, 50, ${particleAlpha})`);
                 grad.addColorStop(1, `rgba(200, 50, 0, 0)`);
              } else {
                 grad.addColorStop(0, `rgba(200, 50, 0, ${particleAlpha * 0.7})`);
                 grad.addColorStop(1, `rgba(50, 50, 50, 0)`);
              }
              this.ctx.fillStyle = grad;
           }
           this.ctx.fill();
        }

        // Draw projectile cone logic removed - replaced entirely by particle stream
      } else if (vfx.type === 'kill_reward') {
          const bounty = vfx.data?.bounty || 0;
          const offsetY = (1 - alpha) * 30;
          this.ctx.fillStyle = '#fbbf24';
          this.ctx.font = 'bold 16px monospace';
          this.ctx.textAlign = 'center';
          this.ctx.strokeStyle = '#000000';
          this.ctx.lineWidth = 3;
          this.ctx.strokeText(`+${bounty}g`, x, y - offsetY);
          this.ctx.fillText(`+${bounty}g`, x, y - offsetY);
      }

      this.ctx.restore();
    }
  }

  private drawHUD(state: GameState): void {
    if (!this.ctx || !this.canvas) return;

    this.ctx.fillStyle = '#ffffff';
    this.ctx.font = '12px monospace';
    this.ctx.textAlign = 'left';

    const playerUnits = Array.from(state.entities.values()).filter(e => e.owner === 'PLAYER').length;
    const enemyUnits = Array.from(state.entities.values()).filter(e => e.owner === 'ENEMY').length;

    this.ctx.fillText(`Units: ${playerUnits} vs ${enemyUnits}`, 10, 20);
    this.ctx.fillText(
      `Health: ${Math.floor(state.playerBase.health)} vs ${Math.floor(state.enemyBase.health)}`,
      10,
      35
    );
  }
}