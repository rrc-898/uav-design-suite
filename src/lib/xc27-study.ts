// ==================================================================
//  XtraChallenge 2027 — estudio de UN avión concreto.
//
//  El optimizador responde «qué avión construir». Este módulo responde
//  lo siguiente: dado ESTE avión, ¿qué hace en la ronda y qué hay que
//  documentar en el informe técnico?
//
//    · ronda simulada fase a fase y su puntuación oficial
//    · barrido de carga: cuánto arroz declarar
//    · predicción de carga frente a la densidad del aire (§6.2, obligatoria)
//    · modelo de empuje T(V, palanca) (§6.2)
//    · diagrama de maniobras V-n y flexión del ala (§6.2, mínimos exigidos)
//    · centrado, punto neutro y margen estático con y sin carga (§7.8)
//    · bahía de arroz y encaje en la caja de transporte (§7.3, §7.8)
//
//  Todo usa la misma física que el Mission Simulator (design.ts), de
//  modo que el número que sale aquí es el que vio el optimizador.
// ==================================================================

import { AIRFOILS, airfoilById, type Airfoil } from './airfoils';
import { BATTERIES, ESCS, MOTORS, PROPS, byId } from './catalog';
import { selectAvionics } from './avionics';
import {
  buildAeroModel, buildDriveMap, driveTrainOf, evaluateDesign, makePack, macOf, rootChordOf,
  takeoffRunOf, sustainedPower,
  type AeroModel, type DesignEvaluation, type DriveUnit, type MassBreakdown, type Planform,
} from './design';
import { missionById, type MissionVariables } from './mission';
import {
  XC27_LIMITS, BOX_CLEARANCE_MM, boxSections, minTransportBox, riceVolumeL, type BoxGeometry,
} from './xc27';
import {
  xc27Extra, xc27FromMetrics, XC27_DEFAULT_STRATEGY,
  type Xc27Flight, type Xc27Sim, type Xc27Strategy,
} from './xc27-flight';

const G = 9.80665;

// ------------------------------------------------------------------
//  Especificación del avión
// ------------------------------------------------------------------
export interface Xc27Spec {
  airfoilId: string;
  spanM: number;
  aspectRatio: number;
  taper: number;
  washoutDeg: number;
  propId: string;
  batteryId: string;
  parallel: number;
  escId: string;
  payloadG: number;          // arroz transportado
  buildFactor: number;
  emptyMassG: number;        // 0 = estimar; > 0 = masa en vacío pesada (sin arroz)
  rho: number;               // densidad del aire el día de vuelo, kg/m³
  windMs: number;
  reservePct: number;
}

const pick = <T extends { id: string }>(list: T[], pred: (x: T) => boolean): string =>
  (list.find(pred) ?? list[0]).id;

export const XC27_DEFAULT_SPEC: Xc27Spec = {
  airfoilId: 'naca4412', spanM: 1.95, aspectRatio: 8, taper: 0.7, washoutDeg: -2,
  propId: pick(PROPS, (p) => p.dia === 14 && p.pitch === 8 && p.folding),
  batteryId: pick(BATTERIES, (b) => b.cells === 3 && b.capacityMah === 4000 && b.massG > 0),
  parallel: 1,
  escId: pick(ESCS, (e) => e.iMax >= 60),
  payloadG: 2300, buildFactor: 1, emptyMassG: 0,
  rho: 1.12, windMs: 2, reservePct: 20,
};

/** Hélices, baterías y variadores que el reglamento 2027 deja montar. */
export const xc27Catalog = () => ({
  airfoils: AIRFOILS.filter((a) => !a.reflex).concat(AIRFOILS.filter((a) => a.reflex)),
  props: [...PROPS].sort((a, b) => a.dia - b.dia || a.pitch - b.pitch),
  batteries: BATTERIES.filter((b) => b.cells === XC27_LIMITS.maxCells && b.massG > 0 && b.chemistry === 'LiPo')
    .sort((a, b) => a.capacityMah - b.capacityMah),
  escs: ESCS.filter((e) => e.iMax >= XC27_LIMITS.escMinA),
});

export function xc27Vars(spec: Xc27Spec, over: Partial<MissionVariables> = {}): MissionVariables {
  const base = missionById('xc27').vars;
  return {
    ...base,
    payloadG: spec.payloadG, payloadMode: 'fija', windMs: spec.windMs, reservePct: spec.reservePct,
    buildFactor: spec.buildFactor, rhoOverride: spec.rho, maxSpanM: Math.max(base.maxSpanM, spec.spanM),
    emptyMassOverrideG: spec.emptyMassG > 0 ? spec.emptyMassG : undefined,
    ...over,
  };
}

export interface Xc27Study {
  spec: Xc27Spec;
  strategy: Xc27Strategy;
  vars: MissionVariables;
  airfoil: Airfoil;
  planform: Planform;
  model: AeroModel;
  drive: DriveUnit;
  ev: DesignEvaluation;
  flight: Xc27Flight;
  sim: Xc27Sim;
}

