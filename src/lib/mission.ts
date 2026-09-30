// ==================================================================
//  Mission framework — el "simulador de puntuaciones" genérico.
//
//  Una misión se describe con tres bloques independientes:
//
//   1. VARIABLES (`MissionVariables`) — lo que fija el operador o el
//      reglamento: carga útil, distancia, loiter, altitud, viento,
//      pista disponible, límites de envergadura / MTOW / celdas…
//
//   2. OBJETIVOS (`Objective[]`) — qué se puntúa y con qué peso.
//      Cada objetivo normaliza una métrica física a 0…1 entre un
//      valor "suspenso" y un valor "excelente", y aporta su peso al
//      total de 1000 puntos. Cambiando los pesos, el mismo motor
//      simula una competición, un pliego militar o un caso de negocio.
//
//   3. RESTRICCIONES (`Constraint[]`) — límites duros (descalifican)
//      o blandos (penalizan) sobre esas mismas métricas.
//
//  Los tipos de misión predefinidos (`MISSION_TYPES`) son sólo
//  combinaciones de esos tres bloques, así que cualquier misión nueva
//  del sector UAV se añade sin tocar la física.
// ==================================================================

import type { AvionicsTag } from './avionics';
import { CORE_AVIONICS } from './avionics';
import type { AirfoilTag } from './airfoils';

// ------------------------------------------------------------------
//  Métricas simuladas sobre las que se puede puntuar o restringir
// ------------------------------------------------------------------
export type MetricKey =
  | 'enduranceMin' | 'rangeKm' | 'cruiseSpeedMs' | 'maxSpeedMs' | 'bestRangeSpeedMs'
  | 'payloadG' | 'payloadFrac' | 'mtowKg' | 'emptyKg' | 'wingLoadingGm2'
  | 'cruiseCurrentA' | 'cruisePowerW' | 'whPerKm' | 'gPerW' | 'cRateUsed'
  | 'takeoffRunM' | 'rocMs' | 'stallSpeedMs' | 'stallMarginPct' | 'thrustWeight'
  | 'ldMax' | 'ldCruise' | 'cd0' | 'spanM' | 'aspectRatio'
  | 'coverageHaPerFlight' | 'distance150M' | 'lapTimeS' | 'costUsd' | 'gustSensitivity'
  // --- XtraChallenge 2027: ronda de ascenso + planeo + pilones ---
  | 'alt60M' | 'glideDistM' | 'glideRatio' | 'glideSpeedMs' | 'pylonTimeS' | 'pylonSpeedMs'
  | 'takeoffMarkM' | 'missionMah' | 'batteryMarginPct' | 'fullCurrentA' | 'boxSumMm';

export interface MetricInfo {
  label: string;
  unit: string;
  better: 'alto' | 'bajo';
  decimals: number;
  help: string;
}

