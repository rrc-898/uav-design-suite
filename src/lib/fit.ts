// ==================================================================
//  Polynomial curve fitting (least squares) for the equation modeler.
//
//  Fits y = a0 + a1·x + a2·x² + … + aN·xᴺ to sampled data.
//  The fit is done in a SCALED domain (xs = x / s, s = max|x|) so the
//  Vandermonde / normal-equation system stays well conditioned even for
//  high orders and large x (e.g. V up to 35 m/s). Coefficients are then
//  converted back to the REAL domain because xs = x/s is a pure scaling:
//      p(xs) = Σ bᵢ·xsⁱ  ⇒  in x:  aᵢ = bᵢ / sⁱ
//  so the returned polynomial evaluates directly on the physical x.
// ==================================================================

/** Evaluate ascending-order polynomial a0 + a1·x + a2·x² + … (Horner). */
export function polyval(coeffs: number[], x: number): number {
  let r = 0;
  for (let i = coeffs.length - 1; i >= 0; i--) r = r * x + coeffs[i];
  return r;
}

/** Solve A·x = b by Gaussian elimination with partial pivoting. */
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / d;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / (M[i][i] || 1e-12));
}

export interface FitResult {
  coeffs: number[]; // ascending, real-x domain
  r2: number;
  rmse: number;
  order: number;
}

/** Least-squares polynomial fit of given order. Returns real-domain coeffs. */
export function polyfit(x: number[], y: number[], order: number): FitResult {
  const n = x.length;
  const m = Math.min(order, Math.max(1, n - 1)) + 1; // coeff count
  const s = Math.max(1e-9, ...x.map((v) => Math.abs(v)));
  const xs = x.map((v) => v / s);

  // moments Σ xsᵏ up to 2·(m-1)
  const mom = new Array(2 * (m - 1) + 1).fill(0);
  for (const xi of xs) { let p = 1; for (let k = 0; k < mom.length; k++) { mom[k] += p; p *= xi; } }

  const A: number[][] = [];
  const rhs: number[] = [];
  for (let i = 0; i < m; i++) {
    A.push(Array.from({ length: m }, (_, j) => mom[i + j]));
    let bi = 0;
    for (let t = 0; t < n; t++) bi += y[t] * Math.pow(xs[t], i);
    rhs.push(bi);
  }

  const bScaled = solveLinear(A, rhs);
  const coeffs = bScaled.map((c, i) => c / Math.pow(s, i)); // back to real domain

  // goodness of fit
  const ybar = y.reduce((p, c) => p + c, 0) / n;
  let ssRes = 0, ssTot = 0;
  for (let t = 0; t < n; t++) {
    const f = polyval(coeffs, x[t]);
    ssRes += (y[t] - f) ** 2;
    ssTot += (y[t] - ybar) ** 2;
  }
  return { coeffs, r2: ssTot > 1e-12 ? 1 - ssRes / ssTot : 1, rmse: Math.sqrt(ssRes / n), order: m - 1 };
}

const SUP = ['', '', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸'];
function numStr(v: number): string {
  if (v === 0) return '0';
  if (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e6) return v.toExponential(3);
  return v.toPrecision(4).replace(/\.?0+$/, '');
}

/** Human-readable equation, e.g. "T(V) = 21.4 − 0.83·V + 0.0091·V²". */
export function formatPoly(coeffs: number[], xSym = 'V', ySym = 'y'): string {
  const terms: string[] = [];
  coeffs.forEach((c, i) => {
    if (c === 0 && i > 0) return;
    const mag = numStr(Math.abs(c));
    const pow = i === 0 ? '' : i === 1 ? `·${xSym}` : `·${xSym}${SUP[i] ?? '^' + i}`;
    if (terms.length === 0) terms.push(`${c < 0 ? '−' : ''}${mag}${pow}`);
    else terms.push(`${c < 0 ? '−' : '+'} ${mag}${pow}`);
  });
  return `${ySym}(${xSym}) = ${terms.join(' ') || '0'}`;
}