function buildParts(spec: Xc27Spec, vars: MissionVariables) {
  const airfoil = airfoilById(spec.airfoilId);
  const planform: Planform = {
    spanM: spec.spanM, aspectRatio: spec.aspectRatio, taper: spec.taper, sweepDeg: 0, washoutDeg: spec.washoutDeg,
  };
  const rho = spec.rho;
  const model = buildAeroModel({ planform, airfoil, flyingWing: airfoil.reflex }, vars, rho);
  const motor = byId(MOTORS, XC27_LIMITS.motorId);
  const prop = byId(PROPS, spec.propId);
  const pack = makePack(byId(BATTERIES, spec.batteryId), 1, Math.max(1, Math.round(spec.parallel)));
  const esc = byId(ESCS, spec.escId);
  const avionics = selectAvionics(missionById('xc27').requiredAvionics, 'masa');
  const drive: DriveUnit = {
    motor, prop, pack, esc, avionics,
    map: buildDriveMap(driveTrainOf({ motor, prop, pack, esc }, rho)),
  };
  return { airfoil, planform, model, drive };
}

/** Evalúa la ronda con un modelo y un tren ya construidos (barato: sin rehacer mapas). */
function runRound(model: AeroModel, drive: DriveUnit, vars: MissionVariables, st: Xc27Strategy) {
  let flight: Xc27Flight | null = null;
  const ev = evaluateDesign(model, drive, vars, {
    pickSpeedBy: (m) => m.rangeKm, vScanSteps: 20,
    extra: xc27Extra(st, (f) => { flight = f; }),
  });
  return { ev, flight: flight as unknown as Xc27Flight, sim: xc27FromMetrics(ev.metrics, st) };
}

export function studyXc27(spec: Xc27Spec, strategy: Xc27Strategy = XC27_DEFAULT_STRATEGY): Xc27Study {
  const vars = xc27Vars(spec);
  const parts = buildParts(spec, vars);
  const r = runRound(parts.model, parts.drive, vars, strategy);
  return { spec, strategy, vars, ...parts, ...r };
}

/** Especificación equivalente a un diseño salido del Mission Simulator. */
export function specFromEvaluation(ev: DesignEvaluation, vars: MissionVariables, rho: number): Xc27Spec {
  const p = ev.model.airframe.planform;
  return {
    airfoilId: ev.model.airframe.airfoil.id, spanM: p.spanM, aspectRatio: p.aspectRatio, taper: p.taper,
    washoutDeg: p.washoutDeg, propId: ev.drive.prop.id, batteryId: ev.drive.pack.battery.id,
    parallel: ev.drive.pack.parallel, escId: ev.drive.esc.id,
    payloadG: Math.round(ev.metrics.payloadG), buildFactor: vars.buildFactor, emptyMassG: 0,
    rho: Math.round(rho * 1000) / 1000, windMs: vars.windMs, reservePct: vars.reservePct,
  };
}

// ------------------------------------------------------------------
//  Barrido de carga: ¿cuánto arroz declarar?
// ------------------------------------------------------------------
export interface PayloadSweepPoint {
  payloadG: number; mtowKg: number; takeoffRunM: number; takeoffMarkM: number;
  alt60M: number; glideDistM: number; pylonTimeS: number; batteryMarginPct: number;
  efficient: number; pPI: number; multiplier: number; pEquipo: number; points: number;
  flies: boolean;
}

export interface PayloadSweep { points: PayloadSweepPoint[]; best: PayloadSweepPoint | null; maxPayloadG: number; }

export function payloadSweep(study: Xc27Study, steps = 30): PayloadSweep {
  const { model, drive, strategy } = study;
  // Tope físico del barrido: la carga con la que la carrera ya no cabe en
  // los 60 m, más un poco para que la curva enseñe el precipicio.
  const runAt = (payloadG: number) => {
    const vars = xc27Vars(study.spec, { payloadG });
    const r = runRound(model, drive, vars, strategy);
    return { vars, r };
  };
  let hi = 500;
  while (hi < 20000 && runAt(hi).r.ev.metrics.takeoffRunM < 60) hi *= 1.5;
  const maxP = Math.min(20000, hi * 1.05);

  const points: PayloadSweepPoint[] = [];
  let best: PayloadSweepPoint | null = null;
  for (let i = 0; i <= steps; i++) {
    const payloadG = (maxP * i) / steps;
    const { r } = runAt(payloadG);
    const m = r.ev.metrics;
    const flies = r.ev.feasible && m.takeoffMarkM <= 60 && m.batteryMarginPct >= 0 && m.cruiseSpeedMs > 0;
    const pt: PayloadSweepPoint = {
      payloadG, mtowKg: m.mtowKg, takeoffRunM: m.takeoffRunM, takeoffMarkM: m.takeoffMarkM,
      alt60M: m.alt60M, glideDistM: m.glideDistM, pylonTimeS: m.pylonTimeS, batteryMarginPct: m.batteryMarginPct,
      efficient: r.sim.result.efficient, pPI: r.sim.result.pPI, multiplier: r.sim.result.multiplier,
      pEquipo: flies ? r.sim.result.pEquipo : 0, points: flies ? r.sim.pointsRaw : 0, flies,
    };
    points.push(pt);
    if (flies && (!best || pt.pEquipo > best.pEquipo)) best = pt;
  }
  return { points, best, maxPayloadG: maxP };
}

// ------------------------------------------------------------------
//  Predicción de carga frente a la densidad del aire (§6.2)
// ------------------------------------------------------------------
export interface PredictionPoint { rho: number; payloadG: number; }
export interface PayloadPrediction {
  markM: number;
  minAlt60M: number;
  points: PredictionPoint[];
  slope: number;           // g por kg/m³
  intercept: number;       // g
  r2: number;
  equation: string;        // MPL [kg] = a·ρ + b
  atDesignG: number;       // predicción a la densidad de diseño
}

