// ==================================================================
//  Propulsion model — 0-D steady-state motor + propeller + battery.
//  Velocity-centric: propeller Ct(J) / Cp(J) are real polynomial fits
//  (UIUC data, from the XtraCalc catalog), so every result is a
//  function of forward speed through the advance ratio J = V/(n·D).
//
//  Motor (Kv model):  ω = Kv·(V_eff − I·Rm),  Q = Kt·(I − I0),
//                     Kt = 9.5493/Kv,  I0 = I0_ref·(V_eff/V_ref)
//  Propeller:         T = Ct(J)·ρ·n²·D⁴,  P = Cp(J)·ρ·n³·D⁵
//  Battery sag:       V_pack = V_nom − I·(R_int·cells + R_esc + R_wire)
//
//  Operating point = (n, I) where the voltage the motor needs to spin
//  the loaded prop equals the throttled, sagging battery supply.
//  Solved by damped fixed-point iteration.
// ==================================================================

export const RHO_SL = 1.225;
const IN_TO_M = 0.0254;
const N_TO_GF = 1000 / 9.80665;

export interface MotorSpec { kv: number; rm: number; i0Ref: number; vRef: number; iMax: number; }
export interface PropSpec { dia: number; pitch: number; ct: number[]; cp: number[]; }
export interface BatterySpec { cells: number; vcell: number; capacityMah: number; cRating: number; rintCell: number; }
export interface EscSpec { iMax: number; efficiency: number; resistance: number; }

export interface DriveTrain {
  motor: MotorSpec;
  prop: PropSpec;
  battery: BatterySpec;
  esc: EscSpec;
  rho?: number;
  wireResistance?: number;
}

export interface OperatingPoint {
  throttle: number; airspeed: number;
  rpm: number; current: number; voltagePack: number;
  powerElec: number; powerShaft: number;
  thrustN: number; thrustG: number; torque: number; J: number;
  etaMotor: number; etaProp: number; etaTotal: number; gPerW: number;
  overCurrent: boolean;
}

/** Evaluate ascending-order polynomial a0 + a1·x + a2·x² + … (Horner). */
function polyval(c: number[], x: number): number {
  let r = 0;
  for (let i = c.length - 1; i >= 0; i--) r = r * x + c[i];
  return r;
}

function airDensityAlt(alt: number): number {
  return RHO_SL * Math.pow(1 - 2.25577e-5 * alt, 4.2559);
}
export { airDensityAlt as airDensity };

export function solvePoint(dt: DriveTrain, throttle: number, airspeed: number): OperatingPoint {
  const rho = dt.rho ?? RHO_SL;
  const Kt = 9.5493 / dt.motor.kv;
  const D = dt.prop.dia * IN_TO_M;
  const D4 = Math.pow(D, 4);
  const D5 = Math.pow(D, 5);
  const Rtot = dt.battery.rintCell * dt.battery.cells + dt.esc.resistance + (dt.wireResistance ?? 0.005);
  const Vnom = dt.battery.cells * dt.battery.vcell;
  const i0 = () => dt.motor.i0Ref * Math.max(0.3, (throttle * Vnom) / dt.motor.vRef);

  let n = 120;
  for (let it = 0; it < 300; it++) {
    const J = airspeed > 0 && n > 0 ? airspeed / (n * D) : 0;
    const Cp = Math.max(0.002, polyval(dt.prop.cp, J));
    const Qprop = (Cp * rho * n * n * D5) / (2 * Math.PI);
    const I = Qprop / Kt + i0();
    const Vpack = Math.max(0, Vnom - I * Rtot);
    const Veff = throttle * Vpack * dt.esc.efficiency;
    const nReq = (dt.motor.kv * (Veff - I * dt.motor.rm)) / 60;
    const step = 0.22 * (nReq - n);
    n += step;
    if (n < 0) n = 0;
    // converged: the fixed point is reached long before 300 iterations,
    // and the optimizer calls this tens of thousands of times.
    if (Math.abs(step) < 1e-5 * Math.max(1, n)) break;
  }

  const J = airspeed > 0 && n > 0 ? airspeed / (n * D) : 0;
  const Ct = Math.max(0, polyval(dt.prop.ct, J));
  const Cp = Math.max(0.002, polyval(dt.prop.cp, J));
  const thrustN = Math.max(0, Ct * rho * n * n * D4);
  const powerShaft = Math.max(0, Cp * rho * n * n * n * D5);
  const torque = n > 0 ? powerShaft / (2 * Math.PI * n) : 0;
  const I = torque / Kt + i0();
  const Vpack = Math.max(0, Vnom - I * Rtot);
  const powerElec = throttle * Vpack * I;
  const thrustG = thrustN * N_TO_GF;
  const useful = thrustN * airspeed;

  return {
    throttle, airspeed,
    rpm: n * 60, current: I, voltagePack: Vpack,
    powerElec, powerShaft, thrustN, thrustG, torque, J,
    etaMotor: powerElec > 1 ? powerShaft / powerElec : 0,
    etaProp: powerShaft > 1 ? useful / powerShaft : 0,
    etaTotal: powerElec > 1 ? useful / powerElec : 0,
    gPerW: powerElec > 1 ? thrustG / powerElec : 0,
    overCurrent: I > Math.min(dt.motor.iMax, dt.esc.iMax),
  };
}

