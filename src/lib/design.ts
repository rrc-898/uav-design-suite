// ==================================================================
//  Coupled design evaluator — aerodinámica × propulsión × aviónica.
//
//  Este es el módulo que cierra el lazo: recibe una CÉLULA (planta
//  alar + perfil) y un TREN PROPULSIVO (motor + hélice + batería +
//  ESC + electrónica) y devuelve las MÉTRICAS de misión que el scorer
//  puntúa.
//
//  Cadena de cálculo:
//    1. Masas   — buildup empírico (ala, fuselaje/cola, tren, batería,
//                 propulsión, aviónica, carga de pago) → MTOW.
//    2. Aero    — línea sustentadora de Prandtl (aero.ts) cacheada por
//                 forma en planta + polar de sección real del perfil
//                 (airfoils.ts) + drag parásito por componentes.
//    3. Trimado — para cada velocidad candidata: L = W ⇒ CL ⇒ D, y se
//                 busca el gas que da T = D con el mapa de propulsión.
//    4. Consumo — corriente del motor + carga hotel de la aviónica
//                 sobre el mismo pack ⇒ autonomía, alcance, Wh/km.
//    5. Prestaciones — pérdida, velocidad máxima, ascenso, despegue.
//
//  La velocidad de crucero NO se impone: se elige la que maximiza la
//  puntuación de la misión (`pickSpeedBy`), que es exactamente lo que
//  haría un piloto optimizando su vuelo.
//
//  Separación deliberada: `AeroModel` depende sólo de la célula y
//  `DriveMap` sólo del tren propulsivo. El optimizador construye cada
//  uno una vez y luego cruza N×M combinaciones a coste casi nulo.
// ==================================================================

import { solveLLT, type Wing, type Fuselage } from './aero';
import { solvePoint, usableCapacityAh, airDensity, type DriveTrain } from './propulsion';
import { clMaxAtRe, type Airfoil } from './airfoils';
import type { AvionicsSuite } from './avionics';
import type { MetricKey, MissionVariables } from './mission';
import type { Motor, Propeller, Battery, Esc } from './catalog';

const G = 9.80665;
const MU_AIR = 1.81e-5;
const N2GF = 1000 / G;

/** Densidad del aire de la misión: la impuesta, o ISA a elevación + altura. */
export const rhoOf = (vars: MissionVariables): number =>
  vars.rhoOverride ?? airDensity(vars.fieldElevM + vars.cruiseAltM);

// ==================================================================
//  1 · Geometría de la célula
// ==================================================================
export interface Planform {
  spanM: number;
  aspectRatio: number;
  taper: number;
  sweepDeg: number;
  washoutDeg: number;
}

export interface Airframe {
  planform: Planform;
  airfoil: Airfoil;
  flyingWing: boolean;   // perfil reflex ⇒ sin fuselaje ni cola
}

export const areaOf = (p: Planform) => (p.spanM * p.spanM) / p.aspectRatio;
export const meanChord = (p: Planform) => p.spanM / p.aspectRatio;
export const rootChordOf = (p: Planform) => (2 * areaOf(p)) / (p.spanM * (1 + p.taper));
export function macOf(p: Planform): number {
  const t = p.taper;
  return (2 / 3) * rootChordOf(p) * (1 + t + t * t) / (1 + t);
}

/** El fuselaje se dimensiona por la carga que tiene que tragar. */
export function fuselageFor(p: Planform, payloadG: number, flyingWing: boolean): Fuselage {
  const payloadKg = Math.max(0.05, payloadG / 1000);
  if (flyingWing) {
    // El ala volante no se libra del volumen: la carga, la batería y la
    // aviónica siguen necesitando una góndola central. Ahorra cola y
    // esbeltez, no capacidad.
    return {
      length: Math.min(0.9, Math.max(0.30, 0.40 * p.spanM)),
      diameter: Math.max(0.075, 0.092 * Math.cbrt(payloadKg + 0.4)),
    };
  }
  const diameter = Math.max(0.085, 0.105 * Math.cbrt(payloadKg + 0.4));
  const length = Math.min(1.6, Math.max(0.45, 0.62 * p.spanM));
  return { length, diameter };
}

// ==================================================================
//  2 · Aerodinámica de la forma en planta (cacheada: sólo depende de
//      AR, estrechamiento, flecha, torsión y pendiente de sección)
// ==================================================================
export interface PlanformAero {
  clAlphaPerDeg: number;
  clAtZeroAlpha: number;  // aporte del washout
  e: number;              // eficiencia de envergadura
  peakClRatio: number;    // cl_local_máx / CL → dónde entra en pérdida
}

const planformCache = new Map<string, PlanformAero>();

