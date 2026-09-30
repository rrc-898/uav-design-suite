// ==================================================================
//  Design-space optimizer — "dime la misión y te doy el avión".
//
//  Cruza el catálogo real de componentes con un abanico de células
//  paramétricas y devuelve el prototipo que más puntúa en la misión:
//  planta motriz (motor · hélice · batería · ESC), perfil alar y
//  forma en planta, y paquete de electrónica.
//
//  Estrategia de búsqueda (lo que la hace viable en el navegador):
//    · La aerodinámica depende SÓLO de la célula     → 1 modelo por ala.
//    · El empuje/corriente dependen SÓLO del tren    → 1 mapa por tren.
//    · La solución de la línea sustentadora depende sólo de la FORMA
//      (AR, estrechamiento, flecha, torsión)         → caché global.
//  Después, cruzar N alas × M trenes es aritmética pura.
//
//  Antes del cruce hay una CRIBA: se descartan los trenes que se pasan
//  de corriente o no dan empuje suficiente, y de cada (motor, batería,
//  ESC) sólo sobreviven las mejores hélices. Se pasa de ~10⁵ trenes
//  posibles a unos cientos sin perder el óptimo.
// ==================================================================

import { MOTORS, PROPS, BATTERIES, ESCS, type Motor, type Propeller, type Battery, type Esc } from './catalog';
import { AIRFOILS, type Airfoil } from './airfoils';
import { selectAvionics, type AvionicsSuite, type AvionicsTag } from './avionics';
import { solvePoint } from './propulsion';
import {
  buildAeroModel, buildDriveMap, driveTrainOf, evaluateBestPayload,
  emptyMetrics, makePack, packWh, rhoOf, rootChordOf,
  type AeroModel, type Airframe, type DriveUnit, type DesignEvaluation, type Metrics,
  type Pack, type PayloadOptions, type Planform,
} from './design';
import {
  scoreMission, normalizeObjective, METRICS,
  type Constraint, type MissionScore, type MissionType, type MissionVariables, type Objective,
} from './mission';
import {
  xcEfficientFromMetrics, xcUrgentFromMetrics, currentScore, payloadEquiv,
  type XcAssumptions, type XcRoundRefs,
} from './scoring';
import { scoreXc27Round, roundPoints, minTransportBox, XC27_LIMITS } from './xc27';
import {
  xc27Extra, xc27FromMetrics, xc27InputFromMetrics, XC27_DEFAULT_STRATEGY,
  type Xc27Sim, type Xc27Strategy,
} from './xc27-flight';

export type Breadth = 'rapido' | 'estandar' | 'exhaustivo';

export interface OptimizeConfig {
  mission: MissionType;
  vars: MissionVariables;
  objectives: Objective[];
  constraints: Constraint[];
  requiredAvionics: AvionicsTag[];
  xcRefs: XcRoundRefs;
  xcAssumptions: XcAssumptions;
  /** Estrategia de ronda XC27; sólo la usan las misiones con scorer 'xc27'. */
  xc27?: Xc27Strategy;
  breadth: Breadth;
}

const xc27Of = (cfg: OptimizeConfig): Xc27Strategy => cfg.xc27 ?? XC27_DEFAULT_STRATEGY;

/**
 * Criba de células por reglamento, antes de cruzarlas con los trenes: en
 * XC27 un ala que no cabe en la caja de 1300 mm ni con el fuselaje más
 * pequeño no merece un solo cálculo de vuelo.
 */
function frameAllowed(cfg: OptimizeConfig, model: AeroModel): boolean {
  if (cfg.mission.scorer !== 'xc27') return true;
  const pf = model.airframe.planform;
  return minTransportBox({
    spanM: pf.spanM, rootChordM: rootChordOf(pf), thickness: model.airframe.airfoil.tc,
    fuseLengthM: model.fuse.length, fuseWidthM: model.fuse.diameter,
  }).sumMm <= XC27_LIMITS.boxSumMm;
}

/** Opciones de evaluación que dependen del reglamento de la misión. */
function ruleOptions(cfg: OptimizeConfig): Pick<PayloadOptions, 'extra' | 'runwayBreaksM' | 'refitFuselage'> {
  if (cfg.mission.scorer !== 'xc27') return {};
  const st = xc27Of(cfg);
  return {
    extra: xc27Extra(st),
    // el arroz ocupa volumen: el fuselaje crece con la carga elegida
    refitFuselage: true,
    // la carga que deja la carrera justo en las marcas de 20 y 40 m
    runwayBreaksM: [20 / st.takeoffMargin, 40 / st.takeoffMargin],
  };
}

export interface RankedDesign {
  rank: number;
  score: number;            // puntuación primaria de la misión
  scoreMax: number;         // techo de la escala (1000, o 375 en XC26)
  mission: MissionScore;
  evaluation: DesignEvaluation;
  xcEfficient?: ReturnType<typeof xcEfficientFromMetrics>;
  xcUrgent?: ReturnType<typeof xcUrgentFromMetrics>;
  xc27?: Xc27Sim;
  why: string[];
}

export interface SensitivityItem {
  label: string;
  delta: number;
  hint: string;
  kind: 'variable' | 'componente';
}