/**
 * Carga máxima transportable en función de ρ. Criterio: despegar dentro de
 * la marca declarada (con el margen de la estrategia) y alcanzar al menos
 * `minAlt60M` a los 60 s. Se ajusta una recta, que es la «ecuación de
 * predicción de carga» que exige el informe técnico.
 */
export function payloadPrediction(study: Xc27Study, markM: 20 | 40 | 60, minAlt60M: number, n = 9): PayloadPrediction {
  const { spec, strategy } = study;
  const points: PredictionPoint[] = [];
  const rhoLo = 1.02, rhoHi = 1.24;
  for (let i = 0; i < n; i++) {
    const rho = rhoLo + ((rhoHi - rhoLo) * i) / (n - 1);
    const s2: Xc27Spec = { ...spec, rho };
    const vars0 = xc27Vars(s2);
    const { model, drive } = buildParts(s2, vars0);
    const ok = (payloadG: number): boolean => {
      const vars = xc27Vars(s2, { payloadG });
      const r = runRound(model, drive, vars, strategy);
      const m = r.ev.metrics;
      return m.cruiseSpeedMs > 0 && m.takeoffRunM * strategy.takeoffMargin <= markM && m.alt60M >= minAlt60M - 1e-6;
    };
    let lo = 0, hi = 20000;
    if (!ok(0)) { points.push({ rho, payloadG: 0 }); continue; }
    for (let it = 0; it < 14; it++) {
      const mid = (lo + hi) / 2;
      if (ok(mid)) lo = mid; else hi = mid;
    }
    points.push({ rho, payloadG: lo });
  }
  // recta de mínimos cuadrados
  const N = points.length;
  const sx = points.reduce((s, p) => s + p.rho, 0), sy = points.reduce((s, p) => s + p.payloadG, 0);
  const sxx = points.reduce((s, p) => s + p.rho * p.rho, 0), sxy = points.reduce((s, p) => s + p.rho * p.payloadG, 0);
  const den = N * sxx - sx * sx;
  const slope = den !== 0 ? (N * sxy - sx * sy) / den : 0;
  const intercept = (sy - slope * sx) / N;
  const mean = sy / N;
  const ssTot = points.reduce((s, p) => s + (p.payloadG - mean) ** 2, 0);
  const ssRes = points.reduce((s, p) => s + (p.payloadG - (slope * p.rho + intercept)) ** 2, 0);
  const sign = intercept >= 0 ? '+' : '−';
  return {
    markM, minAlt60M, points, slope, intercept,
    r2: ssTot > 0 ? 1 - ssRes / ssTot : 1,
    equation: `MPL [kg] = ${(slope / 1000).toFixed(3)}·ρ ${sign} ${Math.abs(intercept / 1000).toFixed(3)}`,
    atDesignG: slope * spec.rho + intercept,
  };
}

// ------------------------------------------------------------------
//  Modelo de empuje T(V, δ) (§6.2)
// ------------------------------------------------------------------
export interface ThrustModelFit {
  v: number[];
  curves: { throttle: number; thrustN: number[]; currentA: number[] }[];
  sustainedN: number[];    // con el límite de corriente de motor/ESC aplicado
  /** T ≈ c0·δ² + c1·δ·V + c2·V²  (N, δ = 0…1, V en m/s) */
  c: [number, number, number];
  r2: number;
  equation: string;
  staticThrustN: number;
  staticCurrentA: number;
  iLimitA: number;
}

export function thrustModel(study: Xc27Study, vMax = 40): ThrustModelFit {
  const map = study.drive.map;
  const iLimit = Math.min(study.drive.motor.iMax, study.drive.esc.iMax);
  const lerpV = (row: number[], V: number) => {
    const dx = map.v[1] - map.v[0];
    const i = Math.min(map.v.length - 2, Math.floor(V / dx));
    const f = (V - map.v[i]) / dx;
    return row[i] + f * (row[i + 1] - row[i]);
  };
  const v: number[] = [];
  for (let V = 0; V <= vMax + 1e-9; V += 2) v.push(V);
  const rows = [map.thr.length - 1, Math.round((map.thr.length - 1) * 0.69), Math.round((map.thr.length - 1) * 0.375)];
  const curves = rows.map((r) => ({
    throttle: map.thr[r],
    thrustN: v.map((V) => lerpV(map.thrust[r], V)),
    currentA: v.map((V) => lerpV(map.current[r], V)),
  }));
  const sustainedN = v.map((V) => sustainedPower(map, V, iLimit).thrustN);

  // mínimos cuadrados sobre todo el mapa con empuje positivo
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  const samples: [number, number, number][] = [];
  for (let r = 0; r < map.thr.length; r++) {
    for (let j = 0; j < map.v.length; j++) {
      const V = map.v[j], T = map.thrust[r][j];
      const d = map.thr[r];
      // zona útil del informe: de medio gas a tope y hasta la velocidad de pilones
      if (V > vMax || T <= 0.05 || d < 0.45) continue;
      const f = [d * d, d * V, V * V];
      samples.push([d, V, T]);
      for (let a = 0; a < 3; a++) { b[a] += f[a] * T; for (let c = 0; c < 3; c++) A[a][c] += f[a] * f[c]; }
    }
  }
  const c = solve3(A, b);
  const mean = samples.reduce((s, x) => s + x[2], 0) / Math.max(1, samples.length);
  let ssTot = 0, ssRes = 0;
  for (const [d, V, T] of samples) {
    ssTot += (T - mean) ** 2;
    ssRes += (T - (c[0] * d * d + c[1] * d * V + c[2] * V * V)) ** 2;
  }
  const sg = (x: number) => (x >= 0 ? '+' : '−');
  return {
    v, curves, sustainedN, c, r2: ssTot > 0 ? 1 - ssRes / ssTot : 1,
    equation: `T [N] = ${c[0].toFixed(2)}·δ² ${sg(c[1])} ${Math.abs(c[1]).toFixed(3)}·δ·V ${sg(c[2])} ${Math.abs(c[2]).toFixed(4)}·V²`,
    staticThrustN: map.thrust[map.thr.length - 1][0],
    staticCurrentA: map.current[map.thr.length - 1][0],
    iLimitA: iLimit,
  };
}

