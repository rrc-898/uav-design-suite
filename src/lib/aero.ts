// ==================================================================
//  Aerodynamics engine — CFD Studio.
//
//  Method (after XFLR5 / AVL / Anderson & Katz-Plotkin):
//   • Finite-wing lift & induced drag via Prandtl LIFTING-LINE THEORY
//     (Glauert Fourier-series solution of the monoplane equation):
//        α(θ) − α_L0(θ) = Σ Aₙ·sin(nθ)·[ 4b/(a0·c(θ)) + n/sin(θ) ]
//        CL = π·AR·A₁ ,  CDi = π·AR·Σ n·Aₙ² = CL²/(π·AR·e),  e = 1/(1+δ)
//   • Parasite drag CD0 by COMPONENT BUILDUP (Raymer / McCormick):
//        CD0 = (1/Sref)·Σ Cf·FF·Q·Swet ,  Cf = 0.455/log10(Re)^2.58
//   • Drag polar:  CD = CD0 + CL²/(π·AR·e)
//   • Performance & propulsion loop: thrust required Tr(V)=½ρV²S·CD vs
//     thrust available Ta(V) (imported polynomial) → trim/cruise speed,
//     max speed, rate of climb.
//  Everything is steady, incompressible, low-Re — the regime of UAVs.
// ==================================================================

import { polyval } from './fit';

const RHO_SL = 1.225;
const MU = 1.81e-5;          // dynamic viscosity, Pa·s
const G = 9.80665;
const DEG = Math.PI / 180;

export interface Wing {
  span: number;        // b, m
  rootChord: number;   // cr, m
  taper: number;       // λ = ct/cr (0..1)
  sweepDeg: number;    // quarter-chord sweep
  washoutDeg: number;  // geometric twist at tip (negative = washout)
  a0PerDeg: number;    // section lift-slope, 1/deg (~0.105 ≈ 2π/rad)
  alpha0Deg: number;   // section zero-lift angle (camber)
  tc: number;          // thickness ratio t/c
  clMax: number;       // section max lift coefficient
  cdMin: number;       // section minimum profile drag
}

export interface Fuselage { length: number; diameter: number; }

export function wingArea(w: Wing): number { return w.span * w.rootChord * (1 + w.taper) / 2; }
export function aspectRatio(w: Wing): number { const S = wingArea(w); return (w.span * w.span) / S; }
export function mac(w: Wing): number {
  const t = w.taper;
  return (2 / 3) * w.rootChord * (1 + t + t * t) / (1 + t);
}

// ---- linear solver (Gaussian elimination, partial pivot) ----------
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / (M[i][i] || 1e-12));
}

// ---- Lifting-line solution at one root angle of attack ------------
export interface LLTResult {
  alphaDeg: number;
  CL: number;
  CDi: number;
  e: number;          // span efficiency (inviscid)
  delta: number;
  station: { y: number[]; cl: number[]; ccl: number[] }; // spanwise (half-span, root→tip)
}

