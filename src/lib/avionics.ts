// ==================================================================
//  Avionics / payload electronics catalog.
//
//  Two things matter for the mission simulator:
//     • massG  — steals directly from the useful payload budget
//     • powerW — a parasitic hotel load that drains the same pack the
//                motor uses, so it shortens endurance. At 14.8 V a
//                25 W avionics suite eats ~1.7 A: comparable to 15 %
//                of a small UAV's cruise current.
//
//  Each item declares a functional TAG. A mission requires a set of
//  tags; `selectAvionics()` picks the lightest / lowest-power /
//  cheapest item per tag, so the simulator can answer "qué electrónica
//  monta el prototipo" instead of assuming a fixed bay.
// ==================================================================

export type AvionicsTag =
  | 'autopilot'
  | 'gnss'
  | 'rtk'
  | 'rc-link'
  | 'rc-24ghz'
  | 'aux-battery'
  | 'rx-switch'
  | 'gyro'
  | 'telemetry'
  | 'video'
  | 'camera-rgb'
  | 'camera-thermal'
  | 'multispectral'
  | 'gimbal'
  | 'lidar-agl'
  | 'airspeed'
  | 'power-sensor'
  | 'servos'
  | 'bec'
  | 'release'
  | 'sprayer'
  | 'adsb'
  | 'lte'
  | 'parachute'
  | 'strobe';

export interface AvionicsItem {
  id: string;
  name: string;
  brand: string;
  tag: AvionicsTag;
  massG: number;
  powerW: number;      // mean draw in cruise
  priceUsd: number;
  note: string;
}

export const AVIONICS_TAG_LABEL: Record<AvionicsTag, string> = {
  autopilot: 'Autopiloto',
  gnss: 'GNSS',
  rtk: 'GNSS RTK',
  'rc-link': 'Enlace de mando (RC)',
  'rc-24ghz': 'Receptor RC 2.4 GHz',
  'aux-battery': 'Batería auxiliar RX/servos',
  'rx-switch': 'Interruptor de receptor',
  gyro: 'Giroestabilizador',
  telemetry: 'Telemetría',
  video: 'Enlace de vídeo',
  'camera-rgb': 'Cámara RGB',
  'camera-thermal': 'Cámara térmica',
  multispectral: 'Cámara multiespectral',
  gimbal: 'Gimbal estabilizado',
  'lidar-agl': 'Altímetro láser',
  airspeed: 'Tubo de Pitot',
  'power-sensor': 'Sensor de tensión/corriente',
  servos: 'Servos de mando',
  bec: 'BEC / distribución',
  release: 'Mecanismo de suelta',
  sprayer: 'Sistema de pulverización',
  adsb: 'ADS-B in/out',
  lte: 'Módem LTE / BVLOS',
  parachute: 'Paracaídas de recuperación',
  strobe: 'Luces anticolisión',
};

