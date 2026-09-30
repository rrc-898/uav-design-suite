// ==================================================================
//  Airfoil catalog + 2-D section model (low-Reynolds regime).
//
//  Every section is described by the four numbers that drive UAV
//  performance, taken from XFOIL/UIUC low-Re polars at the reference
//  Reynolds number `reRef`:
//     • a0        section lift slope        (1/deg)
//     • alpha0    zero-lift angle           (deg, negative = cambered)
//     • clMax     max section lift
//     • cdMin,    minimum profile drag and the parabolic "drag bucket"
//       clOpt,    around it:  cd(cl) = cdMin + kDrag·(cl − clOpt)²
//       kDrag
//
//  Reynolds scaling of drag follows the classic low-Re trend
//  cd ∝ Re^(−0.35) (between the laminar −0.5 and turbulent −0.2 laws),
//  and clMax degrades as Re drops because the laminar separation
//  bubble grows. Both are the dominant effects for UAVs flying at
//  Re = 1·10⁵ … 8·10⁵.
//
//  Sources: UIUC Low-Speed Airfoil Data (Selig et al., vols. I–V),
//  Althaus Stuttgarter Profilkatalog, Abbott & von Doenhoff,
//  XFOIL v6.99 runs at Re 200k–500k, Ncrit 9.
// ==================================================================

export type AirfoilTag =
  | 'alta-sustentacion'
  | 'baja-resistencia'
  | 'carga'
  | 'velocidad'
  | 'endurance'
  | 'ala-volante'
  | 'general';

export interface Airfoil {
  id: string;
  name: string;
  family: string;
  tc: number;            // thickness ratio t/c
  camberPct: number;     // max camber, % chord
  a0PerDeg: number;      // section lift slope, 1/deg
  alpha0Deg: number;     // zero-lift angle of attack, deg
  cm0: number;           // pitching moment about c/4 (negative = nose down)
  clMax: number;         // max section cl at reRef
  clOpt: number;         // cl at the bottom of the drag bucket
  cdMin: number;         // min section drag at reRef
  kDrag: number;         // drag bucket curvature, cd = cdMin + k·(cl−clOpt)²
  reRef: number;         // Reynolds number the polar refers to
  stall: 'suave' | 'moderado' | 'brusco';
  reflex: boolean;       // self-stable section (flying wings)
  buildability: number;  // 1 = fácil (borde de salida grueso) … 0.5 = delicado
  tags: AirfoilTag[];
  note: string;
}

