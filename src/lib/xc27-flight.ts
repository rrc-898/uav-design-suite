// ==================================================================
//  XtraChallenge 2027 — simulación de la ronda de vuelo.
//
//  Traduce un avión ya modelado (AeroModel + mapa de propulsión) a las
//  cuatro magnitudes que mide la caja de telemetría y el cronómetro:
//
//    1. Despegue 1   carrera sobre asfalto  → marca de 20 / 40 / 60 m
//    2. Ascenso      60 s a potencia sostenible → altitud A_60s
//    3. Planeo       motor parado desde la altitud de corte → distancia D_R
//    4. Pilones      10 × 100 m con 9 virajes, SIN la carga → tiempo T_PI
//
//  y comprueba que una sola batería aguanta la ronda entera, porque en
//  el pitstop no se puede cambiar.
//
//  Modelos (todos cuasi-estacionarios, los mismos que el resto de la
//  suite, para que el optimizador pueda llamarlos ~10⁵ veces):
//    · Ascenso:  exceso de potencia específica Ps = V·(T − D)/W a la
//                velocidad de mejor ascenso, menos la energía cinética
//                que hay que ganar desde la rotación.
//    · Planeo:   fineza máxima con la resistencia de la hélice parada
//                (o plegada) añadida a la polar.
//    · Pilones:  balance de energía sobre un ciclo recta + viraje de
//                180° a factor de carga n; se elige el n que da menos
//                tiempo. El viraje cerrado acorta el arco pero frena.
// ==================================================================

import {
  rootChordOf, sustainedPower, type AeroModel, type DriveMap, type ExtraContext,
  type ExtraResult, type Metrics,
} from './design';
import {
  XC27_LIMITS, ALT_SCORE_PEAK_M, scoreXc27Round, roundPoints, takeoffMarkFor, minTransportBox,
  type MinBox, type PayloadUnit, type TakeoffMark, type Xc27RoundInput, type Xc27RoundResult,
} from './xc27';

const G = 9.80665;

// ------------------------------------------------------------------
//  Estrategia y supuestos del equipo
// ------------------------------------------------------------------
export interface Xc27Strategy {
  altCeilingM: number;       // techo operativo: 120 m menos el margen del piloto
  glideEndAltM: number;      // altitud a la que se reenciende el motor (> 10 m)
  glidePathFactor: number;   // pérdidas del planeo real: virajes, ráfagas, pilotaje
  climbEfficiency: number;   // fracción del ascenso ideal que logra el piloto
  climbBeyond60: boolean;    // seguir subiendo tras los 60 s antes de cortar motor
  takeoffMargin: number;     // carrera simulada × margen ≤ marca declarada
  pylonMaxG: number;         // factor de carga máximo en los virajes
  pylonOvershootM: number;   // metros de más por viraje (anticipación del piloto)
  climb2S: number;           // ascenso tras el pitstop hasta entrar en pilones, s
  loadBaseS: number;         // tiempo fijo de carga + descarga (abrir, cerrar, correr)
  loadRateGs: number;        // caudal medio de arroz, g/s (contando carga y descarga)
  carryFraction: number;     // carga transportada / declarada (0.9 … 1)
  externalPilot: boolean;
  payloadUnit: PayloadUnit;
  pMaxRef: number;           // P_equipo de la mejor marca de la ronda
}

export const XC27_DEFAULT_STRATEGY: Xc27Strategy = {
  altCeilingM: 115, glideEndAltM: 15, glidePathFactor: 0.9, climbEfficiency: 0.9,
  climbBeyond60: false, takeoffMargin: 1.15, pylonMaxG: 3.5, pylonOvershootM: 12,
  climb2S: 25, loadBaseS: 25, loadRateGs: 100, carryFraction: 1,
  externalPilot: false, payloadUnit: 'kg', pMaxRef: 3,
};

// ------------------------------------------------------------------
//  Resistencia de la hélice con el motor parado
// ------------------------------------------------------------------

/**
 * Área de resistencia D/q de la hélice frenada (Raymer: 0.8·σ·A_disco, con
 * solidez σ ≈ 0.07 para una bipala de modelismo). Plegada contra el
 * fuselaje queda en torno a una décima parte.
 */
export function stoppedPropDragArea(diaIn: number, folding: boolean): number {
  const d = diaIn * 0.0254;
  const disk = (Math.PI * d * d) / 4;
  return 0.8 * 0.07 * disk * (folding ? 0.1 : 1);
}

