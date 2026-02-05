# Age of War - AI Agent Deployment

A modern, web-based real-time strategy game inspired by the classic "Age of War". This project features a sophisticated AI opponent, unit management, economy progression, and dynamic combat interactions.

## Features

### 🧠 Advanced AI Opponent
- **Modular AI Architecture**: The game features a pluggable AI system driven by `AIController` and specialized behaviors.
- **Adaptive Strategy**: The AI evaluates your army composition and counters it dynamically (e.g., building tanks to soak damage, ranged units to counter melee).
- **Economic Intelligence**: Manages Gold and Mana to balance between immediate unit recruitment, tech upgrades (Age Up), and defensive structures (Turrets).
- **Emergency Logic**: AI enters a high-alert defensive state when under heavy attack, prioritizing survival over expansion.
- **Personalities**: Supports different difficulty levels and playstyles (Balanced, Aggressive, Defensive, Cheater).

### ⚔️ Combat & Units
- **Diverse Roster**: Units across different ages (from Stone Age Clubmen to Future Tech Meks and Robots).
- **Roles**: Frontline (Tanks), Damage Dealers (Ranged/Melee), and Support (Healers/Buffs).
- **Special Abilities**: Units possess unique skills like AoE attacks, Flamethrowers, Healing, and Teleportation.
- **Projectile Physics**: Arcing projectiles, collision detection, and tower mechanics.

### 🏰 Base & Progression
- **Age System**: Evolve through 5 distinct ages, unlocking stronger units and better turrets.
- **Turret Upgrades**: protecting your base with multiple tiers of defensive weaponry.
- **Special Turret Abilities**: 
  - **Chain Lightning**: Zaps multiple enemies.
  - **Artillery Barrage**: Launches a devastating volley of missiles.

### 🎨 Visual Effects
- **Dynamic Particles**: Flamethrowers, explosions, blood splatters, and magic effects.
- **Atmospheric Rendering**: Age-specific backgrounds and base visuals.

## Getting Started

### Prerequisites
- Node.js (v18 or higher recommended)
- npm (Node Package Manager)

### Installation

1. Clone the repository:
   ```bash
   git clone git@github.com:Krarilotus/AgeOfTrashcan.git
   cd AgeOfTrashcan
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

### Development

Start the development server with Hot Module Replacement (HMR):
```bash
npm run dev
```
Open your browser to the URL shown in the terminal (usually `http://localhost:5173`).

### Building for Production

Compile TypeScript and build optimized assets:
```bash
npm run build
```
The output will be in the `dist/` directory, ready for deployment.

## Project Structure

- `src/core/`: Main game loop, random number generation, and world state management.
- `src/systems/`: ECS-style systems for Rendering, Logic, Physics, Economy, and AI.
- `src/ai/`: Brain of the enemy, containing behaviors (`BalancedAI`) and decision logic.
- `src/config/`: Game balance configuration (Units, Turrets, Economy).
- `src/assets/`: Unit sprites and game assets.

## Controls

- **Mouse**: Click unit buttons to spawn troops.
- **Hotkeys**: 
  - `F5`: Reload/Reset the game.
  - UI allows upgrading Age, Turret, and Mana.

## License

Private Project. All rights reserved.