export const AVIONICS: AvionicsItem[] = [
  // --- flight control ---------------------------------------------
  { id: 'matek-h743', name: 'Matek H743-SLIM', brand: 'Matek', tag: 'autopilot', massG: 12, powerW: 1.8, priceUsd: 95, note: 'Autopiloto ArduPilot ligero, ideal cuando cada gramo cuenta.' },
  { id: 'pixhawk-6c-mini', name: 'Pixhawk 6C mini', brand: 'Holybro', tag: 'autopilot', massG: 34, powerW: 2.6, priceUsd: 220, note: 'IMU triple redundante; el estándar para UAVs profesionales.' },
  { id: 'cube-orange', name: 'Cube Orange+', brand: 'CubePilot', tag: 'autopilot', massG: 73, powerW: 3.4, priceUsd: 560, note: 'Grado industrial, IMUs con control térmico. Para BVLOS y operación certificable.' },

  // --- navigation -------------------------------------------------
  { id: 'm10-gps', name: 'M10 GPS + brújula', brand: 'Holybro', tag: 'gnss', massG: 16, powerW: 0.5, priceUsd: 45, note: 'GNSS multiconstelación básico, precisión ~1.5 m.' },
  { id: 'f9p-rtk', name: 'H-RTK F9P Helical', brand: 'Holybro', tag: 'rtk', massG: 52, powerW: 1.1, priceUsd: 480, note: 'RTK centimétrico: obligatorio en fotogrametría sin puntos de control.' },
  { id: 'pitot-dlvr', name: 'Pitot digital DLVR', brand: 'Holybro', tag: 'airspeed', massG: 12, powerW: 0.2, priceUsd: 60, note: 'Velocidad aerodinámica real: imprescindible con viento para volar a la V óptima.' },
  { id: 'lidar-tfmini', name: 'TFmini-S 12 m', brand: 'Benewake', tag: 'lidar-agl', massG: 6, powerW: 0.6, priceUsd: 45, note: 'Altura sobre el suelo para el enderezamiento en el aterrizaje.' },
  { id: 'power-mod', name: 'Power module 100 A', brand: 'Mauch', tag: 'power-sensor', massG: 28, powerW: 0.3, priceUsd: 75, note: 'Medida precisa de corriente: la puntuación de eficiencia depende de este sensor.' },

  // --- links ------------------------------------------------------
  { id: 'elrs-rx', name: 'ExpressLRS 915 RX', brand: 'RadioMaster', tag: 'rc-link', massG: 5, powerW: 0.4, priceUsd: 30, note: 'Enlace de mando de largo alcance y baja latencia.' },
  { id: 'rx-24-6ch', name: 'Receptor 2.4 GHz 6 canales', brand: 'FrSky', tag: 'rc-24ghz', massG: 8, powerW: 0.4, priceUsd: 28, note: 'Único enlace admitido en competiciones que limitan a 2.4 GHz homologado en la UE.' },
  { id: 'rx-24-elrs', name: 'ExpressLRS 2.4 GHz PWM 7 canales', brand: 'RadioMaster', tag: 'rc-24ghz', massG: 11, powerW: 0.5, priceUsd: 24, note: 'Receptor 2.4 GHz con salidas PWM directas: no necesita controladora.' },
  { id: 'aux-2s-650', name: 'LiPo 2S 650 mAh (auxiliar)', brand: 'Gens Ace', tag: 'aux-battery', massG: 42, powerW: 0, priceUsd: 12, note: 'Alimenta receptor y servos con independencia de la batería principal. 650 mAh cubren la ronda y las inspecciones.' },
  { id: 'aux-2s-1000', name: 'LiFe 2S 1000 mAh (auxiliar)', brand: 'Zippy', tag: 'aux-battery', massG: 68, powerW: 0, priceUsd: 14, note: 'LiFe 6.6 V: alimenta servos HV sin regulador y aguanta toda la jornada.' },
  { id: 'rx-switch', name: 'Interruptor de receptor', brand: 'Custom', tag: 'rx-switch', massG: 9, powerW: 0, priceUsd: 5, note: 'Corta la batería auxiliar desde el exterior sin desmontar nada.' },
  { id: 'gyro-3ax', name: 'Giroestabilizador 3 ejes', brand: 'Hobbyeagle', tag: 'gyro', massG: 10, powerW: 0.3, priceUsd: 35, note: 'Estabilización que ayuda al piloto sin automatizar el vuelo: no es GPS ni waypoints.' },
  { id: 'sik-915', name: 'SiK Telemetry 915 MHz 100 mW', brand: 'Holybro', tag: 'telemetry', massG: 22, powerW: 1.6, priceUsd: 55, note: 'Telemetría hasta ~5 km en línea de vista.' },
  { id: 'rfd900x', name: 'RFD900x 1 W', brand: 'RFDesign', tag: 'telemetry', massG: 46, powerW: 5.5, priceUsd: 340, note: 'Telemetría de largo alcance (>40 km). Consumo alto: sólo si la misión lo exige.' },
  { id: 'vtx-analog', name: 'VTX analógico 600 mW', brand: 'Rush', tag: 'video', massG: 18, powerW: 7.0, priceUsd: 35, note: 'Vídeo FPV analógico, latencia mínima para pilotaje manual.' },
  { id: 'vtx-digital', name: 'Walksnail Avatar HD', brand: 'Caddx', tag: 'video', massG: 32, powerW: 9.0, priceUsd: 160, note: 'Vídeo digital HD: mucho mejor para identificar objetivos.' },
  { id: 'lte-modem', name: 'Módem LTE Cat-4', brand: 'Sixfab', tag: 'lte', massG: 42, powerW: 4.2, priceUsd: 130, note: 'Enlace BVLOS sin límite de alcance donde haya cobertura.' },
  { id: 'adsb-in', name: 'ADS-B In μAvionix', brand: 'uAvionix', tag: 'adsb', massG: 20, powerW: 1.0, priceUsd: 220, note: 'Detección de tráfico tripulado: requisito operacional en espacio aéreo compartido.' },

  // --- sensors / payload ------------------------------------------
  { id: 'cam-rgb-light', name: 'Cámara RGB 12 MP', brand: 'Runcam', tag: 'camera-rgb', massG: 38, powerW: 2.2, priceUsd: 120, note: 'Sensor ligero para inspección y mapeo de baja exigencia.' },
  { id: 'cam-a7', name: 'Sony α6000 24 MP', brand: 'Sony', tag: 'camera-rgb', massG: 344, powerW: 4.5, priceUsd: 650, note: 'Cámara de fotogrametría de calidad topográfica. Pesa como media batería.' },
  { id: 'cam-thermal-boson', name: 'FLIR Boson 640', brand: 'Teledyne FLIR', tag: 'camera-thermal', massG: 27, powerW: 1.2, priceUsd: 3200, note: 'Térmica 640×512: detección de personas en SAR de noche.' },
  { id: 'cam-multispec', name: 'MicaSense RedEdge-P', brand: 'AgEagle', tag: 'multispectral', massG: 232, powerW: 8.0, priceUsd: 8500, note: 'Cinco bandas + panchromática para índices NDVI en agricultura.' },
  { id: 'gimbal-2ax', name: 'Gimbal 2 ejes ligero', brand: 'Gremsy', tag: 'gimbal', massG: 165, powerW: 5.5, priceUsd: 590, note: 'Estabiliza la línea de visión: sin él, la imagen es inservible con turbulencia.' },
  { id: 'gimbal-3ax', name: 'Gimbal 3 ejes T3V3', brand: 'Gremsy', tag: 'gimbal', massG: 460, powerW: 9.0, priceUsd: 2400, note: 'Apuntamiento activo de grado profesional para ISR persistente.' },

  // --- actuation / mechanisms --------------------------------------
  { id: 'servos-9g', name: '4 × servo 9 g digital', brand: 'Emax', tag: 'servos', massG: 48, powerW: 3.0, priceUsd: 40, note: 'Mando suficiente hasta ~2 kg de MTOW.' },
  { id: 'servos-mg', name: '5 × servo MG 20 g', brand: 'Savox', tag: 'servos', massG: 115, powerW: 6.5, priceUsd: 110, note: 'Par y precisión para aviones de carga o con viento fuerte.' },
  { id: 'bec-5a', name: 'BEC 5 A 5/6 V', brand: 'Castle', tag: 'bec', massG: 21, powerW: 1.2, priceUsd: 30, note: 'Alimentación estable de la aviónica, aislada del ruido del ESC.' },
  { id: 'release-servo', name: 'Mecanismo de suelta servo', brand: 'Custom', tag: 'release', massG: 35, powerW: 0.5, priceUsd: 25, note: 'Suelta de carga en vuelo sin aterrizar.' },
  { id: 'sprayer-2l', name: 'Bomba + boquillas 2 L', brand: 'Custom', tag: 'sprayer', massG: 380, powerW: 22.0, priceUsd: 260, note: 'Pulverización agrícola. La bomba es el mayor consumidor no propulsivo.' },
  { id: 'parachute-1kg', name: 'Paracaídas balístico 2 kg', brand: 'Skycat', tag: 'parachute', massG: 190, powerW: 0.2, priceUsd: 380, note: 'Recuperación segura sobre zona poblada; suele ser requisito legal.' },
  { id: 'strobe-led', name: 'Luces anticolisión LED', brand: 'uAvionix', tag: 'strobe', massG: 14, powerW: 1.5, priceUsd: 60, note: 'Visibilidad y cumplimiento normativo en operaciones diurnas/nocturnas.' },
];