export function planformAero(p: Planform, a0PerDeg: number): PlanformAero {
  const key = `${p.aspectRatio.toFixed(3)}|${p.taper.toFixed(3)}|${p.sweepDeg}|${p.washoutDeg}|${a0PerDeg}`;
  const hit = planformCache.get(key);
  if (hit) return hit;

  // La LLT sólo depende de la forma, no del tamaño: se resuelve con b = 1.
  const span = 1;
  const S = (span * span) / p.aspectRatio;
  const rootChord = (2 * S) / (span * (1 + p.taper));
  const w: Wing = {
    span, rootChord, taper: p.taper, sweepDeg: p.sweepDeg, washoutDeg: p.washoutDeg,
    a0PerDeg, alpha0Deg: 0, tc: 0.12, clMax: 1.4, cdMin: 0.01,
  };
  const r0 = solveLLT(w, 0);
  const r5 = solveLLT(w, 5);
  const peak = Math.max(...r5.station.cl);
  const res: PlanformAero = {
    clAlphaPerDeg: (r5.CL - r0.CL) / 5,
    clAtZeroAlpha: r0.CL,
    e: r5.e,
    peakClRatio: r5.CL > 0.01 ? Math.max(1.0, peak / r5.CL) : 1.05,
  };
  planformCache.set(key, res);
  return res;
}

// ==================================================================
//  3 · Modelo aerodinámico completo de la célula
// ==================================================================
export interface AeroModel {
  airframe: Airframe;
  fuse: Fuselage;
  S: number;
  macLen: number;
  aspectRatio: number;
  e: number;
  k: number;              // 1/(π·AR·e)
  clAlphaPerRad: number;
  clMaxWing: number;
  cd0Ref: number;
  ldMax: number;
  structMassG: number;    // ala + fuselaje + cola (no depende del tren)
  wingMassG: number;      // sólo el ala
  /** Drag de perfil del ala sola; permite cambiar el fuselaje sin rehacer el ala. */
  cdWing(cl: number, V: number): number;
  /** CD total del avión a un CL y una velocidad dados. */
  cd(cl: number, V: number): number;
  /** Sólo la parte parásita (perfil del ala + resto del avión). */
  cd0(cl: number, V: number): number;
}

function cfTurb(Re: number): number {
  return 0.455 / Math.pow(Math.log10(Math.max(1e4, Re)), 2.58);
}

/**
 * Drag parásito de todo lo que NO es el ala; el ala aporta su polar de
 * sección real. Se evalúa a dos velocidades y se ajusta una ley
 * potencial cd0 ∝ V^n, que reproduce el barrido con un solo `pow`.
 */
function buildNonWingCd0(fuse: Fuselage, S: number, rho: number, flyingWing: boolean) {
  // El ala volante se ahorra el estabilizador horizontal, pero no las
  // superficies verticales: necesita derivas o winglets generosos para tener
  // estabilidad direccional sin brazo de cola.
  const tailFrac = flyingWing ? 0.07 : 0.22;
  const at = (V: number) => {
    const f = fuse.length / Math.max(0.02, fuse.diameter);
    const ReF = (rho * V * fuse.length) / MU_AIR;
    const ffF = 1 + 60 / Math.pow(Math.max(2, f), 3) + f / 400;
    const swetF = Math.PI * fuse.diameter * fuse.length * 0.85;
    let cd0 = (cfTurb(ReF) * ffF * swetF) / S;
    const St = tailFrac * S;
    const cT = Math.sqrt(St / 3);
    const ReT = (rho * V * cT) / MU_AIR;
    cd0 += (cfTurb(ReT) * (1 + 2 * 0.09 + 60 * 0.09 ** 4) * 2.04 * St) / S;
    return cd0 * 1.08;               // interferencia
  };
  const c8 = at(8), c32 = at(32);
  const n = Math.log(c32 / c8) / Math.log(4);
  // tren, antenas, tomas; en ala volante, además, holguras de elevones
  const extra = flyingWing ? 0.0040 : 0.0045;
  return (V: number) => c8 * Math.pow(Math.max(3, V) / 8, n) + extra;
}