export function solveLLT(w: Wing, alphaRootDeg: number, N = 40): LLTResult {
  const b = w.span;
  const S = wingArea(w);
  const AR = (b * b) / S;
  const a0 = (w.a0PerDeg / DEG) * Math.cos(w.sweepDeg * DEG); // per rad, swept correction
  const A: number[][] = [];
  const rhs: number[] = [];
  const thetas: number[] = [];
  const chords: number[] = [];

  for (let i = 1; i <= N; i++) {
    const theta = (i * Math.PI) / (2 * N); // (0, π/2]
    const frac = Math.cos(theta);          // |2y/b| : 0 at root, →1 at tip
    const c = w.rootChord * (1 - (1 - w.taper) * frac);
    const aGeo = (alphaRootDeg + w.washoutDeg * frac) * DEG;
    const aL0 = w.alpha0Deg * DEG;
    thetas.push(theta); chords.push(c);
    const row: number[] = [];
    for (let k = 1; k <= N; k++) {
      const n = 2 * k - 1; // odd harmonics (symmetric loading)
      // monoplane equation with Γ = 2bV·ΣAₙ sin(nθ): coefficient is 4b/(a0·c)
      row.push(Math.sin(n * theta) * (4 * b / (a0 * c) + n / Math.sin(theta)));
    }
    A.push(row);
    rhs.push(aGeo - aL0);
  }

  const coef = solveLinear(A, rhs); // A_1, A_3, A_5 ...
  const A1 = coef[0];
  const CL = Math.PI * AR * A1;
  let delta = 0;
  for (let k = 2; k <= N; k++) { const n = 2 * k - 1; delta += n * (coef[k - 1] / A1) ** 2; }
  const e = 1 / (1 + delta);
  const CDi = (CL * CL) / (Math.PI * AR * e);

  // spanwise distribution
  const y: number[] = [], cl: number[] = [], ccl: number[] = [];
  for (let i = 0; i < N; i++) {
    const theta = thetas[i];
    let sum = 0;
    for (let k = 1; k <= N; k++) { const n = 2 * k - 1; sum += coef[k - 1] * Math.sin(n * theta); }
    const gamma = 2 * b * sum;              // Γ / V
    const clLocal = (2 * gamma) / chords[i]; // local section cl (V·c cancels with 2Γ/(Vc))
    y.push((b / 2) * Math.cos(theta));      // root(0) → tip(b/2)
    cl.push(clLocal);
    ccl.push(clLocal * chords[i]);
  }
  return { alphaDeg: alphaRootDeg, CL, CDi, e, delta, station: { y, cl, ccl } };
}

/** Finite-wing lift-curve slope (per rad) and zero-lift alpha, from two LLT solves. */
export function liftCurve(w: Wing): { CLalphaPerRad: number; alphaL0Deg: number; e: number } {
  const r1 = solveLLT(w, 0), r2 = solveLLT(w, 5);
  const slopePerDeg = (r2.CL - r1.CL) / 5;
  const alphaL0Deg = -r1.CL / slopePerDeg;
  return { CLalphaPerRad: slopePerDeg / DEG, alphaL0Deg, e: r2.e };
}

// ---- parasite drag build-up --------------------------------------
function cfTurb(Re: number): number {
  if (Re < 1e4) Re = 1e4;
  return 0.455 / Math.pow(Math.log10(Re), 2.58);
}

export interface DragBuildup { CD0: number; components: { name: string; cd0: number }[]; }

export function parasiteDrag(w: Wing, fuse: Fuselage, V: number, rho = RHO_SL, miscFactor = 1.1): DragBuildup {
  const S = wingArea(w);
  const macLen = mac(w);
  const comps: { name: string; cd0: number }[] = [];

  // wing
  const ReW = (rho * V * macLen) / MU;
  const ffW = 1 + 0.6 / 0.3 * w.tc + 100 * Math.pow(w.tc, 4);
  const swetW = 2.04 * S;
  const cd0W = (cfTurb(ReW) * ffW * 1.0 * swetW) / S;
  comps.push({ name: 'Ala', cd0: cd0W });

  // fuselage
  const f = fuse.length / Math.max(0.01, fuse.diameter);
  const ReF = (rho * V * fuse.length) / MU;
  const ffF = 1 + 60 / Math.pow(f, 3) + f / 400;
  const swetF = Math.PI * fuse.diameter * fuse.length * 0.9;
  const cd0F = (cfTurb(ReF) * ffF * 1.0 * swetF) / S;
  comps.push({ name: 'Fuselaje', cd0: cd0F });

  // tail group (approx as 0.25·S surfaces, t/c 0.10)
  const ReT = (rho * V * macLen * 0.6) / MU;
  const swetT = 2.04 * (0.25 * S);
  const cd0T = (cfTurb(ReT) * (1 + 2 * 0.10 + 60 * Math.pow(0.10, 4)) * swetT) / S;
  comps.push({ name: 'Empenaje', cd0: cd0T });

  const base = comps.reduce((p, c) => p + c.cd0, 0);
  const sum = base * miscFactor;
  comps.push({ name: 'Misc/interf.', cd0: sum - base });
  return { CD0: sum, components: comps };
}

// ---- drag polar ---------------------------------------------------
export interface PolarPoint { alphaDeg: number; CL: number; CDi: number; CD0: number; CD: number; LD: number; }