// ------------------------------------------------------------------
//  Catalog — 14 sections covering the whole UAV design space, from
//  high-lift cargo haulers to low-drag racers and reflexed flying wings.
// ------------------------------------------------------------------
export const AIRFOILS: Airfoil[] = [
  {
    id: 's1223', name: 'Selig S1223', family: 'Selig high-lift',
    tc: 0.121, camberPct: 8.1, a0PerDeg: 0.103, alpha0Deg: -8.6, cm0: -0.27,
    clMax: 2.20, clOpt: 1.25, cdMin: 0.0208, kDrag: 0.0125, reRef: 3e5,
    stall: 'moderado', reflex: false, buildability: 0.7,
    tags: ['alta-sustentacion', 'carga'],
    note: 'El perfil de máxima sustentación práctica a bajo Re. Rey de las competiciones de carga: permite despegues muy cortos y velocidades de pérdida bajísimas, a costa de mucho Cm (cola grande) y drag alto en crucero rápido.',
  },
  {
    id: 'e423', name: 'Eppler 423', family: 'Eppler high-lift',
    tc: 0.125, camberPct: 7.0, a0PerDeg: 0.104, alpha0Deg: -7.6, cm0: -0.24,
    clMax: 1.95, clOpt: 1.10, cdMin: 0.0186, kDrag: 0.0115, reRef: 3e5,
    stall: 'suave', reflex: false, buildability: 0.75,
    tags: ['alta-sustentacion', 'carga'],
    note: 'Alternativa al S1223 con entrada en pérdida más benigna y algo menos de drag. Muy usado en UAVs de carga útil elevada y despegue corto.',
  },
  {
    id: 'fx63-137', name: 'Wortmann FX 63-137', family: 'Wortmann',
    tc: 0.137, camberPct: 6.0, a0PerDeg: 0.105, alpha0Deg: -6.4, cm0: -0.21,
    clMax: 1.75, clOpt: 0.95, cdMin: 0.0162, kDrag: 0.0100, reRef: 3e5,
    stall: 'suave', reflex: false, buildability: 0.85,
    tags: ['alta-sustentacion', 'carga', 'endurance'],
    note: 'Clásico de alta sustentación y buen comportamiento a Re bajo. Espesor generoso: larguero ligero y bahía de carga interna. Excelente compromiso carga/eficiencia.',
  },
  {
    id: 'sd7062', name: 'Selig-Donovan SD7062', family: 'Selig-Donovan',
    tc: 0.140, camberPct: 3.9, a0PerDeg: 0.106, alpha0Deg: -3.9, cm0: -0.10,
    clMax: 1.45, clOpt: 0.70, cdMin: 0.0118, kDrag: 0.0082, reRef: 3e5,
    stall: 'suave', reflex: false, buildability: 0.95,
    tags: ['carga', 'general', 'endurance'],
    note: 'El "caballo de batalla" de los UAVs de trabajo: mucho espesor estructural, pérdida dócil y drag razonable. Muy tolerante a la suciedad y a errores de construcción.',
  },
  {
    id: 'naca4412', name: 'NACA 4412', family: 'NACA 4-dígitos',
    tc: 0.120, camberPct: 4.0, a0PerDeg: 0.106, alpha0Deg: -4.1, cm0: -0.10,
    clMax: 1.52, clOpt: 0.60, cdMin: 0.0112, kDrag: 0.0090, reRef: 3e5,
    stall: 'moderado', reflex: false, buildability: 1.0,
    tags: ['general', 'carga'],
    note: 'Referencia universal y totalmente documentada. Buen equilibrio sustentación/resistencia y geometría trivial de construir. Punto de partida seguro.',
  },
  {
    id: 'clarky', name: 'Clark Y', family: 'Clark',
    tc: 0.117, camberPct: 3.4, a0PerDeg: 0.105, alpha0Deg: -3.6, cm0: -0.08,
    clMax: 1.38, clOpt: 0.50, cdMin: 0.0108, kDrag: 0.0088, reRef: 3e5,
    stall: 'moderado', reflex: false, buildability: 1.0,
    tags: ['general', 'carga'],
    note: 'Intradós plano: se construye sobre una mesa sin plantillas y es fácil de alinear. Prestaciones honestas en todo el rango. El estándar de facto en prototipos rápidos.',
  },
  {
    id: 'naca2412', name: 'NACA 2412', family: 'NACA 4-dígitos',
    tc: 0.120, camberPct: 2.0, a0PerDeg: 0.106, alpha0Deg: -2.1, cm0: -0.05,
    clMax: 1.35, clOpt: 0.38, cdMin: 0.0098, kDrag: 0.0086, reRef: 3e5,
    stall: 'moderado', reflex: false, buildability: 1.0,
    tags: ['general', 'velocidad'],
    note: 'Poca curvatura: menos drag y menos momento que el 4412, a cambio de menos CLmax. Buena elección cuando la misión pesa más la velocidad que la carga.',
  },
  {
    id: 'sd7037', name: 'Selig-Donovan SD7037', family: 'Selig-Donovan',
    tc: 0.092, camberPct: 3.0, a0PerDeg: 0.105, alpha0Deg: -3.0, cm0: -0.08,
    clMax: 1.26, clOpt: 0.55, cdMin: 0.0094, kDrag: 0.0072, reRef: 3e5,
    stall: 'suave', reflex: false, buildability: 0.85,
    tags: ['endurance', 'baja-resistencia'],
    note: 'Perfil de planeador térmico: bucket muy ancho, drag bajo en un rango grande de cl. Óptimo para vuelos largos con velocidad variable (loiter, ISR).',
  },
  {
    id: 'e205', name: 'Eppler 205', family: 'Eppler',
    tc: 0.105, camberPct: 2.2, a0PerDeg: 0.105, alpha0Deg: -1.9, cm0: -0.045,
    clMax: 1.16, clOpt: 0.38, cdMin: 0.0090, kDrag: 0.0070, reRef: 3e5,
    stall: 'suave', reflex: false, buildability: 0.9,
    tags: ['endurance', 'baja-resistencia', 'velocidad'],
    note: 'Muy poco momento y drag bajo en un rango amplio: cola pequeña y crucero eficiente. Uno de los mejores compromisos para UAVs de resistencia con crucero rápido.',
  },
  {
    id: 'mh32', name: 'MH 32', family: 'Hepperle',
    tc: 0.086, camberPct: 2.6, a0PerDeg: 0.104, alpha0Deg: -2.4, cm0: -0.06,
    clMax: 1.20, clOpt: 0.50, cdMin: 0.0086, kDrag: 0.0068, reRef: 3e5,
    stall: 'suave', reflex: false, buildability: 0.75,
    tags: ['baja-resistencia', 'endurance'],
    note: 'Perfil fino de altas prestaciones para alas de cuerda pequeña. Drag mínimo notable, pero el espesor reducido penaliza el larguero: exige fibra de carbono.',
  },
  {
    id: 'ag35', name: 'Drela AG35', family: 'Drela AG',
    tc: 0.073, camberPct: 2.1, a0PerDeg: 0.103, alpha0Deg: -2.5, cm0: -0.055,
    clMax: 1.10, clOpt: 0.45, cdMin: 0.0080, kDrag: 0.0066, reRef: 2e5,
    stall: 'suave', reflex: false, buildability: 0.6,
    tags: ['baja-resistencia', 'endurance'],
    note: 'Diseñado por Mark Drela para Re muy bajos (alas pequeñas, DLG). El drag más bajo del catálogo, pero muy delgado y sensible a la precisión de fabricación.',
  },
  {
    id: 'naca0012', name: 'NACA 0012', family: 'NACA simétrico',
    tc: 0.120, camberPct: 0, a0PerDeg: 0.107, alpha0Deg: 0, cm0: 0,
    clMax: 1.12, clOpt: 0, cdMin: 0.0084, kDrag: 0.0090, reRef: 3e5,
    stall: 'brusco', reflex: false, buildability: 1.0,
    tags: ['velocidad', 'general'],
    note: 'Simétrico: sin momento, vuelo invertido y acrobacia. Drag mínimo bajo pero pierde rápido sustentación. Estándar también para empenajes.',
  },
  {
    id: 'naca63a010', name: 'NACA 63A-010', family: 'NACA laminar',
    tc: 0.100, camberPct: 0, a0PerDeg: 0.107, alpha0Deg: 0, cm0: 0,
    clMax: 1.05, clOpt: 0, cdMin: 0.0074, kDrag: 0.0115, reRef: 5e5,
    stall: 'brusco', reflex: false, buildability: 0.8,
    tags: ['velocidad', 'baja-resistencia'],
    note: 'Serie laminar: bucket estrecho pero profundo. Sólo interesa en misiones de velocidad punta donde el cl de crucero es muy bajo y constante.',
  },
  {
    id: 'mh60', name: 'MH 60 (reflex)', family: 'Hepperle reflex',
    tc: 0.101, camberPct: 1.6, a0PerDeg: 0.103, alpha0Deg: -1.2, cm0: 0.005,
    clMax: 1.05, clOpt: 0.35, cdMin: 0.0092, kDrag: 0.0080, reRef: 3e5,
    stall: 'suave', reflex: true, buildability: 0.8,
    tags: ['ala-volante', 'velocidad'],
    note: 'Reflex con Cm≈0: estable sin cola. Habilita configuraciones ala volante (menos superficie mojada y menos masa) a cambio de CLmax reducido.',
  },
];

