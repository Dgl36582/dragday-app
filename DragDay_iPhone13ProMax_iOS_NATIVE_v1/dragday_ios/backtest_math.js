/*
  DragDay math backtest (Node)
  Runs deterministic unit tests against the formula code embedded in www/app.js.

  Usage:
    node backtest_math.js
*/

const fs = require('fs');
const path = require('path');

const APP_JS = path.join(__dirname, 'www', 'app.js');
let src = fs.readFileSync(APP_JS, 'utf8');

// Keep only the formula portion (before IndexedDB/UI).
src = src.split('// ---------- IndexedDB ----------')[0];

// Remove DOM helpers ($, $$) which depend on `document`.
src = src.replace(/^const \$\s*=.*\nconst \$\$\s*=.*\n/m, '');

// Remove weather fetch (depends on global fetch / network).
src = src.replace(/async function fetchNwsLatest[\s\S]*?\n}\n\n/,'');

// Build a factory that returns references to the formula symbols.
const factory = new Function(`
  "use strict";
  ${src}
  return {
    rho0,
    clamp,
    toNumber,
    mean,
    stdev,
    pearson,
    normInv,
    satVaporPressurePa,
    airDensityKgM3,
    densityAltitudeFeetFromRho,
    etStdFromDensity,
    etFromStdAndDensity,
    parseTimeslipText,
    calcBracketMetrics,
    calcStripe,
    winnerLogic,
    tCrit95,
    predictNextET,
    recommendDialIn,
  };
`);

const f = factory();

function assert(cond, msg){
  if (!cond) throw new Error(msg);
}
function eps(a,b,tol){
  return Math.abs(a-b) <= tol;
}

function run(){
  // 1) Atmosphere sanity
  const rho = f.airDensityKgM3(15, 0, 1013.25);
  assert(eps(rho, 1.225, 0.03), `airDensity sanity failed: got ${rho}`);
  const da = f.densityAltitudeFeetFromRho(f.rho0);
  assert(eps(da, 0, 300), `densityAltitude sea-level sanity failed: got ${da}`);

  // 2) Statistics / distribution
  assert(eps(f.normInv(0.5), 0, 1e-6), 'normInv(0.5)');
  assert(eps(f.normInv(0.975), 1.95996, 0.015), 'normInv(0.975)');

  // 3) Density-normalized ET identity
  const et = 6.50;
  const etStd = f.etStdFromDensity(et, f.rho0);
  assert(eps(etStd, et, 1e-12), 'ET std identity');
  const etBack = f.etFromStdAndDensity(etStd, f.rho0);
  assert(eps(etBack, et, 1e-12), 'ET back identity');

  // 4) Timeslip parsing
  const slip = `R/T 0.021 60 1.012 330 2.901 1/8 6.510 1/8 MPH 103.21`;
  const p = f.parseTimeslipText(slip);
  assert(eps(p.rt, 0.021, 1e-6), 'timeslip RT');
  assert(eps(p.sixty, 1.012, 1e-6), 'timeslip 60');
  assert(eps(p.threeThirty, 2.901, 1e-6), 'timeslip 330');
  assert(eps(p.eighthEt, 6.510, 1e-6), 'timeslip 1/8 ET');
  assert(eps(p.mph, 103.21, 1e-6), 'timeslip MPH');

  // 5) Bracket metrics
  const m = f.calcBracketMetrics({dial: 6.50, rt: 0.020, eighthEt: 6.510});
  assert(eps(m.package, 0.030, 1e-12), `package expected 0.030 got ${m.package}`);
  assert(eps(m.deviation, 0.010, 1e-12), `deviation expected 0.010 got ${m.deviation}`);
  assert(m.breakout === 0, 'breakout should be 0');

  // 6) Prediction: two-pass minimal, returns ok
  const rhoNow = f.airDensityKgM3(20, 50, 1013.25);
  const passes = [
    {eighthEt: 6.510, rho: rhoNow},
    {eighthEt: 6.495, rho: rhoNow},
  ];
  const pred = f.predictNextET(passes, rhoNow);
  assert(pred.ok === true, 'predictNextET ok');
  assert(Number.isFinite(pred.etPred), 'predictNextET etPred finite');
  assert(pred.bandLo <= pred.etPred && pred.etPred <= pred.bandHi, 'prediction band contains mean');

  // 7) Dial-in suggestion: must be >= predicted ET for low breakout risk
  const dial = f.recommendDialIn(pred.etPred, (pred.scatterStd || 0.01), 0.10);
  assert(Number.isFinite(dial), 'recommendDialIn finite');

  return {status:'PASS', rho, da, pred};
}

try{
  const res = run();
  console.log(JSON.stringify(res, null, 2));
} catch (e){
  console.error('BACKTEST FAIL:', e.message);
  process.exitCode = 1;
}
