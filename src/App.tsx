import React, { useRef, useState, useEffect } from 'react';
import { GameEngine, UNIT_DEFS } from './GameEngine';
import { BASE_CONFIG, INCOME_CONFIG } from './config/gameBalance';

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<GameEngine | null>(null);

  const [gameState, setGameState] = useState<any>(null);
  const [gameOver, setGameOver] = useState<any>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [difficulty, setDifficulty] = useState<'EASY' | 'MEDIUM' | 'HARD' | 'CHEATER'>('MEDIUM');
  const [showAIDebug, setShowAIDebug] = useState(false);
  const [aiDebugInfo, setAIDebugInfo] = useState<any>(null);

  const startGame = () => {
    console.log(`Click: startGame - starting with ${difficulty} difficulty`);
    setIsRunning(true);
  };

  // Initialize game when isRunning becomes true and canvas is available
  useEffect(() => {
    if (!isRunning || gameRef.current) return; // Already initialized

    // Wait a tick for canvas to be rendered
    const timeout = setTimeout(() => {
      if (!canvasRef.current) {
        console.error("Canvas ref is still null!");
        setIsRunning(false);
        return;
      }

      console.log("Canvas is now available, initializing game...");

      const config = {
        difficulty: difficulty,
        startingGold: BASE_CONFIG.startingGold,
        startingMana: BASE_CONFIG.startingMana,
        goldIncomeBase: INCOME_CONFIG.baseGoldPerSecond,
        manaIncomeBase: BASE_CONFIG.baseManaPerSecond, // Start at 0, must upgrade
        laneLength: 50,
        basePositions: { player: 0, enemy: 50 },
      };

      console.log("Creating GameEngine...");
      const game = new GameEngine(config, Math.floor(Math.random() * 1e6), {
        onStateUpdate: (state: any) => {
          // Force React to re-render by creating a new object reference
          setGameState({ ...state });
          // Auto-save game state every update
          if (game) {
            game.saveGameState();
          }
        },
        onGameOver: (winner: string) => {
          console.log("Game over:", winner);
          setGameOver({ winner });
          game.stop();
          // Don't set isRunning(false) here - keep game UI visible to show victory/defeat overlay
          // Clear save on game over
          GameEngine.deleteSavedGame();
        },
        onAgeUpgrade: () => {},
      });

      gameRef.current = game;

      console.log("Calling game.init()");
      game.init(canvasRef.current).then(() => {
        console.log("Game init complete, attempting to load saved game...");
        const loadedSave = game.loadGameState();
        if (loadedSave) {
          console.log("Saved game loaded successfully!");
        } else {
          console.log("No saved game found, starting fresh");
        }
        const initialState = game.getState();
        console.log("Initial state received:", initialState);
        setGameState(initialState);
        console.log("Calling game.start()");
        game.start();
      }).catch((err) => {
        console.error("Game init failed:", err);
        setIsRunning(false);
      });
    }, 0);

    return () => clearTimeout(timeout);
  }, [isRunning]);

  // Update AI Debug Info
  useEffect(() => {
    if (showAIDebug && gameRef.current && gameState) {
       try {
         const info = gameRef.current.getAIController().getDebugInfo();
         setAIDebugInfo(info);
       } catch (e) {
         console.warn("Failed to get AI debug info", e);
       }
    }
  }, [gameState, showAIDebug]);

  // Add F5 key listener for reloading the game
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if (e.key === 'F5' || e.keyCode === 116) {
        e.preventDefault();
        console.log('F5 pressed - reloading game from save');
        // Stop current game if running
        if (gameRef.current) {
          gameRef.current.stop();
          gameRef.current = null;
        }
        // Set running to false first
        setIsRunning(false);
        setGameOver(null);
        // Small delay then reload from localStorage
        setTimeout(() => {
          // Load saved state using consistent key
          const savedState = localStorage.getItem('ageOfWar_saveGame');
          if (savedState) {
            try {
              const parsed = JSON.parse(savedState);
              setGameState(parsed);
              console.log('Loaded game state from localStorage');
            } catch (err) {
              console.error('Failed to parse saved game state:', err);
              setGameState(null);
            }
          } else {
            console.log('No saved state found, starting fresh');
            setGameState(null);
          }
          // Start game
          setIsRunning(true);
        }, 100);
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, []);

  const handleSpawnUnit = (unitId: string) => {
    gameRef.current?.spawnUnit(unitId);
  };

  const handleCancelQueueItem = (index: number) => {
    gameRef.current?.cancelQueueItem(index);
  };

  const getUnitName = (unitId: string) => {
    const names: Record<string, string> = {
      stone_clubman: 'Clubman',
      stone_slinger: 'Slinger',
      stone_dino: 'War Dino',
      bronze_spearman: 'Spearman',
      bronze_archer: 'Archer',
      bronze_catapult: 'Catapult',
      iron_knight: 'Knight',
      iron_mage: 'Mage',
      iron_crossbow: 'Crossbow',
      war_elephant: 'Elephant',
      battle_monk: 'Monk',
      steel_tank: 'Tank',
      artillery: 'Artillery',
      medic: 'Medic',
      heavy_cavalry: 'Heavy Cavalry',
      siege_engineer: 'Siege Engineer',
      gunner: 'Gunner',
      pyro_maniac: 'Pyro',
      energy_shield: 'Shield',
      flamethrower: 'Flamethrower',
      steam_mech: 'Steam Mech',
      sniper: 'Sniper',
      mana_vampire: 'Mana Vampire',
      robot_soldier: 'Robot',
      laser_trooper: 'Laser',
      mech_walker: 'Mech',
      plasma_striker: 'Plasma',
      nanoswarm: 'Nanoswarm',
      titan_mech: 'Titan Mech',
      cyber_assassin: 'Cyber Assassin',
      dark_cultist: 'Dark Cultist',
    };
    return names[unitId] || unitId;
  };

  const getAbilityDisplay = (skill: any) => {
    if (!skill) return null;
    const cooldownSec = (skill.cooldownMs / 1000).toFixed(1);
    const manaCost = skill.manaCost;
    
    if (skill.power < 0) {
       return (
         <div className="flex flex-col leading-tight mt-1">
           <div>💚 Heal {Math.abs(skill.power)} HP</div>
           <div className="text-[10px] opacity-80">Cost: {manaCost}m | CD: {cooldownSec}s</div>
         </div>
       );
    }
    
    if (skill.type === 'aoe') {
       const damage = skill.damage ?? 0;
       const radius = skill.power;
       const range = skill.range ?? 6;
       return (
         <div className="flex flex-col leading-tight mt-1">
           <div>💥 AOE: {damage} Dmg</div>
           <div className="text-[10px] opacity-80">Rng: {range} | Rad: {radius}</div>
           <div className="text-[10px] opacity-80">Cost: {manaCost}m | CD: {cooldownSec}s</div>
         </div>
       );
    } 
    else if (skill.type === 'flamethrower') {
       const dps = (skill.power * (1000 / skill.cooldownMs)).toFixed(0);
       const manaPerSec = (skill.manaCost * (1000 / skill.cooldownMs)).toFixed(0);
       return (
         <div className="flex flex-col leading-tight mt-1">
           <div>🔥 Flame: {dps} DPS</div>
           <div className="text-[10px] opacity-80">Rng: {skill.range ?? 6} | {manaPerSec} mana/s</div>
         </div>
       );
    }
    else {
       const damage = skill.power;
       const range = skill.range ?? 5;
       return (
         <div className="flex flex-col leading-tight mt-1">
           <div>🎯 Strike: {damage} Dmg</div>
           <div className="text-[10px] opacity-80">Rng: {range} | Cost: {manaCost}m | CD: {cooldownSec}s</div>
         </div>
       );
    }
  };

  const getAbilityText = (skill: any) => {
     if (!skill) return '';
     const cooldownSec = (skill.cooldownMs / 1000).toFixed(1);
     if (skill.power < 0) return `💚 Heal ${Math.abs(skill.power)} HP (Cost: ${skill.manaCost}m, CD: ${cooldownSec}s)`;
     if (skill.type === 'aoe') return `💥 AOE: ${skill.damage ?? 0} Dmg (Rad: ${skill.power}, Rng: ${skill.range ?? 6}, Cost: ${skill.manaCost}m, CD: ${cooldownSec}s)`;
     if (skill.type === 'flamethrower') return `🔥 Flamethrower (Range: ${skill.range}, Dmg: ${skill.power}/tick, Rate: ${(1000/skill.cooldownMs).toFixed(0)}/s)`;
     return `🎯 Strike: ${skill.power} Dmg (Rng: ${skill.range ?? 5}, Cost: ${skill.manaCost}m, CD: ${cooldownSec}s)`;
  };

  const handleUpgradeAge = () => {
    gameRef.current?.upgradeAge();
  };

  const handleUpgradeTurret = () => {
    gameRef.current?.upgradeTurret();
  };

  const handleUpgradeManaGeneration = () => {
    gameRef.current?.upgradeManaGeneration();
  };

  const handleHealBase = () => {
    gameRef.current?.healBase();
  };

  const handleRestart = () => {
    console.log("Restarting game...");
    if (gameRef.current) {
      gameRef.current.stop();
      gameRef.current = null;
    }
    // Clear game over state to return to start screen
    setGameOver(null);
    setGameState(null);
    setIsRunning(false);
  };
  
  const handleSaveGame = () => {
    if (gameRef.current) {
      try {
        gameRef.current.saveGameState();
        alert('💾 Game saved successfully!');
      } catch (error) {
        alert('❌ Failed to save game');
        console.error('Save error:', error);
      }
    }
  };
  
  const handleLoadGame = () => {
    if (gameRef.current) {
      try {
        const success = gameRef.current.loadGameState();
        if (success) {
          alert('📂 Game loaded successfully!');
        } else {
          alert('⚠️ No saved game found');
        }
      } catch (error) {
        alert('❌ Failed to load game');
        console.error('Load error:', error);
      }
    }
  };

  // Add a keyboard shortcut to restart
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if (e.key === 'r' || e.key === 'R') {
        handleRestart();
      }
    };
    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, []);

  // Always render the game UI when isRunning, even if still loading
  // This ensures the canvas is available for game initialization
  
  if (!isRunning) {
    console.log("Showing menu screen");
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center gap-6 p-8">
        <div className="text-4xl font-bold bg-gradient-to-r from-amber-400 via-purple-400 to-cyan-400 bg-clip-text text-transparent">
          Age of War: Transcended
        </div>
        <div className="text-slate-400 text-center max-w-lg">
          Command armies across 6 ages of warfare. From Stone Age clubmen to futuristic mechs.
          <br />
          <br />
          <span className="text-sm">Spawn units • Upgrade your base • Advance through ages • Destroy the enemy</span>
        </div>
        
        {/* Difficulty selector */}
        <div className="bg-slate-800 border border-slate-700 rounded-lg p-6 w-full max-w-md">
          <div className="text-lg font-semibold mb-4 text-center">Select Difficulty</div>
          <div className="grid grid-cols-2 gap-3">
            {(['EASY', 'MEDIUM', 'HARD', 'CHEATER'] as const).map((diff) => (
              <button
                key={diff}
                onClick={() => setDifficulty(diff)}
                className={`px-4 py-3 rounded-lg font-semibold transition-all ${
                  difficulty === diff
                    ? 'bg-gradient-to-r from-amber-500 to-purple-500 text-white'
                    : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
                }`}
              >
                {diff === 'EASY' && '😊 Easy'}
                {diff === 'MEDIUM' && '⚔️ Medium'}
                {diff === 'HARD' && '💀 Hard'}
                {diff === 'CHEATER' && '👹 Cheater'}
              </button>
            ))}
          </div>
          <div className="mt-4 text-sm text-slate-400 text-center">
            {difficulty === 'EASY' && 'AI gets 80% income, makes basic decisions'}
            {difficulty === 'MEDIUM' && 'Balanced AI with normal income'}
            {difficulty === 'HARD' && 'Smart AI with 120% income bonus'}
            {difficulty === 'CHEATER' && 'Ruthless AI with 150% income!'}
          </div>
        </div>
        
        <button
          onClick={startGame}
          className="mt-4 bg-gradient-to-r from-amber-500 to-purple-500 hover:from-amber-600 hover:to-purple-600 text-white text-lg px-8 py-6 rounded-lg font-semibold transition-all"
        >
          ⚔️ Play Now
        </button>
        
        {localStorage.getItem('ageOfWar_saveGame') && (
          <button
            onClick={() => {
              localStorage.removeItem('ageOfWar_saveGame');
              window.location.reload();
            }}
            className="mt-2 bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm px-4 py-2 rounded-lg transition-all"
          >
            🗑️ Clear Saved Game
          </button>
        )}
      </div>
    );
  }

  // Game is running - show the game UI with canvas
  return (
    <div className="min-h-screen bg-slate-900 text-white flex flex-col">
      <header className="bg-slate-800 border-b border-slate-700 p-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-2xl font-bold bg-gradient-to-r from-amber-400 to-purple-400 bg-clip-text text-transparent">
              Age of War
            </h1>
            <div className="bg-amber-700 text-white px-3 py-1 rounded-full text-sm">
              Age {gameState?.progression?.player?.age || 1}
            </div>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={() => setAudioEnabled(!audioEnabled)}
              className="text-slate-400 hover:text-white"
              title="Toggle audio"
            >
              {audioEnabled ? "🔊" : "🔇"}
            </button>
            <button
              onClick={handleSaveGame}
              className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 text-white rounded font-semibold transition-colors"
              title="Save game (S)"
            >
              💾 Save
            </button>
            <button
              onClick={handleLoadGame}
              className="px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white rounded font-semibold transition-colors"
              title="Load game (L)"
            >
              📂 Load
            </button>
            <button
              onClick={handleRestart}
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded font-semibold transition-colors"
              title="Restart game (R)"
            >
              🔄 Restart
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col lg:flex-row gap-4 p-4 max-w-full mx-auto w-full overflow-hidden">
        <div className="flex-1 flex flex-col min-w-0 gap-4">
          <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden" style={{ height: '450px' }}>
            <div className="w-full h-full overflow-x-auto overflow-y-hidden">
              <canvas
                ref={canvasRef}
                className="block"
                width={1200}
                height={450}
                style={{ imageRendering: 'crisp-edges' }}
              />
            </div>
            {!gameState && (
              <div className="absolute inset-0 bg-black/80 flex items-center justify-center pointer-events-none">
                <div className="text-white text-xl">Loading...</div>
              </div>
            )}
            {gameOver && (
              <div className="absolute inset-0 bg-black/90 flex items-center justify-center overflow-hidden">
                {/* Victory confetti animation */}
                {gameOver.winner === "PLAYER" && (
                  <div className="absolute inset-0 pointer-events-none">
                    {[...Array(50)].map((_, i) => (
                      <div
                        key={i}
                        className="absolute animate-fall"
                        style={{
                          left: `${Math.random() * 100}%`,
                          top: `-20px`,
                          animationDelay: `${Math.random() * 3}s`,
                          animationDuration: `${2 + Math.random() * 2}s`,
                        }}
                      >
                        <div
                          className="w-3 h-3 opacity-80"
                          style={{
                            backgroundColor: ['#fbbf24', '#a855f7', '#22c55e', '#3b82f6', '#ef4444'][Math.floor(Math.random() * 5)],
                            transform: `rotate(${Math.random() * 360}deg)`,
                          }}
                        />
                      </div>
                    ))}
                  </div>
                )}
                {/* Defeat falling particles */}
                {gameOver.winner !== "PLAYER" && (
                  <div className="absolute inset-0 pointer-events-none">
                    {[...Array(30)].map((_, i) => (
                      <div
                        key={i}
                        className="absolute animate-fall-slow"
                        style={{
                          left: `${Math.random() * 100}%`,
                          top: `-20px`,
                          animationDelay: `${Math.random() * 2}s`,
                          animationDuration: `${3 + Math.random() * 2}s`,
                        }}
                      >
                        <div
                          className="w-2 h-2 bg-red-900/50 rounded-full"
                          style={{
                            filter: 'blur(1px)',
                          }}
                        />
                      </div>
                    ))}
                  </div>
                )}
                <div className="bg-slate-800 border-4 border-slate-600 p-12 rounded-2xl text-center relative z-10 animate-scale-in">
                  <h2 className="text-6xl mb-8 font-bold">
                    {gameOver.winner === "PLAYER" ? (
                      <span className="text-green-400 animate-pulse-slow">🏆 Victory! 🏆</span>
                    ) : (
                      <span className="text-red-400 animate-shake">💀 Defeat 💀</span>
                    )}
                  </h2>
                  <p className="text-slate-400 mb-8 text-lg">
                    {gameOver.winner === "PLAYER" 
                      ? "You have conquered your enemy and brought peace to the realm!"
                      : "Your base has fallen. Regroup and try again!"}
                  </p>
                  <button
                    onClick={handleRestart}
                    className="bg-gradient-to-r from-amber-500 to-purple-500 hover:from-amber-600 hover:to-purple-600 text-white px-8 py-4 rounded-lg font-semibold text-xl transition-all hover:scale-105"
                  >
                    ⚔️ Play Again
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Unit Training Menu - moved here to be under play area */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 max-h-[450px] overflow-y-auto">
            <div className="text-sm text-slate-400 mb-3 flex justify-between items-center">
              <span>⚔️ Unit Training</span>
              <span className="text-xs">
                Build Time: {Math.floor((1 - ((gameState?.progression?.player?.age ?? 1) - 1) * 0.1) * 100)}%
                {(gameState?.progression?.player?.age ?? 1) > 1 && (
                  <span className="text-green-400"> ({((gameState?.progression?.player?.age ?? 1) - 1) * 10}% faster)</span>
                )}
              </span>
            </div>
            
            {/* Group units by age */}
            <div className="space-y-3">
              {[1, 2, 3, 4, 5, 6].map((age) => {
                const playerAge = gameState?.progression?.player?.age ?? 1;
                if (age > playerAge) return null;
                
                const unitsInAge = Object.entries(UNIT_DEFS).filter(([_, def]) => (def.age ?? 1) === age);
                if (unitsInAge.length === 0) return null;
                
                const ageNames = ['Stone', 'Bronze', 'Iron', 'Steel', 'Industrial', 'Future'];
                const ageColors = ['#8B7355', '#CD7F32', '#B0B0B0', '#4682B4', '#FF6B35', '#00D4FF'];
                
                return (
                  <div key={age} className="bg-slate-700 rounded-lg p-3">
                    <div className="text-xs font-bold mb-2" style={{ color: ageColors[age - 1] }}>
                      Age {age}: {ageNames[age - 1]}
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                      {unitsInAge.map(([id, def]) => {
                        const playerGold = gameState?.economy?.player?.gold ?? 0;
                        const playerMana = gameState?.economy?.player?.mana ?? 0;
                        const needsMana = (def.manaCost ?? 0) > 0;
                        const disabled = playerGold < def.cost || (needsMana && playerMana < (def.manaCost ?? 0));
                        const buildTimeMultiplier = Math.max(0.4, 1 - (playerAge - 1) * 0.1);
                        const actualBuildTime = ((def.trainingMs ?? 1000) * buildTimeMultiplier / 1000).toFixed(1);
                        
                        return (
                          <button
                            key={id}
                            onClick={() => handleSpawnUnit(id)}
                            className="bg-slate-800 hover:bg-slate-600 p-2 rounded text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed group"
                            disabled={disabled}
                            title={`${getUnitName(id)}\nHP: ${def.health} | DMG: ${def.damage} | SPD: ${def.speed}\nRange: ${def.range ?? 1} | Build: ${actualBuildTime}s${def.skill ? '\n' + getAbilityText(def.skill) : ''}${def.manaLeech ? `\nMana Leech: ${Math.round(def.manaLeech*100)}%` : ''}${def.manaShield ? '\nMana Shield: Active' : ''}`}
                          >
                            <div className="text-sm font-semibold truncate">{getUnitName(id)}</div>
                            <div className="text-xs text-slate-400 space-y-0.5">
                              <div>💰 {def.cost}g{needsMana ? ` ✨ ${def.manaCost}m` : ''}</div>
                              <div className="flex gap-2">
                                <span title="Health">❤️ {def.health}</span>
                                <span title="Damage">⚔️ {def.damage}</span>
                                <span title="Speed">🦶 {def.speed}</span>
                              </div>
                              <div className="flex gap-2">
                                <span title="Range">{(def.range ?? 1) > 1.5 ? '🏹' : '⚔️'} {def.range ?? 1}</span>
                                <span title="Build Time">⏱️ {actualBuildTime}s</span>
                              </div>
                              {def.skill && (
                                <div className="text-purple-400 text-xs">
                                  {getAbilityDisplay(def.skill)}
                                </div>
                              )}
                              {def.manaLeech && (
                                <div className="text-blue-400 text-xs mt-1">
                                  <span>💧 Mana Leech: {Math.round(def.manaLeech * 100)}%</span>
                                </div>
                              )}
                              {def.manaShield && (
                                <div className="text-cyan-400 text-xs mt-1">
                                  <span>🛡️ Mana Shield</span>
                                </div>
                              )}
                              {def.burstFire && (
                                <div className="text-orange-400 text-xs mt-1">
                                  <span>🔫 Burst: {def.burstFire.shots}x</span>
                                </div>
                              )}
                              {def.teleporter && (
                                <div className="text-pink-400 text-xs mt-1">
                                  <span>🌌 Teleporter</span>
                                </div>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            
            {/* Training Queue */}
            <div className="mt-3 min-h-12 bg-slate-700 rounded p-2">
              {(gameState?.playerQueue?.length ?? 0) > 0 ? (
                <div className="flex items-center gap-2 text-sm text-slate-300">
                  <span className="text-xs text-slate-400">Queue:</span>
                  <div className="flex gap-1 flex-wrap">
                    {(gameState?.playerQueue ?? []).map((q: any, i: number) => (
                      <button
                        key={i}
                        onClick={() => handleCancelQueueItem(i)}
                        title="Click to cancel"
                        className="bg-slate-600 hover:bg-red-700 px-2 py-1 rounded text-xs transition-colors cursor-pointer"
                      >
                        {getUnitName(q.unitId)} {((q.remainingMs ?? 0) / 1000).toFixed(1)}s ✕
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="text-xs text-slate-500">Queue empty</div>
              )}
            </div>
          </div>
            
            {/* AI Debug View */}
            <div className="mt-2 text-right">
                <button 
                    onClick={() => setShowAIDebug(!showAIDebug)}
                    className="text-xs text-slate-500 hover:text-slate-300 underline"
                >
                    {showAIDebug ? 'Hide AI Debug' : 'Show AI Debug'}
                </button>
            </div>
            
            {showAIDebug && aiDebugInfo && (
                <div className="mt-2 bg-slate-900 border border-slate-600 rounded p-4 text-xs font-mono text-green-400 overflow-hidden">
                    <div className="grid grid-cols-3 gap-4">
                        <div>
                            <div className="font-bold text-white mb-2 underline">Threat Analysis</div>
                            <div className="flex justify-between items-center">
                                <span>Level:</span>
                                <span className={`font-bold ${aiDebugInfo.threatLevel === 'HIGH' || aiDebugInfo.threatLevel === 'CRITICAL' ? 'text-red-500' : 'text-green-400'}`}>
                                    {aiDebugInfo.threatLevel}
                                </span>
                            </div>
                            
                            <div className="mt-2 text-[10px] space-y-0.5 bg-slate-800 p-1 rounded">
                                {aiDebugInfo.threatDetails && aiDebugInfo.threatDetails.FACTORS ? (
                                <>
                                    <div className="flex justify-between text-slate-400"><span>Units (P vs AI):</span> <span className="text-white">{Math.round(aiDebugInfo.threatDetails.FACTORS.unitScoreP)} vs {Math.round(aiDebugInfo.threatDetails.FACTORS.unitScoreE)}</span></div>
                                    <div className="flex justify-between text-slate-400">
                                        <span>Gold Adv:</span> 
                                        <span className={aiDebugInfo.threatDetails.FACTORS.goldThreat > 0 ? "text-red-400" : "text-green-400"}>
                                            {aiDebugInfo.threatDetails.FACTORS.goldThreat > 0 ? '+' : ''}{Math.round(aiDebugInfo.threatDetails.FACTORS.goldThreat)}
                                        </span>
                                    </div>
                                    <div className="flex justify-between text-slate-400"><span>Turrets:</span> <span>{Math.round(aiDebugInfo.threatDetails.FACTORS.turretThreatP)} vs {Math.round(aiDebugInfo.threatDetails.FACTORS.turretThreatE)}</span></div>
                                    <div className="border-t border-slate-600 my-1"></div>
                                    <div className="flex justify-between font-bold">
                                        <span>Total Power:</span> 
                                        <span>{Math.round(aiDebugInfo.threatDetails.playerScore)} vs {Math.round(aiDebugInfo.threatDetails.enemyScore)}</span>
                                    </div>
                                    <div className="text-right text-slate-300">Ratio: {aiDebugInfo.threatDetails.ratio.toFixed(2)}</div>
                                </>
                                ) : (
                                    <div className="italic text-slate-500">Waiting for tick...</div>
                                )}
                            </div>
                            <div className="mt-1">Strat: {aiDebugInfo.strategicState}</div>
                            <div title={aiDebugInfo.behaviorParams?.plan} className="text-[9px] text-slate-500 truncate mt-1">
                                {aiDebugInfo.behaviorParams?.plan}
                            </div>
                        </div>
                        <div>
                            <div className="font-bold text-white mb-2 underline">Economy ({aiDebugInfo.behaviorParams?.difficulty})</div>
                             <div className="text-[10px] space-y-0.5 bg-slate-800 p-1 rounded mb-2">
                                <div className="flex justify-between text-slate-400">
                                    <span>Enemy Age:</span> 
                                    <span className="font-bold text-red-400">{gameState?.progression?.enemy?.age ?? 1}</span>
                                </div>
                                <div className="flex justify-between text-slate-400">
                                    <span>Turret Lvl:</span> 
                                    <span className="font-bold text-red-400">Lvl {aiDebugInfo?.behaviorParams?.turret ?? gameState?.enemyBase?.turretLevel ?? 0}</span>
                                </div>
                                <div className="flex justify-between text-slate-400">
                                    <span>Gold/Mana:</span> 
                                    <span className="font-bold text-red-400">
                                        {Math.floor(gameState?.economy?.enemy?.gold ?? 0)} / {Math.floor(gameState?.economy?.enemy?.mana ?? 0)}
                                    </span>
                                </div>
                            </div>
                            
                            <div>
                                Warchest: {aiDebugInfo.behaviorParams?.warchest ?? aiDebugInfo.warchest}g / {aiDebugInfo.behaviorParams?.wcTarget}g
                            </div>
                            <div className="text-xs text-slate-500">
                                AgeTime: {aiDebugInfo.behaviorParams?.timeSinceAge} | Tax: {aiDebugInfo.behaviorParams?.taxRate}
                            </div>
                            <div>Income: +{aiDebugInfo.behaviorParams?.income}/s</div>
                        </div>
                        <div>
                             <div className="font-bold text-white mb-2 underline">Logic</div>
                             <div title="Spendable / Total">Gold: <span className="text-yellow-400">{aiDebugInfo.behaviorParams?.gold}</span></div>
                             <div>Reserved: {aiDebugInfo.behaviorParams?.reserved}g</div>
                             <div className="text-[10px] text-slate-400 mt-1">
                                {aiDebugInfo.behaviorParams?.comp}
                             </div>
                             {aiDebugInfo.behaviorParams?.pushEst && (
                                <div className="text-[10px] text-cyan-400 mt-1" title="Attack Feasibility (Required HP)">
                                    Push: {aiDebugInfo.behaviorParams?.pushEst}
                                </div>
                             )}
                        </div>
                    </div>
                    
                    <div className="mt-3">
                        <div className="font-bold text-white mb-1 underline">Strategy & Planning</div>
                        <div>Composition: <span className="text-purple-300">{aiDebugInfo.behaviorParams?.plan}</span></div>
                        
                         {aiDebugInfo.plannedAttackGroup ? (
                            <div className="mt-1 border-t border-slate-700 pt-1">
                                <div className="text-yellow-300">EXEC: {aiDebugInfo.plannedAttackGroup.name}</div>
                                <div className="text-slate-400 break-words">{aiDebugInfo.plannedAttackGroup.units.join(', ')}</div>
                            </div>
                        ) : (
                            <div className="text-slate-600 text-[10px] italic">No active group execution</div>
                        )}
                    </div>

                     <div className="mt-3">
                        <div className="font-bold text-white mb-1 underline">Recent Actions</div>
                        <div className="flex flex-col gap-0.5 max-h-24 overflow-y-auto">
                            {aiDebugInfo.recentActions.slice().reverse().map((a: string, i: number) => (
                                <span key={i} className="text-slate-400">- {a}</span>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>

        <div className="w-full lg:w-80 flex flex-col gap-4">
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
            <h3 className="text-sm text-slate-400 mb-4">⚔️ Battle Stats</h3>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span>Your Age</span>
                <span className="font-bold text-amber-400">{gameState?.progression?.player?.age ?? 1}</span>
              </div>
              <div className="border-t border-slate-600 pt-2 mt-2">
                <div className="flex justify-between">
                  <span>Your Turret</span>
                  <span className="font-bold text-blue-400">Lv.{gameState?.playerBase?.turretLevel ?? 0}</span>
                </div>
              </div>
              <div className="border-t border-slate-600 pt-2 mt-2">
                <div className="flex justify-between">
                  <span>Your Resources</span>
                  <span className="font-bold">
                    <span className="text-yellow-400">💰 {Math.floor(gameState?.economy?.player?.gold ?? 0)}</span>
                    <span className="text-blue-400 ml-2">✨ {Math.floor(gameState?.economy?.player?.mana ?? 0)}</span>
                  </span>
                </div>
              </div>
            </div>
            <div className="mt-3 text-xs">
              <div className="flex justify-between">
                <span>Damage Dealt</span>
                <span className="font-semibold">{Math.floor(gameState?.stats?.damageDealt?.player ?? 0)} / {Math.floor(gameState?.stats?.damageDealt?.enemy ?? 0)}</span>
              </div>
              <div className="flex justify-between mt-1">
                <span>Turret Effect</span>
                <span className="font-semibold">
                  {(() => {
                    const level = gameState?.playerBase?.turretLevel ?? 0;
                    const baseDmgPerShot = gameState?.meta?.turretBaseDamagePerShot ?? 1.6;
                    const fireInterval = gameState?.meta?.turretFireInterval ?? 0.4;
                    const progressiveBonus = level * (5 + level) * fireInterval;
                    const totalDmgPerShot = baseDmgPerShot + progressiveBonus;
                    const dps = totalDmgPerShot / fireInterval;
                    return `${dps.toFixed(1)} DPS`;
                  })()}
                </span>
              </div>
              <div className="flex justify-between mt-1 text-slate-400">
                <span>Next Turret +</span>
                <span className="font-mono">
                  {(() => {
                    const level = gameState?.playerBase?.turretLevel ?? 0;
                    const fireInterval = gameState?.meta?.turretFireInterval ?? 0.4;
                    const currentBonus = level * (5 + level) * fireInterval;
                    const nextBonus = (level + 1) * (5 + level + 1) * fireInterval;
                    const dpsIncrease = (nextBonus - currentBonus) / fireInterval;
                    return `+${dpsIncrease.toFixed(0)} DPS`;
                  })()}
                </span>
              </div>
              {(() => {
                const level = gameState?.playerBase?.turretLevel ?? 0;
                if (level === 4) return <div className="flex justify-between mt-1 text-purple-400"><span>Next: Piercing Shot</span><span className="text-xs">Lv.5 Ability</span></div>;
                if (level === 6) return <div className="flex justify-between mt-1 text-purple-400"><span>Next: Chain Lightning</span><span className="text-xs">Lv.7 Ability</span></div>;
                if (level === 8) return <div className="flex justify-between mt-1 text-purple-400"><span>Next: Artillery Barrage</span><span className="text-xs">Lv.9 Ability</span></div>;
                if (level >= 5 && level < 7) return <div className="flex justify-between mt-1 text-green-400"><span>Piercing Shot</span><span className="text-xs">Active</span></div>;
                if (level >= 7 && level < 9) return <div className="flex justify-between mt-1 text-green-400"><span>Chain Lightning</span><span className="text-xs">Active</span></div>;
                if (level >= 9) return <div className="flex justify-between mt-1 text-green-400"><span>Artillery Barrage</span><span className="text-xs">Active</span></div>;
                return null;
              })()}
              <div className="flex justify-between mt-1 text-slate-400">
                <span>Age Upgrade Benefit</span>
                <span className="font-mono">
                  {(() => {
                    const age = gameState?.progression?.player?.age ?? 1;
                    const nextGold = Math.min(age + 2, 7); // Next age will give: age 1→2: +2, 2→3: +3, etc.
                    return `+${nextGold}g/s, ${gameState?.meta?.ageBaseHealthMultiplier ?? 2}x HP`;
                  })()}
                </span>
              </div>
              <div className="flex justify-between mt-1">
                <span>Turret Protection</span>
                <span className="font-semibold">
                  {(() => {
                    const level = gameState?.playerBase?.turretLevel ?? 0;
                    if (level === 0) return 'None';
                    // Level 1: 10%, Level 2: +9%, Level 3: +8% ... Level 10: +1% => Max 55%
                    const effectiveLevel = Math.min(Math.max(0, level), 10);
                    const reduction = (11 * effectiveLevel) - (effectiveLevel * (effectiveLevel + 1)) / 2;
                    return `${reduction.toFixed(1)}% dmg reduction`;
                  })()}
                </span>
              </div>
            </div>
          </div>
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
            <h3 className="text-sm text-slate-400 mb-4">Resources</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-yellow-400">💰</span>
                  <span>Gold</span>
                </div>
                <span className="text-xl font-bold text-yellow-400">
                  {Math.floor(gameState?.economy?.player?.gold ?? 0)}
                </span>
              </div>
              <div className="text-xs text-slate-500">
                +{(gameState?.economy?.player?.goldIncomePerSec ?? 0).toFixed(1)}/sec
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-blue-400">✨</span>
                  <span>Mana</span>
                </div>
                <span className="text-xl font-bold text-blue-400">
                  {Math.floor(gameState?.economy?.player?.mana ?? 0)}
                </span>
              </div>
              <div className="text-xs text-slate-500">
                +{(gameState?.economy?.player?.manaIncomePerSec ?? 0).toFixed(1)}/sec
              </div>
              
              {/* Mana Generation Upgrade */}
              <button
                onClick={handleUpgradeManaGeneration}
                className="w-full px-3 py-2 text-sm bg-blue-900 hover:bg-blue-800 border border-blue-700 rounded font-semibold disabled:opacity-50 disabled:cursor-not-started transition-all"
                disabled={(gameState?.economy?.player?.gold ?? 0) < ((gameState?.progression?.player?.manaGenerationLevel ?? 0) + 1) * 200}
              >
                ✨ Upgrade Mana Gen (Lv.{gameState?.progression?.player?.manaGenerationLevel ?? 0}) - {((gameState?.progression?.player?.manaGenerationLevel ?? 0) + 1) * 200}g
              </button>
              <div className="text-xs text-slate-500 text-center">
                {(gameState?.progression?.player?.manaGenerationLevel ?? 0) === 0 
                  ? 'Unlock mana generation!' 
                  : (gameState?.progression?.player?.manaGenerationLevel ?? 0) >= 5
                    ? `+1 mana/sec, +${(gameState?.progression?.player?.manaGenerationLevel ?? 0) - 4}% gold→mana per kill`
                    : 'Increases mana/sec by +1'}
              </div>
            </div>
          </div>

          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
            <h3 className="text-sm text-slate-400 mb-4">Base Status</h3>
            <div className="space-y-3">
              <div>
                <div className="flex justify-between text-sm mb-1">
                  <span>Health</span>
                  <span>
                    {Math.floor(gameState?.playerBase?.health ?? 0)}/
                    {gameState?.playerBase?.maxHealth ?? 200}
                  </span>
                </div>
                <div className="w-full bg-slate-700 rounded h-2">
                  <div
                    className="bg-red-500 h-2 rounded transition-all"
                    style={{
                      width: `${((gameState?.playerBase?.health ?? 0) / (gameState?.playerBase?.maxHealth ?? 200)) * 100}%`,
                    }}
                  />
                </div>
              </div>
              
              {/* Base Healing Button - Only available in Age 4+ */}
              {(gameState?.progression?.player?.age ?? 1) >= 4 && (
                <button
                  onClick={handleHealBase}
                  className="w-full px-3 py-2 text-sm bg-green-900 hover:bg-green-800 border border-green-700 rounded font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                  disabled={
                    (gameState?.economy?.player?.mana ?? 0) < 500 ||
                    (gameState?.playerBase?.health ?? 0) >= (gameState?.playerBase?.maxHealth ?? 200)
                  }
                >
                  💚 Heal Base (+200 HP) - 500 mana
                </button>
              )}
              
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span>🗼</span>
                  <span className="text-sm">Turret Lv.{gameState?.playerBase?.turretLevel ?? 0}</span>
                </div>
                <button
                  onClick={handleUpgradeTurret}
                  className="px-3 py-1 text-sm bg-slate-700 hover:bg-slate-600 rounded border border-slate-600 disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={(gameState?.economy?.player?.gold ?? 0) < (gameState?.playerBase?.turretUpgradeCost ?? 100)}
                >
                  {(gameState?.playerBase?.turretUpgradeCost ?? 100)}g
                </button>
              </div>
            </div>
          </div>

          {(gameState?.progression?.player?.age ?? 1) < 6 && (
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
              <h3 className="text-sm text-slate-400 mb-4">Evolution</h3>
              <button
                onClick={handleUpgradeAge}
                className="w-full px-4 py-2 bg-gradient-to-r from-amber-600 to-purple-600 hover:from-amber-700 hover:to-purple-700 text-white rounded font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                disabled={
                  !(gameState?.progression?.player?.ageProgress?.canUpgrade) ||
                  (gameState?.economy?.player?.gold ?? 0) <
                    (gameState?.progression?.player?.ageProgress?.costGold ?? 500)
                }
              >
                ⬆️ Advance to Age {(gameState?.progression?.player?.age ?? 1) + 1}
                <span className="ml-2 text-sm opacity-75">
                  ({gameState?.progression?.player?.ageProgress?.costGold ?? 500}g)
                </span>
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
