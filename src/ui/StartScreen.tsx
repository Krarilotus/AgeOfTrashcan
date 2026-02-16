import React from 'react';

import { UI_SYMBOLS } from './uiEmotes';

export type Difficulty = 'EASY' | 'MEDIUM' | 'HARD' | 'SMART' | 'SMART_ML' | 'CHEATER';
export type AISelectionValue = Difficulty | `SMART_ML::${string}`;
export type StartMode = 'PLAY' | 'WATCH';

export interface MLCheckpointOption {
  id: string;
  label: string;
}

export interface MLFeaturedAgentOption {
  alias: string;
  id: string;
  label: string;
}

interface StartScreenProps {
  mode: StartMode;
  difficulty: Difficulty;
  playSmartMlSelection: AISelectionValue;
  watchPlayerSelection: AISelectionValue;
  watchEnemySelection: AISelectionValue;
  mlFeaturedOptions: MLFeaturedAgentOption[];
  mlCheckpointOptions: MLCheckpointOption[];
  latestMlCheckpointLabel: string;
  hasSavedGame: boolean;
  onStartNewGame: () => void;
  onStartWatchGame: () => void;
  onContinueGame: () => void;
  onModeChange: (mode: StartMode) => void;
  onDifficultyChange: (difficulty: Difficulty) => void;
  onPlaySmartMlSelectionChange: (selection: AISelectionValue) => void;
  onWatchPlayerSelectionChange: (selection: AISelectionValue) => void;
  onWatchEnemySelectionChange: (selection: AISelectionValue) => void;
  onClearSavedGame: () => void;
}

