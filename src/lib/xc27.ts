// ==================================================================
//  XtraChallenge 2027 — reglamento y puntuación (Categoría Académica).
//  Fuente: Reglamento Técnico XC_27 v1.00 (20.09.2026), V edición,
//  València, 6–9 de julio de 2027.
//
//  Máx 1000 pts = 250 estáticas + 750 vuelo (media de las rondas).
//
//  La ronda 2027 es UN solo vuelo con dos mitades y un pitstop:
//    despegue 1 → ascenso 60 s → planeo (motor parado) → aterrizaje
//    → pitstop (descarga, 120 s) → despegue 2 → 10 pilones → aterrizaje
//
//    P_equipo = (P_AS · P_CA · P_VE + P_PI)
//               · B_predicción · B_despegue · B_carga · S_piloto · L_vuelo
//    P_ronda  = P_equipo / P_max          (la mejor marca se lleva 750)
//
//  Este fichero es puro (sin física ni catálogo): sólo las reglas.
// ==================================================================

// ------------------------------------------------------------------
//  Límites técnicos (§7 y §8)
// ------------------------------------------------------------------
export const XC27_LIMITS = {
  motorId: 'emax-gt2820-985kv',
  motorName: 'Emax GT2820/06 985KV',
  maxCells: 3,
  maxVoltage: 12.6,
  escMinA: 40,
  auxBatteryMinMah: 600,
  budgetEur: 450,
  boxSumMm: 1300,
  minPayloadG: 200,
  riceDensityKgL: 0.89,
  mtowMaxKg: 25,
  telemetryBox: { massG: 150, lengthMm: 90, widthMm: 90, heightMm: 30, screw: 'M3', holeMm: 3.2 },
  idNumberMinCm: 10,
  assemblyMaxMin: 30,
  runwayM: 60,
  runwayWidthM: 10,
  takeoffMarksM: [20, 40, 60],
  takeoffWindowS: 120,
  climbS: 60,
  altMinM: 10,
  altMaxM: 120,
  glideMaxS: 420,
  glideCurrentA: 1,
  loadMaxS: 240,
  pitstopMaxS: 120,
  climb2MaxS: 60,
  pylonLegs: 10,
  pylonLegM: 100,
  windMaxMs: 6,
  roundMaxPts: 750,
  staticMaxPts: 250,
  rounds: 4,
} as const;

// ------------------------------------------------------------------
//  Parciales de la ronda (§9.5)
// ------------------------------------------------------------------

/**
 * §9.5.1 — Puntuación por altitud a los 60 s de ascenso (ec. 6).
 * Polinomio de 4º grado: vale 0 a ~10 m, toca techo (≈100) a ~81 m y cae
 * hasta ≈80 a 120 m. Por encima de 120 m el vuelo no se contabiliza.
 */
export function altitudeScore(alt60M: number): number {
  const a = alt60M;
  if (!(a > 0) || a > XC27_LIMITS.altMaxM) return 0;
  const p = 4.3636e-6 * a ** 4 - 1.215e-3 * a ** 3 + 9.5732e-2 * a ** 2 - 8.6741e-1 * a;
  return Math.max(0, p);
}

/** Altitud que maximiza P_AS (≈ 81 m, ≈ 100 pts). */
export const ALT_SCORE_PEAK_M = (() => {
  let best = 0, bestA = 0;
  for (let a = 60; a <= 100; a += 0.1) {
    const p = altitudeScore(a);
    if (p > best) { best = p; bestA = a; }
  }
  return Math.round(bestA * 10) / 10;
})();

/** §9.5.2 — Vuelo eficiente (ec. 7): P_VE = D_R^√2 / 155², D_R en metros. */
export function glideScore(glideDistM: number): number {
  return glideDistM > 0 ? Math.pow(glideDistM, Math.SQRT2) / (155 * 155) : 0;
}

/** Distancia de planeo que da P_VE = 1 (≈ 1251 m). */
export const GLIDE_UNIT_DIST_M = Math.pow(155 * 155, 1 / Math.SQRT2);

/** §9.5.3 — Pilones (ec. 8): P_PI = 40² / T_PI². Sin tiempo válido, 0. */
export function pylonScore(pylonTimeS: number): number {
  return pylonTimeS > 0 ? (40 * 40) / (pylonTimeS * pylonTimeS) : 0;
}