export interface OptimizeResult {
  designs: RankedDesign[];
  scanned: number;
  feasibleCount: number;
  elapsedMs: number;
  space: { wings: number; drives: number; combos: number; airfoils: number };
  scoreMax: number;
  scoreLabel: string;
  cloud: { x: number; y: number; feasible: boolean }[];
  sensitivity: SensitivityItem[];
  avionics: AvionicsSuite;
  notes: string[];
}

const BREADTH: Record<Breadth, {
  spans: number; ars: number; tapers: number[];
  propsPerCriterion: number; packsPerCells: number; maxDrives: number; vSteps: number;
}> = {
  rapido:     { spans: 2, ars: 3, tapers: [0.7],      propsPerCriterion: 1, packsPerCells: 5,  maxDrives: 400, vSteps: 12 },
  estandar:   { spans: 3, ars: 4, tapers: [0.7],      propsPerCriterion: 1, packsPerCells: 8,  maxDrives: 900, vSteps: 16 },
  exhaustivo: { spans: 4, ars: 5, tapers: [0.7, 1.0], propsPerCriterion: 2, packsPerCells: 12, maxDrives: 1600, vSteps: 20 },
};

// ==================================================================
//  Scorer rápido — se llama millones de veces en el barrido interno
// ==================================================================
export interface Scorer {
  fast: (m: Metrics) => number;
  max: number;
  label: string;
}

function hardPenalty(constraints: Constraint[], m: Metrics): number {
  let f = 1;
  for (const c of constraints) {
    const v = m[c.metric];
    const ok = c.op === '<=' ? v <= c.value : v >= c.value;
    if (ok) continue;
    if (c.hard) { f *= 0.35; continue; }
    const excess = c.op === '<='
      ? (v - c.value) / Math.max(1e-6, Math.abs(c.value))
      : (c.value - v) / Math.max(1e-6, Math.abs(c.value));
    f *= Math.max(0.55, 1 - 0.5 * Math.min(1, Math.max(0, excess)));
  }
  return f;
}

export function makeScorer(cfg: OptimizeConfig): Scorer {
  const { mission, objectives, constraints, xcRefs: R, xcAssumptions: A } = cfg;

  if (mission.scorer === 'xc26-efficient') {
    const takeoffBonus = A.takeoff === 'foul' ? 0 : A.takeoff === '40' ? 1.125 : A.takeoff === '20' ? 1.25 : 1;
    const sPil = A.externalPilot ? 0.75 : 1;
    const sRep = A.sparePenalty ? 0.75 : 1;
    return {
      max: 375, label: 'pts ronda XC26',
      fast: (m) => {
        const waterG = m.payloadG * A.waterFrac;
        const pl = payloadEquiv(waterG, m.payloadG * (1 - A.waterFrac));
        // topes del reglamento: los parciales se normalizan contra la mejor
        // marca de la ronda, así que ninguno puede superar su máximo.
        const pPeso = R.plMaxG > 0 ? Math.min(100, 100 * (pl / R.plMaxG)) : 0;
        const pDist = R.distanceMaxM > 0 ? Math.min(75, 75 * (m.distance150M / R.distanceMaxM)) : 0;
        const pCorr = currentScore(m.cruiseCurrentA, R.currentMinA);
        const tLoad = A.loadBaseS + waterG / Math.max(1, A.loadRateGs);
        const ct = waterG / Math.sqrt(Math.max(1, tLoad));
        const bCarga = R.loadCoeffMax > 0 ? Math.min(50, 50 * (ct / R.loadCoeffMax)) : 0;
        const total = ((pPeso + pDist + pCorr) * A.legality + bCarga) * takeoffBonus * sPil * sRep;
        return total * hardPenalty(constraints, m);
      },
    };
  }

  if (mission.scorer === 'xc26-urgent') {
    const landing = A.landing === '0-10' ? 1.25 : A.landing === '10-20' ? 1.15 : A.landing === '20-30' ? 1.05 : 1;
    const sPil = A.externalPilot ? 0.75 : 1;
    const sRep = A.sparePenalty ? 0.75 : 1;
    return {
      max: 375, label: 'pts ronda XC26',
      fast: (m) => {
        const pTiempo = m.lapTimeS > 0 ? Math.min(300, 300 * (R.timeMinS / m.lapTimeS)) : 0;
        return pTiempo * A.legality * landing * sPil * sRep * hardPenalty(constraints, m);
      },
    };
  }

  if (mission.scorer === 'xc27') {
    const st = xc27Of(cfg);
    return {
      max: XC27_LIMITS.roundMaxPts, label: 'pts ronda XC27',
      // Sin el tope de 750: si el diseño bate la marca de referencia, el
      // optimizador debe seguir viendo gradiente.
      fast: (m) => roundPoints(scoreXc27Round(xc27InputFromMetrics(m, st)).pEquipo, st.pMaxRef, false)
        * hardPenalty(constraints, m),
    };
  }

  const wTotal = objectives.reduce((s, o) => s + Math.max(0, o.weight), 0) || 1;
  return {
    max: 1000, label: 'pts misión',
    fast: (m) => {
      let acc = 0;
      for (const o of objectives) acc += Math.max(0, o.weight) * normalizeObjective(o, m[o.metric]);
      return (1000 * acc) / wTotal * hardPenalty(constraints, m);
    },
  };
}