// ------------------------------------------------------------------
//  Fases
// ------------------------------------------------------------------
export interface ClimbResult {
  vClimb: number; rocMs: number; currentA: number; throttle: number;
  rawAlt60M: number;       // lo que daría el avión sin techo
  alt60M: number;          // altitud puntuable a los 60 s
  altCutM: number;         // altitud a la que se corta motor (inicio del planeo)
  motorTimeS: number;      // segundos de motor en el primer ascenso
}

export function simulateClimb(
  model: AeroModel, map: DriveMap, W: number, rho: number, vStall: number, iLimit: number, st: Xc27Strategy,
): ClimbResult {
  const S = model.S;
  let best = { v: vStall * 1.3, ps: -99, i: 0, thr: 1 };
  for (let k = 0; k <= 12; k++) {
    const V = vStall * (1.15 + 0.1 * k);
    const CL = (2 * W) / (rho * V * V * S);
    if (CL > model.clMaxWing) continue;
    const D = 0.5 * rho * V * V * S * model.cd(CL, V);
    const p = sustainedPower(map, V, iLimit);
    const ps = (V * (p.thrustN - D)) / W;
    if (ps > best.ps) best = { v: V, ps, i: p.currentA, thr: p.throttle };
  }
  const roc = Math.max(0, best.ps) * st.climbEfficiency;
  // se rota a ~1.2·V_s y hay que acelerar hasta la velocidad de ascenso
  const vLof = 1.2 * vStall;
  const accelLoss = Math.max(0, (best.v * best.v - vLof * vLof) / (2 * G));
  const rawAlt60M = Math.max(0, roc * XC27_LIMITS.climbS - accelLoss);

  const ceiling = Math.min(st.altCeilingM, XC27_LIMITS.altMaxM);
  let alt60M: number, altCutM: number, motorTimeS: number;
  if (st.climbBeyond60) {
    // Se pasa por el máximo de P_AS a los 60 s y se sigue hasta el techo.
    alt60M = Math.min(rawAlt60M, ALT_SCORE_PEAK_M, ceiling);
    altCutM = roc > 0.3 ? ceiling : alt60M;
    motorTimeS = XC27_LIMITS.climbS + (roc > 0.3 ? (altCutM - alt60M) / roc : 0);
  } else {
    alt60M = Math.min(rawAlt60M, ceiling);
    altCutM = alt60M;
    // si sobra ascenso, se llega al techo antes y se mantiene con poco gas
    const tFull = rawAlt60M > ceiling ? (XC27_LIMITS.climbS * ceiling) / rawAlt60M : XC27_LIMITS.climbS;
    motorTimeS = tFull + 0.35 * (XC27_LIMITS.climbS - tFull);
  }
  return { vClimb: best.v, rocMs: roc, currentA: best.i, throttle: best.thr, rawAlt60M, alt60M, altCutM, motorTimeS };
}

export interface GlideResult { ld: number; v: number; sinkMs: number; distM: number; timeS: number; capped: boolean; }

export function simulateGlide(
  model: AeroModel, W: number, rho: number, propDragAreaM2: number, fromAltM: number, st: Xc27Strategy,
): GlideResult {
  const S = model.S;
  const dCd = propDragAreaM2 / S;
  let ld = 0, v = 0;
  for (let k = 0; k <= 14; k++) {
    const CL = model.clMaxWing * (0.30 + 0.043 * k);
    const V = Math.sqrt((2 * W) / (rho * S * CL));
    const r = CL / (model.cd(CL, V) + dCd);
    if (r > ld) { ld = r; v = V; }
  }
  const drop = Math.max(0, fromAltM - st.glideEndAltM);
  let distM = drop * ld * st.glidePathFactor;
  const sinkMs = ld > 0 ? v / ld : 0;
  let timeS = sinkMs > 0 ? drop / sinkMs : 0;
  let capped = false;
  if (timeS > XC27_LIMITS.glideMaxS) {       // tope reglamentario de 7 minutos
    distM *= XC27_LIMITS.glideMaxS / timeS;
    timeS = XC27_LIMITS.glideMaxS;
    capped = true;
  }
  return { ld, v, sinkMs, distM, timeS, capped };
}

export interface PylonResult { timeS: number; v: number; n: number; turnRadiusM: number; turnTimeS: number; currentA: number; }