/**
 * §9.5.4 — Carga de pago (ec. 9): P_CA = MPL / 300 con la carga DECLARADA.
 * El texto fija la unidad en kg; con esa lectura una carga de 3 kg vale 0.01
 * y el producto P_AS·P_CA·P_VE queda del mismo orden que P_PI (≈ 1), que es
 * lo que da sentido a sumar ambos. Se deja la lectura en gramos como
 * alternativa hasta que la organización lo aclare.
 */
export type PayloadUnit = 'kg' | 'g';
export function payloadScore(declaredKg: number, unit: PayloadUnit = 'kg'): number {
  const mpl = unit === 'kg' ? declaredKg : declaredKg * 1000;
  return Math.max(0, mpl) / 300;
}

// ------------------------------------------------------------------
//  Bonificaciones y factores (§9.2 – §9.4, §7.5)
// ------------------------------------------------------------------

/** §9.2 ec. 1 — Predicción de carga: transportada / declarada. */
export function predictionBonus(carriedKg: number, declaredKg: number): number {
  if (!(declaredKg > 0)) return 1;
  const r = carriedKg / declaredKg;
  if (r <= 0.5) return 0.1;
  if (r <= 0.7) return 0.6;
  if (r < 0.9) return 0.8;
  return 1;
}

/**
 * §9.2 ec. 2 — Bonificación por carga y descarga.
 * T_CD = tiempo de carga + descarga (s); M_PL = carga transportada (kg).
 * Hasta 35 s da el máximo; después decrece y puede bajar de 1.
 */
export function loadBonus(loadUnloadS: number, carriedKg: number): number {
  if (loadUnloadS <= 35) return 1.25;
  if (!(carriedKg > 0)) return 1;
  const b = 1 + 0.25 * (1.1 - loadUnloadS / (120 * Math.sqrt(carriedKg)));
  return Math.min(1.25, Math.max(0, b));
}

/** Tiempo de carga+descarga con el que B_carga vuelve a valer exactamente 1. */
export const loadBonusBreakEvenS = (carriedKg: number) => 1.1 * 120 * Math.sqrt(Math.max(0, carriedKg));

export type TakeoffMark = '20' | '40' | '60' | 'foul';

/** §9.2 ec. 3 — Despegue corto, declarado en la ficha prevuelo. */
export const takeoffBonus = (t: TakeoffMark): number =>
  t === 'foul' ? 0 : t === '20' ? 1.25 : t === '40' ? 1.125 : 1;

/** Mejor marca declarable para una carrera de despegue simulada con margen. */
export function takeoffMarkFor(runM: number, margin = 1): TakeoffMark {
  const r = runM * margin;
  if (!(r >= 0)) return 'foul';
  if (r <= 20) return '20';
  if (r <= 40) return '40';
  if (r <= 60) return '60';
  return 'foul';
}

export interface Xc27RoundInput {
  alt60M: number;          // altitud a los 60 s de ascenso, m
  glideDistM: number;      // distancia recorrida con el motor parado, m
  pylonTimeS: number;      // tiempo de los 10 pilones, s (0 = se renuncia)
  declaredKg: number;      // MPL_D declarada en el informe técnico
  carriedKg: number;       // MPL_R transportada y devuelta en la ronda
  loadUnloadS: number;     // T_CD, carga + descarga
  takeoff: TakeoffMark;
  externalPilot: boolean;  // §9.3 → ×0.75
  legality: 0 | 0.5 | 1;   // §9.4 L_vuelo
  repairedNoSpares: boolean; // §7.5 → ×0.75 tras reparar sin repuestos presentados
  loadBonusLost: boolean;  // tocar el avión tras cargar / cierre de bahía inseguro
  payloadUnit: PayloadUnit;
}

export interface Xc27RoundResult {
  pAS: number; pCA: number; pVE: number; pPI: number;
  efficient: number;       // P_AS · P_CA · P_VE
  bPrediccion: number; bDespegue: number; bCarga: number;
  sPiloto: number; sRepuestos: number; lVuelo: number;
  multiplier: number;      // producto de todos los factores
  pEquipo: number;
}

export function scoreXc27Round(i: Xc27RoundInput): Xc27RoundResult {
  const pAS = altitudeScore(i.alt60M);
  const pCA = payloadScore(i.declaredKg, i.payloadUnit);
  const pVE = glideScore(i.glideDistM);
  const pPI = pylonScore(i.pylonTimeS);
  const efficient = pAS * pCA * pVE;
  const bPrediccion = predictionBonus(i.carriedKg, i.declaredKg);
  const bDespegue = takeoffBonus(i.takeoff);
  const bCarga = i.loadBonusLost ? 1 : loadBonus(i.loadUnloadS, i.carriedKg);
  const sPiloto = i.externalPilot ? 0.75 : 1;
  const sRepuestos = i.repairedNoSpares ? 0.75 : 1;
  const multiplier = bPrediccion * bDespegue * bCarga * sPiloto * sRepuestos * i.legality;
  return {
    pAS, pCA, pVE, pPI, efficient, bPrediccion, bDespegue, bCarga,
    sPiloto, sRepuestos, lVuelo: i.legality, multiplier,
    pEquipo: (efficient + pPI) * multiplier,
  };
}