export function buildAeroModel(af: Airframe, vars: MissionVariables, rho: number): AeroModel {
  const p0 = af.planform;
  // Un ala volante sólo es estable en cabeceo con torsión geométrica fuerte
  // (o mucha flecha): esa torsión aleja la carga de la elíptica y cuesta
  // resistencia inducida. Es el precio real de volar sin cola.
  const p: Planform = af.flyingWing ? { ...p0, washoutDeg: Math.min(p0.washoutDeg, -5) } : p0;
  const S = areaOf(p);
  const macLen = macOf(p);
  const pa = planformAero(p, af.airfoil.a0PerDeg);
  // penalización de trimado: el ala volante equilibra con los propios
  // elevones hacia arriba, lo que degrada la eficiencia de envergadura.
  const eEff = pa.e * (af.flyingWing ? 0.92 : 1);
  const k = 1 / (Math.PI * p.aspectRatio * eEff);
  const fuse = fuselageFor(p, vars.payloadG, af.flyingWing);
  const nonWing = buildNonWingCd0(fuse, S, rho, af.flyingWing);
  const trimDragFactor = af.flyingWing ? 1.06 : 1;

  // factor de Reynolds del perfil:  (Re/Reref)^-0.35 = base · V^-0.35
  const reBase = Math.pow((rho * macLen) / (MU_AIR * af.airfoil.reRef), -0.35);
  const clMaxSection = clMaxAtRe(af.airfoil, (rho * 14 * macLen) / MU_AIR);
  // el ala entra en pérdida cuando la sección más cargada alcanza su cl máx
  const clMaxWing = (clMaxSection / pa.peakClRatio) * (af.flyingWing ? 0.82 : 0.95);

  const cdWing = (cl: number, V: number) => {
    const bucket = af.airfoil.cdMin + af.airfoil.kDrag * (cl - af.airfoil.clOpt) ** 2;
    const reFac = Math.min(2.2, Math.max(0.55, reBase * Math.pow(Math.max(3, V), -0.35)));
    let cd = bucket * reFac * trimDragFactor;
    const lim = 0.85 * clMaxSection;
    if (Math.abs(cl) > lim) {
      const x = (Math.abs(cl) - lim) / (0.15 * clMaxSection);
      cd *= 1 + 1.8 * x * x;
    }
    return cd;
  };

  const cd0 = (cl: number, V: number) => cdWing(cl, V) + nonWing(V);
  const cd = (cl: number, V: number) => cd0(cl, V) + k * cl * cl;

  const cd0Ref = cd0(0.5, 18);
  // (L/D)máx real: se barre el CL porque el drag de perfil no es constante
  // (el "bucket" del perfil desplaza el óptimo respecto a la fórmula clásica).
  let ldMax = 0;
  for (let i = 1; i <= 30; i++) {
    const cl = (clMaxWing * i) / 30;
    const ld = cl / cd(cl, 16);
    if (ld > ldMax) ldMax = ld;
  }

  // --- masa estructural (densidades superficiales de UAVs construidos)
  const arFactor = Math.pow(p.aspectRatio / 7, 0.35);                       // más envergadura → más larguero
  const tcFactor = Math.pow(0.12 / Math.max(0.06, af.airfoil.tc), 0.30);    // perfil fino → larguero más pesado
  // el ala volante lleva elevones en todo el borde de salida y absorbe las
  // cargas de cabeceo en el propio cajón: sale algo más pesada por m².
  const wingG = 1000 * S * 1.95 * arFactor * tcFactor * vars.buildFactor * (af.flyingWing ? 1.06 : 1);
  const fuseTailG = fuseTailMassG(fuse, S, af.flyingWing, vars.buildFactor);

  return {
    airframe: af, fuse, S, macLen, aspectRatio: p.aspectRatio, e: eEff, k,
    clAlphaPerRad: pa.clAlphaPerDeg / (Math.PI / 180),
    clMaxWing, cd0Ref, ldMax, structMassG: wingG + fuseTailG, wingMassG: wingG, cdWing, cd, cd0,
  };
}

function fuseTailMassG(fuse: Fuselage, S: number, flyingWing: boolean, buildFactor: number): number {
  const swetF = Math.PI * fuse.diameter * fuse.length * 0.85;
  const tailG = 1000 * (flyingWing ? 0.07 : 0.22) * S * 1.45 * buildFactor;
  return 1000 * swetF * 1.25 * buildFactor + tailG;
}

/**
 * El mismo avión con el fuselaje redimensionado para otra carga. El ala (lo
 * caro de calcular) se reutiliza; cambian la resistencia parásita del
 * fuselaje y su masa. Sirve cuando la carga es una variable de decisión y
 * ocupa volumen de verdad: no vale cargar 4 kg en el fuselaje de 200 g.
 */
export function refitFuselage(model: AeroModel, vars: MissionVariables, payloadG: number, rho: number): AeroModel {
  const af = model.airframe;
  const fuse = fuselageFor(af.planform, payloadG, af.flyingWing);
  if (fuse.diameter === model.fuse.diameter && fuse.length === model.fuse.length) return model;
  const nonWing = buildNonWingCd0(fuse, model.S, rho, af.flyingWing);
  const cd0 = (cl: number, V: number) => model.cdWing(cl, V) + nonWing(V);
  const cd = (cl: number, V: number) => cd0(cl, V) + model.k * cl * cl;
  return {
    ...model, fuse, cd, cd0, cd0Ref: cd0(0.5, 18),
    structMassG: model.wingMassG + fuseTailMassG(fuse, model.S, af.flyingWing, vars.buildFactor),
  };
}

// ==================================================================
//  4 · Mapa de propulsión (empuje y corriente vs gas y velocidad)
// ==================================================================
export interface DriveMap {
  thr: number[];
  v: number[];
  thrust: number[][];   // [iThr][iV] en N
  current: number[][];  // A
  vpack: number[][];    // V
}

/**
 * Velocidad tope del mapa: fija, para que el mapa sea cacheable. Se toma muy
 * por encima de cualquier crucero para que la velocidad máxima calculada sea
 * la que impone la física y no el borde de la tabla.
 */
export const MAP_V_MAX = 72;

export function buildDriveMap(dt: DriveTrain, vMax = MAP_V_MAX, nThr = 9, nV = 19): DriveMap {
  const thr: number[] = [], v: number[] = [];
  for (let i = 0; i < nThr; i++) thr.push(0.20 + (0.80 * i) / (nThr - 1));
  for (let j = 0; j < nV; j++) v.push((vMax * j) / (nV - 1));
  const thrust: number[][] = [], current: number[][] = [], vpack: number[][] = [];
  for (const t of thr) {
    const rT: number[] = [], rI: number[] = [], rV: number[] = [];
    for (const vv of v) {
      const pt = solvePoint(dt, t, vv);
      rT.push(pt.thrustN); rI.push(pt.current); rV.push(pt.voltagePack);
    }
    thrust.push(rT); current.push(rI); vpack.push(rV);
  }
  return { thr, v, thrust, current, vpack };
}