// ---- sweeps ------------------------------------------------------
export interface Sweep { x: number[]; [k: string]: number[]; }

export function throttleSweep(dt: DriveTrain, airspeed = 0, steps = 41): Sweep {
  const x: number[] = [], thrust: number[] = [], current: number[] = [],
    rpm: number[] = [], powerElec: number[] = [], gPerW: number[] = [], etaTotal: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const thr = i / steps;
    const p = solvePoint(dt, Math.max(0.02, thr), airspeed);
    x.push(thr * 100);
    thrust.push(p.thrustG); current.push(p.current); rpm.push(p.rpm);
    powerElec.push(p.powerElec); gPerW.push(p.gPerW); etaTotal.push(p.etaTotal * 100);
  }
  return { x, thrust, current, rpm, powerElec, gPerW, etaTotal };
}

/** Velocity sweep at a fixed throttle (the XtraCalc-style view). */
export function velocitySweep(dt: DriveTrain, throttle = 1, vMax = 30, reserve = 0.2, steps = 36): Sweep {
  const cap = usableCapacityAh(dt.battery, reserve);
  const x: number[] = [], thrust: number[] = [], current: number[] = [], rpm: number[] = [],
    powerElec: number[] = [], powerShaft: number[] = [], etaProp: number[] = [], etaTotal: number[] = [],
    endurance: number[] = [], range: number[] = [], gPerW: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const V = (vMax * i) / steps;
    const p = solvePoint(dt, throttle, V);
    const endMin = p.current > 0.01 ? (cap / p.current) * 60 : 0;
    x.push(V);
    thrust.push(p.thrustG); current.push(p.current); rpm.push(p.rpm);
    powerElec.push(p.powerElec); powerShaft.push(p.powerShaft);
    etaProp.push(p.etaProp * 100); etaTotal.push(p.etaTotal * 100);
    gPerW.push(p.gPerW);
    endurance.push(endMin); range.push((endMin / 60) * V * 3.6);
  }
  return { x, thrust, current, rpm, powerElec, powerShaft, etaProp, etaTotal, gPerW, endurance, range };
}

// ---- endurance / range / mission points --------------------------
export function usableCapacityAh(b: BatterySpec, reserve = 0.2): number {
  return (b.capacityMah / 1000) * (1 - reserve);
}

export interface MissionPoint extends OperatingPoint {
  enduranceMin: number; rangeKm: number; cRateUsed: number;
}

export function missionPoint(dt: DriveTrain, throttle: number, airspeed: number, reserve = 0.2): MissionPoint {
  const p = solvePoint(dt, throttle, airspeed);
  const cap = usableCapacityAh(dt.battery, reserve);
  const enduranceMin = p.current > 0.01 ? (cap / p.current) * 60 : 0;
  const rangeKm = (enduranceMin / 60) * airspeed * 3.6;
  const cRateUsed = p.current / (dt.battery.capacityMah / 1000);
  return { ...p, enduranceMin, rangeKm, cRateUsed };
}

/** Best-range speed: maximises range over a velocity sweep at full throttle. */
export function bestRangeSpeed(dt: DriveTrain, vMax = 35, reserve = 0.2): { speed: number; rangeKm: number } {
  const s = velocitySweep(dt, 1, vMax, reserve, 70);
  let bi = 0;
  for (let i = 1; i < s.range.length; i++) if (s.range[i] > s.range[bi]) bi = i;
  return { speed: s.x[bi], rangeKm: s.range[bi] };
}

export function throttleForThrust(dt: DriveTrain, targetG: number, airspeed = 0): number {
  let lo = 0.02, hi = 1;
  if (solvePoint(dt, hi, airspeed).thrustG < targetG) return 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (solvePoint(dt, mid, airspeed).thrustG < targetG) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export const maxStaticThrust = (dt: DriveTrain) => solvePoint(dt, 1, 0);