export const METRICS: Record<MetricKey, MetricInfo> = {
  enduranceMin:  { label: 'Autonomía',            unit: 'min',  better: 'alto', decimals: 1, help: 'Tiempo de vuelo en crucero con la reserva de batería aplicada.' },
  rangeKm:       { label: 'Alcance',              unit: 'km',   better: 'alto', decimals: 1, help: 'Distancia recorrida en crucero, corregida por viento.' },
  cruiseSpeedMs: { label: 'V crucero',            unit: 'm/s',  better: 'alto', decimals: 1, help: 'Velocidad de crucero trimada para la misión.' },
  maxSpeedMs:    { label: 'V máxima',             unit: 'm/s',  better: 'alto', decimals: 1, help: 'Velocidad de equilibrio a gas 100 % (T = D).' },
  bestRangeSpeedMs: { label: 'V mejor alcance',   unit: 'm/s',  better: 'alto', decimals: 1, help: 'Velocidad que maximiza los km por carga de batería.' },
  payloadG:      { label: 'Carga útil',           unit: 'g',    better: 'alto', decimals: 0, help: 'Masa transportada además de la estructura, propulsión y aviónica.' },
  payloadFrac:   { label: 'Fracción de carga',    unit: '%',    better: 'alto', decimals: 1, help: 'Carga útil / MTOW: mide la eficiencia estructural del diseño.' },
  mtowKg:        { label: 'MTOW',                 unit: 'kg',   better: 'bajo', decimals: 2, help: 'Masa máxima al despegue del prototipo completo.' },
  emptyKg:       { label: 'Masa en vacío',        unit: 'kg',   better: 'bajo', decimals: 2, help: 'Estructura + propulsión + aviónica, sin carga de pago.' },
  wingLoadingGm2:{ label: 'Carga alar',           unit: 'g/m²', better: 'bajo', decimals: 0, help: 'MTOW/S. Alta = rápido y estable con viento; baja = despega corto.' },
  cruiseCurrentA:{ label: 'Corriente crucero',    unit: 'A',    better: 'bajo', decimals: 1, help: 'Consumo medio del pack en crucero (propulsión + aviónica).' },
  cruisePowerW:  { label: 'Potencia crucero',     unit: 'W',    better: 'bajo', decimals: 0, help: 'Potencia eléctrica total demandada en crucero.' },
  whPerKm:       { label: 'Energía específica',   unit: 'Wh/km',better: 'bajo', decimals: 1, help: 'Energía por kilómetro recorrido: el indicador limpio de eficiencia.' },
  gPerW:         { label: 'Eficiencia propulsiva',unit: 'g/W',  better: 'alto', decimals: 2, help: 'Gramos de empuje por vatio en el punto de crucero.' },
  cRateUsed:     { label: 'C-rate usado',         unit: 'C',    better: 'bajo', decimals: 1, help: 'Descarga exigida a la batería frente a su capacidad.' },
  takeoffRunM:   { label: 'Carrera de despegue',  unit: 'm',    better: 'bajo', decimals: 1, help: 'Rodadura hasta el despegue sobre hierba (μ = 0.06).' },
  rocMs:         { label: 'Régimen de ascenso',   unit: 'm/s',  better: 'alto', decimals: 1, help: 'Velocidad vertical máxima a gas 100 %.' },
  stallSpeedMs:  { label: 'V de pérdida',         unit: 'm/s',  better: 'bajo', decimals: 1, help: 'Velocidad mínima de vuelo al MTOW.' },
  stallMarginPct:{ label: 'Margen de pérdida',    unit: '%',    better: 'alto', decimals: 0, help: 'Cuánto separa la velocidad de crucero de la pérdida.' },
  thrustWeight:  { label: 'Empuje/peso',          unit: '',     better: 'alto', decimals: 2, help: 'Empuje estático dividido por el peso: capacidad de despegue y escape.' },
  ldMax:         { label: '(L/D) máx',            unit: '',     better: 'alto', decimals: 1, help: 'Eficiencia aerodinámica máxima del avión completo.' },
  ldCruise:      { label: 'L/D en crucero',       unit: '',     better: 'alto', decimals: 1, help: 'Eficiencia real en el punto de vuelo de la misión.' },
  cd0:           { label: 'CD₀',                  unit: '',     better: 'bajo', decimals: 4, help: 'Resistencia parásita del conjunto a la velocidad de crucero.' },
  spanM:         { label: 'Envergadura',          unit: 'm',    better: 'bajo', decimals: 2, help: 'Limitada por la caja de transporte o por el hangar.' },
  aspectRatio:   { label: 'Alargamiento AR',      unit: '',     better: 'alto', decimals: 1, help: 'b²/S. Alto = menos resistencia inducida, ala más flexible.' },
  coverageHaPerFlight: { label: 'Cobertura',      unit: 'ha',   better: 'alto', decimals: 0, help: 'Hectáreas barridas por vuelo (velocidad × autonomía × ancho de pasada).' },
  distance150M:  { label: 'Distancia en 150 s',   unit: 'm',    better: 'alto', decimals: 0, help: 'Distancia recorrida en la ventana de crucero del reglamento XC26.' },
  lapTimeS:   { label: 'Tiempo de circuito',   unit: 's',    better: 'bajo', decimals: 1, help: 'Tiempo en completar el circuito de 1.2 km del reglamento XC26.' },
  costUsd:       { label: 'Coste de componentes', unit: 'USD',  better: 'bajo', decimals: 0, help: 'Suma de propulsión, batería y aviónica (sin estructura).' },
  gustSensitivity:{ label: 'Sensibilidad a ráfaga',unit: '',    better: 'bajo', decimals: 2, help: 'Respuesta vertical a ráfaga (∝ CLα·S/m): baja = plataforma estable para cámara.' },
  alt60M:        { label: 'Altitud a 60 s',       unit: 'm',    better: 'alto', decimals: 0, help: 'Altitud alcanzada a los 60 s de dejar el suelo, a plena potencia y con la carga (XC27 §9.5.1).' },
  glideDistM:    { label: 'Distancia de planeo',  unit: 'm',    better: 'alto', decimals: 0, help: 'Distancia recorrida con el motor parado desde la altitud de corte hasta la de reencendido (XC27 §9.5.2).' },
  glideRatio:    { label: 'L/D en planeo',        unit: '',     better: 'alto', decimals: 1, help: 'Fineza con la hélice parada (o plegada) y la carga a bordo.' },
  glideSpeedMs:  { label: 'V de planeo',          unit: 'm/s',  better: 'alto', decimals: 1, help: 'Velocidad de máxima fineza con la carga a bordo.' },
  pylonTimeS:    { label: 'Tiempo de pilones',    unit: 's',    better: 'bajo', decimals: 1, help: 'Tiempo en recorrer los 10 tramos de 100 m con sus 9 virajes, descargado (XC27 §9.5.3).' },
  pylonSpeedMs:  { label: 'V en pilones',         unit: 'm/s',  better: 'alto', decimals: 1, help: 'Velocidad media sostenida en el circuito de pilones, a plena potencia.' },
  takeoffMarkM:  { label: 'Marca de despegue',    unit: 'm',    better: 'bajo', decimals: 0, help: 'Mejor marca declarable (20/40/60 m) con el margen de seguridad aplicado a la carrera simulada.' },
  missionMah:    { label: 'Consumo de la ronda',  unit: 'mAh',  better: 'bajo', decimals: 0, help: 'Carga extraída de la batería principal en toda la ronda: dos despegues, ascensos, pilones y aproximaciones.' },
  batteryMarginPct:{ label: 'Margen de batería',  unit: '%',    better: 'alto', decimals: 0, help: 'Capacidad utilizable que sobra al acabar la ronda. No se puede cambiar de batería en el pitstop.' },
  boxSumMm:      { label: 'Caja de transporte',   unit: 'mm',   better: 'bajo', decimals: 0, help: 'Alto + ancho + largo interiores de la caja más pequeña en la que cabe el avión desmontado (XC27 §7.3: máx. 1300 mm).' },
  fullCurrentA:  { label: 'Corriente a tope',     unit: 'A',    better: 'bajo', decimals: 1, help: 'Corriente sostenida en el ascenso, ya limitada por motor y ESC.' },
};

// ------------------------------------------------------------------
//  Objetivos y restricciones
// ------------------------------------------------------------------
export interface Objective {
  metric: MetricKey;
  goal: 'max' | 'min' | 'target';
  weight: number;      // peso relativo (se normaliza al total)
  poor: number;        // valor que puntúa 0
  good: number;        // valor que puntúa 1
  target?: number;     // sólo para goal = 'target'
}