function interpRow(xs: number[], ys: number[], x: number): number {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  const dx = xs[1] - xs[0];                 // rejilla uniforme
  const i = Math.min(n - 2, Math.floor((x - xs[0]) / dx));
  const f = (x - xs[i]) / dx;
  return ys[i] + f * (ys[i + 1] - ys[i]);
}

export interface TrimPoint { throttle: number; currentA: number; vpack: number; thrustN: number; ok: boolean; }

/** Gas necesario para dar `needN` newtons de empuje a la velocidad `V`. */
export function trimThrust(map: DriveMap, V: number, needN: number): TrimPoint {
  const last = map.thr.length - 1;
  const tAt: number[] = new Array(map.thr.length);
  for (let i = 0; i <= last; i++) tAt[i] = interpRow(map.v, map.thrust[i], V);

  if (needN > tAt[last]) {
    return { throttle: 1, currentA: interpRow(map.v, map.current[last], V), vpack: interpRow(map.v, map.vpack[last], V), thrustN: tAt[last], ok: false };
  }
  if (needN <= tAt[0]) {
    return { throttle: map.thr[0], currentA: interpRow(map.v, map.current[0], V), vpack: interpRow(map.v, map.vpack[0], V), thrustN: tAt[0], ok: true };
  }
  let i = 1;
  while (i < last && tAt[i] < needN) i++;
  const span = tAt[i] - tAt[i - 1];
  const f = span > 1e-9 ? (needN - tAt[i - 1]) / span : 0;
  const lerp = (rows: number[][]) =>
    interpRow(map.v, rows[i - 1], V) + f * (interpRow(map.v, rows[i], V) - interpRow(map.v, rows[i - 1], V));
  return {
    throttle: map.thr[i - 1] + f * (map.thr[i] - map.thr[i - 1]),
    currentA: lerp(map.current), vpack: lerp(map.vpack), thrustN: needN, ok: true,
  };
}

export const thrustFull = (map: DriveMap, V: number) =>
  interpRow(map.v, map.thrust[map.thr.length - 1], V);

export const currentFull = (map: DriveMap, V: number) =>
  interpRow(map.v, map.current[map.thr.length - 1], V);

/**
 * Potencia máxima SOSTENIBLE a la velocidad `V`: gas a tope, o el gas que
 * deja la corriente justo en el límite de motor/ESC si a tope se pasa.
 * Es lo que se puede pedir durante un ascenso de un minuto, no en un pico.
 */
export function sustainedPower(map: DriveMap, V: number, iLimit: number): { thrustN: number; currentA: number; throttle: number } {
  const last = map.thr.length - 1;
  let iHi = interpRow(map.v, map.current[last], V);
  let tHi = interpRow(map.v, map.thrust[last], V);
  if (iHi <= iLimit) return { thrustN: tHi, currentA: iHi, throttle: 1 };
  for (let r = last - 1; r >= 0; r--) {
    const iLo = interpRow(map.v, map.current[r], V);
    const tLo = interpRow(map.v, map.thrust[r], V);
    if (iLo <= iLimit) {
      const f = iHi - iLo > 1e-9 ? (iLimit - iLo) / (iHi - iLo) : 0;
      return { thrustN: tLo + f * (tHi - tLo), currentA: iLimit, throttle: map.thr[r] + f * (map.thr[r + 1] - map.thr[r]) };
    }
    iHi = iLo; tHi = tLo;
  }
  return { thrustN: tHi, currentA: iHi, throttle: map.thr[0] };
}

/**
 * Carrera de despegue: rodadura acelerando hasta la rotación (CL_TO = 0.8·CLmáx)
 * con la fuerza neta evaluada a 0.7·V_LOF. `mu` es el coeficiente de rodadura
 * (0.06 hierba, 0.04 asfalto). Devuelve 999 si no acelera.
 */
export function takeoffRunOf(model: AeroModel, map: DriveMap, W: number, rho: number, mu = 0.06): number {
  const S = model.S;
  const clTO = Math.max(0.3, model.clMaxWing * 0.80);
  const vLof = 1.15 * Math.sqrt((2 * W) / (rho * S * clTO));
  const vAvg = 0.7 * vLof;
  const clRoll = model.clMaxWing * 0.45;
  const q = 0.5 * rho * vAvg * vAvg * S;
  const net = thrustFull(map, vAvg) - q * model.cd(clRoll, vAvg) - mu * Math.max(0, W - q * clRoll);
  return net > 0.05 ? (1.21 * W * W) / (G * rho * S * clTO * net) : 999;
}

// ==================================================================
//  5 · Tren propulsivo + electrónica
// ==================================================================

/**
 * Configuración de baterías: agrupar packs es una decisión de diseño real.
 *  · en SERIE   → más tensión ⇒ más rpm y más empuje con la misma corriente
 *  · en PARALELO→ más capacidad y menos resistencia interna (menos sag),
 *                 a costa de masa proporcional.
 */
export interface Pack {
  battery: Battery;
  series: number;
  parallel: number;
  cells: number;
  vcell: number;
  capacityMah: number;
  cRating: number;
  rintCell: number;
  massG: number;
  label: string;
}

