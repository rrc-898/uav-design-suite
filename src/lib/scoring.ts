// ==================================================================
//  XtraChallenge 2026 — scoring model (Categoria Academica).
//  Source: Reglamento Tecnico XC_26 v1.12, secciones 9.x.
//  Max 1000 pts = 250 static + 750 flight.
// ==================================================================

// ---- Efficient transport mission (carga) -------------------------
// P_ronda = ((P_peso + P_dist + P_corr) * L + B_carga) * B_despegue * S_piloto * S_repuestos
export interface EfficientInput {
  plWaterG: number;   // water ration mass carried, g
  plFoodG: number;    // food ration mass carried, g
  plMaxG: number;     // best payload score parameter across teams (PL_max)
  distance: number;   // cruise distance over 150 s, m
  distanceMax: number;// best distance across teams
  currentA: number;   // mean cruise current, A
  currentMin: number; // best (lowest) current across teams, A
  loadCoeff: number;  // CT_equipo = C_water / sqrt(t_load)
  loadCoeffMax: number;// CT_max across teams
  legality: 0 | 0.5 | 1;       // L_vuelo
  takeoff: '60' | '40' | '20' | 'foul'; // B_despegue
  externalPilot: boolean;      // S_piloto
  sparePenalty: boolean;       // S_repuestos (25% off if true)
}

export function payloadEquiv(waterG: number, foodG: number): number {
  return 0.95 * waterG + 1.05 * foodG; // PL_equipo
}

const takeoffBonus = (t: EfficientInput['takeoff']) =>
  t === 'foul' ? 0 : t === '40' ? 1.125 : t === '20' ? 1.25 : 1;

export function currentScore(currentA: number, currentMin: number): number {
  // 75 pts at the best (lowest) current, linear down to 0 at 30 A.
  // Capped at 75: the reference is by definition the best of the round,
  // so beating it only means *becoming* the reference.
  if (currentA >= 30) return 0;
  const denom = 30 - currentMin;
  if (denom <= 0) return currentA <= currentMin ? 75 : 0;
  return Math.min(75, Math.max(0, 75 * (30 - currentA) / denom));
}

export interface EfficientResult {
  pPeso: number; pDist: number; pCorr: number; bCarga: number;
  bDespegue: number; sPiloto: number; sRepuestos: number; total: number;
}

export function scoreEfficient(i: EfficientInput): EfficientResult {
  // Los parciales se normalizan contra la MEJOR marca de la ronda, así que
  // ninguno puede pasar de su máximo: superar la referencia sólo significa
  // pasar a ser la referencia.
  const pl = payloadEquiv(i.plWaterG, i.plFoodG);
  const pPeso = i.plMaxG > 0 ? Math.min(100, 100 * (pl / i.plMaxG)) : 0;
  const pDist = i.distanceMax > 0 ? Math.min(75, 75 * (i.distance / i.distanceMax)) : 0;
  const pCorr = currentScore(i.currentA, i.currentMin);
  const bCarga = i.loadCoeffMax > 0 ? Math.min(50, 50 * (i.loadCoeff / i.loadCoeffMax)) : 0;
  const bDespegue = takeoffBonus(i.takeoff);
  const sPiloto = i.externalPilot ? 0.75 : 1;
  const sRepuestos = i.sparePenalty ? 0.75 : 1;
  const total = ((pPeso + pDist + pCorr) * i.legality + bCarga) * bDespegue * sPiloto * sRepuestos;
  return { pPeso, pDist, pCorr, bCarga, bDespegue, sPiloto, sRepuestos, total };
}

// ---- Urgent transport mission (velocidad) ------------------------
// P_ronda = (P_tiempo * L) * B_aterrizaje * S_piloto * S_repuestos
export interface UrgentInput {
  time: number;       // s to complete 1.2 km circuit
  timeMin: number;    // best (lowest) time across teams
  legality: 0 | 0.5 | 1;
  landing: 'none' | '20-30' | '10-20' | '0-10'; // B_aterrizaje
  externalPilot: boolean;
  sparePenalty: boolean;
}

const landingBonus = (l: UrgentInput['landing']) =>
  l === '0-10' ? 1.25 : l === '10-20' ? 1.15 : l === '20-30' ? 1.05 : 1;

export function scoreUrgent(i: UrgentInput) {
  const pTiempo = i.time > 0 ? Math.min(300, 300 * (i.timeMin / i.time)) : 0;
  const bAterrizaje = landingBonus(i.landing);
  const sPiloto = i.externalPilot ? 0.75 : 1;
  const sRepuestos = i.sparePenalty ? 0.75 : 1;
  const total = (pTiempo * i.legality) * bAterrizaje * sPiloto * sRepuestos;
  return { pTiempo, bAterrizaje, sPiloto, sRepuestos, total };
}