/** §9.5.5 ec. 11 + §9.6 — la ronda se normaliza contra la mejor marca y vale 750. */
export function roundPoints(pEquipo: number, pMax: number, cap = true): number {
  if (!(pMax > 0)) return 0;
  const pts = (XC27_LIMITS.roundMaxPts * pEquipo) / pMax;
  return cap ? Math.min(XC27_LIMITS.roundMaxPts, Math.max(0, pts)) : Math.max(0, pts);
}

/** §9.6 ec. 12 — media de TODAS las rondas (una ronda nula cuenta como 0). */
export function flightPoints(rounds: number[], totalRounds: number = XC27_LIMITS.rounds): number {
  const n = Math.max(totalRounds, rounds.length, 1);
  return rounds.reduce((s, r) => s + r, 0) / n;
}

// ------------------------------------------------------------------
//  Pruebas estáticas (§6 y §9.1) — 250 pts
// ------------------------------------------------------------------
export interface StaticItem { id: string; label: string; max: number; ref: string; hint: string; }
export interface StaticGroup { id: string; label: string; max: number; ref: string; deadline?: string; items: StaticItem[]; }

export const XC27_STATIC: StaticGroup[] = [
  {
    id: 'preliminar', label: 'Informe Preliminar', max: 10, ref: '§6.1', deadline: '2027-03-01',
    items: [
      { id: 'pre-completo', label: 'Contenidos completos', max: 10, ref: '§6.1', hint: 'Máx. 2 páginas A4 + 8 figuras: proceso de diseño, configuración, materiales y componentes, organización, dificultades, próximos pasos, estabilidad estática longitudinal y distribución de masas preliminar.' },
    ],
  },
  {
    id: 'tecnico', label: 'Informe Técnico', max: 125, ref: '§6.2', deadline: '2027-05-01',
    items: [
      { id: 'it-gestion', label: 'Gestión del proyecto', max: 10, ref: '§6.2', hint: 'Organización, planificación (Gantt), patrocinadores y análisis de costes (obligatorio: límite de 450 €).' },
      { id: 'it-empuje', label: 'Modelo de empuje', max: 10, ref: '§6.2', hint: 'T(V, palanca), elección de hélice, hipótesis, ensayos en banco. Las hélices usadas DEBEN figurar aquí.' },
      { id: 'it-aero', label: 'Diseño aerodinámico', max: 35, ref: '§6.2', hint: 'Perfil de ala y empenaje, dimensionado, flaps/winglets, análisis paramétricos con gráficas y tablas; CFD valorado.' },
      { id: 'it-estabilidad', label: 'Estabilidad y control', max: 10, ref: '§6.2', hint: 'Estática y dinámica (XFLR5, AVL, OpenVSP…), superficies móviles. CG en sus posiciones extremas, con y sin carga.' },
      { id: 'it-circuito', label: 'Circuito electrónico', max: 10, ref: '§6.2', hint: 'Esquema, lista de componentes y cálculo de la capacidad de la batería.' },
      { id: 'it-estructura', label: 'Diseño estructural', max: 25, ref: '§6.2', hint: 'Materiales, iteraciones, uniones, distribución de masas. Mínimo: flexión estática del ala y diagrama de maniobras (V-n). FEM valorado.' },
      { id: 'it-fabricacion', label: 'Técnicas de fabricación', max: 10, ref: '§6.2', hint: 'Ensayos y procesos por pieza, con fotografías de taller.' },
      { id: 'it-prestaciones', label: 'Prestaciones de la aeronave', max: 10, ref: '§6.2', hint: 'OEW, MTOW, carga, velocidades, despegue, ascenso. Obligatoria la predicción de carga: ecuación + gráfica frente a la densidad del aire.' },
      { id: 'it-lecciones', label: 'Lecciones aprendidas', max: 1, ref: '§6.2', hint: 'Errores y aprendizajes; las anécdotas dan la puntuación máxima.' },
      { id: 'it-comunicacion', label: 'Comunicación efectiva', max: 3, ref: '§6.2', hint: 'Estructura, lenguaje y claridad.' },
      { id: 'it-innovacion', label: 'Innovación', max: 1, ref: '§6.2', hint: 'Aspectos técnicos novedosos.' },
    ],
  },
  {
    id: 'planos', label: 'Planos', max: 60, ref: '§6.3', deadline: '2027-05-01',
    items: [
      { id: 'pl-planos', label: '4 planos A3 (ISO, sin líneas ocultas)', max: 60, ref: '§6.3', hint: '3 vistas en proyección europea con las 12 cotas y la tabla de datos, isométrico y dos adicionales (p. ej. caja de transporte y distribución interna).' },
    ],
  },
  {
    id: 'presentacion', label: 'Presentación de la aeronave', max: 55, ref: '§6.3.1', deadline: '2027-07-01',
    items: [
      { id: 'pr-idea', label: 'Presentación de la idea', max: 10, ref: '§6.3.1', hint: '10 min de exposición + 5 de preguntas.' },
      { id: 'pr-estrategia', label: 'Justificación de la estrategia', max: 10, ref: '§6.3.1', hint: 'Por qué esta aeronave para esta misión.' },
      { id: 'pr-proceso', label: 'Proceso de diseño', max: 10, ref: '§6.3.1', hint: '' },
      { id: 'pr-originalidad', label: 'Originalidad de la presentación', max: 10, ref: '§6.3.1', hint: '' },
      { id: 'pr-innovacion', label: 'Innovación tecnológica', max: 5, ref: '§6.3.1', hint: '' },
      { id: 'pr-oratoria', label: 'Oratoria', max: 10, ref: '§6.3.1', hint: '' },
    ],
  },
];