function solve3(A: number[][], b: number[]): [number, number, number] {
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k <= 3; k++) M[r][k] -= f * M[c][k];
    }
  }
  return [M[0][3] / (M[0][0] || 1e-12), M[1][3] / (M[1][1] || 1e-12), M[2][3] / (M[2][2] || 1e-12)];
}

// ------------------------------------------------------------------
//  Perfil de la ronda (altitud frente al tiempo) para el gráfico
// ------------------------------------------------------------------
export interface ProfilePoint { t: number; h: number; phase: string; }

export function roundProfile(study: Xc27Study): ProfilePoint[] {
  const f = study.flight, st = study.strategy;
  const pts: ProfilePoint[] = [];
  let t = 0;
  const add = (dt: number, h: number, phase: string) => { t += dt; pts.push({ t, h, phase }); };
  pts.push({ t: 0, h: 0, phase: 'Despegue 1' });
  add(4, 0, 'Despegue 1');
  add(XC27_LIMITS.climbS, f.climb.alt60M, 'Ascenso 60 s');
  if (f.climb.altCutM > f.climb.alt60M + 0.5 && f.climb.rocMs > 0) {
    add((f.climb.altCutM - f.climb.alt60M) / f.climb.rocMs, f.climb.altCutM, 'Ascenso al techo');
  }
  add(f.glide.timeS, Math.min(f.climb.altCutM, st.glideEndAltM), 'Planeo');
  add(20, 0, 'Aproximación 1');
  add(XC27_LIMITS.pitstopMaxS * 0.5, 0, 'Pitstop');
  add(4, 0, 'Despegue 2');
  add(st.climb2S, 40, 'Ascenso 2');
  add(f.pylons.timeS < 900 ? f.pylons.timeS : 0, 40, 'Pilones');
  add(30, 0, 'Aproximación 2');
  return pts;
}

// ------------------------------------------------------------------
//  Diagrama de maniobras V-n (§6.2: mínimo exigido en estructuras)
// ------------------------------------------------------------------
export interface VnDiagram {
  massKg: number;
  vs: number; va: number; vc: number; vd: number;
  nPos: number; nNeg: number;
  maneuver: { v: number; n: number }[];   // polígono cerrado
  gustPos: { v: number; n: number }[];
  gustNeg: { v: number; n: number }[];
  nGustMax: number;
  nDesign: number;                        // factor límite que dimensiona (maniobra o ráfaga)
}

export function vnDiagram(
  model: AeroModel, massKg: number, rho: number, nPos: number, nNeg: number, vc: number, gustMs = 5,
): VnDiagram {
  const W = massKg * G, S = model.S;
  const clMax = model.clMaxWing;
  const clMin = -0.6 * clMax;               // ala con curvatura: menos sustentación invertida
  const vs = Math.sqrt((2 * W) / (rho * S * clMax));
  const vsNeg = Math.sqrt((2 * W) / (rho * S * Math.abs(clMin)));
  const va = vs * Math.sqrt(nPos);
  const vaNeg = vsNeg * Math.sqrt(Math.abs(nNeg));
  const vC = Math.max(vc, va * 1.05);
  const vd = 1.3 * vC;

  const maneuver: { v: number; n: number }[] = [];
  for (let i = 0; i <= 20; i++) { const v = (va * i) / 20; maneuver.push({ v, n: (v / vs) ** 2 }); }
  maneuver.push({ v: vd, n: nPos });
  maneuver.push({ v: vd, n: nNeg * 0.5 });
  maneuver.push({ v: vC, n: nNeg });
  for (let i = 20; i >= 0; i--) { const v = (Math.min(vaNeg, vC) * i) / 20; maneuver.push({ v, n: -((v / vsNeg) ** 2) }); }

  // ráfaga (Pratt): Δn = Kg·ρ·U·V·a / (2·W/S)
  const a = model.clAlphaPerRad;
  const mu = (2 * (W / S)) / (rho * model.macLen * a * G);
  const kg = (0.88 * mu) / (5.3 + mu);
  const dn = (v: number, u: number) => (kg * rho * u * v * a) / (2 * (W / S));
  const gustPos = [{ v: 0, n: 1 }, { v: vC, n: 1 + dn(vC, gustMs) }, { v: vd, n: 1 + dn(vd, gustMs / 2) }];
  const gustNeg = [{ v: 0, n: 1 }, { v: vC, n: 1 - dn(vC, gustMs) }, { v: vd, n: 1 - dn(vd, gustMs / 2) }];
  const nGustMax = Math.max(gustPos[1].n, gustPos[2].n);
  return { massKg, vs, va, vc: vC, vd, nPos, nNeg, maneuver, gustPos, gustNeg, nGustMax, nDesign: Math.max(nPos, nGustMax) };
}

// ------------------------------------------------------------------
//  Flexión del ala (§6.2 y ensayo prevuelo de §7.9)
// ------------------------------------------------------------------
export interface SparMaterial { id: string; name: string; sigmaMPa: number; rho: number; eGPa: number; eurPerKg: number; }