// ==================================================================
//  Generación del espacio de diseño
// ==================================================================
/**
 * Se buscan TODOS los perfiles del catálogo: las etiquetas de la misión son
 * una pista para el ingeniero, no un filtro. Restringirlas escondería
 * óptimos legítimos (un ala volante para vigilancia, un perfil de carga en
 * una misión de alcance) y haría que la sensibilidad recomendase perfiles
 * que la propia búsqueda no había podido considerar.
 */
export function candidateAirfoils(_mission: MissionType): Airfoil[] {
  return AIRFOILS;
}

export function candidatePlanforms(vars: MissionVariables, b: Breadth): Planform[] {
  const cfg = BREADTH[b];
  const arList = [5, 6.5, 8, 10, 13].slice(0, cfg.ars);
  const out: Planform[] = [];
  const spanMax = Math.max(0.7, vars.maxSpanM);
  const spanMin = Math.max(0.6, spanMax * 0.5);
  for (let i = 0; i < cfg.spans; i++) {
    const spanM = cfg.spans === 1 ? spanMax : spanMin + ((spanMax - spanMin) * i) / (cfg.spans - 1);
    for (const aspectRatio of arList) {
      for (const taper of cfg.tapers) {
        out.push({ spanM, aspectRatio, taper, sweepDeg: 0, washoutDeg: -2 });
      }
    }
  }
  return out;
}

function dedupeBatteries(list: Battery[]): Battery[] {
  const keep = new Map<string, Battery>();
  for (const b of list) {
    // el catálogo trae celdas "Generic" de prueba sin masa: no son productos reales
    if (!(b.massG > 0)) continue;
    if (b.capacityMah < 800 || b.capacityMah > 30000) continue;
    const key = `${b.cells}-${Math.round(b.capacityMah / 100)}`;
    const cur = keep.get(key);
    // a igualdad de S y capacidad, gana la más ligera y con menos resistencia interna
    if (!cur || b.massG < cur.massG || (b.massG === cur.massG && b.rintCell < cur.rintCell)) keep.set(key, b);
  }
  return [...keep.values()];
}

/**
 * Packs candidatos: cada batería del catálogo, sola o agrupada.
 * Agrupar en serie sube la tensión (más rpm con la misma corriente) y en
 * paralelo sube la energía embarcada y baja el sag — ambas son decisiones
 * de diseño reales que cambian por completo el avión ganador.
 */
export function candidatePacks(vars: MissionVariables, perCells = 99): Pack[] {
  const maxMassG = vars.maxMtowKg * 1000 * 0.5;
  const all: Pack[] = [];
  for (const b of dedupeBatteries(BATTERIES)) {
    for (let s = 1; s <= 2; s++) {
      if (b.cells * s < 3 || b.cells * s > vars.maxCells) continue;
      for (let p = 1; p <= Math.max(1, vars.maxPacksParallel); p++) {
        const pack = makePack(b, s, p);
        if (pack.massG > maxMassG) continue;
        all.push(pack);
      }
    }
  }
  if (perCells >= 99) return all;

  // Muestreo por tensión y energía: la energía embarcada es una variable
  // continua, así que basta con cubrirla de forma uniforme. Quedarse con
  // "los mejores" en su lugar sesga la búsqueda y esconde los óptimos.
  const byCells = new Map<number, Pack[]>();
  for (const p of all) {
    const arr = byCells.get(p.cells) ?? [];
    arr.push(p);
    byCells.set(p.cells, arr);
  }
  const out: Pack[] = [];
  for (const arr of byCells.values()) {
    arr.sort((a, c) => packWh(a) - packWh(c));
    if (arr.length <= perCells) { out.push(...arr); continue; }
    const seen = new Set<number>();
    for (let i = 0; i < perCells; i++) {
      const idx = Math.round((i * (arr.length - 1)) / (perCells - 1));
      if (!seen.has(idx)) { seen.add(idx); out.push(arr[idx]); }
    }
  }
  return out;
}