export const XC27_STATIC_MAX = XC27_STATIC.reduce((s, g) => s + g.max, 0);

/** Cotas obligatorias del plano de 3 vistas (§6.3): se verifican en la inspección. */
export const XC27_DRAWING_DIMS = [
  'Envergadura del ala principal', 'Cuerda en la raíz del ala', 'Cuerda en la punta del ala',
  'Longitud del avión', 'Altura del avión', 'Distancia entre bordes de ataque de ala y empenaje',
  'Envergadura del estabilizador horizontal', 'Cuerda en la raíz del estabilizador horizontal',
  'Altura del estabilizador vertical', 'Cuerda en la raíz del estabilizador vertical',
  'Cuerda en la punta del estabilizador vertical', 'Posición del centro de gravedad',
];

/** Tolerancias de la inspección frente a los planos (§6.3). */
export const drawingToleranceMm = (lengthMm: number) => lengthMm * (lengthMm > 1000 ? 0.01 : 0.035);

// ------------------------------------------------------------------
//  Penalizaciones (§9.7)
// ------------------------------------------------------------------
export interface Penalty { id: string; label: string; points: number; unit: 'fijo' | 'por-dia' | 'por-cm' | 'por-unidad' | 'info'; max?: number; effect?: string; }

export const XC27_PENALTIES: Penalty[] = [
  { id: 'ret-preliminar', label: 'Retraso en el Informe Preliminar', points: 2, unit: 'por-dia', max: 20 },
  { id: 'ret-tecnico', label: 'Retraso en el Informe Técnico', points: 15, unit: 'por-dia' },
  { id: 'sin-imagenes-ip', label: 'Sin imágenes del diseño conceptual en el I.P.', points: 5, unit: 'fijo' },
  { id: 'sin-costes', label: 'Sin análisis de costes en el informe', points: 10, unit: 'fijo' },
  { id: 'sin-estabilidad', label: 'Sin análisis de estabilidad', points: 10, unit: 'fijo' },
  { id: 'sin-prediccion', label: 'Sin expresión de predicción de la carga', points: 10, unit: 'fijo' },
  { id: 'sin-planos', label: 'Sin planos en el Informe Técnico', points: 20, unit: 'fijo', effect: '+ 0 puntos en planos' },
  { id: 'cotas', label: 'Discrepancia de cotas sobre la tolerancia', points: 4, unit: 'por-cm' },
  { id: 'cambio-menor', label: 'Cambio menor respecto a los planos', points: 5, unit: 'por-unidad' },
  { id: 'cambio-mayor', label: 'Cambio mayor respecto a los planos (p. ej. hélice no declarada)', points: 200, unit: 'info', effect: 'hasta 200 puntos' },
  { id: 'caja-sin-permiso', label: 'Extraer piezas de la caja sin autorización', points: 50, unit: 'fijo', effect: '+ vuelo nulo' },
  { id: 'caja-1cm', label: 'Caja: exceso de hasta 1 cm en una dimensión', points: 10, unit: 'por-unidad' },
  { id: 'caja-mas-1cm', label: 'Caja: exceso de más de 1 cm', points: 500, unit: 'info', effect: 'hasta 500 puntos por discrepancia' },
  { id: 'ret-presentacion', label: 'Retraso de hasta 3 min en la presentación oral', points: 10, unit: 'fijo' },
  { id: 'sin-recursos', label: 'No enviar los recursos digitales de la presentación', points: 10, unit: 'fijo' },
  { id: 'sin-video', label: 'Retraso del vídeo de prueba de vuelo', points: 5, unit: 'por-dia', max: 30, effect: '§6.3.2 dice 5/día; la tabla §9.7, 15/día' },
  { id: 'inspeccion', label: 'No superar la inspección técnica el primer día', points: 20, unit: 'fijo' },
  { id: 'pista', label: 'Acceder a pista sin autorización', points: 100, unit: 'fijo', effect: '+ posible descalificación' },
  { id: 'espectadores', label: 'Sobrevolar espectadores y carpas', points: 100, unit: 'fijo', effect: '+ vuelo nulo' },
  { id: 'juez', label: 'Desobedecer al juez de pista', points: 100, unit: 'fijo', effect: '+ posible descalificación' },
  { id: 'protesta', label: 'Protesta no justificada o fuera de cauce', points: 20, unit: 'por-unidad' },
];

