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
  calculateTurretDefenseStats,
} from './config/turrets';
import { GameOverOverlay } from './ui/GameOverOverlay';
import { StartScreen, type AISelectionValue, type Difficulty, type MLCheckpointOption, type StartMode } from './ui/StartScreen';
import { UnitTrainingPanel } from './ui/UnitTrainingPanel';
import { UI_EMOTES, UI_SYMBOLS } from './ui/uiEmotes';

type Winner = 'PLAYER' | 'ENEMY';
type AIOwner = 'PLAYER' | 'ENEMY';

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<GameEngine | null>(null);
  const lastAutosaveMsRef = useRef(0);

  const [gameState, setGameState] = useState<any>(null);
  const [gameOver, setGameOver] = useState<{ winner: Winner } | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [difficulty, setDifficulty] = useState<Difficulty>('MEDIUM');
  const [startMode, setStartMode] = useState<StartMode>('PLAY');
  const [activeMode, setActiveMode] = useState<StartMode>('PLAY');
  const [watchPlayerSelection, setWatchPlayerSelection] = useState<AISelectionValue>('SMART');
  const [watchEnemySelection, setWatchEnemySelection] = useState<AISelectionValue>('SMART_ML');
  const [mlCheckpointOptions, setMLCheckpointOptions] = useState<MLCheckpointOption[]>([]);
  const [latestMlCheckpointId, setLatestMlCheckpointId] = useState<string | null>(null);
  const [latestMlCheckpointLabel, setLatestMlCheckpointLabel] = useState<string>('latest');
  const [showAIDebug, setShowAIDebug] = useState(false);
  const [aiDebugBySide, setAIDebugBySide] = useState<Record<AIOwner, any | null>>({
    PLAYER: null,
    ENEMY: null,
  });
  const [shouldLoadSavedGame, setShouldLoadSavedGame] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  const hasSavedGame = GameEngine.hasSavedGame();
  const playerControlledByAI = gameState?.sideControl?.PLAYER?.control === 'AI';
  const debugOwners: AIOwner[] = playerControlledByAI ? ['PLAYER', 'ENEMY'] : ['ENEMY'];

  const parseAISelection = (selection: AISelectionValue): { difficulty: Difficulty; mlCheckpointId?: string } => {
    if (selection.startsWith('SMART_ML::')) {
      return {
        difficulty: 'SMART_ML',
        mlCheckpointId: selection.slice('SMART_ML::'.length),
      };
    }
    return { difficulty: selection as Difficulty };
  };

  const startNewGame = () => {
    if (gameRef.current) {
      gameRef.current.stop();
      gameRef.current = null;
    }
    GameEngine.deleteSavedGame();
    setGameOver(null);
    setGameState(null);
    setShouldLoadSavedGame(false);
    setIsPaused(false);
    setActiveMode('PLAY');
    setIsRunning(true);
  };

  const startWatchGame = () => {
    if (gameRef.current) {
      gameRef.current.stop();
      gameRef.current = null;
    }
    GameEngine.deleteSavedGame();
    setGameOver(null);
    setGameState(null);
    setShouldLoadSavedGame(false);
    setIsPaused(false);
    setActiveMode('WATCH');
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
    setIsPaused(false);
    setIsRunning(true);
  };

  const handleClearSavedGame = () => {
    GameEngine.deleteSavedGame();
    setGameState(null);
    setGameOver(null);
    setIsRunning(false);
    setShouldLoadSavedGame(false);
    setIsPaused(false);
  };

  useEffect(() => {
    let cancelled = false;
    const loadCheckpointRegistry = async () => {
      try {
        const response = await fetch(`/ml/checkpoints/index.json?t=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) return;
        const payload = await response.json();
        if (cancelled) return;
        const options: MLCheckpointOption[] = Array.isArray(payload?.checkpoints)
          ? payload.checkpoints
              .map((checkpoint: any) => {
                const id = typeof checkpoint?.id === 'string' ? checkpoint.id : '';
                const label = typeof checkpoint?.label === 'string' ? checkpoint.label : id;
                if (!id) return null;
                return { id, label } as MLCheckpointOption;
              })
              .filter((item: MLCheckpointOption | null): item is MLCheckpointOption => item !== null)
          : [];
        setMLCheckpointOptions(options);

        const latestId = typeof payload?.latestCheckpointId === 'string' ? payload.latestCheckpointId : '';
        if (latestId) {
          setLatestMlCheckpointId(latestId);
          const latestOption = options.find((option) => option.id === latestId);
          setLatestMlCheckpointLabel(latestOption?.label ?? latestId);
        } else if (options.length > 0) {
          setLatestMlCheckpointId(options[0].id);
          setLatestMlCheckpointLabel(options[0].label);
        } else {
          setLatestMlCheckpointId(null);
          setLatestMlCheckpointLabel('latest');
        }
      } catch {
        if (!cancelled) {
          setMLCheckpointOptions([]);
          setLatestMlCheckpointId(null);
          setLatestMlCheckpointLabel('latest');
        }
      }
    };
    loadCheckpointRegistry();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isRunning || gameRef.current) return;

    const timeout = setTimeout(() => {
      if (!canvasRef.current) {
        setIsRunning(false);
        return;
      }

      const isWatchMode = activeMode === 'WATCH';
      const watchPlayerConfig = parseAISelection(watchPlayerSelection);
      const watchEnemyConfig = parseAISelection(watchEnemySelection);
      const enemyDifficulty = isWatchMode ? watchEnemyConfig.difficulty : difficulty;
      const config = {
        difficulty: enemyDifficulty,
        mode: activeMode,
        startingGold: BASE_CONFIG.startingGold,
        startingMana: BASE_CONFIG.startingMana,
        goldIncomeBase: INCOME_CONFIG.baseGoldPerSecond,
        manaIncomeBase: BASE_CONFIG.baseManaPerSecond,
        laneLength: 50,
        basePositions: { player: 0, enemy: 50 },
        sideControl: isWatchMode
          ? {
              PLAYER: {
                control: 'AI' as const,
                difficulty: watchPlayerConfig.difficulty,
                mlCheckpointId: watchPlayerConfig.mlCheckpointId,
              },
              ENEMY: {
                control: 'AI' as const,
                difficulty: watchEnemyConfig.difficulty,
                mlCheckpointId: watchEnemyConfig.mlCheckpointId,
              },
            }
          : {
              PLAYER: { control: 'HUMAN' as const },
              ENEMY: {
                control: 'AI' as const,
                difficulty,
                mlCheckpointId: difficulty === 'SMART_ML' ? (latestMlCheckpointId ?? undefined) : undefined,
              },
            },
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
          setIsPaused(false);
          game.start();
        })
        .catch(() => {
          setIsRunning(false);
          gameRef.current = null;
        });
    }, 0);

    return () => clearTimeout(timeout);
  }, [activeMode, difficulty, isRunning, latestMlCheckpointId, shouldLoadSavedGame, watchEnemySelection, watchPlayerSelection]);

  useEffect(() => {
    if (!showAIDebug || !gameRef.current || !gameState) return;

    try {
      setAIDebugBySide({
        PLAYER: gameRef.current.getAIController('PLAYER')?.getDebugInfo() ?? null,
        ENEMY: gameRef.current.getAIController('ENEMY')?.getDebugInfo() ?? null,
      });
    } catch {
      setAIDebugBySide({ PLAYER: null, ENEMY: null });
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
    if (playerControlledByAI) return;
    gameRef.current?.spawnUnit(unitId);
  };

  const handleCancelQueueItem = (index: number) => {
    if (playerControlledByAI) return;
    gameRef.current?.cancelQueueItem(index);
  };

  const handleUpgradeAge = () => {
    if (playerControlledByAI) return;
    gameRef.current?.upgradeAge();
  };

  const handleQueueTurretSlotUpgrade = () => {
    if (playerControlledByAI) return;
    gameRef.current?.queueTurretSlotUpgrade();
  };

  const handleQueueTurretEngine = (slotIndex: number, turretId: string) => {
    if (playerControlledByAI) return;
    gameRef.current?.queueTurretEngine('PLAYER', slotIndex, turretId);
  };

  const handleSellTurretEngine = (slotIndex: number) => {
    if (playerControlledByAI) return;
    gameRef.current?.sellTurretEngine('PLAYER', slotIndex);
  };

  const handleUpgradeManaGeneration = () => {
    if (playerControlledByAI) return;
    gameRef.current?.upgradeManaGeneration();
  };

  const handleHealBase = () => {
    if (playerControlledByAI) return;
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
    setIsPaused(false);
  };

  const handleTogglePause = () => {
    if (!gameRef.current || gameOver) return;
    setIsPaused(gameRef.current.togglePause());
  };

  const handleSaveGame = () => {
    if (!gameRef.current) return;

    try {
      gameRef.current.saveGameState();
      alert(`${UI_EMOTES.save} Game saved successfully!`);
    } catch (error) {
      alert(`${UI_EMOTES.error} Failed to save game`);
      console.error('Save error:', error);
    }
  };

  const handleLoadGame = () => {
    if (!gameRef.current) return;

    try {
      const success = gameRef.current.loadGameState();
      if (success) {
        setGameOver(null);
        setIsPaused(gameRef.current.getIsPaused());
        alert(`${UI_EMOTES.load} Game loaded successfully!`);
      } else {
        alert(`${UI_EMOTES.warning} No saved game found`);
      }
    } catch (error) {
      alert(`${UI_EMOTES.error} Failed to load game`);
      console.error('Load error:', error);
    }
  };

  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if ((e.key === 'p' || e.key === 'P' || e.key === ' ') && isRunning && !gameOver) {
        if (e.key === ' ') e.preventDefault();
        handleTogglePause();
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        handleRestart();
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [gameOver, isRunning]);

  if (!isRunning) {
    return (
      <StartScreen
        mode={startMode}
        difficulty={difficulty}
        watchPlayerSelection={watchPlayerSelection}
        watchEnemySelection={watchEnemySelection}
        mlCheckpointOptions={mlCheckpointOptions}
        latestMlCheckpointLabel={latestMlCheckpointLabel}
        hasSavedGame={hasSavedGame}
        onStartNewGame={startNewGame}
        onStartWatchGame={startWatchGame}
        onContinueGame={continueSavedGame}
        onModeChange={setStartMode}
        onDifficultyChange={setDifficulty}
        onWatchPlayerSelectionChange={setWatchPlayerSelection}
        onWatchEnemySelectionChange={setWatchEnemySelection}
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
            {playerControlledByAI && (
              <div className="bg-cyan-700 text-white px-3 py-1 rounded-full text-sm">
                Watch Mode
              </div>
            )}
          </div>
          <div className="flex items-center gap-4">
            <button onClick={() => setAudioEnabled(!audioEnabled)} className="text-slate-400 hover:text-white" title="Toggle audio">
              {audioEnabled ? UI_EMOTES.audioOn : UI_EMOTES.audioOff}
            </button>
            <button
              onClick={handleTogglePause}
              className="px-4 py-2 bg-violet-700 hover:bg-violet-600 text-white rounded font-semibold transition-colors"
              title="Pause/Resume (P or Space)"
            >
              {isPaused ? `${UI_EMOTES.resume} Resume` : `${UI_EMOTES.pause} Pause`}
            </button>
            <button
              onClick={handleSaveGame}
              className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 text-white rounded font-semibold transition-colors"
              title="Save game"
            >
              {UI_EMOTES.save} Save
            </button>
            <button
              onClick={handleLoadGame}
              className="px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white rounded font-semibold transition-colors"
              title="Load game"
            >
              {UI_EMOTES.load} Load
            </button>
            <button
              onClick={handleRestart}
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded font-semibold transition-colors"
              title="Restart game"
            >
              {UI_EMOTES.restart} Restart
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

            {isPaused && !gameOver && (
              <div className="absolute inset-0 bg-black/35 flex items-center justify-center pointer-events-none">
                <div className="px-4 py-2 bg-slate-900/90 border border-slate-600 rounded text-slate-100 font-semibold tracking-wide">
                  PAUSED
                </div>
              </div>
            )}

            {gameOver && <GameOverOverlay winner={gameOver.winner} onPlayAgain={handleRestart} />}
          </div>

          {!playerControlledByAI && (
            <UnitTrainingPanel
              gameState={gameState}
              onSpawnUnit={handleSpawnUnit}
              onQueueTurretEngine={handleQueueTurretEngine}
              onCancelQueueItem={handleCancelQueueItem}
            />
          )}

          <div className="mt-2 text-right">
            <button onClick={() => setShowAIDebug(!showAIDebug)} className="text-xs text-slate-500 hover:text-slate-300 underline">
              {showAIDebug ? 'Hide AI Debug' : 'Show AI Debug'}
            </button>
          </div>

          {showAIDebug && debugOwners.some((owner) => Boolean(aiDebugBySide[owner])) && (
            <div className="mt-2 bg-slate-900 border border-slate-600 rounded p-3 text-[10px] font-mono text-green-400 overflow-hidden">
              <div className="text-[11px] text-slate-300 mb-2">Dual AI Debug (compact)</div>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                {debugOwners.map((owner) => {
                  const aiDebugInfo = aiDebugBySide[owner];
                  const sideEconomy = owner === 'PLAYER' ? gameState?.economy?.player : gameState?.economy?.enemy;
                  const sideProgression = owner === 'PLAYER' ? gameState?.progression?.player : gameState?.progression?.enemy;
                  const sideBase = owner === 'PLAYER' ? gameState?.playerBase : gameState?.enemyBase;
                  const sideTelemetry = gameState?.telemetry?.bySide?.[owner];

                  if (!aiDebugInfo) {
                    return (
                      <div key={owner} className="bg-slate-950/60 border border-slate-700 rounded p-3">
                        <div className="flex items-center justify-between mb-2">
                          <div className="font-bold text-white">{owner}</div>
                          <span className="text-[10px] text-slate-500">No AI controller</span>
                        </div>
                        <div className="text-slate-500">This side is currently human-controlled or has no debug endpoint.</div>
                      </div>
                    );
                  }

                  const threat = aiDebugInfo.threatLevel ?? 'UNKNOWN';
                  const threatClass = threat === 'HIGH' || threat === 'CRITICAL' ? 'text-red-400' : 'text-emerald-300';
                  const decisionStages = Array.isArray(aiDebugInfo.behaviorParams?.decisionStages)
                    ? aiDebugInfo.behaviorParams.decisionStages.slice(-4).reverse()
                    : [];
                  const recentActions = Array.isArray(aiDebugInfo.recentActions)
                    ? aiDebugInfo.recentActions.slice().reverse().slice(0, 5)
                    : [];
                  const contextEntries = Object.entries(aiDebugInfo.behaviorParams?.context ?? {}).slice(0, 8);
                  const unitEntries = Object.entries(sideTelemetry?.unitBuildCounts ?? {})
                    .sort((a: any, b: any) => (b[1] as number) - (a[1] as number))
                    .slice(0, 3);
                  const telemetryActions = Array.isArray(sideTelemetry?.actionTimeline)
                    ? sideTelemetry.actionTimeline.slice(-3).reverse()
                    : [];

                  return (
                    <div key={owner} className="bg-slate-950/60 border border-slate-700 rounded p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="font-bold text-white">{owner}</div>
                        <div className="text-[10px] text-cyan-300">
                          {aiDebugInfo.behaviorParams?.difficulty ?? aiDebugInfo.endpoint ?? 'AI'}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
                        <div className="text-slate-400">Threat: <span className={threatClass}>{threat}</span></div>
                        <div className="text-slate-400">Age: <span className="text-amber-300">{sideProgression?.age ?? 1}</span></div>
                        <div className="text-slate-400">Gold/Mana: <span className="text-yellow-300">{Math.floor(sideEconomy?.gold ?? 0)}</span> / <span className="text-blue-300">{Math.floor(sideEconomy?.mana ?? 0)}</span></div>
                        <div className="text-slate-400">Slots: <span className="text-cyan-300">{sideBase?.turretSlotsUnlocked ?? 1}/{sideBase?.maxTurretSlots ?? 4}</span></div>
                        <div className="text-slate-400">Warchest: <span className="text-emerald-300">{Math.floor(aiDebugInfo.behaviorParams?.warchest ?? aiDebugInfo.warchest ?? 0)}g</span></div>
                        <div className="text-slate-400">Latency: <span className="text-purple-300">{aiDebugInfo.lastEndpointLatencyMs ?? 0}ms</span></div>
                      </div>

                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                        <div className="bg-slate-800/60 border border-slate-700 rounded p-2">
                          <div className="text-slate-300 mb-1">Decision Pipeline</div>
                          <div className="space-y-0.5 max-h-24 overflow-y-auto">
                            {decisionStages.length > 0 ? (
                              decisionStages.map((stage: any, i: number) => (
                                <div key={i} className="text-slate-400 truncate" title={stage.detail}>
                                  {stage.stage} {UI_SYMBOLS.middleDot} {stage.status}{stage.action ? ` ${UI_SYMBOLS.middleDot} ${stage.action}` : ''}
                                </div>
                              ))
                            ) : (
                              <div className="text-slate-600 italic">No pipeline stages emitted yet</div>
                            )}
                          </div>
                        </div>
                        <div className="bg-slate-800/60 border border-slate-700 rounded p-2">
                          <div className="text-slate-300 mb-1">Recent Actions</div>
                          <div className="space-y-0.5 max-h-24 overflow-y-auto">
                            {recentActions.length > 0 ? (
                              recentActions.map((a: string, i: number) => (
                                <div key={i} className="text-slate-400 truncate" title={a}>- {a}</div>
                              ))
                            ) : (
                              <div className="text-slate-600 italic">No non-wait actions in recent history</div>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="bg-slate-800/60 border border-slate-700 rounded p-2">
                        <div className="text-slate-300 mb-1">Context + Next</div>
                        <div className="text-slate-400 mb-1">
                          Goal: <span className="text-emerald-300">{aiDebugInfo.behaviorParams?.activeGoal ?? aiDebugInfo.strategicState ?? 'n/a'}</span>
                          {' '}{UI_SYMBOLS.middleDot} Next: <span className="text-cyan-300">{aiDebugInfo.behaviorParams?.nextAction ?? 'N/A'}</span>
                        </div>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                          {contextEntries.length > 0 ? (
                            contextEntries.map(([key, val]) => (
                              <React.Fragment key={key}>
                                <span className="text-slate-500">{key}</span>
                                <span className="text-slate-300 text-right truncate" title={String(val)}>{String(val)}</span>
                              </React.Fragment>
                            ))
                          ) : (
                            <span className="text-slate-600 col-span-2">No context payload emitted</span>
                          )}
                        </div>
                      </div>

                      {sideTelemetry && (
                        <div className="bg-slate-800/60 border border-slate-700 rounded p-2">
                          <div className="text-slate-300 mb-1">Telemetry</div>
                          <div className="text-slate-400">
                            Age Ups: {sideTelemetry.ageUpTimes?.length ? sideTelemetry.ageUpTimes.map((t: number) => `${t.toFixed(1)}s`).join(', ') : 'none'}
                          </div>
                          <div className="text-slate-400">
                            Units: {unitEntries.length > 0 ? unitEntries.map(([id, count]) => `${id} x${count}`).join(', ') : 'none'}
                          </div>
                          <div className="text-slate-400">
                            Mana Upgrades: {sideTelemetry.manaUpgradeCount ?? 0} | Turret Slots: {sideTelemetry.turretSlotUpgradeCount ?? 0}
                          </div>
                          <div className="mt-1 space-y-0.5">
                            {telemetryActions.length > 0 ? (
                              telemetryActions.map((entry: any, idx: number) => (
                                <div key={idx} className="text-slate-500 truncate">
                                  {entry.gameTime?.toFixed?.(1) ?? '0.0'}s {UI_SYMBOLS.middleDot} {entry.action} {UI_SYMBOLS.middleDot} g{Math.floor(entry.gold ?? 0)} m{Math.floor(entry.mana ?? 0)}
                                </div>
                              ))
                            ) : (
                              <div className="text-slate-600">No action snapshots yet</div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
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
                <div className="flex justify-between"><span>Turret Slots</span><span className="font-bold text-blue-400">{gameState?.playerBase?.turretSlotsUnlocked ?? 1}/{gameState?.playerBase?.maxTurretSlots ?? 4}</span></div>
              </div>
              <div className="border-t border-slate-600 pt-2 mt-2">
                <div className="flex justify-between">
                  <span>Resources</span>
                  <span className="font-bold"><span className="text-yellow-400">{UI_EMOTES.gold} {Math.floor(gameState?.economy?.player?.gold ?? 0)}</span><span className="text-blue-400 ml-2">{UI_EMOTES.mana} {Math.floor(gameState?.economy?.player?.mana ?? 0)}</span></span>
                </div>
                <div className="flex justify-between mt-1 text-slate-500">
                  <span>Income</span>
                  <span><span className="text-yellow-400">+{(gameState?.economy?.player?.goldIncomePerSec ?? 0).toFixed(1)}g/s</span> <span className="text-blue-400">+{(gameState?.economy?.player?.manaIncomePerSec ?? 0).toFixed(1)}m/s</span></span>
                </div>
              </div>
            </div>
            <div className="mt-3 text-xs">
              {(() => {
                const stats =
                  gameState?.playerBase?.turretDefenseStats ??
                  calculateTurretDefenseStats(gameState?.playerBase ?? { turretSlotsUnlocked: 1, turretSlots: [] });
                const protectionPct = Math.round((1 - (stats?.strongestProtectionMultiplier ?? 1)) * 100);
                return (
                  <>
                    <div className="flex justify-between"><span>Damage Dealt</span><span className="font-semibold">{Math.floor(gameState?.stats?.damageDealt?.player ?? 0)} / {Math.floor(gameState?.stats?.damageDealt?.enemy ?? 0)}</span></div>
                    <div className="flex justify-between mt-1"><span>Turret DPS</span><span className="font-semibold">{(stats?.totalDps ?? 0).toFixed(1)}</span></div>
                    <div className="flex justify-between mt-1 text-slate-400"><span>Max Turret Range</span><span className="font-mono">{(stats?.maxRange ?? 0).toFixed(1)}</span></div>
                    <div className="flex justify-between mt-1 text-slate-400"><span>Best Protection Aura</span><span className="font-mono">{protectionPct}%</span></div>
                  </>
                );
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
                const currentConversionLabel = `${toPercent(conversionRate)} gold${UI_SYMBOLS.arrowRight}mana on kills`;
                const nextConversionLabel = `${toPercent(nextConversionRate)} gold${UI_SYMBOLS.arrowRight}mana on kills`;

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
                      disabled={playerControlledByAI || (gameState?.economy?.player?.gold ?? 0) < nextCost}
                    >
                      {UI_EMOTES.mana} Upgrade Mana Pool (Lv.{level}) - {nextCost}g
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
                  disabled={playerControlledByAI || (gameState?.economy?.player?.mana ?? 0) < 500 || (gameState?.playerBase?.health ?? 0) >= (gameState?.playerBase?.maxHealth ?? 200)}
                >
                  {UI_EMOTES.heal} Heal Base (+200 HP) - 500 mana
                </button>
              )}

              {(() => {
                const slotsUnlocked = gameState?.playerBase?.turretSlotsUnlocked ?? 1;
                const maxSlots = gameState?.playerBase?.maxTurretSlots ?? 4;
                const nextSlotCost = gameState?.playerBase?.nextTurretSlotCost ?? 0;
                const slotUpgradeQueued = (gameState?.playerQueue ?? []).some((q: any) => q.kind === 'turret_slot');
                const queueFull = (gameState?.playerQueue?.length ?? 0) >= 5;
                const canUnlock =
                  slotsUnlocked < maxSlots &&
                  nextSlotCost > 0 &&
                  (gameState?.economy?.player?.gold ?? 0) >= nextSlotCost &&
                  !slotUpgradeQueued &&
                  !queueFull;
                const unlockLabel =
                  slotsUnlocked >= maxSlots
                    ? `${UI_EMOTES.unlocked} All turret slots unlocked`
                    : `${UI_EMOTES.unlockSlot} Unlock Slot ${Math.min(slotsUnlocked + 1, maxSlots)} - ${nextSlotCost}g`;

                return (
                  <button
                    onClick={handleQueueTurretSlotUpgrade}
                    className="w-full px-3 py-2 text-sm bg-amber-900 hover:bg-amber-800 border border-amber-700 rounded font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                    disabled={playerControlledByAI || !canUnlock}
                  >
                    {unlockLabel}
                  </button>
                );
              })()}

              <div className="space-y-2 border-t border-slate-600 pt-2 mt-2">
                <div className="text-sm text-slate-300">Mounted Turret Engines</div>
                {(gameState?.playerBase?.turretSlots ?? []).slice(0, gameState?.playerBase?.turretSlotsUnlocked ?? 1).map((slot: any, idx: number) => {
                  const turret = gameState?.turretCatalog?.[slot.turretId ?? ''];
                  return (
                    <div key={idx} className="flex items-center justify-between text-xs bg-slate-700/40 rounded px-2 py-1">
                      <div>
                        <div className="text-slate-300">Slot {idx + 1}</div>
                        <div className="text-slate-400">{turret?.name ?? (slot.turretId ? slot.turretId : 'Empty')}</div>
                      </div>
                      {slot.turretId && !playerControlledByAI ? (
                        <button
                          onClick={() => handleSellTurretEngine(idx)}
                          className="px-2 py-1 text-xs bg-rose-900 hover:bg-rose-800 border border-rose-700 rounded"
                        >
                          Sell
                        </button>
                      ) : (
                        <span className="text-slate-500">-</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {(gameState?.progression?.player?.age ?? 1) < PROGRESSION_CONFIG.maxAge && (
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
              <h3 className="text-sm text-slate-400 mb-4">Evolution State</h3>
              <button
                onClick={handleUpgradeAge}
                className="w-full px-4 py-2 bg-gradient-to-r from-amber-600 to-purple-600 hover:from-amber-700 hover:to-purple-700 text-white rounded font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                disabled={playerControlledByAI || !(gameState?.progression?.player?.ageProgress?.canUpgrade) || (gameState?.economy?.player?.gold ?? 0) < (gameState?.progression?.player?.ageProgress?.costGold ?? 500)}
              >
                {UI_EMOTES.ageUp} Advance to Age {Math.min((gameState?.progression?.player?.age ?? 1) + 1, PROGRESSION_CONFIG.maxAge)}
                <span className="ml-2 text-sm opacity-75">({gameState?.progression?.player?.ageProgress?.costGold ?? 500}g)</span>
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}


