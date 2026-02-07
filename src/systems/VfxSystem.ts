import { GameState } from '../GameEngine';

// Define VFX Types in a central place or import from config
export type VfxType = 'ability_cast' | 'ability_impact' | 'kill_reward' | 'flamethrower';

export interface VfxData {
  id: number;
  type: VfxType;
  x: number;
  y: number;
  age: number;
  lifeMs: number;
  data?: any;
}

export class VfxSystem {
  public update(state: GameState, deltaSeconds: number): void {
    const deltaMs = deltaSeconds * 1000;
    
    // Filter in place or reassign? GameEngine did reassign.
    state.vfx = state.vfx.filter(vfx => {
      vfx.lifeMs -= deltaMs;
      // You could add more logic here, e.g. updating position for moving particles
      return vfx.lifeMs > 0;
    });
  }

  // Create a new VFX cleanly
  public static spawn(
    state: GameState, 
    type: VfxType, 
    x: number, 
    y: number, 
    lifeMs: number, 
    age: number = 1,
    data?: any
  ): void {
    state.vfx.push({
      id: state.nextVfxId++,
      type,
      x,
      y,
      age,
      lifeMs,
      data
    });
  }
}