export function simulatePylons(
  model: AeroModel, map: DriveMap, W: number, rho: number, iLimit: number, windMs: number, st: Xc27Strategy,
): PylonResult {
  const S = model.S;
  const clLim = 0.9 * model.clMaxWing;
  const vStall = Math.sqrt((2 * W) / (rho * S * Math.max(0.3, model.clMaxWing)));
  const leg = XC27_LIMITS.pylonLegM;
  const legs = XC27_LIMITS.pylonLegs;
  const turns = legs - 1;

  // factor de carga realmente disponible a V: lo limita el CLmáx
  const nAt = (V: number, nWant: number) => Math.min(nWant, (clLim * 0.5 * rho * V * V * S) / W);
  const turnTime = (V: number, n: number) => (Math.PI * V) / (G * Math.sqrt(Math.max(1e-3, n * n - 1)));
  const drag = (V: number, n: number) => {
    const q = 0.5 * rho * V * V * S;
    return q * model.cd((n * W) / q, V);
  };
  // energía neta sobre un ciclo recta + viraje; > 0 ⇒ el avión acelera
  const excess = (V: number, nWant: number) => {
    const n = nAt(V, nWant);
    if (n <= 1.02) return -1;
    const ts = leg / V, tt = turnTime(V, n) + st.pylonOvershootM / V;
    const T = sustainedPower(map, V, iLimit).thrustN;
    return T * (ts + tt) - drag(V, 1) * ts - drag(V, n) * tt;
  };

  let best: PylonResult = { timeS: 999, v: 0, n: 1, turnRadiusM: 0, turnTimeS: 0, currentA: 0 };
  const nMax = Math.max(1.2, st.pylonMaxG);
  for (const nWant of [1 + 0.4 * (nMax - 1), 1 + 0.7 * (nMax - 1), nMax]) {
    let lo = vStall * 1.25, hi = 70;
    if (excess(lo, nWant) <= 0) continue;
    for (let it = 0; it < 10; it++) {
      const mid = (lo + hi) / 2;
      if (excess(mid, nWant) > 0) lo = mid; else hi = mid;
    }
    const V = lo;
    const n = nAt(V, nWant);
    const w = Math.min(Math.abs(windMs), V * 0.6);
    // la mitad de los tramos con viento en cara y la otra mitad en cola
    const tLegs = (legs / 2) * leg * (1 / (V - w) + 1 / (V + w));
    const tt = turnTime(V, n) + st.pylonOvershootM / V;
    const timeS = tLegs + turns * tt;
    if (timeS < best.timeS) {
      best = {
        timeS, v: V, n, turnRadiusM: (V * V) / (G * Math.sqrt(n * n - 1)), turnTimeS: tt,
        currentA: sustainedPower(map, V, iLimit).currentA,
      };
    }
  }
  return best;
}

// ------------------------------------------------------------------
//  Ronda completa
// ------------------------------------------------------------------
export interface EnergyPhase { phase: string; seconds: number; amps: number; mah: number; }

export interface Xc27Flight {
  takeoffRunM: number;
  takeoffMark: TakeoffMark;
  climb: ClimbResult;
  glide: GlideResult;
  pylons: PylonResult;
  emptyFlightKg: number;      // masa en los pilones (sin el arroz)
  energy: EnergyPhase[];
  missionMah: number;
  usableMah: number;
  batteryMarginPct: number;
  box: MinBox;
  reasons: string[];
}

export function simulateXc27(ctx: ExtraContext, st: Xc27Strategy): Xc27Flight {
  const { model, drive, masses, vars, rho, W, vStall, base } = ctx;
  const map = drive.map;
  const iLimit = Math.min(drive.motor.iMax, drive.esc.iMax);
  const reasons: string[] = [];

  const climb = simulateClimb(model, map, W, rho, vStall, iLimit, st);
  const glide = simulateGlide(
    model, W, rho, stoppedPropDragArea(drive.prop.dia, drive.prop.folding), climb.altCutM, st,
  );

  const emptyFlightKg = (masses.mtowG - masses.payloadG) / 1000;
  const pylons = simulatePylons(model, map, emptyFlightKg * G, rho, iLimit, vars.windMs, st);

  const ph = (phase: string, seconds: number, amps: number): EnergyPhase =>
    ({ phase, seconds, amps, mah: (amps * seconds) / 3.6 });
  const energy: EnergyPhase[] = [
    ph('Despegue 1 + ascenso', 5 + climb.motorTimeS, climb.currentA),
    ph('Aproximación 1', 20, 0.35 * climb.currentA),
    ph('Despegue 2 + ascenso', 5 + st.climb2S, climb.currentA),
    ph('Pilones', pylons.timeS < 900 ? pylons.timeS : 0, pylons.currentA),
    ph('Aproximación 2 y motor y al aire', 40, 0.35 * climb.currentA),
  ];
  const missionMah = energy.reduce((s, e) => s + e.mah, 0);
  const usableMah = drive.pack.capacityMah * (1 - vars.reservePct / 100);
  const batteryMarginPct = usableMah > 0 ? (100 * (usableMah - missionMah)) / usableMah : -100;

  const capAh = drive.pack.capacityMah / 1000;
  if (drive.pack.cRating > 0 && climb.currentA > drive.pack.cRating * capAh) {
    reasons.push(`El ascenso pide ${climb.currentA.toFixed(0)} A sostenidos: ${(climb.currentA / capAh).toFixed(0)}C sobre un pack de ${drive.pack.cRating}C.`);
  }

  const pf = model.airframe.planform;
  const box = minTransportBox({
    spanM: pf.spanM, rootChordM: rootChordOf(pf), thickness: model.airframe.airfoil.tc,
    fuseLengthM: model.fuse.length, fuseWidthM: model.fuse.diameter,
  });

  return {
    box,
    takeoffRunM: base.takeoffRunM,
    takeoffMark: takeoffMarkFor(base.takeoffRunM, st.takeoffMargin),
    climb, glide, pylons, emptyFlightKg, energy, missionMah, usableMah, batteryMarginPct, reasons,
  };
}

