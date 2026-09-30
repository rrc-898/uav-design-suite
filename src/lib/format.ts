// Number / unit formatting helpers (engineering display).

export function fmt(value: number, digits = 1): string {
  if (!isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmt0(value: number): string {
  return fmt(value, 0);
}

/** Adaptive precision for a value of unknown magnitude. */
export function smart(value: number): string {
  if (!isFinite(value)) return '—';
  const a = Math.abs(value);
  if (a === 0) return '0';
  if (a >= 1000) return fmt(value, 0);
  if (a >= 100) return fmt(value, 1);
  if (a >= 1) return fmt(value, 2);
  return fmt(value, 3);
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