export function makePack(battery: Battery, series = 1, parallel = 1): Pack {
  const mult = series > 1 || parallel > 1 ? ` ×${series}S${parallel}P` : '';
  return {
    battery, series, parallel,
    cells: battery.cells * series,
    vcell: battery.vcell,
    capacityMah: battery.capacityMah * parallel,
    cRating: battery.cRating,
    rintCell: battery.rintCell / parallel,
    massG: battery.massG * series * parallel,
    label: `${battery.cells * series}S ${battery.capacityMah * parallel} mAh${mult}`,
  };
}

export const packWh = (p: Pack) => (p.capacityMah / 1000) * p.cells * p.vcell;

export interface DriveUnit {
  motor: Motor;
  prop: Propeller;
  pack: Pack;
  esc: Esc;
  avionics: AvionicsSuite;
  map: DriveMap;
}

export const propMassG = (dia: number) => 0.18 * dia * dia + 6;

export const driveTrainOf = (d: { motor: Motor; prop: Propeller; pack: Pack; esc: Esc }, rho: number): DriveTrain => ({
  motor: { kv: d.motor.kv, rm: d.motor.rm, i0Ref: d.motor.i0Ref, vRef: d.motor.vRef, iMax: d.motor.iMax },
  prop: { dia: d.prop.dia, pitch: d.prop.pitch, ct: d.prop.ct, cp: d.prop.cp },
  battery: { cells: d.pack.cells, vcell: d.pack.vcell, capacityMah: d.pack.capacityMah, cRating: d.pack.cRating, rintCell: d.pack.rintCell },
  esc: { iMax: d.esc.iMax, efficiency: d.esc.efficiency, resistance: d.esc.resistance },
  rho,
});

export const driveKey = (d: { motor: Motor; prop: Propeller; pack: Pack; esc: Esc }, rho: number) =>
  `${d.motor.id}|${d.prop.id}|${d.pack.battery.id}|${d.pack.series}x${d.pack.parallel}|${d.esc.id}|${rho.toFixed(4)}`;

export interface MassBreakdown {
  wingG: number; fuseTailG: number; miscG: number;
  motorG: number; propG: number; escG: number; batteryG: number;
  avionicsG: number; payloadG: number;
  fixedG: number;          // masa impuesta por la misión (caja de telemetría…)
  emptyG: number; mtowG: number;
}

export function massBuildup(model: AeroModel, drive: DriveUnit, vars: MissionVariables): MassBreakdown {
  // la estructura viene repartida entre ala y fuselaje/cola con la misma proporción
  // que en buildAeroModel; aquí sólo se separa para poder mostrarla.
  const S = model.S;
  const af = model.airframe;
  const arFactor = Math.pow(model.aspectRatio / 7, 0.35);
  const tcFactor = Math.pow(0.12 / Math.max(0.06, af.airfoil.tc), 0.30);
  const wingG = 1000 * S * 1.95 * arFactor * tcFactor * vars.buildFactor * (af.flyingWing ? 1.06 : 1);
  const fuseTailG = Math.max(0, model.structMassG - wingG);

  const motorG = drive.motor.massG;
  const propG = propMassG(drive.prop.dia);
  const escG = drive.esc.massG;
  const batteryG = drive.pack.massG;
  const avionicsG = drive.avionics.massG;
  const payloadG = vars.payloadG;

  // tren de aterrizaje, refuerzos, cableado, tornillería, mecanismos
  let miscG = 0.075 * (model.structMassG + batteryG + payloadG + motorG) + (vars.runwayM > 0 ? 60 : 15);

  const fixedG = vars.fixedMassG ?? 0;
  let emptyG = model.structMassG + miscG + motorG + propG + escG + batteryG + avionicsG + fixedG;
  // con el avión ya construido manda la báscula: la diferencia se imputa a «varios»
  if (vars.emptyMassOverrideG && vars.emptyMassOverrideG > 0) {
    miscG += vars.emptyMassOverrideG - emptyG;
    emptyG = vars.emptyMassOverrideG;
  }
  return { wingG, fuseTailG, miscG, motorG, propG, escG, batteryG, avionicsG, payloadG, fixedG, emptyG, mtowG: emptyG + payloadG };
}

export function componentCostUsd(d: DriveUnit): number {
  const motor = 25 + 0.32 * d.motor.massG;
  const prop = 4 + 0.55 * d.prop.dia + (d.prop.folding ? 22 : 0);
  const battery = (12 + 0.42 * packWh(d.pack) / (d.pack.series * d.pack.parallel)) * d.pack.series * d.pack.parallel;
  return motor + prop + battery + (d.esc.price ?? 45) + d.avionics.priceUsd;
}

// ==================================================================
//  6 · Evaluación completa
// ==================================================================
export type Metrics = Record<MetricKey, number>;

export interface CruiseState {
  V: number; groundSpeed: number; CL: number; CD: number; LD: number;
  throttle: number; currentA: number; avionicsA: number; powerW: number;
  enduranceMin: number; rangeKm: number;
}

export interface DesignEvaluation {
  model: AeroModel;
  drive: DriveUnit;
  masses: MassBreakdown;
  metrics: Metrics;
  cruise: CruiseState;
  feasible: boolean;
  reasons: string[];
  vStall: number;
}