export function dragPolar(w: Wing, fuse: Fuselage, Vref: number, rho = RHO_SL,
  alphaMin = -4, alphaMax = 14, steps = 28): { points: PolarPoint[]; CD0: number; e: number } {
  const db = parasiteDrag(w, fuse, Vref, rho);
  const points: PolarPoint[] = [];
  let e = 0.9;
  for (let i = 0; i <= steps; i++) {
    const a = alphaMin + (alphaMax - alphaMin) * (i / steps);
    const r = solveLLT(w, a);
    e = r.e;
    const CD = db.CD0 + r.CDi;
    points.push({ alphaDeg: a, CL: r.CL, CDi: r.CDi, CD0: db.CD0, CD, LD: CD > 0 ? r.CL / CD : 0 });
  }
  return { points, CD0: db.CD0, e };
}

// ---- performance & propulsion loop --------------------------------
export interface ThrustModel { coeffs: number[]; vMax: number; }   // Ta(V) [N], ascending poly
export const thrustAvailable = (tm: ThrustModel, V: number) => Math.max(0, polyval(tm.coeffs, V));

export interface PerfPoint { V: number; CL: number; CD: number; thrustReq: number; thrustAvail: number; powerReq: number; rocMs: number; }
export interface Performance {
  massKg: number; S: number; AR: number; e: number; CD0: number;
  vStall: number; ldMax: number; vBestLD: number; vMax: number | null;
  cruiseV: number | null; rocMax: number; vRocMax: number;
  curve: PerfPoint[];
}

export function performance(w: Wing, fuse: Fuselage, massKg: number, tm: ThrustModel | null,
  rho = RHO_SL, clMaxWing = 1.2): Performance {
  const S = wingArea(w);
  const AR = aspectRatio(w);
  const W = massKg * G;
  // CD0/e at a representative speed
  const polar = dragPolar(w, fuse, Math.max(8, (tm?.vMax ?? 25) * 0.6), rho);
  const CD0 = polar.CD0, e = polar.e;
  const k = 1 / (Math.PI * AR * e);

  const CLmax = clMaxWing;
  const vStall = Math.sqrt((2 * W) / (rho * S * CLmax));
  const vMaxScan = Math.max((tm?.vMax ?? 35) * 1.35, vStall * 2.5);

  const curve: PerfPoint[] = [];
  let ldMax = 0, vBestLD = vStall, rocMax = -1e9, vRocMax = vStall;
  let vMax: number | null = null, cruiseV: number | null = null;
  let prevExcess: number | null = null, prevV = 0;

  const steps = 80;
  for (let i = 0; i <= steps; i++) {
    const V = vStall * 0.9 + (vMaxScan - vStall * 0.9) * (i / steps);
    const CL = (2 * W) / (rho * V * V * S);
    const CD = CD0 + k * CL * CL;
    const Tr = 0.5 * rho * V * V * S * CD;     // = D
    const Pr = Tr * V;
    const Ta = tm ? thrustAvailable(tm, V) : NaN;
    const roc = tm ? (V * (Ta - Tr)) / W : NaN;
    const LD = CL / CD;
    if (CL <= CLmax) { // flyable region
      if (LD > ldMax) { ldMax = LD; vBestLD = V; }
      if (tm && roc > rocMax) { rocMax = roc; vRocMax = V; }
    }
    curve.push({ V, CL, CD, thrustReq: Tr, thrustAvail: Ta, powerReq: Pr, rocMs: roc });

    // equilibrium crossing Ta = Tr (max-speed root)
    if (tm) {
      const excess = Ta - Tr;
      if (prevExcess !== null && prevExcess > 0 && excess <= 0 && V > vStall) {
        const frac = prevExcess / (prevExcess - excess);
        vMax = prevV + frac * (V - prevV);
        cruiseV = vMax;
      }
      prevExcess = excess; prevV = V;
    }
  }
  return { massKg, S, AR, e, CD0, vStall, ldMax, vBestLD, vMax, cruiseV, rocMax: tm ? rocMax : 0, vRocMax, curve };
}

// reasonable demo thrust model (Emax GT2826 · 10x5 · 4S, full throttle), Ta(V) in N
export const DEMO_THRUST: ThrustModel = { coeffs: [23.5, -0.311, -0.00972, 6.47e-5], vMax: 32 };