// ------------------------------------------------------------------
//  Calendario (§5)
// ------------------------------------------------------------------
export interface Deadline { id: string; date: string; label: string; detail: string; kind: 'plazo' | 'entrega' | 'evento'; }

export const XC27_DEADLINES: Deadline[] = [
  { id: 'insc-open', date: '2026-09-20', label: 'Apertura de inscripciones', detail: 'Por orden de llegada, máximo 17 equipos académicos.', kind: 'plazo' },
  { id: 'insc-close', date: '2026-11-10', label: 'Cierre de inscripciones', detail: 'Solicitud .xlsx + identificación de miembros + carta de presentación.', kind: 'plazo' },
  { id: 'invitados', date: '2027-02-01', label: 'Lista de invitados', detail: 'Hasta dos invitados si el centro sólo inscribe un equipo.', kind: 'plazo' },
  { id: 'preliminar', date: '2027-03-01', label: 'Informe Preliminar + pago de tasas', detail: '10 pts. −2 pts por día de retraso (máx. 20). Tasas: 70 € por miembro.', kind: 'entrega' },
  { id: 'tecnico', date: '2027-05-01', label: 'Informe Técnico + planos', detail: '125 + 60 pts. −15 pts por día de retraso. Máx. 30 páginas A4.', kind: 'entrega' },
  { id: 'video', date: '2027-06-29', label: 'Vídeo de prueba de vuelo', detail: 'Despegue, vuelta nivelada y aterrizaje seguro. −5 pts por día (máx. 30).', kind: 'entrega' },
  { id: 'recursos', date: '2027-07-01', label: 'Recursos digitales de la presentación', detail: '−10 pts si no se envían.', kind: 'entrega' },
  { id: 'dia-tecnico', date: '2027-07-06', label: 'Día técnico en la UPV', detail: 'Inspección de cajas, inspección técnica y presentaciones.', kind: 'evento' },
  { id: 'vuelos-1', date: '2027-07-07', label: 'Vuelos de prueba + Ronda 1', detail: 'Campo Torre RC Casinos. Montaje en menos de 30 min.', kind: 'evento' },
  { id: 'vuelos-2', date: '2027-07-08', label: 'Rondas 2 y 3', detail: '', kind: 'evento' },
  { id: 'vuelos-3', date: '2027-07-09', label: 'Ronda 4 + entrega de premios', detail: '', kind: 'evento' },
];

// ------------------------------------------------------------------
//  Lista de conformidad — lo que mira la inspección técnica (§7)
// ------------------------------------------------------------------
export interface CheckItem { id: string; group: string; label: string; ref: string; detail: string; }

