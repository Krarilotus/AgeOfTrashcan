import { GameState, GameEngine } from '../GameEngine';
import { UNIT_DEFS } from '../config/units';
import { DIFFICULTY_CONFIG } from '../config/gameBalance';

const FIXED_TIMESTEP = 1000 / 60;

export class EconomySystem {
  
  public static update(state: GameState, deltaSeconds: number): void {
     // Player
    state.economy.player.gold += state.economy.player.goldIncomePerSec * deltaSeconds;
    state.economy.player.mana += state.economy.player.manaIncomePerSec * deltaSeconds;

    // Enemy
    state.economy.enemy.gold += state.economy.enemy.goldIncomePerSec * deltaSeconds;
    state.economy.enemy.mana += state.economy.enemy.manaIncomePerSec * deltaSeconds;

    // Flags
    state.progression.player.ageProgress.canUpgrade = state.economy.player.gold >= state.progression.player.ageProgress.costGold;
    state.progression.enemy.ageProgress.canUpgrade = state.economy.enemy.gold >= state.progression.enemy.ageProgress.costGold;
  }

  public static updateQueues(state: GameState, engine: GameEngine): void {
      // Player
      if (state.playerQueue.length > 0) {
          const unit = state.playerQueue[0];
          unit.remainingMs -= FIXED_TIMESTEP;
          if (unit.remainingMs <= 0) {
              const finished = state.playerQueue.shift();
              if (finished) engine['spawnTestUnit']('PLAYER', finished.unitId); // Needs access to private
          }
      }
      // Enemy
      if (state.enemyQueue.length > 0) {
          const unit = state.enemyQueue[0];
          unit.remainingMs -= FIXED_TIMESTEP;
          if (unit.remainingMs <= 0) {
              const finished = state.enemyQueue.shift();
              if (finished) engine['spawnTestUnit']('ENEMY', finished.unitId);
          }
      }
  }

  // Refactored queueUnit to static helper? 
  // Probably best to keep API methods on GameEngine but delegate logic here.
}
