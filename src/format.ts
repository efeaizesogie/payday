import { LUNA } from './chain'

const nf = (min: number, max: number) => new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max })

/** NIM amount from luna, with sensible precision for the size. */
export function nim(luna: number, opts: { exact?: boolean } = {}): string {
  const v = luna / LUNA
  if (opts.exact) return nf(0, 5).format(v)
  const a = Math.abs(v)
  if (a === 0) return '0'
  if (a < 1) return nf(2, 4).format(v)
  if (a < 100) return nf(0, 2).format(v)
  return nf(0, 0).format(v)
}

export function fiat(luna: number, price: number | undefined, currency: string): string {
  if (price === undefined) return ''
  const v = (luna / LUNA) * price
  const digits = v !== 0 && Math.abs(v) < 0.01 ? 4 : v < 1000 ? 2 : 0
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v)
  }
  catch { return `${nf(digits, digits).format(v)} ${currency.toUpperCase()}` }
}

export const pct = (r: number, d = 1) => `${(r * 100).toFixed(d)}%`

export function duration(ms: number): string {
  if (ms <= 0) return 'now'
  const m = Math.ceil(ms / 60_000)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h ${m % 60} min`
  return `${Math.round(h / 24)} days`
}

export const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c]!)

/** Parse a user-typed NIM amount ("1,250.5") into luna, or NaN. */
export function parseNim(s: string): number {
  const t = s.replace(/[,\s]/g, '')
  if (!/^\d*\.?\d{0,5}$/.test(t) || t === '' || t === '.') return NaN
  return Math.round(parseFloat(t) * LUNA)
}