export const XC27_CHECKLIST: CheckItem[] = [
  // Propulsión
  { id: 'motor', group: 'Propulsión', label: 'Motor Emax GT2820/06 985KV sin modificar, único', ref: '§7.6', detail: 'Bancada fija y accesible para revisarlo en la inspección y antes de cada vuelo.' },
  { id: 'helice', group: 'Propulsión', label: 'Una sola hélice, desmontable y declarada en el informe', ref: '§7.6', detail: 'Con cono o tuercas; misma velocidad de giro que el motor; sin variar la incidencia. No se vuela con una hélice que no figure en el informe técnico.' },
  { id: 'esc', group: 'Propulsión', label: 'ESC comercial de ≥ 40 A continuos', ref: '§7.6', detail: 'No puede cambiar la tensión de la batería.' },
  { id: 'lipo', group: 'Propulsión', label: 'Batería principal LiPo ≤ 3S (12.6 V)', ref: '§7.6', detail: 'Especificaciones visibles y sin modificar salvo el conector. Se admite paralelo.' },
  { id: 'xt60', group: 'Propulsión', label: 'Conectores XT60 accesibles entre batería y ESC', ref: '§7.6', detail: 'Accesibles sin desmontar partes principales (compuerta o escotilla).' },
  { id: 'corte', group: 'Propulsión', label: 'Palanca de corte de motor programada', ref: '§7.6 · §7.7', detail: 'Corte de potencia en la emisora.' },
  // Radiocontrol
  { id: 'aux', group: 'Radiocontrol', label: 'Batería auxiliar independiente para receptor y servos', ref: '§7.6', detail: 'Se recomienda ≥ 600 mAh. No se alimentan desde la batería principal.' },
  { id: 'interruptor', group: 'Radiocontrol', label: 'Interruptor entre batería auxiliar y receptor', ref: '§7.7', detail: 'Accionable sin desmontar ninguna pieza.' },
  { id: 'radio', group: 'Radiocontrol', label: 'Emisora y receptor 2.4 GHz autorizados en la UE', ref: '§7.7', detail: 'Correctamente emparejados.' },
  { id: 'sin-auto', group: 'Radiocontrol', label: 'Sin vuelo automático, GPS, waypoints ni FPV', ref: '§7.7', detail: 'Sólo se admite estabilización que ayude al piloto.' },
  // Telemetría
  { id: 'tele-hueco', group: 'Caja de telemetría', label: 'Alojamiento para la caja 90 × 90 × 30 mm (150 g)', ref: '§7.7.1 · §12.1', detail: 'Se ancla desde la parte superior con dos tornillos M3 (no provistos); dos roscas M3 bajo la caja.' },
  { id: 'tele-cielo', group: 'Caja de telemetría', label: 'Vista del cielo sin obstrucciones sobre la caja', ref: '§7.7.1', detail: 'Respetar la zona libre del plano (20° desde las aristas superiores).' },
  { id: 'tele-xt60', group: 'Caja de telemetría', label: 'XT60 de entrada (batería) y salida (ESC) en el mismo lateral', ref: '§7.7.1', detail: 'La caja va en serie entre batería principal y variador. Perderla en vuelo = 0 puntos.' },
  // Carga
  { id: 'carga-200', group: 'Carga de pago', label: 'Bahía para al menos 200 g de arroz a granel', ref: '§7.8', detail: 'Densidad media 0.89 kg/L. Asegurada y completamente encerrada.' },
  { id: 'carga-cg', group: 'Carga de pago', label: 'Estabilidad verificada con el CG en sus extremos', ref: '§7.8', detail: 'Con carga y sin carga: los pilones se vuelan descargado.' },
  { id: 'carga-estructura', group: 'Carga de pago', label: 'Estructura íntegra con y sin carga ni bandejas', ref: '§7.8', detail: 'Sin depender de la carga o de estructuras auxiliares extraíbles.' },
  { id: 'mtow', group: 'Carga de pago', label: 'MTOW ≤ 25 kg', ref: '§7.8', detail: 'Límite legal.' },
  // Célula
  { id: 'propio', group: 'Célula', label: 'Diseño y fabricación propios; ala fija', ref: '§7', detail: 'Sin alas móviles salvo las superficies de control. Sólo accesorios comerciales (ruedas, tren).' },
  { id: 'caja', group: 'Célula', label: 'Caja de transporte: alto + ancho + largo ≤ 1300 mm', ref: '§7.3', detail: 'Dimensiones internas; todas las piezas del avión a la vez. Se revisa cada día.' },
  { id: 'montaje', group: 'Célula', label: 'Montaje en menos de 30 minutos', ref: '§7.3 · §8.1', detail: 'Si no, se puede perder la ronda.' },
  { id: 'dorsal', group: 'Célula', label: 'Dorsal de ≥ 10 cm en extradós, intradós y ambos lados', ref: '§7.1', detail: 'Más el logo o acrónimo del centro.' },
  { id: 'presupuesto', group: 'Célula', label: 'Presupuesto de fabricación ≤ 450 €', ref: '§7.2', detail: 'PVP de materiales, consumibles, electrónica, moldes y utillajes. Fuera: repuestos, emisora, caja, herramientas, envíos.' },
  { id: 'repuestos', group: 'Célula', label: 'Repuestos idénticos presentados en la inspección', ref: '§7.5', detail: 'Reparar con piezas no presentadas deja el 75 % de los puntos de cada vuelo.' },
  { id: 'flexion', group: 'Célula', label: 'Ensayo de flexión del ala con la carga instalada', ref: '§7.9', detail: 'Antes de cada vuelo: dos miembros levantan el avión por las puntas (≤ 10 cm desde la punta).' },
  // Documentación y piloto
  { id: 'seguro', group: 'Piloto', label: 'Seguro de aeromodelismo ≥ 1 000 000 €', ref: '§4.6', detail: 'O el seguro del proyecto Xtra2 UPV durante la competición.' },
  { id: 'a1a3', group: 'Piloto', label: 'Piloto con certificado A1/A3 de AESA', ref: '§4.6', detail: 'Piloto del equipo: evita el factor ×0.75 del piloto externo.' },
  { id: 'video', group: 'Piloto', label: 'Vídeo de prueba de vuelo enviado', ref: '§6.3.2', detail: 'Despegue, vuelta nivelada y aterrizaje. Límite: 29 de junio.' },
];