export interface Constraint {
  metric: MetricKey;
  op: '<=' | '>=';
  value: number;
  label: string;
  hard: boolean;       // true = descalifica; false = penaliza
}

export type ScorerKind = 'generic' | 'xc26-efficient' | 'xc26-urgent' | 'xc27';

export interface MissionVariables {
  payloadG: number;        // carga de pago exigida (mínima si payloadMode = 'maxima')
  /**
   * 'fija'   → la misión impone la carga (sensor, paquete sanitario…).
   * 'maxima' → la carga es una DECISIÓN de diseño: el optimizador busca el
   *            punto de la curva carga/alcance que más puntúa, limitado por
   *            MTOW, empuje/peso y carrera de despegue.
   */
  payloadMode: 'fija' | 'maxima';
  maxPacksParallel: number; // packs de batería en paralelo admisibles (espacio en fuselaje)
  legDistanceKm: number;   // distancia de ida (o radio de operación)
  loiterMin: number;       // tiempo en zona / vigilancia
  cruiseAltM: number;      // altura sobre el nivel de despegue
  fieldElevM: number;      // elevación del campo de vuelo
  windMs: number;          // viento medio en contra en crucero
  runwayM: number;         // pista disponible (0 = lanzamiento a mano/catapulta)
  reservePct: number;      // reserva de batería sin usar
  maxSpanM: number;        // límite de envergadura (caja de transporte)
  maxMtowKg: number;       // límite de masa al despegue
  maxCells: number;        // celdas máximas en serie (reglamento)
  escMinA: number;         // corriente mínima exigida al ESC
  swathM: number;          // ancho de pasada útil (mapeo / agricultura)
  lockMotorId: string;     // '' = libre; id = motor obligatorio
  buildFactor: number;     // 0.75 fibra de carbono … 1.25 conservador
  avionicsPreference: 'masa' | 'potencia' | 'precio' | 'capacidad';
  // --- opcionales: sólo los fija el reglamento que los necesita ---
  /** Masa fija no catalogada que el avión debe llevar (p. ej. caja de telemetría), g. */
  fixedMassG?: number;
  /** true = receptor y servos van a una batería auxiliar: no drenan el pack principal. */
  auxBattery?: boolean;
  /** Coeficiente de rodadura de la pista (0.06 hierba, 0.04 asfalto). */
  rollingMu?: number;
  /** Densidad del aire impuesta (kg/m³); si falta, ISA a elevación + altura. */
  rhoOverride?: number;
  /** Masa en vacío REAL (pesada, sin carga de pago), g: sustituye a la estimada. */
  emptyMassOverrideG?: number;
  /** Empuje/peso estático mínimo exigido al elegir la carga (por defecto 0.55 con pista, 0.70 a mano). */
  minThrustWeight?: number;
}

export interface MissionType {
  id: string;
  name: string;
  sector: string;
  icon: string;
  summary: string;
  scorer: ScorerKind;
  vars: MissionVariables;
  requiredAvionics: AvionicsTag[];
  preferredAirfoils: AirfoilTag[];
  objectives: Objective[];
  constraints: Constraint[];
  designHint: string;
}

// ------------------------------------------------------------------
//  Base común de variables
// ------------------------------------------------------------------
const baseVars: MissionVariables = {
  payloadG: 500, payloadMode: 'fija', maxPacksParallel: 2, legDistanceKm: 5, loiterMin: 10,
  cruiseAltM: 100, fieldElevM: 0, windMs: 3, runwayM: 60,
  reservePct: 20, maxSpanM: 2.0, maxMtowKg: 8, maxCells: 6, escMinA: 40,
  swathM: 60, lockMotorId: '', buildFactor: 1.0, avionicsPreference: 'masa',
};

const V = (o: Partial<MissionVariables>): MissionVariables => ({ ...baseVars, ...o });

