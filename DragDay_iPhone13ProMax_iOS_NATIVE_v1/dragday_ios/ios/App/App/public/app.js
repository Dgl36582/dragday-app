/**
 * DragDay PWA (iPhone-friendly)
 * Offline-first race-day logger for 1/8-mile bracket racing.
 * Data stays on-device (IndexedDB).
 */

// ---------- Utilities ----------
const $ = (sel, el=document) => el.querySelector(sel);
const $$ = (sel, el=document) => Array.from(el.querySelectorAll(sel));

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}
function clamp(x, a, b){ return Math.max(a, Math.min(b, x)); }
function toNumber(v){
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function fmt(n, d=3){
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  return n.toFixed(d);
}
function mean(arr){
  const xs = arr.filter(x => Number.isFinite(x));
  if (!xs.length) return null;
  return xs.reduce((a,b)=>a+b,0)/xs.length;
}
function stdev(arr){
  const xs = arr.filter(x => Number.isFinite(x));
  const n = xs.length;
  if (n < 2) return null;
  const m = mean(xs);
  const v = xs.reduce((a,b)=>a+(b-m)*(b-m),0)/(n-1);
  return Math.sqrt(v);
}
function pearson(x, y){
  const pairs = [];
  for (let i=0;i<Math.min(x.length,y.length);i++){
    if (Number.isFinite(x[i]) && Number.isFinite(y[i])) pairs.push([x[i], y[i]]);
  }
  if (pairs.length < 3) return null;
  const xs = pairs.map(p=>p[0]); const ys = pairs.map(p=>p[1]);
  const mx = mean(xs), my = mean(ys);
  const sx = stdev(xs), sy = stdev(ys);
  if (!sx || !sy) return null;
  let cov = 0;
  for (const [a,b] of pairs) cov += (a-mx)*(b-my);
  cov /= (pairs.length-1);
  return cov/(sx*sy);
}

// Normal inverse CDF (Acklam approx).
function normInv(p){
  p = clamp(p, 1e-12, 1-1e-12);
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.3577518672690, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q, r;
  if (p < plow){
    q = Math.sqrt(-2*Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  if (p > phigh){
    q = Math.sqrt(-2*Math.log(1-p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
            ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  q = p - 0.5;
  r = q*q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
         (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}

// ---------- Weather + Atmosphere ----------
const Rd = 287.05;
const Rv = 461.495;
const rho0 = 1.225;

function satVaporPressurePa(Tc){
  const es_hPa = 6.112 * Math.exp((17.67*Tc)/(Tc+243.5));
  return es_hPa * 100.0;
}
function airDensityKgM3(Tc, rhPct, p_hPa){
  const T = Tc + 273.15;
  const p = (p_hPa ?? 1013.25) * 100.0;
  const rh = clamp((rhPct ?? 50)/100.0, 0, 1);
  const pv = rh * satVaporPressurePa(Tc);
  const pd = p - pv;
  return pd/(Rd*T) + pv/(Rv*T);
}
function densityAltitudeFeetFromRho(rho){
  // ISA troposphere approximation using density ratio sigma = rho/rho0.
  // Mirrors standard ISA relationships (see README citations).
  if (!Number.isFinite(rho) || rho <= 0) return null;
  const T0 = 288.15;
  const L = 0.0065;
  const g = 9.80665;
  const n = (g/(Rd*L)) - 1; // exponent denominator
  const sigma = rho / rho0;
  const h_m = (T0/L) * (1 - Math.pow(sigma, 1/n));
  return h_m / 0.3048; // feet
}
function etStdFromDensity(et, rho){
  if (!Number.isFinite(et) || !Number.isFinite(rho) || rho <= 0) return null;
  return et * Math.pow(rho/rho0, 1/3);
}
function etFromStdAndDensity(etStd, rho){
  if (!Number.isFinite(etStd) || !Number.isFinite(rho) || rho <= 0) return null;
  return etStd / Math.pow(rho/rho0, 1/3);
}

async function fetchNwsLatest(lat, lon){
  const base = 'https://api.weather.gov';
  const pt = await fetch(`${base}/points/${lat},${lon}`, {headers:{'Accept':'application/geo+json'}});
  if (!pt.ok) throw new Error(`NWS points error: ${pt.status}`);
  const ptJson = await pt.json();
  const obsStationsUrl = ptJson.properties?.observationStations;
  if (!obsStationsUrl) throw new Error('NWS points: no observationStations');
  const stationsResp = await fetch(obsStationsUrl, {headers:{'Accept':'application/geo+json'}});
  if (!stationsResp.ok) throw new Error(`Stations error: ${stationsResp.status}`);
  const stationsJson = await stationsResp.json();
  const stationId = stationsJson.features?.[0]?.properties?.stationIdentifier;
  if (!stationId) throw new Error('No station found nearby');
  const obsResp = await fetch(`${base}/stations/${stationId}/observations/latest`, {headers:{'Accept':'application/geo+json'}});
  if (!obsResp.ok) throw new Error(`Observations error: ${obsResp.status}`);
  const obsJson = await obsResp.json();
  const p = obsJson.properties || {};
  const Tc = p.temperature?.value;
  const rh = p.relativeHumidity?.value;
  const windSpeedMs = p.windSpeed?.value;
  const windDir = p.windDirection?.value;
  let pPa = p.barometricPressure?.value;
  if (!pPa && p.seaLevelPressure?.value) pPa = p.seaLevelPressure.value;
  const p_hPa = pPa ? (pPa/100.0) : null;
  return {
    source: `NWS ${stationId}`,
    Tc: (Tc!==null && Tc!==undefined) ? Tc : null,
    rh: (rh!==null && rh!==undefined) ? rh : null,
    p_hPa,
    windSpeedMs: (windSpeedMs!==null && windSpeedMs!==undefined) ? windSpeedMs : null,
    windDir: (windDir!==null && windDir!==undefined) ? windDir : null,
    timestamp: p.timestamp || null,
  };
}

// ---------- Timeslip parsing ----------
function parseTimeslipText(text){
  const t = (text||'').replace(/\s+/g,' ').toUpperCase();
  const out = {};
  const find = (labelRegex, valRegex=/(-?\d+\.\d+|-?\d+)/) => {
    const m = t.match(new RegExp(labelRegex.source + "\\s*[:=]?\\s*" + valRegex.source));
    if (!m) return null;
    return toNumber(m[1]);
  };
  out.rt = find(/(?:R\/T|RT)\b/);
  out.sixty = find(/(?:\b60\b|60')/);
  out.threeThirty = find(/\b330\b/);
  out.eighthEt = find(/(?:\b660\b|1\/8(?:\s*ET)?\b)/);
  out.mph = find(/(?:\bMPH\b|1\/8\s*MPH\b)/);

  const nums = (text||'').match(/-?\d+\.\d+|-?\d+/g)?.map(toNumber)?.filter(n=>Number.isFinite(n)) || [];
  if (!Number.isFinite(out.rt) && nums.length>=1) out.rt = nums[0];
  if (!Number.isFinite(out.sixty) && nums.length>=2) out.sixty = nums[1];
  if (!Number.isFinite(out.threeThirty) && nums.length>=3) out.threeThirty = nums[2];
  if (!Number.isFinite(out.eighthEt) && nums.length>=4) out.eighthEt = nums[3];
  if (!Number.isFinite(out.mph) && nums.length>=5) out.mph = nums[4];
  return out;
}

// ---------- Bracket calculations ----------
function calcBracketMetrics(me){
  const dial = toNumber(me.dial);
  const rt = toNumber(me.rt);
  const et = toNumber(me.eighthEt);
  const out = { dial, rt, et, deviation:null, breakout:null, package:null };
  if (Number.isFinite(dial) && Number.isFinite(et)){
    out.deviation = et - dial;
    out.breakout = Math.max(0, dial - et);
  }
  if (Number.isFinite(rt) && Number.isFinite(et) && Number.isFinite(dial)){
    out.package = rt + (et - dial);
  }
  return out;
}
function calcStripe(me, opp){
  const Dme = toNumber(me.dial), Rme = toNumber(me.rt), Eme = toNumber(me.eighthEt);
  const Dop = toNumber(opp.dial), Rop = toNumber(opp.rt), Eop = toNumber(opp.eighthEt);
  if (![Dme,Rme,Eme,Dop,Rop,Eop].every(Number.isFinite)) return null;
  const Dslow = Math.max(Dme, Dop);
  const finishMe = (Dslow - Dme) + Rme + Eme;
  const finishOpp = (Dslow - Dop) + Rop + Eop;
  const movSeconds = Math.abs(finishMe - finishOpp);
  let movInches = null;
  const mphBehind = toNumber(me.mphBehind ?? null);
  if (Number.isFinite(mphBehind)) movInches = 17.6 * mphBehind * movSeconds;
  return {finishMe, finishOpp, movSeconds, movInches};
}
function winnerLogic(me, opp){
  const mr = !!me.redLight, or = !!opp.redLight;
  const mrl = toNumber(me.redAmount), orl = toNumber(opp.redAmount);
  const mbo = toNumber(me.breakout), obo = toNumber(opp.breakout);
  if (mr && !or) return {winner:'opponent', reason:'You red-lit'};
  if (!mr && or) return {winner:'you', reason:'Opponent red-lit'};
  if (mr && or){
    if (Number.isFinite(mrl) && Number.isFinite(orl)){
      if (mrl > orl) return {winner:'opponent', reason:'Both red; your red was worse'};
      if (orl > mrl) return {winner:'you', reason:'Both red; opponent red was worse'};
    }
    return {winner:'tie', reason:'Both red'};
  }
  const mb = Number.isFinite(mbo) && mbo>0;
  const ob = Number.isFinite(obo) && obo>0;
  if (mb && !ob) return {winner:'opponent', reason:'You broke out'};
  if (!mb && ob) return {winner:'you', reason:'Opponent broke out'};
  if (mb && ob){
    if (mbo < obo) return {winner:'you', reason:'Both broke out; you broke out less'};
    if (obo < mbo) return {winner:'opponent', reason:'Both broke out; opponent broke out less'};
    return {winner:'tie', reason:'Double breakout tie'};
  }
  const stripe = calcStripe(me, opp);
  if (!stripe) return {winner:'unknown', reason:'Need dial/RT/ET on both'};
  if (stripe.finishMe < stripe.finishOpp) return {winner:'you', reason:'You reached stripe first'};
  if (stripe.finishOpp < stripe.finishMe) return {winner:'opponent', reason:'Opponent reached stripe first'};
  return {winner:'tie', reason:'Exact tie'};
}

// ---------- Prediction ----------
function tCrit95(df){
  // 95% two-sided t critical values (approx). Used when sample count is small.
  const table = {1:12.706, 2:4.303, 3:3.182, 4:2.776, 5:2.571, 6:2.447, 7:2.365, 8:2.306, 9:2.262, 10:2.228};
  return table[df] ?? 1.96;
}

function predictNextET(passes, rhoNext){
  // Uses density-normalized ET (ET_std) and a conservative short-window predictor.
  // Steps:
  // 1) Compute ET_std for passes with ET + rho
  // 2) Keep last k passes (k<=6)
  // 3) Baseline = mean of first k-1 (older) passes in that window
  // 4) Predicted ET_std = w_recent*last + (1-w_recent)*baseline
  // 5) Scatter from residuals vs baseline, and 95% band (t-crit for small n)

  const usable = passes.map(p=>{
    const et = toNumber(p.eighthEt);
    const rho = toNumber(p.rho);
    const etStd = (Number.isFinite(et) && Number.isFinite(rho)) ? etStdFromDensity(et, rho) : null;
    return {...p, et, rho, etStd};
  }).filter(p=>Number.isFinite(p.etStd));

  if (usable.length < 2) return {ok:false, message:'Need at least 2 passes with ET + weather (temp/RH/pressure).'};
  const k = Math.min(6, usable.length);
  const win = usable.slice(-k);
  const last = win[win.length-1].etStd;

  const baseline = mean(win.slice(0, -1).map(p=>p.etStd)) ?? last;
  const w_recent = 0.60;
  const etStdPred = w_recent*last + (1-w_recent)*baseline;

  const residuals = win.map(p => p.etStd - baseline);
  const sigmaStd = stdev(residuals) ?? 0;

  const df = Math.max(1, residuals.length - 1);
  const t = tCrit95(df);

  const rhoUse = Number.isFinite(rhoNext) ? rhoNext : win[win.length-1].rho;
  const etPred = etFromStdAndDensity(etStdPred, rhoUse);
  const bandLo = etFromStdAndDensity(etStdPred - t*sigmaStd, rhoUse);
  const bandHi = etFromStdAndDensity(etStdPred + t*sigmaStd, rhoUse);

  return {ok:true, etStdPred, etPred, bandLo, bandHi, rhoUsed: rhoUse, n: win.length, scatterStd: sigmaStd};
}
function recommendDialIn(etPred, sigmaEt, breakoutRisk){
  if (!Number.isFinite(etPred) || !Number.isFinite(sigmaEt) || sigmaEt<=0) return null;
  const p = clamp(breakoutRisk, 1e-6, 0.499999);
  const z = normInv(p);
  return etPred + z*sigmaEt;
}

// ---------- IndexedDB ----------
const DB_NAME = 'dragday-db';
const DB_VERSION = 1;

function openDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', {keyPath:'id'});
      if (!db.objectStoreNames.contains('raceDays')) db.createObjectStore('raceDays', {keyPath:'id'});
      if (!db.objectStoreNames.contains('passes')) {
        const st = db.createObjectStore('passes', {keyPath:'id'});
        st.createIndex('byRaceDay', 'raceDayId', {unique:false});
      }
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', {keyPath:'id'});
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetAll(store){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(store, obj){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(obj);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}
async function idbDelete(store, key){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(store, key){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function idbGetPassesByRaceDay(raceDayId){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('passes', 'readonly');
    const idx = tx.objectStore('passes').index('byRaceDay');
    const req = idx.getAll(raceDayId);
    req.onsuccess = () => resolve((req.result || []).sort((a,b)=> (a.runNo||0)-(b.runNo||0)));
    req.onerror = () => reject(req.error);
  });
}

// ---------- State ----------
const state = {
  tab: 'Race Day',
  tracks: [],
  raceDays: [],
  currentRaceDayId: null,
  currentTrackId: null,
  passes: [],
  lastMessage: null,
  bracketOutHtml: ''
};
const TABS = ['Race Day', 'Enter Pass', 'Runs Table', 'Bracket', 'Analysis', 'Export/Backup'];
// ---------- Default Tracks (preloaded) ----------
// You can edit/delete these in the app. Coordinates are prefilled from public sources.
const DEFAULT_TRACKS = [
  {name: 'Gulfport Dragway', lat: 30.4028, lon: -89.1230},
  {name: 'Montgomery International Dragway (Montgomery Raceway Park / Capital City Motorsports Park)', lat: 32.4328, lon: -86.2524},
  {name: 'Mobile Dragway', lat: 30.512056, lon: -88.223165},
  {name: 'Holiday Raceway', lat: 33.2204, lon: -87.1677},
  {name: 'Cottonwood Dragway', lat: 31.0978, lon: -85.2790},
  {name: 'Atmore Dragway', lat: 31.1012, lon: -87.5009},
  {name: 'No Problem Raceway Park', lat: 30.017865, lon: -91.082046},
  {name: 'Bristol Dragway (Bristol Motor Speedway & Dragway)', lat: 36.5178508, lon: -82.2568802},
  {name: 'GALOT Motorsports Park', lat: 35.3164, lon: -78.5132},
  {name: 'North Florida Motorsports Complex (North Florida Motorplex / Powerhouse Motorsports Park)', lat: 30.5078, lon: -85.3504},
];


// ---------- Rendering ----------
function renderTabs(){
  const nav = $('#tabs');
  nav.innerHTML = '';
  for (const t of TABS){
    const b = document.createElement('button');
    b.textContent = t;
    if (state.tab === t) b.classList.add('active');
    b.onclick = () => { state.tab = t; render(); };
    nav.appendChild(b);
  }
}
function card(title, innerHTML){
  return `<div class="card"><div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;">
    <div><b>${title}</b></div>
  </div>
  <div style="margin-top:10px;">${innerHTML}</div></div>`;
}
function messageBox(){
  if (!state.lastMessage) return '';
  const cls = state.lastMessage.type==='ok' ? 'ok' : (state.lastMessage.type==='bad'?'bad':'');
  return `<div class="card"><div class="${cls}">${escapeHtml(state.lastMessage.text)}</div></div>`;
}

function screenRaceDay(){
  const trackOptions = state.tracks.map(t=>`<option value="${t.id}" ${t.id===state.currentTrackId?'selected':''}>${escapeHtml(t.name)} (${fmt(toNumber(t.lat),3)}, ${fmt(toNumber(t.lon),3)})</option>`).join('');
  const raceDayOptions = state.raceDays
    .filter(rd => !state.currentTrackId || rd.trackId===state.currentTrackId)
    .sort((a,b)=> (b.date||'').localeCompare(a.date||''))
    .map(rd=>`<option value="${rd.id}" ${rd.id===state.currentRaceDayId?'selected':''}>${escapeHtml(rd.date)} — ${escapeHtml(rd.name||'Race Day')}</option>`).join('');

  return `
  ${messageBox()}
  ${card('Select Track + Race Day', `
    <div class="row">
      <div>
        <label>Track</label>
        <select id="selTrack"><option value="">— Select —</option>${trackOptions}</select>
        <div class="btns">
          <button class="ghost" id="btnNewTrack">Add Track</button>
        </div>
      </div>
      <div>
        <label>Race Day</label>
        <select id="selRaceDay"><option value="">— Select —</option>${raceDayOptions}</select>
        <div class="btns">
          <button class="ghost" id="btnNewRaceDay">New Race Day</button>
        </div>
      </div>
    </div>
    <p class="notice">All passes and analysis attach to the selected Race Day.</p>
  `)}
  ${card('Quick start', `
    <ol>
      <li>Add your track (name + GPS)</li>
      <li>Create a Race Day</li>
      <li>Enter passes (or paste timeslip text)</li>
      <li>Use Bracket + Analysis tabs for package/stripe and predictions</li>
    </ol>
  `)}
  `;
}

function screenEnterPass(){
  if (!state.currentRaceDayId) {
    return card('Select a Race Day first', `Go to <b>Race Day</b> tab and pick or create a Race Day.`);
  }
  const rd = state.raceDays.find(r=>r.id===state.currentRaceDayId);
  const tr = state.tracks.find(t=>t.id===rd?.trackId);
  const nextRunNo = (state.passes.length ? Math.max(...state.passes.map(p=>p.runNo||0))+1 : 1);

  return `
  ${messageBox()}
  ${card(`Enter Pass — ${escapeHtml(rd.date)} @ ${escapeHtml(tr?.name||'')}`, `
  <div class="row">
    <div><label>Run #</label><input id="runNo" inputmode="numeric" value="${nextRunNo}"/></div>
    <div><label>Lane</label>
      <select id="lane"><option value="">—</option><option>Left</option><option>Right</option></select>
    </div>
  </div>

  <hr/>
  <div class="row">
    <div><label>Tire pressure (rear, PSI)</label><input id="tireRear" inputmode="decimal"/></div>
    <div><label>Tire pressure (front, PSI - optional)</label><input id="tireFront" inputmode="decimal"/></div>
  </div>
  <div class="row">
    <div><label>Trans temp (°F)</label><input id="transTemp" inputmode="decimal"/></div>
    <div><label>Water temp (°F)</label><input id="waterTemp" inputmode="decimal"/></div>
  </div>
  <div class="row">
    <div><label>Delay box setting (sec)</label><input id="delay" inputmode="decimal"/></div>
    <div><label>Launch RPM</label><input id="launchRpm" inputmode="numeric"/></div>
  </div>
  <div class="row">
    <div><label>Shift RPM</label><input id="shiftRpm" inputmode="numeric"/></div>
    <div><label>Shock clicks (format: FL/FR/RL/RR)</label><input id="shocks" placeholder="8/8/10/10"/></div>
  </div>
  <div><label>Notes (optional)</label><textarea id="notes" placeholder="Burnout routine, stage depth, stripe note, etc."></textarea></div>

  <hr/>
  <b>Timeslip</b>
  <div class="row">
    <div><label>Reaction time (R/T)</label><input id="rt" inputmode="decimal"/></div>
    <div><label>60 ft</label><input id="sixty" inputmode="decimal"/></div>
  </div>
  <div class="row">
    <div><label>330 ft</label><input id="threeThirty" inputmode="decimal"/></div>
    <div><label>1/8 ET</label><input id="eighthEt" inputmode="decimal"/></div>
  </div>
  <div class="row">
    <div><label>1/8 MPH</label><input id="mph" inputmode="decimal"/></div>
    <div><label>Dial-in (optional)</label><input id="dial" inputmode="decimal"/></div>
  </div>

  <div class="btns">
    <button class="ghost" id="btnParse">Paste/Parse Timeslip Text</button>
  </div>

  <hr/>
  <b>Weather (stored with this pass)</b>
  <div class="row">
    <div><label>Track GPS</label><input value="${fmt(toNumber(tr?.lat),3)} , ${fmt(toNumber(tr?.lon),3)}" disabled/></div>
    <div><label>Weather source</label><input id="wxSource" placeholder="NWS station ID or Manual"/></div>
  </div>
  <div class="row">
    <div><label>Temp (°C)</label><input id="wxTc" inputmode="decimal"/></div>
    <div><label>RH (%)</label><input id="wxRh" inputmode="decimal"/></div>
  </div>
  <div class="row">
    <div><label>Pressure (hPa)</label><input id="wxPhpa" inputmode="decimal" placeholder="1013"/></div>
    <div><label>Wind speed (m/s)</label><input id="wxWind" inputmode="decimal"/></div>
  </div>
  <div class="row">
    <div><label>Wind direction (deg)</label><input id="wxWindDir" inputmode="decimal"/></div>
    <div><label>Computed: Air density (kg/m³)</label><input id="wxRho" disabled/></div>
  </div>
  <div class="row">
    <div><label>Computed: Density altitude (ft)</label><input id="wxDa" disabled/></div>
    <div><label>Weather timestamp</label><input id="wxTs" placeholder="auto or manual"/></div>
  </div>

  <div class="btns">
    <button class="ghost" id="btnFetchWx">Fetch Weather (NWS)</button>
    <button class="ghost" id="btnComputeWx">Compute Density/DA</button>
  </div>

  <div class="btns">
    <button class="primary" id="btnSavePass">Save Pass</button>
  </div>
  `)}
  `;
}

function screenRunsTable(){
  if (!state.currentRaceDayId) return card('Select a Race Day first', `Go to <b>Race Day</b> tab and pick a Race Day.`);
  const rows = state.passes.map(p => `
    <tr>
      <td class="mono">${p.runNo||''}</td>
      <td>${escapeHtml(p.lane||'')}</td>
      <td class="mono">${fmt(toNumber(p.rt),3)}</td>
      <td class="mono">${fmt(toNumber(p.sixty),3)}</td>
      <td class="mono">${fmt(toNumber(p.threeThirty),3)}</td>
      <td class="mono">${fmt(toNumber(p.eighthEt),3)}</td>
      <td class="mono">${fmt(toNumber(p.mph),1)}</td>
      <td class="mono">${fmt(toNumber(p.dial),3)}</td>
      <td class="mono">${fmt(toNumber(p.delay),3)}</td>
      <td class="mono">${fmt(toNumber(p.transTempF),1)}</td>
      <td class="mono">${fmt(toNumber(p.waterTempF),1)}</td>
      <td class="mono">${fmt(toNumber(p.rho),4)}</td>
      <td class="mono">${fmt(toNumber(p.daFt),0)}</td>
      <td>
        <button class="ghost" data-edit="${p.id}">Edit</button>
        <button class="danger" data-del="${p.id}">Delete</button>
      </td>
    </tr>
  `).join('');

  return `
    ${messageBox()}
    ${card('Runs Table (spreadsheet view)', `
      <div style="overflow:auto;">
        <table>
          <thead>
            <tr>
              <th>Run</th><th>Lane</th><th>RT</th><th>60</th><th>330</th><th>1/8 ET</th><th>MPH</th><th>Dial</th><th>Delay</th><th>Trans°F</th><th>Water°F</th><th>ρ</th><th>DA ft</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>${rows || `<tr><td colspan="14"><small>No passes yet.</small></td></tr>`}</tbody>
        </table>
      </div>
      <p class="notice">Edit opens the pass for correction, then you Save again.</p>
    `)}
  `;
}

function screenBracket(){
  if (!state.currentRaceDayId) return card('Select a Race Day first', `Go to <b>Race Day</b> tab and pick a Race Day.`);
  const options = state.passes.map(p=>`<option value="${p.id}">Run ${p.runNo}: ET ${fmt(toNumber(p.eighthEt),3)} / RT ${fmt(toNumber(p.rt),3)} / Dial ${fmt(toNumber(p.dial),3)}</option>`).join('');
  return `
    ${messageBox()}
    ${card('Bracket: Dial-in / Package / Stripe', `
      <div class="row">
        <div>
          <label>Select your run</label>
          <select id="selMyRun"><option value="">— Select —</option>${options}</select>
        </div>
        <div>
          <label>Opponent name/notes</label>
          <input id="oppName" placeholder="optional"/>
        </div>
      </div>

      <hr/>
      <b>Opponent slip</b>
      <div class="row">
        <div><label>Opponent Dial</label><input id="oppDial" inputmode="decimal"/></div>
        <div><label>Opponent R/T</label><input id="oppRt" inputmode="decimal"/></div>
      </div>
      <div class="row">
        <div><label>Opponent 1/8 ET</label><input id="oppEt" inputmode="decimal"/></div>
        <div><label>Opponent 1/8 MPH</label><input id="oppMph" inputmode="decimal"/></div>
      </div>

      <hr/>
      <b>Red-light / foul (optional)</b>
      <div class="row">
        <div><label>You red-light?</label>
          <select id="meRed"><option value="no">No</option><option value="yes">Yes</option></select>
        </div>
        <div><label>Your red amount (sec, optional)</label><input id="meRedAmt" inputmode="decimal" placeholder="0.012"/></div>
      </div>
      <div class="row">
        <div><label>Opponent red-light?</label>
          <select id="oppRed"><option value="no">No</option><option value="yes">Yes</option></select>
        </div>
        <div><label>Opponent red amount (sec, optional)</label><input id="oppRedAmt" inputmode="decimal"/></div>
      </div>

      <hr/>
      <b>Stripe estimate (optional)</b>
      <div class="row">
        <div><label>Approx MPH behind at stripe (if you know)</label><input id="mphBehind" inputmode="decimal" placeholder="optional"/></div>
        <div><label>—</label><input disabled value="Inches = 17.6 × MPHbehind × MOVsec"/></div>
      </div>

      <div class="btns">
        <button class="primary" id="btnCalcBracket">Calculate</button>
        <button class="ghost" id="btnSaveOpp">Save opponent to selected run</button>
      </div>

      <div id="bracketOut">${state.bracketOutHtml || ''}</div>
    `)}
  `;
}


function buildRecommendations(passes){
  // Data-driven suggestions only. No fabricated numbers.
  const ets = passes.map(p=>toNumber(p.eighthEt));
  const sixties = passes.map(p=>toNumber(p.sixty));
  const rts = passes.map(p=>toNumber(p.rt));
  const delays = passes.map(p=>toNumber(p.delay));
  const tps = passes.map(p=>toNumber(p.tireRearPsi));
  const trans = passes.map(p=>toNumber(p.transTempF));
  const water = passes.map(p=>toNumber(p.waterTempF));

  const out = [];

  const etSd = stdev(ets);
  const sixtySd = stdev(sixties);
  const rtSd = stdev(rts);

  // Correlations (magnitude)
  const r60 = pearson(sixties, ets);
  const rRT = pearson(rts, ets);
  const rDelay = pearson(delays, rts);
  const rTP = pearson(tps, sixties);

  // Outlier detection on ET (z-score)
  const etMean = mean(ets);
  const etZ = (Number.isFinite(etSd) && etSd>0) ? passes.map(p=>{
    const et = toNumber(p.eighthEt);
    if (!Number.isFinite(et)) return null;
    return {runNo:p.runNo, z:(et-etMean)/etSd};
  }).filter(x=>x && Math.abs(x.z)>=2.0) : [];
  if (etZ.length){
    out.push(`Outliers: runs with |z| ≥ 2.0 on 1/8 ET: ${etZ.map(x=>`Run ${x.runNo} (z=${x.z.toFixed(2)})`).join(', ')}. Check notes + conditions for those runs.`);
  }

  if (Number.isFinite(rtSd) && rtSd>0.015){
    out.push('Your RT variation is noticeable. Tighten your routine: same pre-stage/stage timing and staging depth each run, and keep your cockpit process identical.');
  }

  if (Number.isFinite(sixtySd) && sixtySd>0.020){
    out.push('Your 60-foot variation is noticeable. Start by controlling variables that directly affect traction/leave: rear tire pressure, consistent burnout length, and consistent launch RPM.');
  }

  if (Number.isFinite(r60) && Math.abs(r60) >= 0.70){
    out.push('Today, ET is strongly tied to your 60-foot. Focus on leave/traction consistency first (tire pressure, launch RPM, shock settings, and track prep adaptation).');
  } else if (Number.isFinite(r60) && Math.abs(r60) < 0.40 && Number.isFinite(etSd) && etSd>0.020){
    out.push('ET is not tightly linked to your 60-foot today, so inconsistency may be happening mid-track (shift RPM consistency, trans temp, or traction management after the hit).');
  }

  if (Number.isFinite(rTP) && Math.abs(rTP) >= 0.50){
    out.push('Your data suggests rear tire pressure is influencing 60-foot. When you adjust pressure, do it in small steps and log it every run.');
  }

  if (Number.isFinite(rDelay) && Math.abs(rDelay) >= 0.50){
    out.push('Delay box changes appear to move RT. For consistency, avoid “chasing” the tree with large delay swings; use smaller adjustments and keep your staging routine fixed.');
  }

  // Temperature stability checks
  const transSd = stdev(trans);
  const waterSd = stdev(water);
  if (Number.isFinite(transSd) && transSd > 15){
    out.push('Transmission temperature is swinging. Consistent staging-line temperature can help repeatability—log your trans temp at the same point each round.');
  }
  if (Number.isFinite(waterSd) && waterSd > 10){
    out.push('Water temp swings are present. Try to hit the lanes at a consistent water temp (fan/idle strategy) to keep ET repeatable.');
  }

  if (!out.length){
    out.push('Not enough variation detected (or not enough runs) to make data-driven recommendations yet. Keep logging—more runs makes the pattern detection stronger.');
  }
  return out;
}

function screenAnalysis(){
  if (!state.currentRaceDayId) return card('Select a Race Day first', `Go to <b>Race Day</b> tab and pick a Race Day.`);

  const ets = state.passes.map(p=>toNumber(p.eighthEt));
  const rts = state.passes.map(p=>toNumber(p.rt));
  const sixties = state.passes.map(p=>toNumber(p.sixty));
  const three = state.passes.map(p=>toNumber(p.threeThirty));
  const mphs = state.passes.map(p=>toNumber(p.mph));
  const rhos = state.passes.map(p=>toNumber(p.rho));

  const etMean = mean(ets), etSd = stdev(ets);
  const rtMean = mean(rts), rtSd = stdev(rts);
  const sixtyMean = mean(sixties), sixtySd = stdev(sixties);

  const corrList = [
    {name:"60 ft", v:pearson(sixties, ets)},
    {name:"330 ft", v:pearson(three, ets)},
    {name:"MPH", v:pearson(mphs, ets)},
    {name:"Air density (ρ)", v:pearson(rhos, ets)},
  ].filter(x=>x.v!==null).sort((a,b)=>Math.abs(b.v)-Math.abs(a.v));

  const corrHtml = corrList.length
    ? `<ol>${corrList.map(c=>`<li><span class="mono">${escapeHtml(c.name)}</span>: r=${fmt(toNumber(c.v),2)}</li>`).join('')}</ol>`
    : `<small>Need at least 3 passes with those fields to compute correlations.</small>`;


  const recs = buildRecommendations(state.passes);
  const recHtml = '<ul>' + recs.map(s => '<li>' + escapeHtml(s) + '</li>').join('') + '</ul>' +
    '<p class="notice">These suggestions are driven by your logged variables and common tuning levers: staging routine, tire pressure/traction, shocks, and temperature control.</p>';
  const latestRho = rhos.filter(x=>Number.isFinite(x)).slice(-1)[0] ?? null;
  const pred = predictNextET(state.passes, latestRho);
  let predHtml = '';
  if (!pred.ok){
    predHtml = `<small>${escapeHtml(pred.message)}</small>`;
  } else {
    predHtml = `
      <div class="kpi">
        <div class="pill"><div><small>ET prediction</small></div><b class="mono">${fmt(toNumber(pred.etPred),3)}</b></div>
        <div class="pill"><div><small>95% band</small></div><b class="mono">${fmt(toNumber(pred.bandLo),3)} – ${fmt(toNumber(pred.bandHi),3)}</b></div>
        <div class="pill"><div><small>Passes used</small></div><b class="mono">${pred.n}</b></div>
        <div class="pill"><div><small>Scatter (σ std-ET)</small></div><b class="mono">${fmt(toNumber(pred.scatterStd),3)}</b></div>
      </div>
      <p class="notice">Prediction uses density-normalized ET and a weighted moving average. Band comes from your own scatter.</p>
    `;
  }

  return `
    ${messageBox()}
    ${card('Consistency KPIs (today)', `
      <div class="kpi">
        <div class="pill"><div><small>1/8 ET mean</small></div><b class="mono">${fmt(toNumber(etMean),3)}</b></div>
        <div class="pill"><div><small>1/8 ET stdev</small></div><b class="mono">${fmt(toNumber(etSd),3)}</b></div>
        <div class="pill"><div><small>RT mean</small></div><b class="mono">${fmt(toNumber(rtMean),3)}</b></div>
        <div class="pill"><div><small>RT stdev</small></div><b class="mono">${fmt(toNumber(rtSd),3)}</b></div>
        <div class="pill"><div><small>60 mean</small></div><b class="mono">${fmt(toNumber(sixtyMean),3)}</b></div>
        <div class="pill"><div><small>60 stdev</small></div><b class="mono">${fmt(toNumber(sixtySd),3)}</b></div>
      </div>
    `)}
    ${card('What is moving ET today? (correlations)', corrHtml)}
    ${card('Recommendations (based on your data today)', recHtml)}
    ${card('Next-round ET prediction + Dial-in', `
      ${predHtml}
      <hr/>
      <div class="row">
        <div>
          <label>Breakout risk target (0.10 = 10%)</label>
          <input id="risk" inputmode="decimal" value="0.10"/>
        </div>
        <div>
          <label>Dial-in recommendation</label>
          <input id="dialRec" disabled/>
        </div>
      </div>
      <div class="btns">
        <button class="ghost" id="btnDialRec">Compute Dial-in</button>
      </div>
    `)}
  `;
}

function screenExport(){
  if (!state.currentRaceDayId) return card('Select a Race Day first', `Go to <b>Race Day</b> tab and pick a Race Day.`);
  return `
    ${messageBox()}
    ${card('Export to CSV (Excel-friendly)', `
      <p class="notice">Creates a CSV you can open in Excel, AirDrop, or email to yourself.</p>
      <div class="btns">
        <button class="primary" id="btnExportCsv">Export CSV</button>
      </div>
    `)}
    ${card('Import CSV (restore)', `
      <div class="row">
        <div>
          <label>Import passes CSV</label>
          <input id="csvFile" type="file" accept=".csv,text/csv"/>
        </div>
        <div>
          <label>—</label>
          <button class="ghost" id="btnImportCsv">Import CSV</button>
        </div>
      </div>
      <small>Import expects the same columns the app exports.</small>
    `)}
  `;
}

function escapeHtml(s){
  return (s??'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function render(){
  renderTabs();
  const app = $('#app');
  let html = '';
  if (state.tab === 'Race Day') html = screenRaceDay();
  else if (state.tab === 'Enter Pass') html = screenEnterPass();
  else if (state.tab === 'Runs Table') html = screenRunsTable();
  else if (state.tab === 'Bracket') html = screenBracket();
  else if (state.tab === 'Analysis') html = screenAnalysis();
  else if (state.tab === 'Export/Backup') html = screenExport();
  app.innerHTML = html;
  bind();
}

// ---------- Bind events per screen ----------
function bind(){
  if (state.tab === 'Race Day'){
    const selTrack = $('#selTrack');
    const selRace = $('#selRaceDay');
    if (selTrack){
      selTrack.onchange = async () => {
        state.currentTrackId = selTrack.value || null;
        const rds = state.raceDays.filter(r=>r.trackId===state.currentTrackId).sort((a,b)=> (b.date||'').localeCompare(a.date||''));
        state.currentRaceDayId = rds[0]?.id || null;
        await refreshPasses();
        render();
      };
    }
    if (selRace){
      selRace.onchange = async () => {
        state.currentRaceDayId = selRace.value || null;
        const rd = state.raceDays.find(r=>r.id===state.currentRaceDayId);
        state.currentTrackId = rd?.trackId || state.currentTrackId;
        await refreshPasses();
        render();
      };
    }
    const btnNewTrack = $('#btnNewTrack');
    if (btnNewTrack) btnNewTrack.onclick = async () => {
      const name = prompt('Track name? (Example: Montgomery Motorsports Park)');
      if (!name) return;
      const lat = toNumber(prompt('Track latitude? (Example: 32.XXXX)'));
      const lon = toNumber(prompt('Track longitude? (Example: -86.XXXX)'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)){
        toast('bad', 'Need valid latitude and longitude.');
        render();
        return;
      }
      const t = {id:uid(), name, lat, lon, createdAt:new Date().toISOString()};
      await idbPut('tracks', t);
      await loadAll();
  try{ selfTest(); } catch(e){ toast('bad', String(e.message||e)); }

      state.currentTrackId = t.id;
      toast('ok', 'Track added.');
      render();
    };
    const btnNewRD = $('#btnNewRaceDay');
    if (btnNewRD) btnNewRD.onclick = async () => {
      if (!state.currentTrackId){ toast('bad', 'Select a track first.'); render(); return; }
      const date = prompt('Race day date (YYYY-MM-DD)?', new Date().toISOString().slice(0,10));
      if (!date) return;
      const name = prompt('Race day name (optional)', 'Bracket Race');
      const rd = {id:uid(), trackId:state.currentTrackId, date, name, createdAt:new Date().toISOString()};
      await idbPut('raceDays', rd);
      await loadAll();
  try{ selfTest(); } catch(e){ toast('bad', String(e.message||e)); }

      state.currentRaceDayId = rd.id;
      await refreshPasses();
      toast('ok', 'Race day created.');
      render();
    };
  }

  if (state.tab === 'Enter Pass'){
    const btnFetchWx = $('#btnFetchWx');
    if (btnFetchWx) btnFetchWx.onclick = async () => {
      try{
        const rd = state.raceDays.find(r=>r.id===state.currentRaceDayId);
        const tr = state.tracks.find(t=>t.id===rd?.trackId);
        if (!tr) throw new Error('Track not found');
        toast('info', 'Fetching weather...');
        render();
        const wx = await fetchNwsLatest(tr.lat, tr.lon);
        $('#wxSource').value = wx.source || '';
        if (wx.Tc!==null) $('#wxTc').value = wx.Tc;
        if (wx.rh!==null) $('#wxRh').value = wx.rh;
        if (wx.p_hPa!==null) $('#wxPhpa').value = wx.p_hPa;
        if (wx.windSpeedMs!==null) $('#wxWind').value = wx.windSpeedMs;
        if (wx.windDir!==null) $('#wxWindDir').value = wx.windDir;
        if (wx.timestamp) $('#wxTs').value = wx.timestamp;
        computeWxFields();
        toast('ok', 'Weather loaded.');
        render();
      } catch(e){
        toast('bad', e.message || String(e));
        render();
      }
    };
    const btnComputeWx = $('#btnComputeWx');
    if (btnComputeWx) btnComputeWx.onclick = () => { computeWxFields(); toast('ok','Computed density and DA.'); render(); };

    const btnParse = $('#btnParse');
    if (btnParse) btnParse.onclick = () => {
      const text = prompt('Paste the timeslip text here:');
      if (!text) return;
      const p = parseTimeslipText(text);
      if (Number.isFinite(p.rt)) $('#rt').value = p.rt;
      if (Number.isFinite(p.sixty)) $('#sixty').value = p.sixty;
      if (Number.isFinite(p.threeThirty)) $('#threeThirty').value = p.threeThirty;
      if (Number.isFinite(p.eighthEt)) $('#eighthEt').value = p.eighthEt;
      if (Number.isFinite(p.mph)) $('#mph').value = p.mph;
      toast('ok','Parsed. Verify fields, then Save Pass.');
      render();
    };

    const btnSave = $('#btnSavePass');
    if (btnSave) btnSave.onclick = async () => {
      const runNo = toNumber($('#runNo').value);
      if (!Number.isFinite(runNo)){ toast('bad','Run # is required.'); render(); return; }
      const pass = await buildPassObject(runNo);
      await idbPut('passes', pass);
      await refreshPasses();
      toast('ok', 'Pass saved.');
      state.tab = 'Runs Table';
      render();
    };
  }

  if (state.tab === 'Runs Table'){
    $$('button[data-edit]').forEach(btn => btn.onclick = async () => {
      const id = btn.getAttribute('data-edit');
      const p = await idbGet('passes', id);
      if (!p) return;
      await idbPut('settings', {id:'editPass', passId:id});
      state.tab = 'Enter Pass';
      render();
      fillPassForm(p);
      toast('info', `Editing Run ${p.runNo}`);
      render();
    });
    $$('button[data-del]').forEach(btn => btn.onclick = async () => {
      const id = btn.getAttribute('data-del');
      if (!confirm('Delete this pass?')) return;
      await idbDelete('passes', id);
      await refreshPasses();
      toast('ok', 'Deleted.');
      render();
    });
  }

  if (state.tab === 'Bracket'){
    const btnCalc = $('#btnCalcBracket');
    if (btnCalc) btnCalc.onclick = async () => {
      const myId = $('#selMyRun').value;
      if (!myId){ toast('bad','Select your run.'); render(); return; }
      const my = state.passes.find(p=>p.id===myId);
      if (!my){ toast('bad','Run not found.'); render(); return; }

      const me = {
        dial: toNumber(my.dial),
        rt: toNumber(my.rt),
        eighthEt: toNumber(my.eighthEt),
        mphBehind: toNumber($('#mphBehind').value),
        redLight: $('#meRed').value==='yes',
        redAmount: toNumber($('#meRedAmt').value)
      };
      const opp = {
        dial: toNumber($('#oppDial').value),
        rt: toNumber($('#oppRt').value),
        eighthEt: toNumber($('#oppEt').value),
        redLight: $('#oppRed').value==='yes',
        redAmount: toNumber($('#oppRedAmt').value)
      };

      const meM = calcBracketMetrics(me);
      const opM = calcBracketMetrics(opp);
      const stripe = calcStripe(me, opp);
      const win = winnerLogic(
        {...me, breakout: meM.breakout},
        {...opp, breakout: opM.breakout}
      );

      state.bracketOutHtml = `
        <hr/>
        <div class="row">
          <div class="card">
            <b>You</b><br/>
            Dial: <span class="mono">${fmt(meM.dial,3)}</span><br/>
            ET: <span class="mono">${fmt(meM.et,3)}</span><br/>
            RT: <span class="mono">${fmt(meM.rt,3)}</span><br/>
            Deviation: <span class="mono">${fmt(meM.deviation,3)}</span><br/>
            Breakout: <span class="mono">${fmt(meM.breakout,3)}</span><br/>
            Package: <span class="mono">${fmt(meM.package,3)}</span>
          </div>
          <div class="card">
            <b>Opponent</b><br/>
            Dial: <span class="mono">${fmt(opM.dial,3)}</span><br/>
            ET: <span class="mono">${fmt(opM.et,3)}</span><br/>
            RT: <span class="mono">${fmt(opM.rt,3)}</span><br/>
            Deviation: <span class="mono">${fmt(opM.deviation,3)}</span><br/>
            Breakout: <span class="mono">${fmt(opM.breakout,3)}</span><br/>
            Package: <span class="mono">${fmt(opM.package,3)}</span>
          </div>
        </div>
        <div class="card">
          <b>Result</b><br/>
          Winner: <b>${escapeHtml(win.winner)}</b><br/>
          Reason: <span class="mono">${escapeHtml(win.reason)}</span><br/>
          ${stripe ? `Stripe MOV: <span class="mono">${fmt(stripe.movSeconds,3)}</span> sec` : 'Stripe: need dial/RT/ET on both.'}
          ${stripe && Number.isFinite(stripe.movInches) ? `<br/>Approx MOV: <span class="mono">${fmt(stripe.movInches,0)}</span> inches` : ''}
        </div>
      `;
      toast('ok','Calculated.');
      render();
    };

    const btnSaveOpp = $('#btnSaveOpp');
    if (btnSaveOpp) btnSaveOpp.onclick = async () => {
      const myId = $('#selMyRun').value;
      if (!myId){ toast('bad','Select your run.'); render(); return; }
      const my = state.passes.find(p=>p.id===myId);
      if (!my){ toast('bad','Run not found.'); render(); return; }
      my.opp = {
        name: $('#oppName').value || null,
        dial: toNumber($('#oppDial').value),
        rt: toNumber($('#oppRt').value),
        et: toNumber($('#oppEt').value),
        mph: toNumber($('#oppMph').value),
        red: $('#oppRed').value==='yes',
        redAmt: toNumber($('#oppRedAmt').value)
      };
      await idbPut('passes', my);
      await refreshPasses();
      toast('ok','Opponent saved to run.');
      render();
    };
  }

  if (state.tab === 'Analysis'){
    const btnDialRec = $('#btnDialRec');
    if (btnDialRec) btnDialRec.onclick = () => {
      const rhos = state.passes.map(p=>toNumber(p.rho)).filter(x=>Number.isFinite(x));
      const latestRho = rhos.slice(-1)[0] ?? null;
      const pred = predictNextET(state.passes, latestRho);
      if (!pred.ok){ toast('bad', pred.message); render(); return; }
      const sigmaStd = pred.scatterStd;
      const sigmaEt = Number.isFinite(sigmaStd) ? sigmaStd / Math.pow(pred.rhoUsed/rho0, 1/3) : null;
      const risk = toNumber($('#risk').value);
      const dial = recommendDialIn(pred.etPred, sigmaEt, risk);
      $('#dialRec').value = Number.isFinite(dial) ? dial.toFixed(3) : '';
      toast('ok','Dial-in computed.');
      render();
    };
  }

  if (state.tab === 'Export/Backup'){
    const btnExport = $('#btnExportCsv');
    if (btnExport) btnExport.onclick = async () => {
      const csv = exportCsv();
      await exportCsvToUser(`dragday_${state.currentRaceDayId}.csv`, csv);
      toast('ok','CSV exported (shared or downloaded).');
      render();
    };
    const btnImport = $('#btnImportCsv');
    if (btnImport) btnImport.onclick = async () => {
      const file = $('#csvFile').files?.[0];
      if (!file){ toast('bad','Pick a CSV file first.'); render(); return; }
      const text = await file.text();
      const added = await importCsv(text);
      toast('ok', `Imported ${added} passes.`);
      await refreshPasses();
      render();
    };
  }
}

function toast(type, text){
  state.lastMessage = {type, text};
}

// ---------- Form helpers ----------
function computeWxFields(){
  const Tc = toNumber($('#wxTc').value);
  const rh = toNumber($('#wxRh').value);
  const p_hPa = toNumber($('#wxPhpa').value);
  if (!Number.isFinite(Tc) || !Number.isFinite(rh) || !Number.isFinite(p_hPa)) {
    $('#wxRho').value = '';
    $('#wxDa').value = '';
    return;
  }
  const rho = airDensityKgM3(Tc, rh, p_hPa);
  const da = densityAltitudeFeetFromRho(rho);
  $('#wxRho').value = rho.toFixed(4);
  $('#wxDa').value = da.toFixed(0);
}

async function buildPassObject(runNo){
  let edit = await idbGet('settings', 'editPass');
  let existing = null;
  if (edit?.passId) existing = await idbGet('passes', edit.passId);

  const pass = existing ? {...existing} : {id:uid(), createdAt:new Date().toISOString()};
  pass.raceDayId = state.currentRaceDayId;
  pass.runNo = runNo;
  pass.lane = $('#lane').value || null;

  pass.tireRearPsi = toNumber($('#tireRear').value);
  pass.tireFrontPsi = toNumber($('#tireFront').value);
  pass.transTempF = toNumber($('#transTemp').value);
  pass.waterTempF = toNumber($('#waterTemp').value);
  pass.delay = toNumber($('#delay').value);
  pass.launchRpm = toNumber($('#launchRpm').value);
  pass.shiftRpm = toNumber($('#shiftRpm').value);
  pass.shocks = $('#shocks').value || null;
  pass.notes = $('#notes').value || null;

  pass.rt = toNumber($('#rt').value);
  pass.sixty = toNumber($('#sixty').value);
  pass.threeThirty = toNumber($('#threeThirty').value);
  pass.eighthEt = toNumber($('#eighthEt').value);
  pass.mph = toNumber($('#mph').value);
  pass.dial = toNumber($('#dial').value);

  pass.wxSource = $('#wxSource').value || null;
  pass.Tc = toNumber($('#wxTc').value);
  pass.rh = toNumber($('#wxRh').value);
  pass.p_hPa = toNumber($('#wxPhpa').value);
  pass.windMs = toNumber($('#wxWind').value);
  pass.windDir = toNumber($('#wxWindDir').value);
  pass.wxTs = $('#wxTs').value || null;

  if (Number.isFinite(pass.Tc) && Number.isFinite(pass.rh) && Number.isFinite(pass.p_hPa)){
    pass.rho = airDensityKgM3(pass.Tc, pass.rh, pass.p_hPa);
    pass.daFt = densityAltitudeFeetFromRho(pass.rho);
    pass.etStd = (Number.isFinite(pass.eighthEt)) ? etStdFromDensity(pass.eighthEt, pass.rho) : null;
  } else {
    pass.rho = null; pass.daFt = null; pass.etStd = null;
  }

  if (edit?.passId){
    await idbPut('settings', {id:'editPass', passId:null});
  }
  return pass;
}

function fillPassForm(p){
  if (!$('#runNo')) return;
  $('#runNo').value = p.runNo ?? '';
  $('#lane').value = p.lane ?? '';
  $('#tireRear').value = p.tireRearPsi ?? '';
  $('#tireFront').value = p.tireFrontPsi ?? '';
  $('#transTemp').value = p.transTempF ?? '';
  $('#waterTemp').value = p.waterTempF ?? '';
  $('#delay').value = p.delay ?? '';
  $('#launchRpm').value = p.launchRpm ?? '';
  $('#shiftRpm').value = p.shiftRpm ?? '';
  $('#shocks').value = p.shocks ?? '';
  $('#notes').value = p.notes ?? '';

  $('#rt').value = p.rt ?? '';
  $('#sixty').value = p.sixty ?? '';
  $('#threeThirty').value = p.threeThirty ?? '';
  $('#eighthEt').value = p.eighthEt ?? '';
  $('#mph').value = p.mph ?? '';
  $('#dial').value = p.dial ?? '';

  $('#wxSource').value = p.wxSource ?? '';
  $('#wxTc').value = p.Tc ?? '';
  $('#wxRh').value = p.rh ?? '';
  $('#wxPhpa').value = p.p_hPa ?? '';
  $('#wxWind').value = p.windMs ?? '';
  $('#wxWindDir').value = p.windDir ?? '';
  $('#wxTs').value = p.wxTs ?? '';
  if (p.rho) $('#wxRho').value = Number(p.rho).toFixed(4);
  if (p.daFt!==null && p.daFt!==undefined) $('#wxDa').value = Number(p.daFt).toFixed(0);
}

// ---------- CSV export/import ----------
function exportCsv(){
  const cols = [
    'runNo','lane','rt','sixty','threeThirty','eighthEt','mph','dial',
    'tireRearPsi','tireFrontPsi','transTempF','waterTempF','delay','launchRpm','shiftRpm','shocks','notes',
    'Tc','rh','p_hPa','windMs','windDir','wxSource','wxTs','rho','daFt'
  ];
  const lines = [cols.join(',')];
  for (const p of state.passes){
    const row = cols.map(c => csvEscape(p[c]));
    lines.push(row.join(','));
  }
  return lines.join('\n');
}
function csvEscape(v){
  if (v===null || v===undefined) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g,'""')}"`;
  return s;
}

async function exportCsvToUser(filename, csvText){
  // iOS-friendly: prefer Share Sheet when available, fallback to classic download.
  try{
    if (navigator.share && typeof File !== 'undefined'){
      const file = new File([csvText], filename, {type:'text/csv'});
      await navigator.share({title:'DragDay Export', text:'Race day CSV export', files:[file]});
      return true;
    }
  }catch(e){
    // Fall through to download
  }
  downloadText(filename, csvText, 'text/csv');
  return true;
}

function downloadText(filename, text, mime){
  const blob = new Blob([text], {type:mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
async function importCsv(text){
  const lines = text.split(/\r?\n/).filter(l=>l.trim()!=='');
  if (lines.length<2) return 0;
  const header = parseCsvLine(lines[0]);
  let added = 0;
  for (let i=1;i<lines.length;i++){
    const vals = parseCsvLine(lines[i]);
    const obj = {id:uid(), raceDayId:state.currentRaceDayId, createdAt:new Date().toISOString()};
    for (let j=0;j<header.length;j++){
      obj[header[j]] = vals[j] ?? '';
    }
    for (const k of Object.keys(obj)){
      if (['lane','shocks','notes','wxSource','wxTs'].includes(k)) continue;
      if (k==='id' || k==='raceDayId' || k==='createdAt') continue;
      const n = toNumber(obj[k]);
      obj[k] = (n===null) ? (obj[k]||null) : n;
    }
    await idbPut('passes', obj);
    added++;
  }
  return added;
}
function parseCsvLine(line){
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i=0;i<line.length;i++){
    const ch = line[i];
    if (inQ){
      if (ch === '"'){
        if (line[i+1] === '"'){ cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else {
      if (ch === ','){ out.push(cur); cur=''; }
      else if (ch === '"'){ inQ = true; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// ---------- Initialization ----------

async function seedDefaultTracksIfEmpty(){
  const existing = await idbGetAll('tracks');
  if (existing.length) return false;
  for (const t of DEFAULT_TRACKS){
    await idbPut('tracks', {id: uid(), name: t.name, lat: t.lat, lon: t.lon, createdAt: new Date().toISOString(), seeded: true});
  }
  return true;
}

async function loadAll(){
  await seedDefaultTracksIfEmpty();
  state.tracks = await idbGetAll('tracks');
  state.raceDays = await idbGetAll('raceDays');
  if (!state.currentRaceDayId && state.raceDays.length){
    const rd = state.raceDays.slice().sort((a,b)=> (b.date||'').localeCompare(a.date||''))[0];
    state.currentRaceDayId = rd.id;
    state.currentTrackId = rd.trackId;
  }
  if (!state.currentTrackId && state.tracks.length){
    state.currentTrackId = state.tracks[0].id;
  }
  await refreshPasses();
}
async function refreshPasses(){
  if (!state.currentRaceDayId){ state.passes=[]; return; }
  state.passes = await idbGetPassesByRaceDay(state.currentRaceDayId);
}


function selfTest(){
  // Sanity checks so the math is auditable.
  const eps = (a,b,tol)=> Math.abs(a-b) <= tol;
  // ISA sea level: 15°C, 0% RH, 1013.25 hPa => ~1.225 kg/m^3 (dry air approx)
  const rho = airDensityKgM3(15, 0, 1013.25);
  if (!eps(rho, 1.225, 0.03)) throw new Error(`Self-test failed: air density sanity (got ${rho})`);
  if (!eps(normInv(0.5), 0, 1e-6)) throw new Error('Self-test failed: normInv(0.5)');
  if (!eps(normInv(0.975), 1.95996, 0.01)) throw new Error('Self-test failed: normInv(0.975)');
  const et = 6.50;
  const std = etStdFromDensity(et, rho0);
  if (!eps(std, et, 1e-12)) throw new Error('Self-test failed: ET std identity');
}

(async function init(){
  await loadAll();
  try{ selfTest(); } catch(e){ toast('bad', String(e.message||e)); }

  if (!state.tracks.length){
    const demo = {id:uid(), name:'(Add your track)', lat: 30.0, lon: -88.0, createdAt:new Date().toISOString()};
    await idbPut('tracks', demo);
    await loadAll();
  try{ selfTest(); } catch(e){ toast('bad', String(e.message||e)); }

  }
  render();
})();