export const airfoilById = (id: string): Airfoil =>
  AIRFOILS.find((a) => a.id === id) ?? AIRFOILS[0];

// ------------------------------------------------------------------
//  Reynolds corrections
// ------------------------------------------------------------------

/** Drag scaling with Reynolds: cd ∝ Re^(−0.35), clamped to a sane band. */
export function dragReFactor(Re: number, reRef: number): number {
  const r = Math.max(3e4, Re) / reRef;
  return Math.min(2.2, Math.max(0.55, Math.pow(r, -0.35)));
}

/**
 * clMax degradation at low Reynolds (laminar separation bubble).
 * Full clMax above ~5·10⁵, ~25 % penalty near 8·10⁴.
 */
export function clMaxAtRe(af: Airfoil, Re: number): number {
  const f = 0.62 + 0.38 * Math.min(1, Math.log10(Math.max(5e4, Re) / 5e4) / Math.log10(10));
  return af.clMax * f;
}

/** Section drag polar cd(cl) at a given Reynolds, with a post-stall penalty. */
export function cdSection(af: Airfoil, cl: number, Re: number): number {
  const clm = clMaxAtRe(af, Re);
  const bucket = af.cdMin + af.kDrag * (cl - af.clOpt) ** 2;
  let cd = bucket * dragReFactor(Re, af.reRef);
  if (Math.abs(cl) > 0.85 * clm) {
    // drag rises steeply as the section approaches stall
    const x = (Math.abs(cl) - 0.85 * clm) / (0.15 * clm);
    cd *= 1 + 1.8 * x * x;
  }
  return cd;
}

/** Section lift slope corrected for thickness/Re — used by the lifting line. */
export const a0OfAirfoil = (af: Airfoil) => af.a0PerDeg;