// ------------------------------------------------------------------
//  Catálogo de tipos de misión del sector UAV
// ------------------------------------------------------------------
export const MISSION_TYPES: MissionType[] = [
  // ---------------- Competición ----------------------------------
  {
    id: 'xc27',
    name: 'XtraChallenge 2027 · Ascenso, planeo y pilones',
    sector: 'Competición universitaria',
    icon: 'trophy',
    summary: 'Una ronda, dos mitades: despegar corto con el arroz, ganar altitud en 60 s y planear con el motor parado; tras el pitstop de descarga, 10 pilones de 100 m contra el crono. Puntuación con la fórmula oficial §9.5 del reglamento XC_27 v1.00. Aire de día caluroso en Casinos (ρ ≈ 1.12 kg/m³).',
    scorer: 'xc27',
    vars: V({
      payloadG: 200, payloadMode: 'maxima', maxPacksParallel: 2, legDistanceKm: 1, loiterMin: 5,
      cruiseAltM: 60, fieldElevM: 900, windMs: 2, runwayM: 60, maxSpanM: 2.6, maxMtowKg: 25,
      maxCells: 3, escMinA: 40, reservePct: 20, lockMotorId: 'emax-gt2820-985kv',
      fixedMassG: 150, auxBattery: true, rollingMu: 0.04, minThrustWeight: 0.36,
    }),
    requiredAvionics: ['rc-24ghz', 'servos', 'aux-battery', 'rx-switch'],
    preferredAirfoils: ['carga', 'endurance', 'general', 'alta-sustentacion'],
    objectives: [
      { metric: 'payloadG',    goal: 'max', weight: 100, poor: 200,  good: 4000 },
      { metric: 'alt60M',      goal: 'max', weight: 80,  poor: 20,   good: 115 },
      { metric: 'glideDistM',  goal: 'max', weight: 80,  poor: 400,  good: 1800 },
      { metric: 'pylonTimeS',  goal: 'min', weight: 80,  poor: 90,   good: 45 },
      { metric: 'takeoffRunM', goal: 'min', weight: 40,  poor: 60,   good: 17 },
    ],
    constraints: [
      { metric: 'mtowKg',           op: '<=', value: 25,  label: 'MTOW legal (§7.8)', hard: true },
      { metric: 'payloadG',         op: '>=', value: 200, label: 'Bahía para al menos 200 g de arroz (§7.8)', hard: true },
      { metric: 'boxSumMm',         op: '<=', value: 1300, label: 'Caja de transporte: alto + ancho + largo ≤ 1300 mm (§7.3)', hard: true },
      { metric: 'takeoffMarkM',     op: '<=', value: 60,  label: 'Despegue dentro de la pista de 60 m (§8.6)', hard: true },
      { metric: 'batteryMarginPct', op: '>=', value: 0,   label: 'La batería aguanta la ronda entera (sin cambio en el pitstop)', hard: true },
      { metric: 'alt60M',           op: '>=', value: 25,  label: 'Ascenso suficiente para iniciar el planeo con margen', hard: true },
      { metric: 'stallSpeedMs',     op: '<=', value: 13,  label: 'Pérdida manejable para dos aterrizajes por ronda', hard: false },
    ],
    designHint: 'El arroz multiplica a la altitud y al planeo, pero se descarga antes de los pilones: el avión tiene que subir cargado y correr vacío. Una hélice plegable vale su peso en el planeo, y los 20 m de despegue dan un ×1.25 sobre toda la ronda.',
  },
  {
    id: 'xc26-efficient',
    name: 'XtraChallenge 2026 · Transporte eficiente',
    sector: 'Competición universitaria',
    icon: 'trophy',
    summary: 'Llevar la máxima ración de agua y comida recorriendo la mayor distancia en 150 s con la mínima corriente media. Puntuación con la fórmula oficial §9.9.1 del reglamento XC_26 v1.12.',
    scorer: 'xc26-efficient',
    vars: V({ payloadG: 250, payloadMode: 'maxima', maxPacksParallel: 1, legDistanceKm: 4.5, loiterMin: 2.5, cruiseAltM: 60, windMs: 3, runwayM: 20, maxSpanM: 1.7, maxMtowKg: 25, maxCells: 4, escMinA: 50, reservePct: 15, lockMotorId: 'emax-gt2826-1090kv' }),
    requiredAvionics: [...CORE_AVIONICS, 'release'],
    preferredAirfoils: ['alta-sustentacion', 'carga', 'general'],
    objectives: [
      { metric: 'payloadG',       goal: 'max', weight: 100, poor: 100, good: 900 },
      { metric: 'distance150M',   goal: 'max', weight: 75,  poor: 2200, good: 4800 },
      { metric: 'cruiseCurrentA', goal: 'min', weight: 75,  poor: 30,  good: 7 },
      { metric: 'takeoffRunM',    goal: 'min', weight: 50,  poor: 60,  good: 15 },
    ],
    constraints: [
      { metric: 'spanM',        op: '<=', value: 1.7,  label: 'Caja de transporte 85 cm (ala en 2 piezas)', hard: true },
      { metric: 'mtowKg',       op: '<=', value: 25,   label: 'MTOW reglamentario', hard: true },
      { metric: 'takeoffRunM',  op: '<=', value: 60,   label: 'Pista de 60 m', hard: true },
      { metric: 'stallMarginPct', op: '>=', value: 20, label: 'Margen de pérdida de seguridad', hard: false },
      { metric: 'thrustWeight', op: '>=', value: 0.60, label: 'Empuje/peso mínimo para despegar', hard: true },
    ],
    designHint: 'Motor fijo y 4S: la palanca real está en el perfil de alta sustentación (despegue corto con mucha carga) y en una hélice de paso largo que baje la corriente de crucero.',
  },
  {
    id: 'xc26-urgent',
    name: 'XtraChallenge 2026 · Transporte urgente',
    sector: 'Competición universitaria',
    icon: 'trophy',
    summary: 'Completar el circuito de 1.2 km en el menor tiempo posible y aterrizar en la zona más corta. Puntuación con la fórmula oficial §9.9.2.',
    scorer: 'xc26-urgent',
    vars: V({ payloadG: 150, maxPacksParallel: 1, legDistanceKm: 1.2, loiterMin: 1, cruiseAltM: 40, windMs: 3, runwayM: 20, maxSpanM: 1.7, maxMtowKg: 25, maxCells: 4, escMinA: 50, reservePct: 15, lockMotorId: 'emax-gt2826-1090kv' }),
    requiredAvionics: [...CORE_AVIONICS],
    preferredAirfoils: ['velocidad', 'baja-resistencia', 'general'],
    objectives: [
      { metric: 'lapTimeS',  goal: 'min', weight: 100, poor: 130, good: 45 },
      { metric: 'maxSpeedMs',   goal: 'max', weight: 40,  poor: 15,  good: 40 },
      { metric: 'takeoffRunM',  goal: 'min', weight: 25,  poor: 60,  good: 15 },
      { metric: 'stallSpeedMs', goal: 'min', weight: 20,  poor: 16,  good: 7 },
    ],
    constraints: [
      { metric: 'spanM',       op: '<=', value: 1.7, label: 'Caja de transporte 85 cm (ala en 2 piezas)', hard: true },
      { metric: 'takeoffRunM', op: '<=', value: 60,  label: 'Pista de 60 m', hard: true },
      { metric: 'thrustWeight',op: '>=', value: 0.70,label: 'Empuje/peso para aceleración', hard: true },
      { metric: 'cRateUsed',   op: '<=', value: 35,  label: 'Descarga máxima de la batería', hard: false },
    ],
    designHint: 'Aquí manda la potencia disponible menos la resistencia: ala pequeña y cargada, perfil fino de poco drag y hélice de paso alto. Cuidado con no quedarse sin margen de despegue.',
  },
  {
    id: 'cargo-challenge',
    name: 'Air Cargo Challenge · Carga máxima',
    sector: 'Competición universitaria',
    icon: 'box',
    summary: 'Levantar la mayor carga posible desde una pista corta. La puntuación es prácticamente proporcional a los gramos transportados.',
    scorer: 'generic',
    vars: V({ payloadG: 800, payloadMode: 'maxima', legDistanceKm: 1, loiterMin: 2, cruiseAltM: 50, windMs: 3, runwayM: 60, maxSpanM: 2.4, maxMtowKg: 12, maxCells: 6, escMinA: 60, reservePct: 20 }),
    requiredAvionics: [...CORE_AVIONICS],
    preferredAirfoils: ['alta-sustentacion', 'carga'],
    objectives: [
      { metric: 'payloadG',     goal: 'max', weight: 100, poor: 500, good: 6000 },
      { metric: 'payloadFrac',  goal: 'max', weight: 45,  poor: 20,  good: 60 },
      { metric: 'takeoffRunM',  goal: 'min', weight: 40,  poor: 60,  good: 20 },
      { metric: 'rocMs',        goal: 'max', weight: 20,  poor: 0.5, good: 5 },
    ],
    constraints: [
      { metric: 'takeoffRunM', op: '<=', value: 60,   label: 'Pista disponible', hard: true },
      { metric: 'thrustWeight',op: '>=', value: 0.55, label: 'Empuje/peso mínimo', hard: true },
      { metric: 'enduranceMin',op: '>=', value: 5,    label: 'Combustible para el circuito completo', hard: false },
      { metric: 'stallMarginPct', op: '>=', value: 15, label: 'Margen de pérdida', hard: false },
    ],
    designHint: 'Todo el diseño gira alrededor de CLmax·S: perfil de alta sustentación, superficie grande y estructura ligera. La autonomía es casi irrelevante.',
  },

  // ---------------- Operación civil / profesional ------------------
  {
    id: 'isr-loiter',
    name: 'ISR · Vigilancia persistente',
    sector: 'Seguridad y defensa',
    icon: 'eye',
    summary: 'Permanecer el máximo tiempo sobre una zona con cámara estabilizada, volando despacio y con baja firma acústica.',
    scorer: 'generic',
    vars: V({ payloadG: 300, maxPacksParallel: 3, legDistanceKm: 8, loiterMin: 60, cruiseAltM: 300, windMs: 5, runwayM: 0, maxSpanM: 3.0, maxMtowKg: 7, maxCells: 6, escMinA: 40, reservePct: 25, avionicsPreference: 'potencia' }),
    requiredAvionics: [...CORE_AVIONICS, 'camera-rgb', 'gimbal', 'video', 'airspeed'],
    preferredAirfoils: ['endurance', 'baja-resistencia'],
    objectives: [
      { metric: 'enduranceMin',    goal: 'max', weight: 100, poor: 25,  good: 150 },
      { metric: 'ldCruise',        goal: 'max', weight: 45,  poor: 8,   good: 22 },
      { metric: 'gustSensitivity', goal: 'min', weight: 30,  poor: 1.6, good: 0.5 },
      { metric: 'rangeKm',         goal: 'max', weight: 25,  poor: 20,  good: 120 },
      { metric: 'mtowKg',          goal: 'min', weight: 20,  poor: 7,   good: 2 },
    ],
    constraints: [
      { metric: 'cruiseSpeedMs', op: '>=', value: 12,  label: 'Penetración mínima frente al viento', hard: true },
      { metric: 'spanM',         op: '<=', value: 3.0, label: 'Envergadura transportable', hard: true },
      { metric: 'thrustWeight',  op: '>=', value: 0.55,label: 'Lanzamiento con catapulta', hard: true },
      { metric: 'stallMarginPct',op: '>=', value: 25,  label: 'Margen de pérdida con ráfagas', hard: false },
    ],
    designHint: 'La autonomía se gana con L/D alto y carga alar baja, no con más batería: cada 100 g extra de pack sólo compensan si el L/D no cae.',
  },
  {
    id: 'mapping',
    name: 'Cartografía y fotogrametría',
    sector: 'Topografía y construcción',
    icon: 'map',
    summary: 'Cubrir la máxima superficie por vuelo con solape fotográfico correcto y precisión centimétrica (RTK).',
    scorer: 'generic',
    vars: V({ payloadG: 400, maxPacksParallel: 3, legDistanceKm: 6, loiterMin: 35, cruiseAltM: 120, windMs: 5, runwayM: 0, maxSpanM: 2.2, maxMtowKg: 6, maxCells: 6, escMinA: 40, reservePct: 25, swathM: 90 }),
    requiredAvionics: [...CORE_AVIONICS, 'camera-rgb', 'rtk', 'airspeed', 'lidar-agl'],
    preferredAirfoils: ['endurance', 'baja-resistencia', 'general'],
    objectives: [
      { metric: 'coverageHaPerFlight', goal: 'max', weight: 100, poor: 40, good: 900 },
      { metric: 'enduranceMin',        goal: 'max', weight: 50,  poor: 20, good: 120 },
      { metric: 'gustSensitivity',     goal: 'min', weight: 35,  poor: 1.6, good: 0.6 },
      { metric: 'whPerKm',             goal: 'min', weight: 25,  poor: 12,  good: 3 },
    ],
    constraints: [
      { metric: 'cruiseSpeedMs', op: '>=', value: 14,  label: 'Velocidad mínima para productividad', hard: true },
      { metric: 'cruiseSpeedMs', op: '<=', value: 26,  label: 'Máxima para no arrastrar la imagen', hard: false },
      { metric: 'spanM',         op: '<=', value: 2.2, label: 'Transporte en furgoneta', hard: true },
      { metric: 'thrustWeight',  op: '>=', value: 0.55,label: 'Lanzamiento con catapulta', hard: true },
    ],
    designHint: 'La cobertura es velocidad × autonomía: hay un óptimo intermedio. Un ala demasiado eficiente vuela lento y cubre menos hectáreas por hora.',
  },
  {
    id: 'delivery',
    name: 'Logística · Entrega de última milla',
    sector: 'Transporte y salud',
    icon: 'package',
    summary: 'Llevar un paquete sanitario o comercial a un punto alejado y volver, con suelta en vuelo y despegue desde superficie no preparada.',
    scorer: 'generic',
    vars: V({ payloadG: 800, payloadMode: 'maxima', maxPacksParallel: 3, legDistanceKm: 25, loiterMin: 3, cruiseAltM: 120, windMs: 6, runwayM: 40, maxSpanM: 3.0, maxMtowKg: 12, maxCells: 6, escMinA: 60, reservePct: 30 }),
    requiredAvionics: [...CORE_AVIONICS, 'release', 'lte', 'airspeed', 'strobe', 'parachute'],
    preferredAirfoils: ['carga', 'general', 'endurance'],
    objectives: [
      { metric: 'rangeKm',      goal: 'max', weight: 100, poor: 20,  good: 140 },
      { metric: 'payloadG',     goal: 'max', weight: 80,  poor: 500, good: 4000 },
      { metric: 'whPerKm',      goal: 'min', weight: 40,  poor: 25,  good: 6 },
      { metric: 'cruiseSpeedMs',goal: 'max', weight: 30,  poor: 14,  good: 32 },
      { metric: 'takeoffRunM',  goal: 'min', weight: 20,  poor: 60,  good: 20 },
    ],
    constraints: [
      { metric: 'rangeKm',     op: '>=', value: 20,   label: 'Ida y vuelta al punto de entrega', hard: true },
      { metric: 'takeoffRunM', op: '<=', value: 40,   label: 'Superficie de despegue disponible', hard: true },
      { metric: 'thrustWeight',op: '>=', value: 0.60, label: 'Empuje/peso con carga', hard: true },
      { metric: 'cRateUsed',   op: '<=', value: 20,   label: 'Descarga suave para vida del pack', hard: false },
    ],
    designHint: 'Con reserva del 30 % y viento de 6 m/s el alcance útil cae mucho: conviene una carga alar media-alta y una hélice optimizada a la velocidad de mejor alcance.',
  },
  {
    id: 'sar',
    name: 'Búsqueda y rescate (SAR)',
    sector: 'Emergencias',
    icon: 'search',
    summary: 'Llegar rápido a la zona, barrerla con cámara térmica y aguantar el máximo tiempo sobre el área de búsqueda.',
    scorer: 'generic',
    vars: V({ payloadG: 350, maxPacksParallel: 3, legDistanceKm: 15, loiterMin: 45, cruiseAltM: 150, windMs: 6, runwayM: 0, maxSpanM: 2.6, maxMtowKg: 8, maxCells: 6, escMinA: 50, reservePct: 25, swathM: 120 }),
    requiredAvionics: [...CORE_AVIONICS, 'camera-thermal', 'gimbal', 'video', 'lte', 'strobe', 'airspeed'],
    preferredAirfoils: ['endurance', 'general', 'baja-resistencia'],
    objectives: [
      { metric: 'enduranceMin',        goal: 'max', weight: 90, poor: 25, good: 120 },
      { metric: 'coverageHaPerFlight', goal: 'max', weight: 60, poor: 100, good: 900 },
      { metric: 'cruiseSpeedMs',       goal: 'max', weight: 45, poor: 15, good: 32 },
      { metric: 'rocMs',               goal: 'max', weight: 25, poor: 1.5, good: 7 },
      { metric: 'gustSensitivity',     goal: 'min', weight: 20, poor: 1.6, good: 0.6 },
    ],
    constraints: [
      { metric: 'cruiseSpeedMs', op: '>=', value: 16,   label: 'Tiempo de respuesta a la zona', hard: true },
      { metric: 'thrustWeight',  op: '>=', value: 0.55, label: 'Lanzamiento a mano / catapulta', hard: true },
      { metric: 'stallMarginPct',op: '>=', value: 25,   label: 'Seguridad con viento de emergencia', hard: false },
    ],
    designHint: 'Misión de dos fases con requisitos opuestos (transitar rápido, buscar despacio): gana el diseño con la polar más plana, no el más rápido ni el más eficiente.',
  },
  {
    id: 'agri',
    name: 'Agricultura de precisión',
    sector: 'Agrotecnología',
    icon: 'leaf',
    summary: 'Barrer parcelas a baja altura con sensor multiespectral, volando lento y estable para no arrastrar la imagen.',
    scorer: 'generic',
    vars: V({ payloadG: 600, legDistanceKm: 3, loiterMin: 40, cruiseAltM: 80, windMs: 4, runwayM: 0, maxSpanM: 2.4, maxMtowKg: 7, maxCells: 6, escMinA: 40, reservePct: 20, swathM: 70 }),
    requiredAvionics: [...CORE_AVIONICS, 'multispectral', 'rtk', 'airspeed', 'lidar-agl'],
    preferredAirfoils: ['endurance', 'carga', 'general'],
    objectives: [
      { metric: 'coverageHaPerFlight', goal: 'max', weight: 100, poor: 30,  good: 400 },
      { metric: 'gustSensitivity',     goal: 'min', weight: 50,  poor: 1.6, good: 0.5 },
      { metric: 'enduranceMin',        goal: 'max', weight: 40,  poor: 20,  good: 80 },
      { metric: 'costUsd',             goal: 'min', weight: 15,  poor: 12000, good: 9000 },
    ],
    constraints: [
      { metric: 'cruiseSpeedMs', op: '<=', value: 22,   label: 'Máxima para calidad de imagen', hard: false },
      { metric: 'cruiseSpeedMs', op: '>=', value: 12,   label: 'Mínima frente al viento', hard: true },
      { metric: 'thrustWeight',  op: '>=', value: 0.55, label: 'Lanzamiento con catapulta', hard: true },
      { metric: 'stallMarginPct',op: '>=', value: 25,   label: 'Margen a baja altura', hard: true },
    ],
    designHint: 'La carga alar baja da estabilidad de imagen pero la hace vulnerable a la ráfaga; el óptimo suele ser AR alto con superficie moderada.',
  },
  {
    id: 'inspection',
    name: 'Inspección de infraestructuras lineales',
    sector: 'Energía y utilities',
    icon: 'tower',
    summary: 'Seguir líneas eléctricas o gasoductos durante decenas de kilómetros en BVLOS, con vídeo y detección de tráfico.',
    scorer: 'generic',
    vars: V({ payloadG: 500, maxPacksParallel: 3, legDistanceKm: 40, loiterMin: 10, cruiseAltM: 120, windMs: 6, runwayM: 30, maxSpanM: 3.0, maxMtowKg: 9, maxCells: 6, escMinA: 50, reservePct: 30 }),
    requiredAvionics: [...CORE_AVIONICS, 'camera-rgb', 'gimbal', 'lte', 'adsb', 'strobe', 'airspeed', 'parachute'],
    preferredAirfoils: ['endurance', 'baja-resistencia', 'general'],
    objectives: [
      { metric: 'rangeKm',      goal: 'max', weight: 100, poor: 40, good: 220 },
      { metric: 'whPerKm',      goal: 'min', weight: 55,  poor: 12, good: 3 },
      { metric: 'enduranceMin', goal: 'max', weight: 35,  poor: 30, good: 120 },
      { metric: 'cruiseSpeedMs',goal: 'max', weight: 25,  poor: 15, good: 30 },
    ],
    constraints: [
      { metric: 'rangeKm',       op: '>=', value: 60,  label: 'Tramo de inspección completo', hard: true },
      { metric: 'cruiseSpeedMs', op: '>=', value: 16,  label: 'Progreso frente al viento', hard: true },
      { metric: 'spanM',         op: '<=', value: 3.0, label: 'Transporte y despliegue', hard: true },
    ],
    designHint: 'Wh/km es la métrica que decide: alarga el ala hasta el límite de transporte y baja la velocidad hasta el mínimo que la normativa y el viento permiten.',
  },
  {
    id: 'relay',
    name: 'Repetidor de comunicaciones',
    sector: 'Telecomunicaciones',
    icon: 'radio',
    summary: 'Estacionar sobre un punto a gran altura durante horas, alimentando una radio de alta potencia.',
    scorer: 'generic',
    vars: V({ payloadG: 250, maxPacksParallel: 3, legDistanceKm: 5, loiterMin: 120, cruiseAltM: 500, fieldElevM: 600, windMs: 6, runwayM: 0, maxSpanM: 3.4, maxMtowKg: 7, maxCells: 6, escMinA: 40, reservePct: 25, avionicsPreference: 'potencia' }),
    requiredAvionics: [...CORE_AVIONICS, 'lte', 'adsb', 'strobe', 'airspeed'],
    preferredAirfoils: ['endurance', 'baja-resistencia'],
    objectives: [
      { metric: 'enduranceMin', goal: 'max', weight: 100, poor: 40,  good: 200 },
      { metric: 'ldCruise',     goal: 'max', weight: 50,  poor: 10,  good: 25 },
      { metric: 'cruisePowerW', goal: 'min', weight: 35,  poor: 220, good: 60 },
      { metric: 'mtowKg',       goal: 'min', weight: 15,  poor: 7,   good: 2.5 },
    ],
    constraints: [
      { metric: 'cruiseSpeedMs',  op: '>=', value: 13, label: 'Mantener posición con viento', hard: true },
      { metric: 'thrustWeight',   op: '>=', value: 0.55, label: 'Lanzamiento con catapulta', hard: true },
      { metric: 'stallMarginPct', op: '>=', value: 25, label: 'Seguridad en loiter prolongado', hard: false },
      { metric: 'rocMs',          op: '>=', value: 2,  label: 'Ascenso al nivel de trabajo', hard: true },
    ],
    designHint: 'A 1100 m de densidad-altitud la hélice pierde empuje y el ala necesita más velocidad: la altitud es la variable que más cambia el ganador.',
  },
  {
    id: 'speed',
    name: 'Velocidad punta / interceptación',
    sector: 'I+D y defensa',
    icon: 'zap',
    summary: 'Alcanzar la máxima velocidad y aceleración con un tiempo de misión corto.',
    scorer: 'generic',
    vars: V({ payloadG: 150, legDistanceKm: 5, loiterMin: 2, cruiseAltM: 100, windMs: 4, runwayM: 0, maxSpanM: 1.6, maxMtowKg: 5, maxCells: 6, escMinA: 60, reservePct: 15 }),
    requiredAvionics: [...CORE_AVIONICS, 'video', 'airspeed'],
    preferredAirfoils: ['velocidad', 'baja-resistencia', 'ala-volante'],
    objectives: [
      { metric: 'maxSpeedMs',  goal: 'max', weight: 100, poor: 22,  good: 65 },
      { metric: 'rocMs',       goal: 'max', weight: 40,  poor: 3,   good: 22 },
      { metric: 'thrustWeight',goal: 'max', weight: 30,  poor: 0.6, good: 2.0 },
      { metric: 'enduranceMin',goal: 'max', weight: 20,  poor: 4,   good: 25 },
    ],
    constraints: [
      { metric: 'thrustWeight', op: '>=', value: 0.8, label: 'Lanzamiento a mano a alta carga alar', hard: true },
      { metric: 'cRateUsed',    op: '<=', value: 45,  label: 'Límite de descarga del pack', hard: true },
      { metric: 'stallSpeedMs', op: '<=', value: 18,  label: 'Recuperación manejable', hard: false },
      { metric: 'mtowKg',       op: '<=', value: 3.5, label: 'Masa lanzable a mano', hard: true },
    ],
    designHint: 'Con la potencia limitada por el ESC, la velocidad punta la fija CD0·S: ala pequeña, perfil fino y fuselaje afinado mandan sobre el motor.',
  },
  {
    id: 'custom',
    name: 'Misión personalizada',
    sector: 'Definida por el usuario',
    icon: 'sliders',
    summary: 'Parte de un perfil equilibrado y ajusta variables, pesos y restricciones para tu caso concreto.',
    scorer: 'generic',
    vars: V({}),
    requiredAvionics: [...CORE_AVIONICS],
    preferredAirfoils: ['general', 'endurance', 'carga', 'velocidad', 'baja-resistencia', 'alta-sustentacion', 'ala-volante'],
    objectives: [
      { metric: 'enduranceMin', goal: 'max', weight: 50, poor: 15,  good: 90 },
      { metric: 'rangeKm',      goal: 'max', weight: 50, poor: 15,  good: 120 },
      { metric: 'payloadG',     goal: 'max', weight: 50, poor: 200, good: 2500 },
      { metric: 'mtowKg',       goal: 'min', weight: 25, poor: 8,   good: 2 },
    ],
    constraints: [
      { metric: 'thrustWeight', op: '>=', value: 0.55, label: 'Empuje/peso mínimo', hard: true },
    ],
    designHint: 'Sube el peso del objetivo que de verdad decide tu misión: el optimizador cambiará de familia de avión, no sólo de componente.',
  },
];