// ------------------------------------------------------------------
//  Fases de la ronda (§8.6) — para el diagrama de misión
// ------------------------------------------------------------------
export interface Phase { id: string; label: string; limit: string; scored: string; detail: string; }

export const XC27_PHASES: Phase[] = [
  { id: 'carga', label: 'Carga', limit: '≤ 4 min', scored: 'B_carga', detail: 'Tres miembros cargan el arroz en la mesa. El crono arranca al tocar carga, avión o herramienta.' },
  { id: 'despegue1', label: 'Despegue 1', limit: '20 / 40 / 60 m', scored: 'B_despegue', detail: 'Pista de asfalto. La marca se declara en la ficha prevuelo; 2 min para un despegue válido.' },
  { id: 'ascenso', label: 'Ascenso', limit: '60 s · ≤ 120 m', scored: 'P_AS', detail: 'Se puntúa la altitud barométrica a los 60 s de dejar el suelo.' },
  { id: 'planeo', label: 'Planeo', limit: '≤ 7 min · 10–120 m', scored: 'P_VE', detail: 'Motor parado (< 1 A). Cuenta la distancia GPS hasta que el consumo vuelve a superar 1 A.' },
  { id: 'aterrizaje1', label: 'Aterrizaje 1', limit: 'zona designada', scored: '—', detail: 'Con todos los componentes elementales; lo roto se repara en el pitstop.' },
  { id: 'pitstop', label: 'Pitstop', limit: '≤ 120 s', scored: 'B_carga', detail: 'Descarga y reparaciones. Sin cambiar batería ni modelo de hélice. Se puede renunciar a los pilones.' },
  { id: 'despegue2', label: 'Despegue 2', limit: 'un solo intento', scored: '—', detail: 'Cuenta como intento mantener más de 1 A durante 5 s.' },
  { id: 'pilones', label: 'Pilones', limit: '10 × 100 m', scored: 'P_PI', detail: 'Cronometrado entre dos postes, entre 10 y 120 m. Hasta 60 s para el primer viraje.' },
  { id: 'aterrizaje2', label: 'Aterrizaje 2', limit: 'zona designada', scored: 'L_vuelo', detail: 'Un accidente en la aproximación deja el 50 % de la ronda.' },
];

// ------------------------------------------------------------------
//  Puntos del reglamento que conviene consultar a la organización
// ------------------------------------------------------------------
export const XC27_OPEN_QUESTIONS: { title: string; text: string }[] = [
  { title: 'Unidad de P_CA', text: 'La ec. 9 es MPL/300 y el texto dice «en kg». Con kg, 3 kg de arroz valen 0.01 y el bloque de carga·ascenso·planeo pesa lo mismo que los pilones; con gramos los pilones serían irrelevantes. El simulador usa kg y permite cambiarlo.' },
  { title: 'Carga declarada frente a transportada', text: 'P_CA usa la carga DECLARADA en el informe y B_predicción sólo castiga por debajo del 90 %. Llevar más de lo declarado no suma; llevar el 90 % puntúa como el 100 %.' },
  { title: '¿Se puede seguir subiendo tras los 60 s?', text: 'P_AS mide la altitud a los 60 s, pero el planeo empieza cuando la corriente baja de 1 A. Si se permite, lo óptimo es pasar por ~81 m a los 60 s y cortar motor cerca del techo de 120 m.' },
  { title: 'Hélices por fase', text: '§7.6 permite hélices distintas por fase si están en el informe, pero §8.6 prohíbe cambiar de modelo durante el pitstop. En la práctica, una sola hélice para ascenso y pilones.' },
  { title: 'P_max de la ronda', text: 'P_ronda = P_equipo/P_max: se asume que P_max es la mejor marca de la ronda y que ésta se lleva los 750 puntos.' },
  { title: 'Fin del planeo', text: 'La fase termina al superar de nuevo 1 A. Hay que reencender por encima de 10 m: bajar de ahí planeando puede anular el vuelo.' },
];