/** Criba de trenes propulsivos: descarta lo inviable y ordena por calidad. */
export function buildDrives(cfg: OptimizeConfig, rho: number, avionics: AvionicsSuite): { drives: DriveUnit[]; screened: number } {
  const b = BREADTH[cfg.breadth];
  const vars = cfg.vars;
  const motors = vars.lockMotorId ? MOTORS.filter((m) => m.id === vars.lockMotorId) : MOTORS;
  const packs = candidatePacks(vars, b.packsPerCells);
  const escs = ESCS.filter((e) => e.iMax >= vars.escMinA);
  const escList = escs.length ? escs : [ESCS.reduce((a, e) => (e.iMax > a.iMax ? e : a))];
  // la hélice no puede ser mayor que lo que el tren de aterrizaje / fuselaje admite
  const maxDia = Math.min(18, (vars.maxSpanM * 0.32) / 0.0254);
  const props = PROPS.filter((p) => p.dia <= maxDia && p.dia >= 5);

  // peso de referencia para juzgar si un tren "levanta" el avión
  const estAirframeG = 260 + 420 * vars.maxSpanM;
  const cruiseV = 16;

  interface Cand {
    motor: Motor; prop: Propeller; pack: Pack; esc: Esc;
    eff: number;       // eficiencia en crucero  → misiones de autonomía/alcance
    lift: number;      // empuje estático        → misiones de carga y despegue corto
    fast: number;      // empuje a alta velocidad→ misiones de velocidad
  }
  const byGroup = new Map<string, Cand[]>();
  let screened = 0;

  for (const motor of motors) {
    for (const pack of packs) {
      for (const esc of escList) {
        const iLimit = Math.min(motor.iMax, esc.iMax);
        const wEstN = ((estAirframeG + pack.massG + motor.massG + avionics.massG + vars.payloadG) / 1000) * 9.80665;
        for (const prop of props) {
          screened++;
          const dt = driveTrainOf({ motor, prop, pack, esc }, rho);
          const st = solvePoint(dt, 1, 0);
          if (!Number.isFinite(st.thrustN) || st.thrustN <= 0) continue;
          if (st.current > iLimit * 1.30) continue;             // quemaría motor o ESC
          if (st.thrustN / wEstN < 0.45) continue;              // no despega ni lanzado a mano
          const cr = solvePoint(dt, 0.65, cruiseV);
          const hi = solvePoint(dt, 1, 30);
          const key = `${motor.id}|${pack.battery.id}|${pack.series}x${pack.parallel}|${esc.id}`;
          const arr = byGroup.get(key) ?? [];
          arr.push({ motor, prop, pack, esc, eff: cr.etaTotal, lift: st.thrustN, fast: hi.thrustN });
          byGroup.set(key, arr);
        }
      }
    }
  }

  // De cada grupo sobreviven las mejores hélices en CADA criterio, no en una
  // media: una hélice de paso corto y otra de paso largo ganan misiones
  // distintas, y quedarse sólo con la "mejor global" perdería el óptimo.
  const picked: Cand[] = [];
  // Cuando la misión incluye planeo con el motor parado, plegable y fija son
  // hélices distintas aunque empujen igual: se criban por separado.
  const splitFolding = cfg.mission.scorer === 'xc27';
  for (const arr of byGroup.values()) {
    const chosen = new Set<Cand>();
    const classes = splitFolding ? [arr.filter((c) => c.prop.folding), arr.filter((c) => !c.prop.folding)] : [arr];
    for (const cls of classes) {
      for (const crit of ['eff', 'lift', 'fast'] as const) {
        [...cls].sort((x, y) => y[crit] - x[crit]).slice(0, b.propsPerCriterion).forEach((c) => chosen.add(c));
      }
    }
    picked.push(...chosen);
  }
  picked.sort((x, y) => y.eff + y.lift / 40 - (x.eff + x.lift / 40));
  const finalList = picked.slice(0, b.maxDrives);

  const drives: DriveUnit[] = finalList.map((c) => ({
    motor: c.motor, prop: c.prop, pack: c.pack, esc: c.esc, avionics,
    map: buildDriveMap(driveTrainOf(c, rho)),
  }));
  return { drives, screened };
}

// ==================================================================
//  Búsqueda
// ==================================================================
/**
 * Cede el hilo para que la barra de progreso se repinte.
 * Se usa MessageChannel y no setTimeout: los navegadores estrangulan
 * setTimeout a 1 s en pestañas de fondo, lo que multiplicaba por veinte el
 * tiempo total de una búsqueda que en realidad dura un par de segundos.
 */
const yieldToUI: () => Promise<void> =
  typeof MessageChannel === 'undefined'
    ? () => new Promise<void>((r) => setTimeout(r, 0))
    : () => new Promise<void>((resolve) => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
        ch.port2.postMessage(0);
      });

export interface Progress { stage: string; done: number; total: number; }