export const emptyMetrics = (): Metrics => ({
  enduranceMin: 0, rangeKm: 0, cruiseSpeedMs: 0, maxSpeedMs: 0, bestRangeSpeedMs: 0,
  payloadG: 0, payloadFrac: 0, mtowKg: 0, emptyKg: 0, wingLoadingGm2: 0,
  cruiseCurrentA: 999, cruisePowerW: 9999, whPerKm: 999, gPerW: 0, cRateUsed: 99,
  takeoffRunM: 999, rocMs: -9, stallSpeedMs: 99, stallMarginPct: 0, thrustWeight: 0,
  ldMax: 0, ldCruise: 0, cd0: 1, spanM: 0, aspectRatio: 0,
  coverageHaPerFlight: 0, distance150M: 0, lapTimeS: 999, costUsd: 0, gustSensitivity: 9,
  alt60M: 0, glideDistM: 0, glideRatio: 0, glideSpeedMs: 0, pylonTimeS: 999, pylonSpeedMs: 0,
  takeoffMarkM: 999, missionMah: 0, batteryMarginPct: 0, fullCurrentA: 0, boxSumMm: 0,
});

/** Lo que recibe un evaluador de reglamento para añadir sus propias métricas. */
export interface ExtraContext {
  model: AeroModel; drive: DriveUnit; masses: MassBreakdown; vars: MissionVariables;
  rho: number; W: number; vStall: number; base: Metrics;
}
export interface ExtraResult { metrics: Partial<Metrics>; reasons?: string[]; }

export interface EvalOptions {
  /** Puntúa unas métricas: el evaluador elige la V de crucero que lo maximiza. */
  pickSpeedBy: (m: Metrics) => number;
  vScanSteps?: number;
  /**
   * Métricas específicas de un reglamento (ascenso cronometrado, planeo,
   * pilones…) que no dependen del punto de crucero. Si devuelve `reasons`,
   * el diseño queda marcado como no viable.
   */
  extra?: (ctx: ExtraContext) => ExtraResult;
}

