# UAV Design Suite

**Engineering platform to design, simulate and optimise fixed-wing UAVs.** Propulsion, mission and
aerodynamics modules in one web app, plus a complete design package for the Xtra Challenge 2027 competition.

![Astro](https://img.shields.io/badge/Astro-framework-FF5D01?logo=astro&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)

---

Plataforma de ingeniería para el **diseño, simulación y optimización de UAVs**.
Construida en **Astro + TypeScript + TailwindCSS**, con modo claro/oscuro y una
estética profesional inspirada en Linear / Vercel / Stripe.

> Estado: iteración 2. **Propulsion Designer**, **Mission Simulator** y **CFD Studio**
> operativos con física real, más el paquete completo para la **XtraChallenge 2027**
> (reglamento XC_27 v1.00; el PDF oficial `XC_27_RT_V1.00.pdf` no se incluye en el repo).

---

## Arranque

```bash
git clone https://github.com/rrc-898/uav-design-suite && cd uav-design-suite
npm install
npm run dev        # http://localhost:4321
```

Build de producción:

```bash
npm run build      # genera dist/
npm run preview
```

Requisitos: Node.js ≥ 18.

---

## Módulos

| Ruta | Módulo | Estado |
|------|--------|--------|
| `/` | **Dashboard** — proyectos, KPIs, accesos rápidos | ✅ |
| `/xc27` | **XtraChallenge 2027** — reglamento, calculadora de ronda, estáticas, conformidad, presupuesto y calendario | ✅ Operativo |
| `/xc27-avion` | **Estudio de avión XC27** — ronda simulada, carga, empuje, V-n, flexión, centrado, caja y planos | ✅ Operativo |
| `/propulsion` | **Propulsion Designer** — motor + hélice + batería + ESC → curvas y autonomía | ✅ Operativo |
| `/competition` | **Mission Simulator** — misión → mejor planta motriz, perfil alar y aviónica | ✅ Operativo |
| `/database` | **Component DB** — catálogo navegable de componentes | ✅ |
| `/cfd` | **CFD Studio** — Lifting-Line + drag buildup + lazo de propulsión | ✅ Operativo |
| `/team` | **Team Hub** — Kanban, Gantt, wiki, pizarras | 🗺️ Roadmap |
| `/copilot` | **AI Copilot** — asistente de ingeniería | 🗺️ Roadmap |

---

## XtraChallenge 2027

Todo sale del reglamento técnico XC_27 v1.00 (V edición, València, 6–9 de julio de 2027).
La ronda 2027 es **un solo vuelo con dos mitades y un pitstop**:

```
despegue 1 → ascenso 60 s → planeo (motor parado) → aterrizaje
→ pitstop (descarga del arroz, 120 s) → despegue 2 → 10 pilones de 100 m → aterrizaje

P_equipo = (P_AS · P_CA · P_VE + P_PI) · B_pred · B_desp · B_carga · S_piloto · L_vuelo
P_ronda  = 750 · P_equipo / P_max          (media de las 4 rondas; + 250 de estáticas)
```

| Parcial | Fórmula | Fuente |
|---|---|---|
| `P_AS` altitud a 60 s | polinomio de 4º grado, máximo 100 a ~81 m, 80 a 120 m | §9.5.1 |
| `P_VE` planeo | `D_R^√2 / 155²` (1 con 1252 m) | §9.5.2 |
| `P_PI` pilones | `40² / T_PI²` | §9.5.3 |
| `P_CA` carga | `MPL / 300` con la carga declarada, en kg | §9.5.4 |
| `B_pred` | 1 si transportada/declarada ≥ 0.9; 0.8 · 0.6 · 0.1 por debajo | §9.2 |
| `B_desp` | 20 m ×1.25 · 40 m ×1.125 · 60 m ×1 | §9.2 |
| `B_carga` | ×1.25 hasta 35 s; luego `1 + 0.25·(1.1 − T_CD/(120·√M_PL))` | §9.2 |

**Qué hay:**

- `src/lib/xc27.ts` — reglas puras: límites técnicos, parciales y bonificaciones, estáticas
  (10 + 125 + 60 + 55), penalizaciones de §9.7, calendario, lista de inspección técnica,
  caja de transporte mínima y los puntos ambiguos del texto.
- `src/lib/xc27-flight.ts` — la ronda simulada sobre la física de `design.ts`: carrera en
  asfalto y marca declarable, ascenso a potencia sostenible (limitada por motor/ESC),
  planeo con la resistencia de la hélice parada o plegada, pilones **sin la carga** por
  balance de energía recta + viraje, y consumo de la ronda con una sola batería.
- `src/lib/xc27-study.ts` — estudio de un avión concreto: barrido de carga, predicción de
  carga frente a la densidad (ecuación obligatoria del informe), modelo `T(V, δ)`,
  diagrama V-n, flexión del ala y ensayo de puntas, punto neutro y margen estático con
  y sin arroz, bahía y caja.
- **Mission Simulator**: misión «XtraChallenge 2027» con el motor Emax GT2820/06 985KV
  bloqueado, LiPo ≤ 3S, ESC ≥ 40 A, 150 g de caja de telemetría, batería auxiliar y la caja
  de 1300 mm como restricción dura. La carga es variable de decisión y el fuselaje crece
  con ella. «Estudiar avión →» pasa el ganador a `/xc27-avion`. `/competition#run` lanza
  la optimización al cargar.

**Supuestos que conviene conocer** (todos editables en «Estrategia de ronda»):

- `P_CA` en kg, como dice el texto. Con gramos los pilones no pesarían nada; hay un selector.
- El motor se corta a los 60 s. La casilla «seguir subiendo» modela la lectura alternativa.
- Techo operativo 115 m, reencendido a 15 m, eficacia de ascenso y de planeo 0.9, margen de
  despegue ×1.15, virajes a 3.5 g, `P_max = 3` como marca de referencia de la ronda.
- Densidad de día caluroso en Casinos (~310 m, 31 °C → ρ ≈ 1.12 kg/m³).
- **Motor**: masa (140 g) y corriente máxima (57 A) de catálogo; `Rm` e `I0` son estimados.
  Un ensayo en banco y dos números en `src/data/motors.json` lo calibran.
- La caja mínima y las masas estructurales son estimaciones de anteproyecto; en el estudio de
  avión se puede introducir la masa en vacío pesada.

---

## Propulsion Designer — modelo físico

Análisis estacionario 0-D del tren propulsivo eléctrico (`src/lib/propulsion.ts`):

- **Motor (modelo Kv):** `ω = Kv·(V − I·Rm)`, `Q = Kt·(I − I₀)`, `Kt = 9.5493/Kv`.
- **Hélice (coeficientes adimensionales):** `T = Ct(J)·ρ·n²·D⁴`, `P = Cp(J)·ρ·n³·D⁵`,
  con `J = V/(n·D)`. `Ct`, `Cp` son un modelo paramétrico tipo APC en función de
  paso/diámetro y nº de palas.
- **Batería:** caída de tensión bajo carga `V = V_nom − I·R_int`, descarga C-rating,
  autonomía y alcance con reserva configurable.
- **Punto de operación:** se resuelve el par `(n, I)` donde la tensión que necesita el
  motor para mover la hélice cargada iguala la que entrega la batería (iteración amortiguada).

**Validación:** calibrado contra el **Emax GT2826 1090KV** (motor obligatorio del
XtraChallenge 2026). Config 10×5 @ 4S → ~48 A, ~12.2 krpm, ~2.3 kg, ~3.7 g/W, en línea
con el límite real del motor (47 A). El modelo detecta sobrecorriente, sobrepotencia y
descarga excesiva de batería.

El panel **"Modelar ecuación → Aerodinámica"** ajusta un polinomio (orden 1–6) a cualquier
curva vs velocidad (empuje, potencia, corriente, η) mediante mínimos cuadrados (`src/lib/fit.ts`)
y la exporta como JSON `uav-suite/propulsion-equation@1` que consume CFD Studio.

---

## CFD Studio — aerodinámica y prestaciones

Analizador aero & performance (`src/lib/aero.ts`), enfoque XFLR5/AVL:

- **Sustentación e inducida:** línea sustentadora de Prandtl (solución de Glauert por serie
  de Fourier de la ecuación monoplano) → `CL`, `CLα`, distribución de sustentación,
  eficiencia de envergadura `e` y `CDi = CL²/(π·AR·e)`.
- **Drag parásito:** suma por componentes (Raymer/McCormick) `CD0 = Σ Cf·FF·Q·Swet/Sref`
  con `Cf = 0.455/log₁₀(Re)^2.58` (ala, fuselaje, empenaje, interferencia).
- **Polar:** `CD = CD0 + CL²/(π·AR·e)`; L/D vs α; geometría paramétrica con planform en SVG.
- **Lazo de propulsión:** importa la ecuación `T(V)` del Propulsion Designer y cruza
  `T_req(V) = ½ρV²S·CD` con `T_disp(V)` → **velocidad de equilibrio (crucero/V máx)**,
  velocidad de pérdida, mejor L/D y régimen de ascenso (ROC).

**Validación:** ala rectangular AR=6 → `CLα ≈ 4.5/rad`, `e ≈ 0.95`; ala con taper 0.6 AR≈7.7 →
`e ≈ 0.98`; distribución de sustentación que tiende a la elíptica. Resultados coherentes con
la teoría clásica de ala finita. Régimen estacionario, incompresible, bajo Re (UAVs). Para
flecha alta, alas múltiples o estabilidad → migrar a VLM (v2).

**Referencias:** Anderson *Fundamentals of Aerodynamics*; Drela *Flight Vehicle Aerodynamics*;
Katz & Plotkin *Low-Speed Aerodynamics*; McCormick; Raymer. Simuladores de referencia:
XFOIL, XFLR5, AVL, OpenVSP/VSPAERO, AeroSandbox.

> Los coeficientes de hélice son un modelo paramétrico. Para máxima precisión, calibra
> `Ct₀ / Cp₀` en `propCoeffsBase()` con datos del fabricante (p. ej. tablas APC).

---

## Mission Simulator — simulador de puntuaciones multimisión

El módulo **no es una calculadora de puntos**: es un optimizador. Se le describe la
misión y responde **qué avión construir** — planta motriz, perfil alar, forma en planta
y electrónica embarcada — con la física de los otros dos módulos cerrando el lazo.

### 1. Cómo se describe una misión

Tres bloques independientes (`src/lib/mission.ts`), de modo que una misión nueva del
sector se añade sin tocar la física:

- **Variables** (`MissionVariables`): carga útil (fija o como variable de decisión),
  distancia, loiter, altitud y elevación, viento, pista disponible, reserva de batería,
  límites de envergadura / MTOW / celdas / ESC, ancho de pasada, packs en paralelo,
  factor de construcción y motor obligatorio.
- **Objetivos** (`Objective[]`): cada uno normaliza una métrica física entre un valor
  «suspenso» y otro «excelente» y aporta su peso al total de 1000 puntos. Cambiando los
  pesos cambia la familia de avión, no sólo el componente.
- **Restricciones** (`Constraint[]`): duras (descalifican) o blandas (penalizan).

Hay **13 tipos de misión** predefinidos: XtraChallenge 2027, XtraChallenge 2026 eficiente y urgente, Air Cargo
Challenge, ISR persistente, cartografía/fotogrametría, entrega de última milla, SAR,
agricultura de precisión, inspección de infraestructuras, repetidor de comunicaciones,
velocidad punta y personalizada.

Para las misiones de reglamento, las métricas simuladas se inyectan en la **fórmula
oficial XC_26 v1.12** (§9.9.1 y §9.9.2), así que la puntuación de competición sale de la
física del prototipo y no de números introducidos a mano:

```
P_ronda = ((P_peso + P_dist + P_corr)·L + B_carga) · B_despegue · S_piloto · S_repuestos
```

Los parciales se topan en su máximo: al normalizarse contra la mejor marca de la ronda,
superar la referencia sólo significa pasar a ser la referencia.

### 2. Cómo se evalúa un diseño

`src/lib/design.ts` acopla las tres disciplinas para cada candidato:

1. **Masas** — buildup por densidades superficiales (ala, fuselaje/cola, tren, batería,
   propulsión, aviónica, carga) escalado por el factor de construcción.
2. **Aerodinámica** — línea sustentadora de Prandtl cacheada por forma en planta
   (`CLα`, `e`, pico de `cl` local para la pérdida) + **polar de sección real del perfil**
   corregida por Reynolds + drag parásito por componentes de todo lo que no es el ala.
3. **Trimado** — para cada velocidad: `L = W ⇒ CL ⇒ D`, y se busca el gas que da `T = D`
   interpolando el **mapa de empuje/corriente** del tren propulsivo.
4. **Consumo** — corriente del motor **más la carga hotel de la aviónica** sobre el mismo
   pack ⇒ autonomía, alcance y Wh/km.
5. **Prestaciones** — pérdida, velocidad máxima, ascenso y carrera de despegue.

Ni la velocidad de crucero ni la carga útil se imponen: se elige el punto que **más puntúa
en la misión**, que es lo que haría un piloto optimizando su vuelo.

### 3. Cómo se busca

`src/lib/optimizer.ts` cruza células paramétricas (envergadura × alargamiento ×
estrechamiento × los 14 perfiles del catálogo) con cada tren propulsivo viable
(motor × hélice × pack × ESC), del orden de **10⁴–10⁵ combinaciones en 1–4 s** en el
navegador. Las claves:

- La aerodinámica depende **sólo** de la célula → un modelo por ala.
- El empuje y la corriente dependen **sólo** del tren → un mapa por tren.
- La solución de la línea sustentadora depende sólo de la **forma** → caché global.
- **Criba previa** por corriente y empuje/peso; de cada grupo sobreviven las mejores
  hélices en *cada* criterio (eficiencia, empuje estático y empuje a alta velocidad),
  porque una hélice de paso corto y otra de paso largo ganan misiones distintas.
- Los packs se muestrean uniformemente en energía en vez de «por calidad», que sesgaba
  la búsqueda y escondía óptimos.

La salida incluye la ficha del prototipo, el desglose de puntuación, las restricciones
cumplidas e incumplidas, la justificación en lenguaje de ingeniero, un análisis de
**sensibilidad** (variables de misión y cambios de componente sobre el ganador), hasta 12
alternativas diversas y la nube completa de diseños. Exporta a JSON y CSV.

**Baterías**: `Pack` permite agrupar celdas en serie (más tensión ⇒ más rpm con la misma
corriente) y en paralelo (más energía y menos caída de tensión, a costa de masa), que son
decisiones de diseño reales y cambian el avión ganador.

**Aviónica** (`src/lib/avionics.ts`): 27 equipos con masa, consumo y coste. La misión
declara qué funciones necesita (autopiloto, RTK, térmica, gimbal, suelta, ADS-B…) y el
simulador escoge el equipo por masa, consumo, precio o prestaciones. Su consumo drena el
mismo pack que el motor, así que acorta la autonomía de verdad.

**Perfiles** (`src/lib/airfoils.ts`): 14 secciones desde el S1223 de alta sustentación
hasta el AG35 de mínima resistencia y el MH60 reflex para alas volantes, con `cl_max`,
`cd_min`, «drag bucket», `α₀`, `Cm₀` y comportamiento en pérdida. El ala volante se
modela con su precio real: torsión fuerte para estabilidad, penalización de trimado,
derivas y elevones.

---

## Estructura

```
uav-design-suite/
├── astro.config.mjs
├── tailwind.config.mjs
├── tsconfig.json
├── src/
│   ├── layouts/AppShell.astro        # sidebar + topbar + tema
│   ├── components/                   # Sidebar, StatCard
│   ├── lib/
│   │   ├── propulsion.ts             # tren propulsivo 0-D (núcleo)
│   │   ├── aero.ts                   # línea sustentadora + drag buildup
│   │   ├── airfoils.ts               # catálogo de perfiles + polar de sección
│   │   ├── avionics.ts               # catálogo de electrónica embarcada
│   │   ├── mission.ts                # tipos de misión, variables, objetivos
│   │   ├── design.ts                 # evaluador acoplado aero × propulsión × aviónica
│   │   ├── optimizer.ts              # búsqueda en el espacio de diseño
│   │   ├── scoring.ts                # reglamento XtraChallenge 2026 + puente a la simulación
│   │   ├── xc27.ts                   # reglamento XtraChallenge 2027 (reglas puras)
│   │   ├── xc27-flight.ts            # ronda 2027: ascenso, planeo, pilones, batería
│   │   ├── xc27-study.ts             # estudio de un avión: carga, V-n, flexión, centrado, caja
│   │   ├── plot.ts                   # tema de Plotly compartido
│   │   ├── catalog.ts                # base de datos de componentes
│   │   ├── fit.ts                    # ajuste polinómico
│   │   └── format.ts                 # utilidades
│   ├── pages/                        # una página por módulo
│   └── styles/global.css             # design tokens (claro/oscuro)
└── public/favicon.svg
```

---

## Stack y decisiones

- **Astro 4** (islas, cero JS por defecto) + **TypeScript** estricto.
- **TailwindCSS 3** con tokens de color por CSS variables (theming claro/oscuro robusto).
- **Plotly** (CDN) para gráficas interactivas con zoom y exportación a PNG.
- Componentes shadcn/UI emulados con Tailwind para mantener el bundle ligero; pueden
  migrarse a islas React/shadcn reales cuando se necesite estado complejo compartido.

## Validación del Mission Simulator

- **Aerodinámica**: ala rectangular AR=6 → `CLα ≈ 4.39/rad` (teoría ≈ 4.5), `e ≈ 0.95`;
  AR=8 con taper 0.6 y washout −2° → `e ≈ 0.98`. Pico de `cl` local 1.14·CL, coherente
  con la distribución de una planta rectangular.
- **Perfiles**: Clark Y a `cl` 0.5 → `cd` 0.0108 a Re 300k y 0.0159 a Re 100k;
  `cl_max` cae a 1.11 a Re 150k. En línea con las polares UIUC de bajo Reynolds.
- **Convergencia de la búsqueda**: el mismo caso en «exhaustivo» (152 000 combinaciones,
  4.4 s) mejora sólo un 0.4 % sobre «estándar» (16 000 combinaciones, 0.8 s), y la
  sensibilidad residual por cambio de componente cae a ruido — señal de que la criba no
  esconde el óptimo.
- **Coherencia**: `L/D` de crucero nunca supera `(L/D)máx`, y cada misión converge a la
  familia de avión que le corresponde: S1223 y superficie grande para carga máxima,
  AR alto y baja carga alar para vigilancia, ala pequeña y perfil fino para velocidad.

Limitaciones conocidas: régimen estacionario e incompresible; sin estabilidad ni control
(no se dimensionan cola ni márgenes estáticos); masas estructurales empíricas — calíbralas
con tu propio histórico de construcción mediante el factor de construcción; el catálogo de
baterías llega a 4S y 15 Ah, y por encima de ahí el simulador agrupa packs.

---

## Próximos pasos sugeridos

1. CFD Studio: visor Three.js + solver VLM (AVL-like) en WASM → curva de drag.
2. Dimensionado de cola y margen estático dentro del optimizador (hoy no se comprueba
   la estabilidad longitudinal del ganador).
3. Enviar la célula ganadora del Mission Simulator directamente a CFD Studio y su tren
   propulsivo al Propulsion Designer (el JSON exportado ya lleva todo lo necesario).
4. Persistencia de proyectos (SQLite/Postgres) y autenticación.
5. Calibrar el catálogo de hélices con datos APC reales y ampliar baterías Li-Ion.
