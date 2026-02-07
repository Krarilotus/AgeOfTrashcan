import React, { useEffect, useRef, useState } from 'react';
import { GameEngine } from './GameEngine';
import {
  BASE_CONFIG,
  INCOME_CONFIG,
  PROGRESSION_CONFIG,
  getGoldIncome,
  getGoldToManaConversionRate,
  getManaCost,
  getManaGeneration,
} from './config/gameBalance';
import {
  TURRET_ABILITY_CONFIG,
  calculateTurretDPS,
  calculateTurretProtectionReductionPercent,
} from './config/turretConfig';
import { GameOverOverlay } from './ui/GameOverOverlay';
import { StartScreen, type Difficulty } from './ui/StartScreen';
import { UnitTrainingPanel } from './ui/UnitTrainingPanel';

type Winner = 'PLAYER' | 'ENEMY';

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<GameEngine | null>(null);
  const lastAutosaveMsRef = useRef(0);

  const [gameState, setGameState] = useState<any>(null);
  const [gameOver, setGameOver] = useState<{ winner: Winner } | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [difficulty, setDifficulty] = useState<Difficulty>('MEDIUM');
  const [showAIDebug, setShowAIDebug] = useState(false);
  const [aiDebugInfo, setAIDebugInfo] = useState<any>(null);
  const [shouldLoadSavedGame, setShouldLoadSavedGame] = useState(false);

  const hasSavedGame = GameEngine.hasSavedGame();

  const startNewGame = () => {
    if (gameRef.current) {
      gameRef.current.stop();
      gameRef.current = null;
    }
    GameEngine.deleteSavedGame();
    setGameOver(null);
    setGameState(null);
    setShouldLoadSavedGame(false);
    setIsRunning(true);
  };

  const continueSavedGame = () => {
    if (!GameEngine.hasSavedGame()) return;

    if (gameRef.current) {
      gameRef.current.stop();
      gameRef.current = null;
    }
    setGameOver(null);
    setGameState(null);
    setShouldLoadSavedGame(true);
    setIsRunning(true);
  };

  const handleClearSavedGame = () => {
    GameEngine.deleteSavedGame();
    setGameState(null);
    setGameOver(null);
    setIsRunning(false);
    setShouldLoadSavedGame(false);
  };

  useEffect(() => {
    if (!isRunning || gameRef.current) return;

    const timeout = setTimeout(() => {
      if (!canvasRef.current) {
        setIsRunning(false);
        return;
      }

      const config = {
        difficulty,
        startingGold: BASE_CONFIG.startingGold,
        startingMana: BASE_CONFIG.startingMana,
        goldIncomeBase: INCOME_CONFIG.baseGoldPerSecond,
        manaIncomeBase: BASE_CONFIG.baseManaPerSecond,
        laneLength: 50,
        basePositions: { player: 0, enemy: 50 },
      };

      const game = new GameEngine(config, Math.floor(Math.random() * 1e6), {
        onStateUpdate: (state: any) => {
          setGameState({ ...state });
        },
        onGameOver: (winner: string) => {
          setGameOver({ winner: winner as Winner });
          game.stop();
          GameEngine.deleteSavedGame();
        },
        onAgeUpgrade: () => {},
      });

      gameRef.current = game;

      game
        .init(canvasRef.current)
        .then(() => {
          if (shouldLoadSavedGame) {
            game.loadGameState();
          }

          setGameState(game.getState());
          game.start();
        })
        .catch(() => {
          setIsRunning(false);
          gameRef.current = null;
        });
    }, 0);

    return () => clearTimeout(timeout);
  }, [difficulty, isRunning, shouldLoadSavedGame]);

  useEffect(() => {
    if (!showAIDebug || !gameRef.current || !gameState) return;

    try {
      const info = gameRef.current.getAIController().getDebugInfo();
      setAIDebugInfo(info);
    } catch {
      setAIDebugInfo(null);
    }
  }, [gameState, showAIDebug]);

  useEffect(() => {
    if (!isRunning || !gameRef.current || !gameState || gameOver) return;

    const now = Date.now();
    if (now - lastAutosaveMsRef.current < 2000) return;

    lastAutosaveMsRef.current = now;
    try {
      gameRef.current.saveGameState();
    } catch {
      // Intentionally ignore autosave errors to avoid gameplay interruption.
    }
  }, [gameState, gameOver, isRunning]);

  useEffect(() => {
    return () => {
      if (gameRef.current) {
        gameRef.current.stop();
        gameRef.current = null;
      }
    };
  }, []);

  const handleSpawnUnit = (unitId: string) => {
    gameRef.current?.spawnUnit(unitId);
  };

  const handleCancelQueueItem = (index: number) => {
    gameRef.current?.cancelQueueItem(index);
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
    if (gameRef.current) {
      gameRef.current.stop();
      gameRef.current = null;
    }
    setGameOver(null);
    setGameState(null);
    setIsRunning(false);
    setShouldLoadSavedGame(false);
  };

  const handleSaveGame = () => {
    if (!gameRef.current) return;

    try {
      gameRef.current.saveGameState();
      alert('💾 Game saved successfully!');
    } catch (error) {
      alert('❌ Failed to save game');
      console.error('Save error:', error);
    }
  };

  const handleLoadGame = () => {
    if (!gameRef.current) return;

    try {
      const success = gameRef.current.loadGameState();
      if (success) {
        setGameOver(null);
        alert('📂 Game loaded successfully!');
      } else {
        alert('⚠️ No saved game found');
      }
    } catch (error) {
      alert('❌ Failed to load game');
      console.error('Load error:', error);
    }
  };

  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if (e.key === 'r' || e.key === 'R') {
        handleRestart();
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, []);

  if (!isRunning) {
    return (
      <StartScreen
        difficulty={difficulty}
        hasSavedGame={hasSavedGame}
        onStartNewGame={startNewGame}
        onContinueGame={continueSavedGame}
        onDifficultyChange={setDifficulty}
        onClearSavedGame={handleClearSavedGame}
      />
    );
  }

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
            <button onClick={() => setAudioEnabled(!audioEnabled)} className="text-slate-400 hover:text-white" title="Toggle audio">
              {audioEnabled ? '🔊' : '🔇'}
            </button>
            <button
              onClick={handleSaveGame}
              className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 text-white rounded font-semibold transition-colors"
              title="Save game"
            >
              💾 Save
            </button>
            <button
              onClick={handleLoadGame}
              className="px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white rounded font-semibold transition-colors"
              title="Load game"
            >
              📂 Load
            </button>
            <button
              onClick={handleRestart}
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded font-semibold transition-colors"
              title="Restart game"
            >
              🔄 Restart
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col lg:flex-row gap-4 p-4 max-w-full mx-auto w-full overflow-hidden">
        <div className="flex-1 flex flex-col min-w-0 gap-4">
          <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden relative" style={{ height: '450px' }}>
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

            {gameOver && <GameOverOverlay winner={gameOver.winner} onPlayAgain={handleRestart} />}
          </div>

          <UnitTrainingPanel
            gameState={gameState}
            onSpawnUnit={handleSpawnUnit}
            onCancelQueueItem={handleCancelQueueItem}
          />

          <div className="mt-2 text-right">
            <button onClick={() => setShowAIDebug(!showAIDebug)} className="text-xs text-slate-500 hover:text-slate-300 underline">
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
                          <span className={aiDebugInfo.threatDetails.FACTORS.goldThreat > 0 ? 'text-red-400' : 'text-green-400'}>
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
                      <span className="font-bold text-red-400">{Math.floor(gameState?.economy?.enemy?.gold ?? 0)} / {Math.floor(gameState?.economy?.enemy?.mana ?? 0)}</span>
                    </div>
                  </div>
                  <div>Warchest: {aiDebugInfo.behaviorParams?.warchest ?? aiDebugInfo.warchest}g / {aiDebugInfo.behaviorParams?.wcTarget}g</div>
                  <div className="text-xs text-slate-500">AgeTime: {aiDebugInfo.behaviorParams?.timeSinceAge} | Tax: {aiDebugInfo.behaviorParams?.taxRate}</div>
                  <div>Income: +{aiDebugInfo.behaviorParams?.income}/s</div>
                </div>
                <div>
                  <div className="font-bold text-white mb-2 underline">Logic</div>
                  <div title="Spendable / Total">Gold: <span className="text-yellow-400">{aiDebugInfo.behaviorParams?.gold}</span></div>
                  <div>Reserved: {aiDebugInfo.behaviorParams?.reserved}g</div>
                  <div className="text-[10px] text-slate-400 mt-1">{aiDebugInfo.behaviorParams?.comp}</div>
                  {aiDebugInfo.behaviorParams?.pushEst && (
                    <div className="text-[10px] text-cyan-400 mt-1" title="Attack Feasibility (Required HP)">Push: {aiDebugInfo.behaviorParams?.pushEst}</div>
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
            <h3 className="text-sm text-slate-400 mb-4">Your Battle Stats</h3>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between"><span>Age</span><span className="font-bold text-amber-400">{gameState?.progression?.player?.age ?? 1}</span></div>
              <div className="border-t border-slate-600 pt-2 mt-2">
                <div className="flex justify-between"><span>Turret</span><span className="font-bold text-blue-400">Lv.{gameState?.playerBase?.turretLevel ?? 0}</span></div>
              </div>
              <div className="border-t border-slate-600 pt-2 mt-2">
                <div className="flex justify-between">
                  <span>Resources</span>
                  <span className="font-bold"><span className="text-yellow-400">💰 {Math.floor(gameState?.economy?.player?.gold ?? 0)}</span><span className="text-blue-400 ml-2">✨ {Math.floor(gameState?.economy?.player?.mana ?? 0)}</span></span>
                </div>
                <div className="flex justify-between mt-1 text-slate-500">
                  <span>Income</span>
                  <span><span className="text-yellow-400">+{(gameState?.economy?.player?.goldIncomePerSec ?? 0).toFixed(1)}g/s</span> <span className="text-blue-400">+{(gameState?.economy?.player?.manaIncomePerSec ?? 0).toFixed(1)}m/s</span></span>
                </div>
              </div>
            </div>
            <div className="mt-3 text-xs">
              <div className="flex justify-between"><span>Damage Dealt</span><span className="font-semibold">{Math.floor(gameState?.stats?.damageDealt?.player ?? 0)} / {Math.floor(gameState?.stats?.damageDealt?.enemy ?? 0)}</span></div>
              <div className="flex justify-between mt-1">
                <span>Turret Effect</span>
                <span className="font-semibold">
                  {(() => {
                    const level = gameState?.playerBase?.turretLevel ?? 0;
                    const dps = calculateTurretDPS(level);
                    return `${dps.toFixed(1)} DPS`;
                  })()}
                </span>
              </div>
              <div className="flex justify-between mt-1 text-slate-400">
                <span>Next Turret +</span>
                <span className="font-mono">
                  {(() => {
                    const level = gameState?.playerBase?.turretLevel ?? 0;
                    const nextLevel = Math.min(level + 1, 10);
                    const dpsIncrease = calculateTurretDPS(nextLevel) - calculateTurretDPS(level);
                    return `+${dpsIncrease.toFixed(0)} DPS`;
                  })()}
                </span>
              </div>
              {(() => {
                const level = gameState?.playerBase?.turretLevel ?? 0;
                const piercingLv = TURRET_ABILITY_CONFIG.PIERCING_SHOT.requiredLevel;
                const chainLv = TURRET_ABILITY_CONFIG.CHAIN_LIGHTNING.requiredLevel;
                const barrageLv = TURRET_ABILITY_CONFIG.ARTILLERY_BARRAGE.requiredLevel;
                if (level === piercingLv - 1) return <div className="flex justify-between mt-1 text-purple-400"><span>Next: Piercing Shot</span><span className="text-xs">Lv.{piercingLv} Ability</span></div>;
                if (level === chainLv - 1) return <div className="flex justify-between mt-1 text-purple-400"><span>Next: Chain Lightning</span><span className="text-xs">Lv.{chainLv} Ability</span></div>;
                if (level === barrageLv - 1) return <div className="flex justify-between mt-1 text-purple-400"><span>Next: Artillery Barrage</span><span className="text-xs">Lv.{barrageLv} Ability</span></div>;
                if (level >= piercingLv && level < chainLv) return <div className="flex justify-between mt-1 text-green-400"><span>Piercing Shot</span><span className="text-xs">Active</span></div>;
                if (level >= chainLv && level < barrageLv) return <div className="flex justify-between mt-1 text-green-400"><span>Chain Lightning</span><span className="text-xs">Active</span></div>;
                if (level >= barrageLv) return <div className="flex justify-between mt-1 text-green-400"><span>Artillery Barrage</span><span className="text-xs">Active</span></div>;
                return null;
              })()}
              <div className="flex justify-between mt-1 text-slate-400">
                <span>Age Upgrade Benefit</span>
                <span className="font-mono">{(() => {
                  const age = gameState?.progression?.player?.age ?? 1;
                  if (age >= PROGRESSION_CONFIG.maxAge) return 'Max age reached';
                  const goldGain = getGoldIncome(age + 1) - getGoldIncome(age);
                  return `+${goldGain}g/s, ${PROGRESSION_CONFIG.ageBaseHealthMultiplier}x HP`;
                })()}</span>
              </div>
              <div className="flex justify-between mt-1">
                <span>Turret Protection</span>
                <span className="font-semibold">{(() => {
                  const level = gameState?.playerBase?.turretLevel ?? 0;
                  if (level === 0) return 'None';
                  const reduction = calculateTurretProtectionReductionPercent(level);
                  return `${reduction.toFixed(1)}% dmg reduction`;
                })()}</span>
              </div>
            </div>
          </div>

          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
            <h3 className="text-sm text-slate-400 mb-4">Mana Pool</h3>
            <div className="space-y-3">
              {(() => {
                const level = gameState?.progression?.player?.manaGenerationLevel ?? 0;
                const nextLevel = level + 1;
                const nextCost = getManaCost(level);
                const currentManaPerSec = getManaGeneration(level);
                const nextManaPerSec = getManaGeneration(nextLevel);
                const conversionRate = getGoldToManaConversionRate(level);
                const nextConversionRate = getGoldToManaConversionRate(nextLevel);
                const toPercent = (rate: number): string => {
                  const percent = rate * 100;
                  return Number.isInteger(percent) ? `${percent.toFixed(0)}%` : `${percent.toFixed(1)}%`;
                };
                const currentConversionLabel = `${toPercent(conversionRate)} gold→mana on kills`;
                const nextConversionLabel = `${toPercent(nextConversionRate)} gold→mana on kills`;

                const currentEffectText =
                  level === 0
                    ? 'No passive mana generation yet.'
                    : conversionRate > 0
                      ? `+${currentManaPerSec.toFixed(1)} mana/sec and ${currentConversionLabel}`
                      : `+${currentManaPerSec.toFixed(1)} mana/sec`;

                const nextEffectText =
                  nextConversionRate > 0
                    ? `+${nextManaPerSec.toFixed(1)} mana/sec and ${nextConversionLabel}`
                    : `+${nextManaPerSec.toFixed(1)} mana/sec`;

                return (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-slate-300">Level</span>
                      <span className="font-bold text-blue-300">Lv.{level}</span>
                    </div>
                    <div className="text-xs text-slate-400">
                      Current: <span className="text-blue-300">{currentEffectText}</span>
                    </div>
                    <button
                      onClick={handleUpgradeManaGeneration}
                      className="w-full px-3 py-2 text-sm bg-blue-900 hover:bg-blue-800 border border-blue-700 rounded font-semibold disabled:opacity-50 disabled:cursor-not-started transition-all"
                      disabled={(gameState?.economy?.player?.gold ?? 0) < nextCost}
                    >
                      ✨ Upgrade Mana Pool (Lv.{level}) - {nextCost}g
                    </button>
                    <div className="text-xs text-slate-500 text-center">
                      Upgrade yields: <span className="text-blue-300">{nextEffectText}</span>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>

          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
            <h3 className="text-sm text-slate-400 mb-4">Base Status</h3>
            <div className="space-y-3">
              <div>
                <div className="flex justify-between text-sm mb-1"><span>Health</span><span>{Math.floor(gameState?.playerBase?.health ?? 0)}/{gameState?.playerBase?.maxHealth ?? 200}</span></div>
                <div className="w-full bg-slate-700 rounded h-2">
                  <div className="bg-red-500 h-2 rounded transition-all" style={{ width: `${((gameState?.playerBase?.health ?? 0) / (gameState?.playerBase?.maxHealth ?? 200)) * 100}%` }} />
                </div>
              </div>

              {(gameState?.progression?.player?.age ?? 1) >= 4 && (
                <button
                  onClick={handleHealBase}
                  className="w-full px-3 py-2 text-sm bg-green-900 hover:bg-green-800 border border-green-700 rounded font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                  disabled={(gameState?.economy?.player?.mana ?? 0) < 500 || (gameState?.playerBase?.health ?? 0) >= (gameState?.playerBase?.maxHealth ?? 200)}
                >
                  💚 Heal Base (+200 HP) - 500 mana
                </button>
              )}

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2"><span>🗼</span><span className="text-sm">Turret Lv.{gameState?.playerBase?.turretLevel ?? 0}</span></div>
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

          {(gameState?.progression?.player?.age ?? 1) < PROGRESSION_CONFIG.maxAge && (
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
              <h3 className="text-sm text-slate-400 mb-4">Evolution State</h3>
              <button
                onClick={handleUpgradeAge}
                className="w-full px-4 py-2 bg-gradient-to-r from-amber-600 to-purple-600 hover:from-amber-700 hover:to-purple-700 text-white rounded font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                disabled={!(gameState?.progression?.player?.ageProgress?.canUpgrade) || (gameState?.economy?.player?.gold ?? 0) < (gameState?.progression?.player?.ageProgress?.costGold ?? 500)}
              >
                ⬆️ Advance to Age {Math.min((gameState?.progression?.player?.age ?? 1) + 1, PROGRESSION_CONFIG.maxAge)}
                <span className="ml-2 text-sm opacity-75">({gameState?.progression?.player?.ageProgress?.costGold ?? 500}g)</span>
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