export function StartScreen({
  mode,
  difficulty,
  playSmartMlSelection,
  watchPlayerSelection,
  watchEnemySelection,
  mlFeaturedOptions,
  mlCheckpointOptions,
  latestMlCheckpointLabel,
  hasSavedGame,
  onStartNewGame,
  onStartWatchGame,
  onContinueGame,
  onModeChange,
  onDifficultyChange,
  onPlaySmartMlSelectionChange,
  onWatchPlayerSelectionChange,
  onWatchEnemySelectionChange,
  onClearSavedGame,
}: StartScreenProps) {
  const allDifficulties = ['EASY', 'MEDIUM', 'HARD', 'SMART', 'SMART_ML', 'CHEATER'] as const;
  const watchBaseDifficulties = allDifficulties.filter((diff) => diff !== 'SMART_ML');
  const mlSelectionOptionsRaw: Array<{ value: AISelectionValue; label: string }> = [
    { value: 'SMART_ML', label: `SMART_ML (latest: ${latestMlCheckpointLabel})` },
    ...mlFeaturedOptions.map((option) => ({
      value: `SMART_ML::${option.id}` as AISelectionValue,
      label: option.label,
    })),
    ...mlCheckpointOptions.map((option) => ({
      value: `SMART_ML::${option.id}` as AISelectionValue,
      label: `SMART_ML ${UI_SYMBOLS.arrowRight} ${option.label}`,
    })),
  ];
  const mlSelectionOptions = mlSelectionOptionsRaw.filter(
    (option, index) => mlSelectionOptionsRaw.findIndex((candidate) => candidate.value === option.value) === index
  );

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center gap-6 p-8">
      <div className="text-4xl font-bold bg-gradient-to-r from-amber-400 via-purple-400 to-cyan-400 bg-clip-text text-transparent">
        Age of War: Transcended
      </div>
      <div className="text-slate-400 text-center max-w-lg">
        Command armies across 6 ages of warfare. From Stone Age clubmen to futuristic mechs.
        <br />
        <br />
        <span className="text-sm">Spawn units {UI_SYMBOLS.bullet} Upgrade your base {UI_SYMBOLS.bullet} Advance through ages {UI_SYMBOLS.bullet} Destroy the enemy</span>
      </div>

      <div className="bg-slate-800 border border-slate-700 rounded-lg p-6 w-full max-w-md">
        <div className="text-lg font-semibold mb-4 text-center">Choose Mode</div>
        <div className="grid grid-cols-2 gap-3 mb-5">
          <button
            onClick={() => onModeChange('PLAY')}
            className={`px-4 py-3 rounded-lg font-semibold transition-all ${
              mode === 'PLAY'
                ? 'bg-gradient-to-r from-amber-500 to-purple-500 text-white'
                : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
            }`}
          >
            Play Game
          </button>
          <button
            onClick={() => onModeChange('WATCH')}
            className={`px-4 py-3 rounded-lg font-semibold transition-all ${
              mode === 'WATCH'
                ? 'bg-gradient-to-r from-cyan-500 to-blue-600 text-white'
                : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
            }`}
          >
            Watch Game
          </button>
        </div>

        {mode === 'PLAY' && (
          <>
            <div className="text-lg font-semibold mb-4 text-center">Select Enemy Difficulty</div>
            <div className="grid grid-cols-3 gap-3">
              {allDifficulties.map((diff) => (
                <button
                  key={diff}
                  onClick={() => onDifficultyChange(diff)}
                  className={`px-4 py-3 rounded-lg font-semibold transition-all ${
                    difficulty === diff
                      ? 'bg-gradient-to-r from-amber-500 to-purple-500 text-white'
                      : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
                  }`}
                >
                  {diff === 'EASY' && 'Easy'}
                  {diff === 'MEDIUM' && 'Medium'}
                  {diff === 'HARD' && 'Hard'}
                  {diff === 'SMART' && 'Smart'}
                  {diff === 'SMART_ML' && 'Smart ML'}
                  {diff === 'CHEATER' && 'Cheater'}
                </button>
              ))}
            </div>
            <div className="mt-4 text-sm text-slate-400 text-center">
              {difficulty === 'EASY' && 'Basic reactive AI with no discounts.'}
              {difficulty === 'MEDIUM' && 'Balanced AI with moderate discounts and income.'}
              {difficulty === 'HARD' && 'Balanced AI with stronger economy and discounts.'}
              {difficulty === 'SMART' && 'Hierarchical planner AI with proactive wave + turret strategy.'}
              {difficulty === 'SMART_ML' && `Smart economy profile with modular ML-ready AI endpoint (latest: ${latestMlCheckpointLabel}).`}
              {difficulty === 'CHEATER' && 'Ruthless AI with extreme economy and pressure.'}
            </div>
            {difficulty === 'SMART_ML' && (
              <div className="mt-4">
                <div className="text-sm text-slate-400 mb-1">Smart ML Enemy Variant</div>
                <select
                  value={playSmartMlSelection}
                  onChange={(event) => onPlaySmartMlSelectionChange(event.target.value as AISelectionValue)}
                  className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-slate-100"
                >
                  {mlSelectionOptions.map((option) => (
                    <option key={`play-${option.value}`} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </>
        )}

        {mode === 'WATCH' && (
          <div className="space-y-4">
            <div className="text-lg font-semibold text-center">Select AI Matchup</div>
            <div>
              <div className="text-sm text-slate-400 mb-1">Left Side AI (Player Base)</div>
              <select
                value={watchPlayerSelection}
                onChange={(event) => onWatchPlayerSelectionChange(event.target.value as AISelectionValue)}
                className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-slate-100"
              >
                {watchBaseDifficulties.map((diff) => (
                  <option key={`left-${diff}`} value={diff}>
                    {diff}
                  </option>
                ))}
                {mlSelectionOptions.map((option) => (
                  <option key={`left-ml-${option.value}`} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div className="text-sm text-slate-400 mb-1">Right Side AI (Enemy Base)</div>
              <select
                value={watchEnemySelection}
                onChange={(event) => onWatchEnemySelectionChange(event.target.value as AISelectionValue)}
                className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-slate-100"
              >
                {watchBaseDifficulties.map((diff) => (
                  <option key={`right-${diff}`} value={diff}>
                    {diff}
                  </option>
                ))}
                {mlSelectionOptions.map((option) => (
                  <option key={`right-ml-${option.value}`} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="text-sm text-slate-400 text-center">
              Watch AI vs AI with side-specific economy and discount benefits.
            </div>
          </div>
        )}
      </div>

      {mode === 'PLAY' && (
        <button
          onClick={onStartNewGame}
          className="mt-2 bg-gradient-to-r from-amber-500 to-purple-500 hover:from-amber-600 hover:to-purple-600 text-white text-lg px-8 py-4 rounded-lg font-semibold transition-all"
        >
          Play New Game
        </button>
      )}

      {mode === 'WATCH' && (
        <button
          onClick={onStartWatchGame}
          className="mt-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-600 hover:to-blue-700 text-white text-lg px-8 py-4 rounded-lg font-semibold transition-all"
        >
          Watch AI Match
        </button>
      )}

      {hasSavedGame && (
        <>
          <button
            onClick={onContinueGame}
            className="bg-blue-700 hover:bg-blue-600 text-white text-lg px-8 py-3 rounded-lg font-semibold transition-all"
          >
            Continue Saved Game
          </button>
          <button
            onClick={onClearSavedGame}
            className="bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm px-4 py-2 rounded-lg transition-all"
          >
            Clear Saved Game
          </button>
        </>
      )}
    </div>
  );
}
