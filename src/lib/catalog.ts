// ------------------------------------------------------------------
// UAV component catalog.
// Motors, propellers and batteries imported from the XtraCalc
// (XtraChallenge v2026.03) catalog — real Rm/I0/inertia for motors,
// polynomial Ct(J)/Cp(J) UIUC fits for propellers, and measured
// internal resistance / OCV for batteries.
// ESCs are a small curated list (XtraCalc has no ESC catalog).
// ------------------------------------------------------------------
import motorsData from '../data/motors.json';
import propsData from '../data/props.json';
import batteriesData from '../data/batteries.json';

export interface Motor {
  id: string;
  name: string;
  brand: string;
  kv: number;       // rpm / V
  rm: number;       // winding resistance, ohm
  i0Ref: number;    // no-load current at vRef, A
  vRef: number;     // reference voltage for i0Ref, V
  inertia: number;  // rotor inertia, kg·m^2
  massG: number;
  iMax: number;     // max continuous current, A
  note?: string;
}

export interface Propeller {
  id: string;
  name: string;
  brand: string;
  family: string;
  dia: number;      // in
  pitch: number;    // in
  ct: number[];     // Ct(J) polynomial, ascending a0..aN
  cp: number[];     // Cp(J) polynomial, ascending a0..aN
  folding: boolean;
}

export interface Battery {
  id: string;
  name: string;
  brand: string;
  series: string;
  chemistry: 'LiPo' | 'Li-Ion';
  cells: number;        // series count (S)
  vcell: number;        // nominal V per cell
  capacityMah: number;
  cRating: number;      // continuous; 0 = unspecified
  rintCell: number;     // internal resistance per cell, ohm
  massG: number;
  connector: string;
  ocv: number[] | null; // open-circuit voltage polynomial vs SoC (per cell)
}

export interface Esc {
  id: string;
  name: string;
  brand: string;
  iMax: number;        // continuous, A
  efficiency: number;  // 0..1
  resistance: number;  // ohm
  massG: number;
  price?: number;
}

export const MOTORS: Motor[] = motorsData as Motor[];
export const PROPS: Propeller[] = propsData as Propeller[];
export const BATTERIES: Battery[] = batteriesData as Battery[];

export const ESCS: Esc[] = [
  { id: 'apd-50f3', name: 'F-Series 50A', brand: 'APD', iMax: 50, efficiency: 0.97, resistance: 0.010, massG: 28, price: 55 },
  { id: 'hobbywing-60', name: 'Platinum 60A', brand: 'Hobbywing', iMax: 60, efficiency: 0.96, resistance: 0.009, massG: 63, price: 42 },
  { id: 'tmotor-60a', name: 'FLAME 60A', brand: 'T-Motor', iMax: 60, efficiency: 0.97, resistance: 0.009, massG: 73, price: 70 },
  { id: 'hobbywing-skywalker-40', name: 'Skywalker 40A V2', brand: 'Hobbywing', iMax: 40, efficiency: 0.95, resistance: 0.012, massG: 39, price: 22 },
  { id: 'hobbywing-skywalker-60', name: 'Skywalker 60A V2', brand: 'Hobbywing', iMax: 60, efficiency: 0.95, resistance: 0.010, massG: 63, price: 32 },
  { id: 'castle-talon-35', name: 'Talon 35A', brand: 'Castle', iMax: 35, efficiency: 0.96, resistance: 0.012, massG: 35, price: 60 },
];

// Default selection: the XtraChallenge 2026 mandatory motor + a competition-legal setup.
export const DEFAULTS = {
  motor: 'emax-gt2826-1090kv',
  prop: 'aeronaut-cam-carbon-10x5-folding',
  battery: MOTORS.length ? (BATTERIES.find((b) => b.cells === 4)?.id ?? BATTERIES[0]?.id) : '',
  esc: 'apd-50f3',
};

export const byId = <T extends { id: string }>(list: T[], id: string): T =>
  list.find((x) => x.id === id) ?? list[0];