/** Métricas de misión que salen de una ronda simulada. */
export const xc27MetricsOf = (f: Xc27Flight): Partial<Metrics> => ({
  alt60M: f.climb.alt60M,
  glideDistM: f.glide.distM,
  glideRatio: f.glide.ld,
  glideSpeedMs: f.glide.v,
  pylonTimeS: f.pylons.timeS,
  pylonSpeedMs: f.pylons.v,
  takeoffMarkM: f.takeoffMark === 'foul' ? 999 : Number(f.takeoffMark),
  missionMah: f.missionMah,
  batteryMarginPct: f.batteryMarginPct,
  fullCurrentA: f.climb.currentA,
  boxSumMm: f.box.sumMm,
});

/** Evaluador de reglamento para `evaluateDesign` (opción `extra`). */
export const xc27Extra = (st: Xc27Strategy, onFlight?: (f: Xc27Flight) => void) => (ctx: ExtraContext): ExtraResult => {
  const f = simulateXc27(ctx, st);
  onFlight?.(f);
  return { metrics: xc27MetricsOf(f), reasons: f.reasons };
};

// ------------------------------------------------------------------
//  Puente simulación → reglamento
// ------------------------------------------------------------------

/** Tiempo de carga + descarga estimado para una cantidad de arroz. */
export const loadUnloadTimeS = (payloadG: number, st: Xc27Strategy) =>
  payloadG > 0 ? st.loadBaseS + payloadG / Math.max(1, st.loadRateGs) : 0;

export interface Xc27Sim {
  input: Xc27RoundInput;
  result: Xc27RoundResult;
  points: number;          // sobre 750, con tope
  pointsRaw: number;       // sin tope: > 750 ⇒ se bate la marca de referencia
}

type Xc27MetricSubset = Pick<Metrics, 'payloadG' | 'alt60M' | 'glideDistM' | 'pylonTimeS' | 'takeoffMarkM'>;

export function xc27InputFromMetrics(m: Xc27MetricSubset, st: Xc27Strategy): Xc27RoundInput {
  const carriedKg = m.payloadG / 1000;
  const mark = m.takeoffMarkM;
  return {
    alt60M: m.alt60M,
    glideDistM: m.glideDistM,
    pylonTimeS: m.pylonTimeS < 900 ? m.pylonTimeS : 0,
    declaredKg: carriedKg / Math.min(1, Math.max(0.05, st.carryFraction)),
    carriedKg,
    loadUnloadS: loadUnloadTimeS(m.payloadG, st),
    takeoff: mark <= 20 ? '20' : mark <= 40 ? '40' : mark <= 60 ? '60' : 'foul',
    externalPilot: st.externalPilot,
    legality: 1,
    repairedNoSpares: false,
    loadBonusLost: false,
    payloadUnit: st.payloadUnit,
  };
}

/** Puntuación §9.5 alimentada por las métricas simuladas del prototipo. */
export function xc27FromMetrics(m: Xc27MetricSubset, st: Xc27Strategy): Xc27Sim {
  const input = xc27InputFromMetrics(m, st);
  const result = scoreXc27Round(input);
  return {
    input, result,
    points: roundPoints(result.pEquipo, st.pMaxRef, true),
    pointsRaw: roundPoints(result.pEquipo, st.pMaxRef, false),
  };
}