export async function optimize(
  cfg: OptimizeConfig,
  onProgress?: (p: Progress) => void,
): Promise<OptimizeResult> {
  const t0 = performance.now();
  const vars = cfg.vars;
  const b = BREADTH[cfg.breadth];
  const rho = rhoOf(vars);
  const avionics = selectAvionics(cfg.requiredAvionics, vars.avionicsPreference);
  const scorer = makeScorer(cfg);
  const rules = ruleOptions(cfg);
  const notes: string[] = [];

  onProgress?.({ stage: 'Cribando trenes propulsivos del catálogo…', done: 0, total: 1 });
  await yieldToUI();
  const { drives } = buildDrives(cfg, rho, avionics);
  if (!drives.length) {
    return {
      designs: [], scanned: 0, feasibleCount: 0, elapsedMs: performance.now() - t0,
      space: { wings: 0, drives: 0, combos: 0, airfoils: 0 }, scoreMax: scorer.max, scoreLabel: scorer.label,
      cloud: [], sensitivity: [], avionics,
      notes: ['Ningún tren propulsivo del catálogo cumple las restricciones: relaja el mínimo de ESC, el límite de celdas o la carga de pago.'],
    };
  }

  const airfoils = candidateAirfoils(cfg.mission);
  const planforms = candidatePlanforms(vars, cfg.breadth);
  const frames: Airframe[] = [];
  for (const airfoil of airfoils)
    for (const planform of planforms)
      frames.push({ planform, airfoil, flyingWing: airfoil.reflex });

  const allModels: AeroModel[] = frames.map((f) => buildAeroModel(f, vars, rho));
  const models = allModels.filter((m) => frameAllowed(cfg, m));
  if (models.length < allModels.length) {
    notes.push(`${allModels.length - models.length} de ${allModels.length} células no caben en la caja de transporte de 1300 mm ni con el fuselaje mínimo y se han descartado antes de simular.`);
  }
  // En XC27 la puntuación no depende del punto de crucero: basta un barrido
  // de velocidad corto en la pasada gruesa.
  const coarseVSteps = cfg.mission.scorer === 'xc27' ? 6 : b.vSteps;
  const pick: PayloadOptions = {
    pickSpeedBy: scorer.fast, vScanSteps: coarseVSteps,
    payloadMode: vars.payloadMode, payloadLevels: 3, extra: rules.extra, refitFuselage: rules.refitFuselage,
  };

  let scanned = 0, feasibleCount = 0;
  const cloud: { x: number; y: number; feasible: boolean }[] = [];
  // Se guardan muchos más de los que se muestran: el filtro de diversidad
  // descarta variantes casi idénticas y hay que llegar con margen.
  const KEEP = 48;
  const top: { score: number; ev: DesignEvaluation }[] = [];

  for (let wi = 0; wi < models.length; wi++) {
    const model = models[wi];
    for (const drive of drives) {
      const ev = evaluateBestPayload(model, drive, vars, pick);
      scanned++;
      if (ev.metrics.cruiseSpeedMs <= 0) continue;
      const score = scorer.fast(ev.metrics);
      const hardOk = ev.feasible && cfg.constraints.every((c) => {
        if (!c.hard) return true;
        const v = ev.metrics[c.metric];
        return c.op === '<=' ? v <= c.value : v >= c.value;
      });
      if (hardOk) feasibleCount++;
      if (cloud.length < 4000) cloud.push({ x: ev.metrics.mtowKg, y: score, feasible: hardOk });

      const effective = hardOk ? score : score * 0.5;
      if (top.length < KEEP || effective > top[top.length - 1].score) {
        top.push({ score: effective, ev });
        top.sort((a, c) => c.score - a.score);
        if (top.length > KEEP) top.length = KEEP;
      }
    }
    if (wi % 8 === 7) {
      onProgress?.({ stage: 'Cruzando células y trenes propulsivos…', done: wi + 1, total: models.length });
      await yieldToUI();
    }
  }

  // Segunda pasada de precisión sobre la lista corta: más niveles de carga
  // y más resolución en velocidad, ya sin coste apreciable.
  onProgress?.({ stage: 'Refinando los mejores candidatos…', done: models.length, total: models.length });
  await yieldToUI();
  const fine: PayloadOptions = { pickSpeedBy: scorer.fast, vScanSteps: 26, payloadMode: vars.payloadMode, payloadLevels: 7, ...rules };
  const refined = top
    .map((t) => evaluateBestPayload(t.ev.model, t.ev.drive, vars, fine))
    .filter((ev) => ev.metrics.cruiseSpeedMs > 0)
    .map((ev) => ({ ev, score: scorer.fast(ev.metrics) }))
    .sort((a, c) => c.score - a.score);

  // Diversidad: una lista de alternativas con el mismo perfil y la misma
  // batería no informa. Se limita la repetición para que cada fila sea un
  // concepto realmente distinto.
  const seenAf = new Map<string, number>(), seenPack = new Map<string, number>();
  const diverse = refined.filter((t, i) => {
    const af = t.ev.model.airframe.airfoil.id, pk = t.ev.drive.pack.label;
    const na = (seenAf.get(af) ?? 0), np = (seenPack.get(pk) ?? 0);
    if (i > 0 && (na >= 3 || np >= 3)) return false;
    seenAf.set(af, na + 1); seenPack.set(pk, np + 1);
    return true;
  }).slice(0, 12);

  const designs = diverse.map((t, i) => finishDesign(t.ev, cfg, scorer, i + 1));

  if (!designs.length) {
    notes.push('Ningún concepto alcanza vuelo estabilizado con estas restricciones. Prueba a bajar la carga de pago o a subir el límite de envergadura.');
  } else if (!designs.some((d) => d.mission.feasible)) {
    notes.push('Ningún diseño cumple todas las restricciones duras: se muestra el más cercano, con los incumplimientos marcados en rojo.');
  }
  if (vars.lockMotorId) notes.push('Motor bloqueado por reglamento: la optimización se juega en hélice, batería, perfil y planta alar.');

  // Si los parciales del reglamento saturan, el modelo pierde gradiente y deja
  // de indicar qué mejorar: hay que subir las marcas de referencia de la ronda.
  const w = designs[0];
  if (w?.xcEfficient) {
    const r = w.xcEfficient.result;
    const cap: string[] = [];
    if (r.pPeso >= 99.9) cap.push('P_peso');
    if (r.pDist >= 74.9) cap.push('P_dist');
    if (r.pCorr >= 74.9) cap.push('P_corr');
    if (r.bCarga >= 49.9) cap.push('B_carga');
    if (cap.length) notes.push(`Tu diseño supera la marca de referencia en ${cap.join(', ')}: el parcial satura en su tope y la sensibilidad se aplana. Sube las mejores marcas de la ronda para seguir optimizando.`);
  }
  if (w?.xc27) {
    if (w.xc27.pointsRaw > XC27_LIMITS.roundMaxPts + 0.5) {
      notes.push(`Tu diseño bate la marca de referencia de la ronda (P_equipo ${w.xc27.result.pEquipo.toFixed(2)} frente a P_max ${xc27Of(cfg).pMaxRef}): la ronda satura en 750. Sube P_max para comparar diseños con una referencia realista.`);
    }
    if (w.evaluation.metrics.alt60M >= xc27Of(cfg).altCeilingM - 0.5) {
      notes.push('El avión llega al techo operativo antes de los 60 s: sobra ascenso. Ese exceso de potencia se puede cambiar por más carga o por una hélice de más paso para los pilones.');
    }
    notes.push('Reglamento XC27: P_CA se calcula con la carga en ' + (xc27Of(cfg).payloadUnit === 'kg' ? 'kg (texto de §9.5.4)' : 'gramos (lectura alternativa)') + '. Es la mayor incertidumbre de la fórmula — confírmala con la organización.');
  }
  if (w?.xcUrgent && w.xcUrgent.result.pTiempo >= 299.9) {
    notes.push('Tu tiempo de circuito bate la marca de referencia: P_tiempo satura en 300. Sube el tiempo mínimo de la ronda para recuperar sensibilidad.');
  }

  const sensitivity = designs.length ? await sensitivityOf(designs[0], cfg, rho, avionics, scorer) : [];

  return {
    designs, scanned, feasibleCount, elapsedMs: performance.now() - t0,
    space: { wings: models.length, drives: drives.length, combos: models.length * drives.length, airfoils: airfoils.length },
    scoreMax: scorer.max, scoreLabel: scorer.label, cloud, sensitivity, avionics, notes,
  };
}