export const avionicsById = (id: string) => AVIONICS.find((a) => a.id === id);

export interface AvionicsSuite {
  items: AvionicsItem[];
  massG: number;
  powerW: number;
  priceUsd: number;
}

export type AvionicsPreference = 'masa' | 'potencia' | 'precio' | 'capacidad';

/**
 * Pick one item per required tag.
 *  • 'masa'      → el más ligero  (maximiza carga útil / autonomía)
 *  • 'potencia'  → el que menos consume (maximiza autonomía)
 *  • 'precio'    → el más barato
 *  • 'capacidad' → el de mayores prestaciones (el más caro del tag)
 */
export function selectAvionics(
  tags: AvionicsTag[],
  preference: AvionicsPreference = 'masa',
): AvionicsSuite {
  const items: AvionicsItem[] = [];
  for (const tag of Array.from(new Set(tags))) {
    const candidates = AVIONICS.filter((a) => a.tag === tag);
    if (!candidates.length) continue;
    const cost = (a: AvionicsItem) =>
      preference === 'masa' ? a.massG
      : preference === 'potencia' ? a.powerW
      : preference === 'precio' ? a.priceUsd
      : -a.priceUsd;
    items.push(candidates.reduce((best, a) => (cost(a) < cost(best) ? a : best)));
  }
  return {
    items,
    massG: items.reduce((s, a) => s + a.massG, 0),
    powerW: items.reduce((s, a) => s + a.powerW, 0),
    priceUsd: items.reduce((s, a) => s + a.priceUsd, 0),
  };
}

/** Base suite every fixed-wing UAV needs regardless of the mission. */
export const CORE_AVIONICS: AvionicsTag[] = [
  'autopilot', 'gnss', 'rc-link', 'telemetry', 'servos', 'bec', 'power-sensor',
];