export function evaluateDesign(
  model: AeroModel, drive: DriveUnit, vars: MissionVariables, opts: EvalOptions,
): DesignEvaluation {
  const reasons: string[] = [];
  const rho = rhoOf(vars);
  const masses = massBuildup(model, drive, vars);
  const mKg = masses.mtowG / 1000;
  const W = mKg * G;
  const S = model.S;
  const map = drive.map;

  const clMaxWing = model.clMaxWing;
  const vStall = Math.sqrt((2 * W) / (rho * S * Math.max(0.3, clMaxWing)));
  const iLimit = Math.min(drive.motor.iMax, drive.esc.iMax);
  const capAh = usableCapacityAh(
    { cells: drive.pack.cells, vcell: drive.pack.vcell, capacityMah: drive.pack.capacityMah, cRating: drive.pack.cRating, rintCell: drive.pack.rintCell },
    vars.reservePct / 100,
  );

  const dragAt = (V: number, CL: number) => 0.5 * rho * V * V * S * model.cd(CL, V);

  // --- velocidad máxima, ascenso, empuje estático ------------------
  const staticThrustN = thrustFull(map, 0);
  const thrustWeight = staticThrustN / W;
  const vTop = Math.min(MAP_V_MAX, Math.max(vStall * 3.2, 40));
  let vMax = 0, rocMax = -99, ldMax = 0;
  for (let i = 0; i <= 26; i++) {
    const V = vStall + ((vTop - vStall) * i) / 26;
    const CL = (2 * W) / (rho * V * V * S);
    if (CL > clMaxWing) continue;
    const D = dragAt(V, CL);
    const Ta = thrustFull(map, V);
    if (Ta >= D) vMax = V;
    const roc = (V * (Ta - D)) / W;
    if (roc > rocMax) rocMax = roc;
    // (L/D)máx sobre la envolvente real de vuelo nivelado a este peso:
    // el drag de perfil depende del Reynolds, así que el óptimo no coincide
    // con la fórmula clásica de CD0 constante.
    const ld = (W / D);
    if (ld > ldMax) ldMax = ld;
  }

  // --- carrera de despegue (rodadura; μ = 0.06 hierba por defecto) --
  const takeoffRunM = vars.runwayM > 0 ? takeoffRunOf(model, map, W, rho, vars.rollingMu) : 0;

  // --- métricas independientes del punto de crucero ---------------
  const base = emptyMetrics();
  base.payloadG = vars.payloadG;
  base.mtowKg = mKg;
  base.emptyKg = masses.emptyG / 1000;
  base.payloadFrac = (100 * vars.payloadG) / masses.mtowG;
  base.spanM = model.airframe.planform.spanM;
  base.aspectRatio = model.aspectRatio;
  base.wingLoadingGm2 = masses.mtowG / S;
  base.stallSpeedMs = vStall;
  base.maxSpeedMs = vMax;
  base.rocMs = rocMax;
  base.thrustWeight = thrustWeight;
  base.takeoffRunM = takeoffRunM;
  base.costUsd = componentCostUsd(drive);
  base.cd0 = model.cd0Ref;
  base.ldMax = ldMax;

  let extraBad = false;
  if (opts.extra) {
    const ex = opts.extra({ model, drive, masses, vars, rho, W, vStall, base });
    Object.assign(base, ex.metrics);
    if (ex.reasons?.length) { extraBad = true; reasons.push(...ex.reasons); }
  }

  // --- barrido de velocidad: gana la que más puntúa en esta misión --
  const steps = opts.vScanSteps ?? 16;
  const vLo = vStall * 1.12;
  const vHi = vMax > vLo ? vMax * 0.985 : vLo;

  let best: Metrics | null = null;
  let bestScore = -Infinity;
  let bestCruise: CruiseState | null = null;
  let bestRangeV = 0, bestRangeKm = -1;

  for (let i = 0; i <= steps; i++) {
    const V = steps > 0 ? vLo + ((vHi - vLo) * i) / steps : vLo;
    const CL = (2 * W) / (rho * V * V * S);
    if (CL > clMaxWing) continue;
    const CD = model.cd(CL, V);
    const D = 0.5 * rho * V * V * S * CD;
    const tp = trimThrust(map, V, D);
    if (!tp.ok) continue;

    const vpack = Math.max(6, tp.vpack);
    // con batería auxiliar, receptor y servos no tocan el pack principal
    const avionicsA = vars.auxBattery ? 0 : drive.avionics.powerW / vpack;
    const totalA = tp.currentA + avionicsA;
    if (totalA > iLimit * 1.02) continue;

    const enduranceMin = (capAh / Math.max(0.05, totalA)) * 60;
    const groundSpeed = Math.max(1, V - vars.windMs * 0.45);
    const rangeKm = (enduranceMin / 60) * groundSpeed * 3.6;
    const powerW = vpack * totalA;
    if (rangeKm > bestRangeKm) { bestRangeKm = rangeKm; bestRangeV = V; }

    const m: Metrics = { ...base };
    m.cruiseSpeedMs = V;
    m.cruiseCurrentA = totalA;
    m.cruisePowerW = powerW;
    m.enduranceMin = enduranceMin;
    m.rangeKm = rangeKm;
    m.whPerKm = powerW / Math.max(0.1, groundSpeed * 3.6);
    m.ldCruise = CL / CD;
    m.gPerW = (D * N2GF) / Math.max(1, powerW);
    m.cRateUsed = totalA / Math.max(0.1, drive.pack.capacityMah / 1000);
    m.stallMarginPct = 100 * (V / vStall - 1);
    m.distance150M = groundSpeed * 150;
    m.lapTimeS = 1200 / groundSpeed;
    m.gustSensitivity = (model.clAlphaPerRad * S * rho * V) / (2 * W);
    const transitMin = (2 * vars.legDistanceKm * 1000) / Math.max(1, groundSpeed) / 60;
    m.coverageHaPerFlight = (vars.swathM * groundSpeed * Math.max(0, enduranceMin - transitMin) * 60) / 10000;

    const sc = opts.pickSpeedBy(m);
    if (sc > bestScore) {
      bestScore = sc;
      best = m;
      bestCruise = {
        V, groundSpeed, CL, CD, LD: CL / CD, throttle: tp.throttle,
        currentA: totalA, avionicsA, powerW, enduranceMin, rangeKm,
      };
    }
  }

  if (!best || !bestCruise) {
    reasons.push('Sin punto de vuelo estabilizado: el empuje disponible no equilibra la resistencia en ninguna velocidad válida.');
    return {
      model, drive, masses, metrics: base, vStall, feasible: false, reasons,
      cruise: { V: 0, groundSpeed: 0, CL: 0, CD: 0, LD: 0, throttle: 1, currentA: 0, avionicsA: 0, powerW: 0, enduranceMin: 0, rangeKm: 0 },
    };
  }

  best.bestRangeSpeedMs = bestRangeV;

  // --- viabilidad física ------------------------------------------
  let feasible = !extraBad;
  if (vMax <= vStall * 1.12) { feasible = false; reasons.push('La velocidad máxima no supera el margen de pérdida: no hay vuelo nivelado.'); }
  if (thrustWeight < 0.35) { feasible = false; reasons.push(`Empuje/peso ${thrustWeight.toFixed(2)}: insuficiente para despegar o lanzar a mano.`); }
  if (drive.pack.cRating > 0 && best.cRateUsed > drive.pack.cRating) {
    feasible = false;
    reasons.push(`Descarga de ${best.cRateUsed.toFixed(0)}C sobre un pack de ${drive.pack.cRating}C: caída de tensión y degradación.`);
  }
  if (mKg > vars.maxMtowKg) { feasible = false; reasons.push(`MTOW ${mKg.toFixed(2)} kg supera el límite de ${vars.maxMtowKg} kg.`); }
  if (model.airframe.planform.spanM > vars.maxSpanM + 1e-6) { feasible = false; reasons.push(`Envergadura ${model.airframe.planform.spanM.toFixed(2)} m sobre el límite de ${vars.maxSpanM} m.`); }

  return { model, drive, masses, metrics: best, cruise: bestCruise, feasible, reasons, vStall };
}

// ==================================================================
//  7 · La carga útil como VARIABLE DE DECISIÓN
//
//  En media misión del sector (competición de carga, reparto, ACC) el
//  equipo elige cuánto carga. El límite lo ponen la física y la pista:
//  MTOW, empuje/peso y carrera de despegue. Aquí se resuelve ese límite
//  y se ofrecen varios niveles para que sea el scorer de la misión —y
//  no una suposición— quien elija el punto de la curva carga/alcance.
// ==================================================================

