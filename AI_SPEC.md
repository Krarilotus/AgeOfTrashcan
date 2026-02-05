# AI Specification: Age of War

## Core Philosophy
The AI is designed to provide a "fair" but challenging opponent that scales with difficulty. It simulates a human player's decision-making process, balancing economy (Aging Up) with military pressure (Unit Recruitment) and defense.

## 1. Economy & Warchest System
The AI uses a **Warchest** system to ensure consistent progression through Ages. This reserve is "sacrosanct" and is generally not touched for unit recruitment unless in an emergency.

### Warchest Accumulation
The AI reserves gold based on the time spent in the current age. This ensures that even if under pressure, the AI will eventually accumulate enough gold to age up.

**Formula:**
```
Warchest = (Time Since Last Age Up) × Difficulty Multiplier × Current Age
```

**Difficulty Multipliers:**
- **Easy:** 1.0
- **Medium:** 1.5
- **Hard:** 2.0
- **Cheater:** 3.0

### Spending Rules
- **Aging Up:** Consumes the Warchest + any available gold.
- **Recruitment / Upgrades:** Can ONLY spend `Total Gold - Warchest`. The Warchest is strictly protected.

## 2. Emergency Defense Mechanic
When the AI is in danger of losing, it switches to a "Desperate Defense" mode.

**Trigger Conditions:**
- **Base Health:** < 25%
- **Under Attack:** Received damage within the last 2 seconds.

**Emergency Behavior:**
1. **Queue Constraint:** The AI restricts its build queue to **maximum 1 unit** to avoid clogging the pipeline with cheap units that won't arrive in time.
2. **Unit Selection:** Ignores "counters" or "cost-efficiency". Instead, it selects the **Strongest Possible Unit** (highest combat stats) that can be afforded immediately.
3. **Spending:** In emergency mode, the Warchest protection is overridden. The AI will spend whatever it takes to survive.

## 3. Difficulty Tuning
| Feature | Easy | Medium | Hard | Cheater |
|---------|------|--------|------|---------|
| Warchest Mult | 1.0 | 1.5 | 2.0 | 3.0 |
| Income | 100% | 120% | 150% | 200% | (Defined in GameBalance)
| Reaction Time | Slow | Normal | Fast | Instant |

## 4. Future Roadmap
- **Dynamic Personality States:** AI should shift between `Defensive` (turtling), `Aggressive` (hard pushing), and `Balanced` states randomly or reactively.
- **Long-term Planning:** Analyzing unit compositions to send waves that can survive enemy turrets.
- **Unit Purpose:** verifying that recruited units can actually reach the enemy base alive (calculating HP vs Turret DPS).
