# Asset Loading System Documentation

## Overview
The GameEngine now includes a framework for loading and animating unit sprites with support for:
- SVG fallbacks (current implementation)
- PNG sprite sheets
- Animated sequences for different states

## Asset Manifest Structure

Each unit can have an asset manifest entry defining:

```typescript
assetManifest.set('unit_id', {
  type: 'svg' | 'png' | 'spritesheet',
  path: 'assets/units/unit_name.{svg|png}',
  animations?: {
    idle: { frames: number; fps: number },
    walk: { frames: number; fps: number },
    attack: { frames: number; fps: number },
    ability?: { frames: number; fps: number },
    death?: { frames: number; fps: number }
  }
});
```

## Implementation Algorithm

### 1. Asset Loading (async)
```typescript
async loadAsset(unitId: string): Promise<ImageSource> {
  const manifest = this.assetManifest.get(unitId);
  
  if (!manifest) {
    // Fallback to SVG sprite generation
    return this.generateSVGSprite(unitId);
  }
  
  switch (manifest.type) {
    case 'svg':
      return this.loadSVG(manifest.path);
      
    case 'png':
      return this.loadPNG(manifest.path);
      
    case 'spritesheet':
      const sheet = await this.loadSpriteSheet(manifest.path);
      return this.createAnimatedSprite(sheet, manifest.animations);
  }
}
```

### 2. Animation State Machine
```typescript
class AnimatedSprite {
  private currentAnimation: string = 'idle';
  private currentFrame: number = 0;
  private frameTimer: number = 0;
  
  update(deltaTime: number, entityState: string) {
    // Transition to appropriate animation
    if (entityState === 'ATTACK') this.currentAnimation = 'attack';
    else if (entityState === 'MOVE') this.currentAnimation = 'walk';
    else this.currentAnimation = 'idle';
    
    // Advance frame based on FPS
    const anim = this.animations[this.currentAnimation];
    this.frameTimer += deltaTime;
    
    if (this.frameTimer >= 1 / anim.fps) {
      this.frameTimer = 0;
      this.currentFrame = (this.currentFrame + 1) % anim.frames;
    }
  }
  
  render(ctx: CanvasRenderingContext2D, x: number, y: number) {
    const anim = this.animations[this.currentAnimation];
    const frameWidth = this.spriteSheet.width / anim.frames;
    const sx = this.currentFrame * frameWidth;
    
    ctx.drawImage(
      this.spriteSheet,
      sx, 0, frameWidth, this.spriteSheet.height,
      x - frameWidth/2, y - this.spriteSheet.height/2,
      frameWidth, this.spriteSheet.height
    );
  }
}
```

### 3. Sprite Sheet Format
For sprite sheets, frames should be laid out horizontally:
```
[idle_1][idle_2][idle_3]...[walk_1][walk_2]...[attack_1][attack_2]...
```

Metadata file (unit_name.json):
```json
{
  "frameWidth": 64,
  "frameHeight": 64,
  "animations": {
    "idle": { "startFrame": 0, "frames": 4, "fps": 8 },
    "walk": { "startFrame": 4, "frames": 8, "fps": 12 },
    "attack": { "startFrame": 12, "frames": 6, "fps": 15 },
    "ability": { "startFrame": 18, "frames": 10, "fps": 20 },
    "death": { "startFrame": 28, "frames": 6, "fps": 10 }
  }
}
```

### 4. Integration with Rendering

Update `drawUnit()` to use animated sprites:

```typescript
private drawUnit(entity: Entity): void {
  const sprite = this.unitSprites.get(entity.unitId);
  
  if (sprite instanceof AnimatedSprite) {
    sprite.update(this.deltaTime, entity.animationState);
    sprite.render(this.ctx, screenX, screenY, entity.kinematics.vx < 0);
  } else {
    // Static sprite rendering (current SVG system)
    this.ctx.drawImage(sprite, ...);
  }
}
```

## Migration Path

1. **Current**: SVG sprites (static, 64x64)
2. **Phase 1**: Add PNG support with static images
3. **Phase 2**: Implement sprite sheet loader
4. **Phase 3**: Add animation state machine
5. **Phase 4**: Create animated assets for all units

## Performance Considerations

- Cache loaded sprite sheets in memory
- Use `requestAnimationFrame` timing for smooth animations
- Consider texture atlasing for WebGL renderer
- Implement LOD system for distant units
- Use object pooling for sprite instances

## File Naming Convention

```
assets/units/
  ├── stone_clubman.svg          (current fallback)
  ├── stone_clubman.png          (static sprite)
  ├── stone_clubman_sheet.png    (animation sprite sheet)
  ├── stone_clubman.json         (animation metadata)
  └── ...
```

## Example Asset Creation

For a unit with walk cycle:
1. Create 8 frames of walking animation at 64x64 pixels each
2. Arrange horizontally in 512x64 PNG (8 frames × 64px)
3. Create metadata JSON with frame timing
4. Update manifest to reference sprite sheet
5. Test in-game with animation preview tool

This system is designed to be backward-compatible with current SVG sprites while preparing for richer animated content in future updates.