/** Admisibles a compresión conservadores para largueros de aeromodelo. */
export const SPAR_MATERIALS: SparMaterial[] = [
  { id: 'carbono', name: 'Carbono UD pultrusionado', sigmaMPa: 800, rho: 1550, eGPa: 120, eurPerKg: 160 },
  { id: 'vidrio', name: 'Fibra de vidrio UD', sigmaMPa: 300, rho: 1900, eGPa: 35, eurPerKg: 35 },
  { id: 'pino', name: 'Pino / abeto', sigmaMPa: 35, rho: 450, eGPa: 10, eurPerKg: 8 },
  { id: 'balsa', name: 'Balsa dura', sigmaMPa: 9, rho: 170, eGPa: 3.5, eurPerKg: 60 },
  { id: 'aluminio', name: 'Aluminio 6061-T6', sigmaMPa: 240, rho: 2700, eGPa: 69, eurPerKg: 12 },
];

export interface SparOption { material: SparMaterial; capAreaMm2: number; capMassG: number; tipDeflectionMm: number; }

export interface WingBending {
  wingMassKg: number;
  rootMomentFlight1g: number;    // N·m a 1 g
  rootMomentLimit: number;       // N·m al factor límite
  rootMomentTest: number;        // N·m en el ensayo de puntas
  testEquivalentG: number;       // factor de carga de vuelo equivalente al ensayo
  designMoment: number;          // N·m de cálculo (el mayor, × coeficiente de seguridad)
  rootShearLimit: number;        // N
  sparHeightMm: number;          // distancia entre centros de los cordones en la raíz
  capForceN: number;
  options: SparOption[];
  tubeOdMm: number;              // tubo de carbono de pared 1 mm equivalente
  stations: { y: number; moment: number }[];  // momento flector de vuelo al factor límite
}

export function wingBending(
  planform: Planform, airfoil: Airfoil, masses: MassBreakdown, nLimit: number, safety = 1.5,
): WingBending {
  const b = planform.spanM, half = b / 2;
  const W = (masses.mtowG / 1000) * G;
  const Ww = (masses.wingG / 1000) * G;
  const lam = planform.taper;
  // centro de la semicarga elíptica y centroide de área de la semiala trapezoidal
  const yLift = (4 / (3 * Math.PI)) * half;
  const yWing = (b / 6) * (1 + 2 * lam) / (1 + lam);
  const m1g = (W / 2) * yLift - (Ww / 2) * yWing;
  const rootMomentLimit = nLimit * m1g;
  // Ensayo: dos personas levantan el avión cargado por las puntas (mano ≤ 10 cm)
  const ySupport = half - 0.05;
  const rootMomentTest = (W / 2) * ySupport - (Ww / 2) * yWing;
  const designMoment = Math.max(rootMomentLimit, rootMomentTest) * safety;

  const cr = rootChordOf(planform);
  const h = 0.80 * airfoil.tc * cr;          // cordones separados ~80 % del espesor máximo
  const capForceN = designMoment / Math.max(1e-4, h);
  const options: SparOption[] = SPAR_MATERIALS.map((material) => {
    const capAreaMm2 = capForceN / material.sigmaMPa;
    // dos cordones que se afinan hacia la punta (~55 % del volumen de sección constante)
    const capMassG = 2 * (capAreaMm2 * 1e-6) * b * material.rho * 0.55 * 1000;
    // flecha en el ensayo: viga biapoyada con la carga central (fuselaje) en el centro
    const I = 2 * (capAreaMm2 * 1e-6) * (h / 2) ** 2;
    const L = 2 * ySupport;
    const tipDeflectionMm = I > 0 ? (((W - Ww) * L ** 3) / (48 * material.eGPa * 1e9 * I)) * 1000 : 0;
    return { material, capAreaMm2, capMassG, tipDeflectionMm };
  });

  // tubo de carbono de pared 1 mm: Z = π(D⁴ − d⁴)/(32·D) ≥ M/σ
  const zReq = designMoment / (SPAR_MATERIALS[0].sigmaMPa * 1e6);
  let tubeOdMm = 4;
  for (; tubeOdMm < 60; tubeOdMm += 0.5) {
    const D = tubeOdMm / 1000, d = D - 0.002;
    if ((Math.PI * (D ** 4 - d ** 4)) / (32 * D) >= zReq) break;
  }

  // momento a lo largo de la semienvergadura (carga elíptica menos peso del ala)
  const stations: { y: number; moment: number }[] = [];
  const N = 40;
  for (let i = 0; i <= 20; i++) {
    const y0 = (half * i) / 20;
    let mom = 0;
    for (let k = 0; k < N; k++) {
      const y = y0 + ((half - y0) * (k + 0.5)) / N;
      const dy = (half - y0) / N;
      const lift = ((nLimit * W) / 2) * (4 / (Math.PI * half)) * Math.sqrt(Math.max(0, 1 - (y / half) ** 2));
      const chordFrac = (1 - (1 - lam) * (y / half)) / ((1 + lam) / 2);
      const weight = ((nLimit * Ww) / 2 / half) * chordFrac;
      mom += (lift - weight) * (y - y0) * dy;
    }
    stations.push({ y: y0, moment: mom });
  }

  return {
    wingMassKg: masses.wingG / 1000, rootMomentFlight1g: m1g, rootMomentLimit, rootMomentTest,
    testEquivalentG: m1g > 0 ? rootMomentTest / m1g : 0, designMoment,
    rootShearLimit: (nLimit * (W - Ww)) / 2, sparHeightMm: h * 1000, capForceN, options, tubeOdMm, stations,
  };
}

