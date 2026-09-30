// Tema de Plotly compartido por las páginas nuevas (sólo navegador):
// lee los design tokens de CSS para que las gráficas sigan al modo claro/oscuro.

export const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
export const rgb = (v: string) => `rgb(${css(v)})`;
export const rgba = (v: string, a: number) => `rgba(${css(v).split(/\s+/).join(',')}, ${a})`;

export function plotLayout(extra: Record<string, any> = {}) {
  const grid = rgba('--border', 0.6);
  const axis = { gridcolor: grid, zeroline: false, linecolor: grid };
  const { xaxis, yaxis, yaxis2, ...rest } = extra;
  return {
    paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: 'JetBrains Mono, monospace', size: 10, color: rgb('--muted') },
    margin: { l: 52, r: yaxis2 ? 52 : 16, t: 8, b: 38 },
    showlegend: true, legend: { orientation: 'h', y: 1.16, x: 0, font: { size: 9 } },
    xaxis: { ...axis, ...(xaxis || {}) },
    yaxis: { ...axis, ...(yaxis || {}) },
    ...(yaxis2 ? { yaxis2: { ...axis, overlaying: 'y', side: 'right', showgrid: false, ...yaxis2 } } : {}),
    ...rest,
  };
}

export const PLOT_CFG = {
  responsive: true, displaylogo: false,
  modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d'],
} as any;

/** Dibuja si Plotly ya está cargado (viene por CDN). */
export function plot(id: string, traces: any[], layout: Record<string, any> = {}) {
  const P = (window as any).Plotly;
  if (!P || !document.getElementById(id)) return;
  P.react(id, traces, plotLayout(layout), PLOT_CFG);
}

/** Línea vertical de referencia con etiqueta. */
export const vline = (x: number, color: string, dash = 'dot') => ({
  type: 'line', x0: x, x1: x, yref: 'paper', y0: 0, y1: 1, line: { color, width: 1, dash },
});
export const hline = (y: number, color: string, dash = 'dot') => ({
  type: 'line', y0: y, y1: y, xref: 'paper', x0: 0, x1: 1, line: { color, width: 1, dash },
});