// ------------------------------------------------------------------
//  Ficha completa del diseño (puntuación detallada + porqués)
// ------------------------------------------------------------------
function finishDesign(ev: DesignEvaluation, cfg: OptimizeConfig, scorer: Scorer, rank: number): RankedDesign {
  const mission = scoreMission(cfg.objectives, cfg.constraints, ev.metrics);
  const score = scorer.fast(ev.metrics);
  const d: RankedDesign = {
    rank, score, scoreMax: scorer.max, mission, evaluation: ev,
    why: explain(ev, cfg),
  };
  if (cfg.mission.scorer === 'xc26-efficient') d.xcEfficient = xcEfficientFromMetrics(ev.metrics, cfg.xcRefs, cfg.xcAssumptions);
  if (cfg.mission.scorer === 'xc27') d.xc27 = xc27FromMetrics(ev.metrics, xc27Of(cfg));
  if (cfg.mission.scorer === 'xc26-urgent') d.xcUrgent = xcUrgentFromMetrics(ev.metrics, cfg.xcRefs, cfg.xcAssumptions);
  return d;
}

/** Justificación en lenguaje de ingeniero de por qué gana este avión. */
export function explain(ev: DesignEvaluation, cfg: OptimizeConfig): string[] {
  const out: string[] = [];
  const m = ev.metrics;
  const af = ev.model.airframe.airfoil;
  const p = ev.model.airframe.planform;
  const dr = ev.drive;

  out.push(`**Perfil ${af.name}** (CLmáx de ala ${ev.model.clMaxWing.toFixed(2)}, cd mín ${af.cdMin.toFixed(4)}): ${af.note.split('.')[0]}.`);
  out.push(`**Planta alar** b=${p.spanM.toFixed(2)} m · AR=${p.aspectRatio.toFixed(1)} · S=${ev.model.S.toFixed(3)} m² → carga alar ${m.wingLoadingGm2.toFixed(0)} g/m² y (L/D)máx ${m.ldMax.toFixed(1)}.`);
  out.push(`**Hélice ${dr.prop.dia}×${dr.prop.pitch}"** sobre ${dr.motor.name}: en crucero pide ${(ev.cruise.throttle * 100).toFixed(0)} % de gas y ${m.cruiseCurrentA.toFixed(1)} A de un límite de ${Math.min(dr.motor.iMax, dr.esc.iMax)} A.`);
  if (cfg.mission.scorer === 'xc27') {
    const st = xc27Of(cfg);
    out.length = 2;
    out.push(`**Hélice ${dr.prop.dia}×${dr.prop.pitch}"${dr.prop.folding ? ' plegable' : ' fija'}** sobre ${dr.motor.name}: ${m.fullCurrentA.toFixed(0)} A sostenidos en el ascenso de un límite de ${Math.min(dr.motor.iMax, dr.esc.iMax)} A.`);
    out.push(`**Ascenso**: ${m.alt60M.toFixed(0)} m a los 60 s con ${m.payloadG.toFixed(0)} g de arroz (T/W ${m.thrustWeight.toFixed(2)}, ${m.rocMs.toFixed(1)} m/s de régimen máximo).`);
    out.push(`**Planeo**: fineza ${m.glideRatio.toFixed(1)} a ${m.glideSpeedMs.toFixed(1)} m/s con la hélice ${dr.prop.folding ? 'plegada' : 'parada (una plegable quitaría esa resistencia)'} → ${m.glideDistM.toFixed(0)} m desde el corte hasta ${st.glideEndAltM} m.`);
    out.push(`**Pilones** descargado: ${m.pylonTimeS.toFixed(1)} s a ${m.pylonSpeedMs.toFixed(1)} m/s de media, virando a un máximo de ${st.pylonMaxG} g.`);
    out.push(`**Despegue** en ${m.takeoffRunM.toFixed(0)} m de asfalto → marca de ${m.takeoffMarkM <= 60 ? m.takeoffMarkM.toFixed(0) + ' m' : 'fuera de pista'} con un margen ×${st.takeoffMargin}.`);
    out.push(`**Batería ${dr.pack.label}** (${dr.pack.massG.toFixed(0)} g): la ronda consume ${m.missionMah.toFixed(0)} mAh y deja un ${m.batteryMarginPct.toFixed(0)} % de la capacidad utilizable. No se cambia en el pitstop.`);
    out.push(`**Radio**: ${dr.avionics.items.length} equipos, ${dr.avionics.massG} g, alimentados por batería auxiliar; más ${cfg.vars.fixedMassG ?? 0} g de caja de telemetría.`);
    if (!ev.feasible) out.push(`⚠ ${ev.reasons.join(' ')}`);
    return out;
  }
  out.push(`**Batería ${dr.pack.label}** (${dr.pack.massG.toFixed(0)} g, ${packWh(dr.pack).toFixed(0)} Wh): ${m.enduranceMin.toFixed(0)} min a ${m.cruiseSpeedMs.toFixed(1)} m/s con ${cfg.vars.reservePct} % de reserva y descarga de ${m.cRateUsed.toFixed(1)}C.`);
  if (cfg.vars.payloadMode === 'maxima') out.push(`**Carga útil elegida ${m.payloadG.toFixed(0)} g** (${m.payloadFrac.toFixed(0)} % del MTOW): el punto de la curva carga/alcance que más puntúa en esta misión.`);
  out.push(`**Electrónica**: ${dr.avionics.items.length} equipos, ${dr.avionics.massG} g y ${dr.avionics.powerW.toFixed(1)} W — una carga hotel de ${ev.cruise.avionicsA.toFixed(2)} A, el ${((ev.cruise.avionicsA / Math.max(0.01, m.cruiseCurrentA)) * 100).toFixed(0)} % del consumo total.`);

  if (ev.model.airframe.flyingWing) out.push('Configuración **ala volante**: sin cola ni fuselaje, menos superficie mojada y menos masa, a cambio de menor CLmáx y menor margen de pérdida.');
  if (m.takeoffRunM > 0 && m.takeoffRunM < 900) out.push(`Despega en **${m.takeoffRunM.toFixed(0)} m** de hierba sobre los ${cfg.vars.runwayM} m disponibles.`);
  if (cfg.vars.runwayM <= 0) out.push('Lanzamiento a mano o con catapulta: no hay carrera de despegue, pero se exige empuje/peso alto.');
  if (!ev.feasible) out.push(`⚠ ${ev.reasons.join(' ')}`);
  return out;
}