export const missionById = (id: string): MissionType =>
  MISSION_TYPES.find((m) => m.id === id) ?? MISSION_TYPES[0];

// ------------------------------------------------------------------
//  Scorer genérico
// ------------------------------------------------------------------
export interface ObjectiveScore {
  metric: MetricKey;
  label: string;
  raw: number;
  unit: string;
  norm: number;       // 0…1
  weight: number;
  points: number;     // contribución al total sobre 1000
  maxPoints: number;
}

export interface ConstraintCheck {
  label: string;
  metric: MetricKey;
  ok: boolean;
  hard: boolean;
  value: number;
  limit: number;
  op: '<=' | '>=';
}

export interface MissionScore {
  total: number;             // 0…1000
  objectives: ObjectiveScore[];
  constraints: ConstraintCheck[];
  feasible: boolean;         // ninguna restricción dura violada
  penalty: number;           // factor aplicado por restricciones blandas
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Normaliza una métrica a 0…1 según el objetivo (con saturación). */
export function normalizeObjective(o: Objective, raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  if (o.goal === 'target') {
    const t = o.target ?? (o.good + o.poor) / 2;
    const span = Math.abs(o.good - o.poor) || 1;
    return clamp01(1 - Math.abs(raw - t) / span);
  }
  const span = o.good - o.poor;
  if (Math.abs(span) < 1e-12) return raw >= o.good ? 1 : 0;
  return clamp01((raw - o.poor) / span);
}

export function scoreMission(
  objectives: Objective[],
  constraints: Constraint[],
  metrics: Record<MetricKey, number>,
): MissionScore {
  const wTotal = objectives.reduce((s, o) => s + Math.max(0, o.weight), 0) || 1;

  const objScores: ObjectiveScore[] = objectives.map((o) => {
    const raw = metrics[o.metric];
    const norm = normalizeObjective(o, raw);
    const maxPoints = (1000 * Math.max(0, o.weight)) / wTotal;
    return {
      metric: o.metric, label: METRICS[o.metric].label, unit: METRICS[o.metric].unit,
      raw, norm, weight: o.weight, points: norm * maxPoints, maxPoints,
    };
  });

  const checks: ConstraintCheck[] = constraints.map((c) => {
    const value = metrics[c.metric];
    const ok = c.op === '<=' ? value <= c.value : value >= c.value;
    return { label: c.label, metric: c.metric, ok, hard: c.hard, value, limit: c.value, op: c.op };
  });

  const feasible = checks.every((c) => c.ok || !c.hard);
  // cada restricción blanda incumplida penaliza proporcionalmente a cuánto se pasa
  let penalty = 1;
  for (const c of checks) {
    if (c.ok || c.hard) continue;
    const excess = c.op === '<='
      ? (c.value - c.limit) / Math.max(1e-6, Math.abs(c.limit))
      : (c.limit - c.value) / Math.max(1e-6, Math.abs(c.limit));
    penalty *= Math.max(0.55, 1 - 0.5 * Math.min(1, Math.max(0, excess)));
  }

  const total = objScores.reduce((s, o) => s + o.points, 0) * penalty;
  return { total, objectives: objScores, constraints: checks, feasible, penalty };
}