// ------------------------------------------------------------------
//  Centrado y estabilidad estática longitudinal (§6.1, §6.2, §7.8)
// ------------------------------------------------------------------
export interface MassItem { id: string; label: string; massG: number; xM: number; payload?: boolean; }

export interface Layout {
  fuseLengthM: number;
  fuseWidthM: number;
  wingLeM: number;          // borde de ataque de la raíz del ala, desde el morro
  tailArmLeM: number;       // de borde de ataque del ala a borde de ataque del estabilizador
  hSpanM: number; hChordM: number;
  vHeightM: number; vRootM: number; vTipM: number;
  items: MassItem[];
}

/**
 * Disposición de partida: cola por coeficientes de volumen típicos, masas del
 * buildup y el ala colocada donde el avión descargado queda con un 12 % de
 * margen estático. El arroz va sobre el CG para que descargarlo no lo mueva.
 */
export function defaultLayout(study: Xc27Study): Layout {
  const { model, planform, ev } = study;
  const S = model.S, mac = model.macLen, b = planform.spanM;
  const Lf = Math.max(model.fuse.length, 0.55 * b);
  const ms = ev.masses;
  const tailG = Math.min(ms.fuseTailG * 0.6, 1000 * 0.22 * S * 1.45 * study.vars.buildFactor);

  const at = (wingLeM: number, batteryM = 0.20): Layout => {
    let hChordM = 0.6 * mac, hSpanM = 0.6;
    let tailArmLeM = Lf - wingLeM - hChordM;
    for (let i = 0; i < 3; i++) {
      const lh = tailArmLeM + 0.25 * hChordM - 0.25 * mac;
      const Sh = (0.50 * S * mac) / Math.max(0.2, lh);       // V_h = 0.50
      hSpanM = Math.sqrt(4 * Sh);                            // alargamiento 4
      hChordM = hSpanM / 4;
      tailArmLeM = Lf - wingLeM - hChordM;
    }
    const Sv = (0.04 * S * b) / Math.max(0.2, tailArmLeM);   // V_v = 0.04
    const vHeightM = Math.sqrt(1.5 * Sv);
    const cv = Sv / vHeightM;
    const xLeMac = wingLeM + 0.25 * (rootChordOf(planform) - macOf(planform));
    const items: MassItem[] = [
      { id: 'motor', label: 'Motor + hélice', massG: ms.motorG + ms.propG, xM: 0.03 },
      { id: 'esc', label: 'Variador (ESC)', massG: ms.escG, xM: 0.12 },
      { id: 'bateria', label: 'Batería principal', massG: ms.batteryG, xM: batteryM },
      { id: 'radio', label: 'Receptor, servos y batería auxiliar', massG: ms.avionicsG, xM: xLeMac + 0.6 * mac },
      { id: 'telemetria', label: 'Caja de telemetría', massG: ms.fixedG, xM: xLeMac + 0.35 * mac },
      { id: 'ala', label: 'Ala', massG: ms.wingG, xM: xLeMac + 0.42 * mac },
      { id: 'fuselaje', label: 'Fuselaje, tren y varios', massG: Math.max(0, ms.fuseTailG - tailG + ms.miscG), xM: 0.42 * Lf },
      { id: 'cola', label: 'Empenaje', massG: tailG, xM: wingLeM + tailArmLeM + 0.4 * hChordM },
      { id: 'carga', label: 'Arroz (carga de pago)', massG: ms.payloadG, xM: xLeMac + 0.30 * mac, payload: true },
    ];
    return {
      fuseLengthM: Lf, fuseWidthM: model.fuse.diameter, wingLeM, tailArmLeM,
      hSpanM, hChordM, vHeightM, vRootM: cv * 1.25, vTipM: cv * 0.75, items,
    };
  };

  // Mover el ala hacia atrás adelanta el CG respecto al punto neutro. Se
  // limita al 40 % del fuselaje para no quedarse sin brazo de cola.
  const sm = (l: Layout) => stabilityOf(study, l).smEmptyPct;
  let lo = 0.15 * Lf, hi = 0.40 * Lf;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (sm(at(mid)) < 12) lo = mid; else hi = mid;
  }
  const wingLeM = (lo + hi) / 2;
  // Ajuste fino con la batería, que es lo que se mueve en el avión real.
  let bLo = 0.06, bHi = wingLeM + 0.6 * mac;
  for (let i = 0; i < 16; i++) {
    const mid = (bLo + bHi) / 2;
    if (sm(at(wingLeM, mid)) > 12) bLo = mid; else bHi = mid;
  }
  const layout = at(wingLeM, (bLo + bHi) / 2);
  // el arroz, sobre el CG en vacío: descargar no cambia el centrado
  const st = stabilityOf(study, layout);
  const rice = layout.items.find((i) => i.payload);
  if (rice) rice.xM = st.cgEmptyM;
  return layout;
}

export interface Stability {
  macM: number; xLeMacM: number;
  sH: number; sV: number; vH: number; vV: number; arH: number;
  xNpM: number; npPctMac: number;
  cgLoadedM: number; cgEmptyM: number;
  cgLoadedPct: number; cgEmptyPct: number;
  smLoadedPct: number; smEmptyPct: number;
  cgShiftMm: number;                 // cuánto se mueve el CG al descargar
  cgFwdLimitM: number; cgAftLimitM: number;  // para un margen del 20 % y del 5 %
  massLoadedG: number; massEmptyG: number;
  notes: { level: 'ok' | 'aviso' | 'mal'; text: string }[];
}