// ------------------------------------------------------------------
//  Utilidades
// ------------------------------------------------------------------

/** Volumen de bahía necesario para una carga de arroz a granel, en litros. */
export const riceVolumeL = (payloadG: number, packing = 1.08) =>
  (payloadG / 1000 / XC27_LIMITS.riceDensityKgL) * packing;

// ------------------------------------------------------------------
//  Caja de transporte (§7.3)
// ------------------------------------------------------------------
export interface BoxGeometry {
  spanM: number; rootChordM: number; thickness: number;   // espesor relativo t/c
  fuseLengthM: number; fuseWidthM: number;
}
export interface MinBox {
  sumMm: number; lengthMm: number; widthMm: number; heightMm: number;
  panels: number; layout: 'fuselaje al lado' | 'fuselaje encima';
}

/**
 * Caja más pequeña (en suma de dimensiones interiores) en la que cabe el
 * avión desmontado. El ala se parte en 2–5 paneles apilados; el fuselaje,
 * en tramos (por defecto dos: góndola + cola) que viajan al lado o encima de la pila;
 * los estabilizadores, planos, en una holgura de 25 mm. Es una estimación
 * de anteproyecto: el encaje real se decide con el CAD.
 */
export function minTransportBox(g: BoxGeometry, fusePieces = 2): MinBox {
  let best: MinBox | null = null;
  for (let panels = 2; panels <= 5; panels++) {
    for (const o of boxSections(g, panels)) {
      const lengthMm = Math.max((g.spanM * 1000) / panels, (g.fuseLengthM * 1000) / Math.max(1, fusePieces)) + BOX_CLEARANCE_MM;
      const sumMm = lengthMm + o.widthMm + o.heightMm;
      if (!best || sumMm < best.sumMm) best = { sumMm, lengthMm, widthMm: o.widthMm, heightMm: o.heightMm, panels, layout: o.layout };
    }
  }
  return best as MinBox;
}

export const BOX_CLEARANCE_MM = 10;

/** Sección (ancho × alto) que piden las piezas según cómo se coloque el fuselaje. */
export function boxSections(g: BoxGeometry, panels: number): { layout: MinBox['layout']; widthMm: number; heightMm: number }[] {
  const cr = g.rootChordM * 1000, t = g.thickness * cr, wf = g.fuseWidthM * 1000;
  // los paneles se alternan borde de ataque con borde de salida: ~90 % del espesor
  const stack = panels * t * 0.9 + 25;
  return [
    { layout: 'fuselaje al lado', widthMm: cr + wf + BOX_CLEARANCE_MM, heightMm: Math.max(stack, wf) + BOX_CLEARANCE_MM },
    { layout: 'fuselaje encima', widthMm: Math.max(cr, wf) + BOX_CLEARANCE_MM, heightMm: stack + wf + BOX_CLEARANCE_MM },
  ];
}

/** Densidad del aire a partir de la elevación del campo y la temperatura. */
export function airDensityAt(elevationM: number, tempC: number): number {
  const p = 101325 * Math.pow(1 - 2.25577e-5 * elevationM, 5.25588);
  return p / (287.05 * (tempC + 273.15));
}

/** Casinos (Valencia): campo de vuelo Torre RC, ~310 m sobre el mar. */
export const XC27_FIELD = { name: 'Club Torre RC Casinos', elevationM: 310, julyTempC: 31, surface: 'asfalto', mu: 0.04 };

/** Días que faltan hasta una fecha ISO (negativo = ya pasó). */
export function daysUntil(isoDate: string, now: Date = new Date()): number {
  const d = new Date(isoDate + 'T23:59:00');
  return Math.ceil((d.getTime() - now.getTime()) / 86400000);
}
