import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const rootDir = process.cwd();
const turretsPath = path.join(rootDir, 'src', 'config', 'turrets.ts');
const source = fs.readFileSync(turretsPath, 'utf8');

const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
  },
});

const moduleShim = { exports: {} };
const context = {
  module: moduleShim,
  exports: moduleShim.exports,
  require: () => ({}),
  console,
};
vm.runInNewContext(transpiled.outputText, context, { filename: 'turrets.js' });

const { TURRET_ENGINES, estimateEngineDps } = moduleShim.exports;

function singleTargetBaselineDps(engine) {
  if (engine.attackType === 'projectile' && engine.projectile) {
    return engine.projectile.damage / Math.max(engine.fireIntervalSec, 0.1);
  }
  if (engine.attackType === 'chain_lightning' && engine.chainLightning) {
    return engine.chainLightning.initialDamage / Math.max(engine.chainLightning.cooldownSeconds, 0.1);
  }
  if (engine.attackType === 'artillery_barrage' && engine.artillery) {
    return engine.artillery.shellDamage / Math.max(engine.artillery.cooldownSeconds, 0.1);
  }
  if (engine.attackType === 'oil_pour' && engine.oil) {
    return engine.oil.damage / Math.max(engine.oil.cooldownSeconds, 0.1);
  }
  if (engine.attackType === 'drone_swarm' && engine.drones) {
    return engine.drones.droneDamage / Math.max(engine.drones.cooldownSeconds, 0.1);
  }
  return 0;
}

function targetEfficiency(age) {
  // Progressive target curve: late ages should carry better gold efficiency.
  return 4.9 + age * 0.55;
}

const rows = Object.values(TURRET_ENGINES)
  .map((engine) => {
    const dps = estimateEngineDps(engine);
    const baseline = Math.max(0.01, singleTargetBaselineDps(engine));
    const abilityImpact = dps / baseline;
    const dpsPer100Gold = (dps / Math.max(1, engine.cost)) * 100;
    const target = targetEfficiency(engine.age);
    const efficiencyGap = dpsPer100Gold - target;
    return {
      id: engine.id,
      name: engine.name,
      age: engine.age,
      cost: engine.cost,
      range: engine.range,
      dps,
      dpsPer100Gold,
      baseline,
      abilityImpact,
      target,
      efficiencyGap,
    };
  })
  .sort((a, b) => (a.age - b.age) || (a.cost - b.cost));

console.log('id,age,cost,range,dps,dpsPer100g,baselineDps,abilityImpact,targetEff,gap');
for (const r of rows) {
  console.log(
    [
      r.id,
      r.age,
      r.cost,
      r.range,
      r.dps.toFixed(2),
      r.dpsPer100Gold.toFixed(2),
      r.baseline.toFixed(2),
      r.abilityImpact.toFixed(2),
      r.target.toFixed(2),
      r.efficiencyGap.toFixed(2),
    ].join(',')
  );
}