export function stabilityOf(study: Xc27Study, layout: Layout): Stability {
  const { model, planform } = study;
  const S = model.S, b = planform.spanM, mac = macOf(planform);
  const xLeMacM = layout.wingLeM + 0.25 * (rootChordOf(planform) - mac);
  const sH = layout.hSpanM * layout.hChordM;
  const sV = (layout.vHeightM * (layout.vRootM + layout.vTipM)) / 2;
  const arH = sH > 0 ? (layout.hSpanM * layout.hSpanM) / sH : 0;
  const xAcW = xLeMacM + 0.25 * mac;
  const lH = layout.wingLeM + layout.tailArmLeM + 0.25 * layout.hChordM - xAcW;
  const lV = layout.wingLeM + layout.tailArmLeM + 0.25 * layout.vRootM - xAcW;
  const vH = (sH * lH) / (S * mac);
  const vV = (sV * lV) / (S * b);

  const aW = model.clAlphaPerRad;
  const aT = (2 * Math.PI * arH) / (2 + Math.sqrt(4 + arH * arH));     // Helmbold
  const deda = Math.min(0.8, (2 * aW) / (Math.PI * model.aspectRatio));
  // fuselaje (Gilruth/Raymer): desestabiliza en proporción a w²·L
  const dFus = (0.57 * layout.fuseWidthM ** 2 * layout.fuseLengthM) / (S * mac * aW);
  const hN = 0.25 + 0.9 * vH * (aT / aW) * (1 - deda) - dFus;
  const xNpM = xLeMacM + hN * mac;

  const cg = (items: MassItem[]) => {
    const m = items.reduce((s, i) => s + i.massG, 0);
    return { m, x: m > 0 ? items.reduce((s, i) => s + i.massG * i.xM, 0) / m : 0 };
  };
  const loaded = cg(layout.items);
  const empty = cg(layout.items.filter((i) => !i.payload));
  const pct = (x: number) => (100 * (x - xLeMacM)) / mac;
  const smLoadedPct = (100 * (xNpM - loaded.x)) / mac;
  const smEmptyPct = (100 * (xNpM - empty.x)) / mac;

  const notes: Stability['notes'] = [];
  const judge = (sm: number, who: string) => {
    if (sm < 0) notes.push({ level: 'mal', text: `${who}: margen estático negativo (${sm.toFixed(1)} %): el avión es inestable en cabeceo.` });
    else if (sm < 5) notes.push({ level: 'aviso', text: `${who}: margen estático de ${sm.toFixed(1)} %, por debajo del 5 %: muy sensible al mando de profundidad.` });
    else if (sm > 20) notes.push({ level: 'aviso', text: `${who}: margen estático de ${sm.toFixed(1)} %, por encima del 20 %: mucho timón para rotar y más resistencia de trimado.` });
    else notes.push({ level: 'ok', text: `${who}: margen estático de ${sm.toFixed(1)} %, dentro del 5–20 % recomendado.` });
  };
  judge(smLoadedPct, 'Cargado (ascenso y planeo)');
  judge(smEmptyPct, 'Descargado (pilones)');
  const shift = (empty.x - loaded.x) * 1000;
  if (Math.abs(shift) > 0.03 * mac * 1000) {
    notes.push({ level: 'aviso', text: `El CG se mueve ${Math.abs(shift).toFixed(0)} mm hacia ${shift > 0 ? 'atrás' : 'delante'} al descargar el arroz. Centra la bahía sobre el CG para que el pitstop no cambie el trimado.` });
  } else {
    notes.push({ level: 'ok', text: `La bahía está prácticamente sobre el CG: descargar sólo lo mueve ${Math.abs(shift).toFixed(0)} mm.` });
  }
  if (vH < 0.35) notes.push({ level: 'aviso', text: `Coeficiente de volumen horizontal ${vH.toFixed(2)}: bajo (típico 0.40–0.60). Más superficie o más brazo de cola.` });
  if (vV < 0.025) notes.push({ level: 'aviso', text: `Coeficiente de volumen vertical ${vV.toFixed(3)}: bajo (típico 0.030–0.050).` });
  if (study.airfoil.cm0 < -0.15) notes.push({ level: 'aviso', text: `El ${study.airfoil.name} tiene Cm₀ = ${study.airfoil.cm0}: exige un estabilizador con bastante carga hacia abajo. Comprueba el trimado en XFLR5/AVL.` });

  return {
    macM: mac, xLeMacM, sH, sV, vH, vV, arH, xNpM, npPctMac: pct(xNpM),
    cgLoadedM: loaded.x, cgEmptyM: empty.x, cgLoadedPct: pct(loaded.x), cgEmptyPct: pct(empty.x),
    smLoadedPct, smEmptyPct, cgShiftMm: shift,
    cgFwdLimitM: xNpM - 0.20 * mac, cgAftLimitM: xNpM - 0.05 * mac,
    massLoadedG: loaded.m, massEmptyG: empty.m, notes,
  };
}

// ------------------------------------------------------------------
//  Bahía de arroz y caja de transporte (§7.3, §7.8)
// ------------------------------------------------------------------
export interface RiceBay { volumeL: number; minVolumeL: number; lengthInFuseM: number; fitsInFuse: boolean; fuseUsePct: number; }