// ==================================================================
//  Puente simulación → reglamento
//
//  El simulador de misión produce métricas físicas (carga, velocidad
//  de crucero, corriente media…). Estas funciones las traducen a las
//  variables del reglamento y aplican la fórmula oficial, de modo que
//  la puntuación XC26 sale directamente de la física del prototipo y
//  no de números introducidos a mano.
// ==================================================================

/** Mejores marcas de la ronda: la puntuación del reglamento es relativa. */
export interface XcRoundRefs {
  plMaxG: number;
  distanceMaxM: number;
  currentMinA: number;
  loadCoeffMax: number;
  timeMinS: number;
}

/**
 * Marcas de referencia por defecto: se toman ambiciosas a propósito. Si la
 * referencia es floja, todos los parciales saturan en su tope y el simulador
 * se queda sin gradiente — deja de decir qué mejorar. Sustitúyelas por las
 * marcas reales de la ronda en cuanto se conozcan.
 */
export const XC_DEFAULT_REFS: XcRoundRefs = {
  plMaxG: 950, distanceMaxM: 5400, currentMinA: 6, loadCoeffMax: 95, timeMinS: 45,
};

export interface XcAssumptions {
  waterFrac: number;      // reparto agua/comida de la ración
  loadBaseS: number;      // tiempo fijo de manipulación de la bahía, s
  loadRateGs: number;     // caudal de carga de agua, g/s
  legality: 0 | 0.5 | 1;
  takeoff: EfficientInput['takeoff'];
  landing: UrgentInput['landing'];
  externalPilot: boolean;
  sparePenalty: boolean;
}

export const XC_DEFAULT_ASSUMPTIONS: XcAssumptions = {
  waterFrac: 0.6, loadBaseS: 10, loadRateGs: 22,
  legality: 1, takeoff: '20', landing: '10-20',
  externalPilot: false, sparePenalty: false,
};

/** Tiempo de carga estimado a partir del agua embarcada (bahía + caudal). */
export const loadTimeS = (waterG: number, a: XcAssumptions) =>
  a.loadBaseS + waterG / Math.max(1, a.loadRateGs);

export interface XcEfficientSim {
  input: EfficientInput;
  result: EfficientResult;
  waterG: number;
  foodG: number;
  loadTimeS: number;
}

/** Puntuación §9.9.1 alimentada por las métricas simuladas del prototipo. */
export function xcEfficientFromMetrics(
  m: { payloadG: number; distance150M: number; cruiseCurrentA: number },
  refs: XcRoundRefs,
  a: XcAssumptions,
): XcEfficientSim {
  const waterG = m.payloadG * a.waterFrac;
  const foodG = m.payloadG * (1 - a.waterFrac);
  const tLoad = loadTimeS(waterG, a);
  const input: EfficientInput = {
    plWaterG: waterG, plFoodG: foodG, plMaxG: refs.plMaxG,
    distance: m.distance150M, distanceMax: refs.distanceMaxM,
    currentA: m.cruiseCurrentA, currentMin: refs.currentMinA,
    loadCoeff: waterG / Math.sqrt(Math.max(1, tLoad)), loadCoeffMax: refs.loadCoeffMax,
    legality: a.legality, takeoff: a.takeoff,
    externalPilot: a.externalPilot, sparePenalty: a.sparePenalty,
  };
  return { input, result: scoreEfficient(input), waterG, foodG, loadTimeS: tLoad };
}

/** Puntuación §9.9.2 alimentada por el tiempo de circuito simulado. */
export function xcUrgentFromMetrics(
  m: { lapTimeS: number },
  refs: XcRoundRefs,
  a: XcAssumptions,
) {
  const input: UrgentInput = {
    time: m.lapTimeS, timeMin: refs.timeMinS, legality: a.legality,
    landing: a.landing, externalPilot: a.externalPilot, sparePenalty: a.sparePenalty,
  };
  return { input, result: scoreUrgent(input) };
}

/** Puntuación máxima teórica de cada misión de vuelo (para normalizar barras). */
export const XC_ROUND_MAX = { efficient: 375, urgent: 375 };

// ---- Static tests (max 250) --------------------------------------
export const STATIC_MAX = {
  preliminar1: 0,
  preliminar2: 5,
  informeTecnico: 125,
  planos: 50,
  presentacion: 70,
};

// ---- Technical constraints (hard limits from the regulation) -----
export const XC_CONSTRAINTS = {
  motor: 'Emax GT2826 1090KV (unico, sin modificar)',
  escMinCurrentA: 50,
  batteryMaxCells: 4,
  batteryMaxVoltage: 16.8,
  mtowMaxKg: 25,
  transportBoxCm: { l: 85, w: 35, h: 25 },
  cruiseAltMinM: 10,
  cruiseAltMaxM: 120,
  windMaxMs: 6,
  runwayM: 60,
};