// ------------------------------------------------------------------
//  Sensibilidad: variables de misión y cambios de componente
// ------------------------------------------------------------------
async function sensitivityOf(
  winner: RankedDesign, cfg: OptimizeConfig, rho: number, avionics: AvionicsSuite, scorer: Scorer,
): Promise<SensitivityItem[]> {
  const items: SensitivityItem[] = [];
  const base = winner.score;
  const ev = winner.evaluation;
  const pick: PayloadOptions = {
    // misma resolución que la pasada de refinado: si no, el propio ruido de la
    // rejilla aparecería como sensibilidad
    pickSpeedBy: scorer.fast, vScanSteps: 26,
    payloadMode: cfg.vars.payloadMode, payloadLevels: 7, ...ruleOptions(cfg),
  };

  const rescore = (model: AeroModel, drive: DriveUnit, vars: MissionVariables) =>
    scorer.fast(evaluateBestPayload(model, drive, vars, pick).metrics);

  // --- variables de misión ---------------------------------------
  const varCases: { label: string; hint: string; vars: Partial<MissionVariables>; rebuildAero?: boolean }[] = [
    { label: '+100 g de carga', hint: cfg.vars.payloadMode === 'maxima' ? 'subir el mínimo exigido de carga' : 'sensibilidad al peso de la misión', vars: { payloadG: cfg.vars.payloadG + 100 }, rebuildAero: true },
    { label: '+2 m/s de viento', hint: 'degradación con meteorología adversa', vars: { windMs: cfg.vars.windMs + 2 } },
    { label: 'Construcción −15 % masa', hint: 'invertir en fibra de carbono', vars: { buildFactor: cfg.vars.buildFactor * 0.85 }, rebuildAero: true },
    { label: 'Reserva de batería −5 pts', hint: 'apurar el pack (más riesgo)', vars: { reservePct: Math.max(5, cfg.vars.reservePct - 5) } },
    { label: '+500 m de altitud', hint: 'menor densidad: menos empuje y más V de pérdida', vars: { cruiseAltM: cfg.vars.cruiseAltM + 500 } },
  ];
  for (const c of varCases) {
    const vars = { ...cfg.vars, ...c.vars };
    const rho2 = rhoOf(vars);
    const model = c.rebuildAero || rho2 !== rho ? buildAeroModel(ev.model.airframe, vars, rho2) : ev.model;
    const drive = rho2 !== rho
      ? { ...ev.drive, map: buildDriveMap(driveTrainOf(ev.drive, rho2)) }
      : ev.drive;
    items.push({ label: c.label, hint: c.hint, delta: rescore(model, drive, vars) - base, kind: 'variable' });
  }

  await yieldToUI();

  // --- cambios de componente sobre el ganador ---------------------
  const bestSwap = <T>(list: T[], make: (x: T) => { model: AeroModel; drive: DriveUnit } | null, name: (x: T) => string) => {
    let bestDelta = 0, bestName = '';
    for (const x of list) {
      const built = make(x);
      if (!built) continue;
      const d = rescore(built.model, built.drive, cfg.vars) - base;
      if (d > bestDelta) { bestDelta = d; bestName = name(x); }
    }
    return { bestDelta, bestName };
  };

  const maxDia = Math.min(18, (cfg.vars.maxSpanM * 0.32) / 0.0254);
  const propSwap = bestSwap(
    PROPS.filter((p) => p.dia <= maxDia && p.id !== ev.drive.prop.id),
    (prop) => {
      const drive: DriveUnit = { ...ev.drive, prop, map: buildDriveMap(driveTrainOf({ ...ev.drive, prop }, rho)) };
      return { model: ev.model, drive };
    },
    (p) => `${p.dia}×${p.pitch}" ${p.brand}`,
  );
  if (propSwap.bestName) items.push({ label: `Hélice → ${propSwap.bestName}`, hint: 'ajuste fino del paso al punto de crucero', delta: propSwap.bestDelta, kind: 'componente' });

  await yieldToUI();

  const curPack = ev.drive.pack;
  const battSwap = bestSwap(
    candidatePacks(cfg.vars).filter((x) => x.label !== curPack.label),
    (pack) => {
      const drive: DriveUnit = { ...ev.drive, pack, map: buildDriveMap(driveTrainOf({ ...ev.drive, pack }, rho)) };
      return { model: ev.model, drive };
    },
    (x) => `${x.label} (${x.massG.toFixed(0)} g)`,
  );
  if (battSwap.bestName) items.push({ label: `Batería → ${battSwap.bestName}`, hint: 'compromiso energía embarcada / masa', delta: battSwap.bestDelta, kind: 'componente' });

  await yieldToUI();

  const afSwap = bestSwap(
    AIRFOILS.filter((a) => a.id !== ev.model.airframe.airfoil.id),
    (airfoil) => {
      const frame: Airframe = { ...ev.model.airframe, airfoil, flyingWing: airfoil.reflex };
      return { model: buildAeroModel(frame, cfg.vars, rho), drive: ev.drive };
    },
    (a) => a.name,
  );
  if (afSwap.bestName) items.push({ label: `Perfil → ${afSwap.bestName}`, hint: 'otra familia de perfil sobre la misma planta alar', delta: afSwap.bestDelta, kind: 'componente' });

  const spanSwap = bestSwap(
    [0.85, 0.92, 1.08, 1.15].filter((f) => ev.model.airframe.planform.spanM * f <= cfg.vars.maxSpanM),
    (f) => {
      const planform = { ...ev.model.airframe.planform, spanM: ev.model.airframe.planform.spanM * f };
      return { model: buildAeroModel({ ...ev.model.airframe, planform }, cfg.vars, rho), drive: ev.drive };
    },
    (f) => `${(ev.model.airframe.planform.spanM * f).toFixed(2)} m`,
  );
  if (spanSwap.bestName) items.push({ label: `Envergadura → ${spanSwap.bestName}`, hint: 'más envergadura baja la resistencia inducida pero pesa', delta: spanSwap.bestDelta, kind: 'componente' });

  return items.sort((a, c) => c.delta - a.delta);
}

// ------------------------------------------------------------------
//  Utilidades para la interfaz
// ------------------------------------------------------------------
export const metricLabel = (k: keyof Metrics) => METRICS[k].label;

export function emptyResult(): OptimizeResult {
  return {
    designs: [], scanned: 0, feasibleCount: 0, elapsedMs: 0,
    space: { wings: 0, drives: 0, combos: 0, airfoils: 0 },
    scoreMax: 1000, scoreLabel: 'pts misión', cloud: [], sensitivity: [],
    avionics: { items: [], massG: 0, powerW: 0, priceUsd: 0 }, notes: [],
  };
}

export const blankMetrics = emptyMetrics;