export function riceBay(payloadG: number, layout: Layout): RiceBay {
  const volumeL = riceVolumeL(payloadG);
  // sección interior aprovechable ≈ 70 % de la sección exterior del fuselaje
  const area = 0.70 * Math.PI * (layout.fuseWidthM / 2) ** 2;
  const lengthInFuseM = area > 0 ? (volumeL / 1000) / area : 99;
  return {
    volumeL, minVolumeL: riceVolumeL(XC27_LIMITS.minPayloadG), lengthInFuseM,
    fitsInFuse: lengthInFuseM <= 0.45 * layout.fuseLengthM,
    fuseUsePct: (100 * lengthInFuseM) / layout.fuseLengthM,
  };
}

export interface BoxSpec { lengthMm: number; widthMm: number; heightMm: number; wingPanels: number; fusePieces: number; }
export interface BoxPart { label: string; qty: number; dimsMm: [number, number, number]; fits: boolean; }
export interface BoxCheck {
  sumMm: number; sumOk: boolean; marginMm: number;
  parts: BoxPart[];
  sectionFits: boolean;       // la pila de alas + fuselaje cabe en ancho × alto
  sectionLayout: string;
  ok: boolean;
  maxSpanM: number;           // envergadura máxima con estos paneles en esta caja
  notes: string[];
}

const boxGeometry = (study: Xc27Study, layout: Layout): BoxGeometry => ({
  spanM: study.planform.spanM, rootChordM: rootChordOf(study.planform), thickness: study.airfoil.tc,
  fuseLengthM: layout.fuseLengthM, fuseWidthM: layout.fuseWidthM,
});

/** Caja mínima para este avión, redondeada al centímetro, como punto de partida. */
export function suggestedBox(study: Xc27Study, layout: Layout, fusePieces = 2): BoxSpec {
  const m = minTransportBox(boxGeometry(study, layout), fusePieces);
  const up = (x: number) => Math.ceil(x / 10) * 10;
  return { lengthMm: up(m.lengthMm), widthMm: up(m.widthMm), heightMm: up(m.heightMm), wingPanels: m.panels, fusePieces };
}

export function boxCheck(study: Xc27Study, layout: Layout, box: BoxSpec): BoxCheck {
  const { planform, airfoil } = study;
  const g = boxGeometry(study, layout);
  const sumMm = box.lengthMm + box.widthMm + box.heightMm;
  const L = box.lengthMm - BOX_CLEARANCE_MM;
  const cross = [box.widthMm, box.heightMm].sort((a, b) => b - a);
  const cr = rootChordOf(planform) * 1000;
  const panels = Math.max(1, Math.round(box.wingPanels));
  const fusePieces = Math.max(1, Math.round(box.fusePieces));
  // una pieza cabe si su largo entra en la caja y su sección en ancho × alto
  const fits = (d: [number, number, number]) => {
    const s = [...d].sort((a, b) => b - a);
    return s[0] <= L && s[1] <= cross[0] && s[2] <= cross[1];
  };
  const mk = (label: string, qty: number, dimsMm: [number, number, number]): BoxPart =>
    ({ label, qty, dimsMm, fits: fits(dimsMm) });
  const parts: BoxPart[] = [
    mk('Panel de ala', panels, [(planform.spanM * 1000) / panels, cr, airfoil.tc * cr]),
    mk('Tramo de fuselaje', fusePieces, [(layout.fuseLengthM * 1000) / fusePieces, layout.fuseWidthM * 1000, layout.fuseWidthM * 1000]),
    mk('Estabilizador horizontal', 1, [layout.hSpanM * 1000, layout.hChordM * 1000, 0.09 * layout.hChordM * 1000 + 4]),
    mk('Estabilizador vertical', 1, [layout.vHeightM * 1000, layout.vRootM * 1000, 0.09 * layout.vRootM * 1000 + 4]),
  ];
  // todo a la vez: la pila de paneles con el fuselaje al lado o encima
  const fit = boxSections(g, panels).find((o) => {
    const need = [o.widthMm, o.heightMm].sort((a, b) => b - a);
    return need[0] <= cross[0] && need[1] <= cross[1];
  });
  const notes: string[] = [];
  const sumOk = sumMm <= XC27_LIMITS.boxSumMm;
  if (!sumOk) notes.push(`La caja suma ${sumMm} mm: ${sumMm - XC27_LIMITS.boxSumMm} mm por encima del límite de 1300 mm.`);
  for (const p of parts) if (!p.fits) notes.push(`${p.label}: ${p.dimsMm.map((d) => d.toFixed(0)).join(' × ')} mm no cabe en ${box.lengthMm} × ${box.widthMm} × ${box.heightMm} mm.`);
  if (!fit) {
    const need = boxSections(g, panels).map((o) => `${o.widthMm.toFixed(0)} × ${o.heightMm.toFixed(0)} mm (${o.layout})`).join(' o ');
    notes.push(`La pila de ${panels} paneles más el fuselaje no cabe en la sección de ${box.widthMm} × ${box.heightMm} mm: hacen falta ${need}.`);
  }
  return {
    sumMm, sumOk, marginMm: XC27_LIMITS.boxSumMm - sumMm, parts,
    sectionFits: !!fit, sectionLayout: fit?.layout ?? '—',
    ok: sumOk && parts.every((p) => p.fits) && !!fit,
    maxSpanM: (panels * L) / 1000, notes,
  };
}

/** Carrera de despegue a otra masa/densidad sin rehacer el estudio entero. */
export const takeoffRunFor = (study: Xc27Study, massKg: number) =>
  takeoffRunOf(study.model, study.drive.map, massKg * G, study.spec.rho, study.vars.rollingMu);