/** Máxima carga que este avión puede levantar cumpliendo los límites duros. */
export function maxLiftablePayloadG(model0: AeroModel, drive: DriveUnit, vars: MissionVariables, refit = false): number {
  const rho = rhoOf(vars);
  const S = model0.S;
  const clMaxWing = model0.clMaxWing;
  const minTW = vars.minThrustWeight ?? (vars.runwayM > 0 ? 0.55 : 0.70);   // lanzamiento a mano exige más

  const ok = (payloadG: number): boolean => {
    const model = refit ? refitFuselage(model0, vars, payloadG, rho) : model0;
    const mass = massBuildup(model, drive, { ...vars, payloadG });
    const mKg = mass.mtowG / 1000;
    if (mKg > vars.maxMtowKg) return false;
    const W = mKg * G;
    if (thrustFull(drive.map, 0) / W < minTW) return false;
    const vStall = Math.sqrt((2 * W) / (rho * S * Math.max(0.3, clMaxWing)));
    // ¿existe vuelo nivelado a 1.3·Vstall?
    const V = vStall * 1.3;
    const CL = (2 * W) / (rho * V * V * S);
    if (CL > clMaxWing) return false;
    if (thrustFull(drive.map, V) < 0.5 * rho * V * V * S * model.cd(CL, V)) return false;
    if (vars.runwayM > 0 && takeoffRunOf(model, drive.map, W, rho, vars.rollingMu) > vars.runwayM) return false;
    return true;
  };

  if (!ok(0)) return 0;
  let lo = 0;
  let hi = Math.max(0, vars.maxMtowKg * 1000 - massBuildup(model0, drive, { ...vars, payloadG: 0 }).emptyG);
  if (hi <= 0) return 0;
  if (ok(hi)) return hi;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

export interface PayloadOptions extends EvalOptions {
  /** 'fija' respeta vars.payloadG; 'maxima' la trata como mínimo y busca el óptimo. */
  payloadMode?: 'fija' | 'maxima';
  payloadLevels?: number;
  /**
   * Pistas más cortas que la disponible que el reglamento premia por
   * escalones (p. ej. 20 y 40 m). La carga que deja la carrera justo en cada
   * escalón se añade a los niveles evaluados: el óptimo suele estar ahí, y
   * una rejilla uniforme de carga se lo saltaría.
   */
  runwayBreaksM?: number[];
  /** Redimensiona el fuselaje para cada nivel de carga evaluado (ver `refitFuselage`). */
  refitFuselage?: boolean;
}

/**
 * Evalúa el concepto eligiendo también la carga útil: el mismo criterio
 * que la velocidad de crucero — gana el punto que más puntúa en la misión.
 */
export function evaluateBestPayload(
  model: AeroModel, drive: DriveUnit, vars: MissionVariables, opts: PayloadOptions,
): DesignEvaluation {
  if ((opts.payloadMode ?? 'fija') === 'fija') return evaluateDesign(model, drive, vars, opts);

  const refit = opts.refitFuselage ?? false;
  const rho = rhoOf(vars);
  const at = (payloadG: number) =>
    evaluateDesign(refit ? refitFuselage(model, vars, payloadG, rho) : model, drive, { ...vars, payloadG }, opts);
  const pMax = maxLiftablePayloadG(model, drive, vars, refit);
  const pMin = Math.min(vars.payloadG, pMax);
  const n = Math.max(2, opts.payloadLevels ?? 4);
  if (pMax <= 0 || pMax < vars.payloadG - 1) {
    // no llega ni a la carga mínima exigida: se evalúa igualmente para poder
    // explicar por qué queda descartado.
    return evaluateDesign(model, drive, vars, opts);
  }

  const levels: number[] = [];
  for (let i = 0; i < n; i++) levels.push(pMin + ((pMax - pMin) * i) / (n - 1));
  for (const runwayM of opts.runwayBreaksM ?? []) {
    if (!(runwayM > 0) || runwayM >= vars.runwayM) continue;
    const pBreak = maxLiftablePayloadG(model, drive, { ...vars, runwayM }, refit);
    if (pBreak > pMin + 1 && pBreak < pMax - 1) levels.push(pBreak);
  }

  let best: DesignEvaluation | null = null;
  let bestScore = -Infinity;
  for (const payloadG of levels) {
    const ev = at(payloadG);
    if (ev.metrics.cruiseSpeedMs <= 0) continue;
    const s = opts.pickSpeedBy(ev.metrics);
    if (s > bestScore) { bestScore = s; best = ev; }
  }
  return best ?? at(pMin);
}

// ------------------------------------------------------------------
//  Puente con CFD Studio: exportar la célula ganadora como Wing
// ------------------------------------------------------------------
export function airframeToWing(af: Airframe): Wing {
  const p = af.planform;
  return {
    span: p.spanM, rootChord: rootChordOf(p), taper: p.taper,
    sweepDeg: p.sweepDeg, washoutDeg: p.washoutDeg,
    a0PerDeg: af.airfoil.a0PerDeg, alpha0Deg: af.airfoil.alpha0Deg,
    tc: af.airfoil.tc, clMax: af.airfoil.clMax, cdMin: af.airfoil.cdMin,
  };
}
