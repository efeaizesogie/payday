// Logic for Payday's standout features. No server: everything is chain data, the device, or a link.
import { type Net, type NetStats, getTransactions, getBalance, supplyAt, sameAddress, cleanAddress, formatAddress } from './chain'
import { b64urlEncode, b64urlDecode } from './crypto'

const LUNA = 100_000
const POS_START = Date.parse('2024-11-19T16:45:20Z') // staking exists from Nimiq's proof-of-stake launch

// ── 1. Time machine: what your idle NIM could have earned ────────────────────
export interface Missed { since: number, missedNim: number, idleNim: number, avgIdleNim: number }

/**
 * Rebuilds your unstaked balance over time from your own transactions (walking back from today's
 * balance), then adds up what that NIM would have earned at the network rate of each moment.
 * Conservative on purpose: simple interest, no compounding, NIM before proof-of-stake ignored,
 * and any gap in the history can only make the number smaller.
 */
export async function missedEarnings(net: Net, accounts: string[], stats: NetStats, fee: number): Promise<Missed | null> {
  const unique = [...new Map(accounts.map(a => [cleanAddress(a), a])).values()]
  const [lists, balances] = await Promise.all([
    Promise.all(unique.map(a => getTransactions(net, a, 500))),
    Promise.all(unique.map(a => getBalance(net, a))),
  ])
  const events: { t: number, delta: number }[] = []
  const seen = new Set<string>()
  lists.forEach((list) => {
    for (const tx of list) {
      if (!tx.executionResult || seen.has(tx.hash)) continue
      seen.add(tx.hash)
      let delta = 0
      if (unique.some(a => sameAddress(tx.from, a))) delta -= tx.value + tx.fee
      if (unique.some(a => sameAddress(tx.to, a))) delta += tx.value
      if (delta) events.push({ t: tx.timestamp, delta })
    }
  })
  if (!events.length) return null
  events.sort((a, b) => b.t - a.t)
  let bal = balances.reduce((s, b) => s + b, 0)
  const now = Date.now()
  let t1 = now
  let missed = 0
  let weighted = 0
  for (const e of [...events, { t: 0, delta: 0 }]) {
    const t0 = Math.max(e.t, POS_START)
    if (t0 < t1 && bal > 0) {
      const s0 = supplyAt(net, t0)
      const perNim = (supplyAt(net, t1) - s0) / (stats.stakedRatio * s0)
      missed += (bal / LUNA) * perNim * (1 - fee)
      weighted += (bal / LUNA) * (t1 - t0)
    }
    t1 = Math.min(t1, t0)
    if (e.t <= POS_START) break
    bal = Math.max(0, bal - e.delta)
  }
  const since = Math.max(POS_START, events[events.length - 1].t)
  const span = now - since
  return { since, missedNim: missed, idleNim: balances.reduce((s, b) => s + b, 0) / LUNA, avgIdleNim: span > 0 ? weighted / span : 0 }
}

/** Demo: 25,000 NIM sitting idle since mid-March 2025, through the same formula. */
export function demoMissed(net: Net, stats: NetStats, fee: number): Missed {
  const since = Date.parse('2025-03-14T09:00:00Z'), now = Date.now()
  const perNim = (supplyAt(net, now) - supplyAt(net, since)) / (stats.stakedRatio * supplyAt(net, since))
  return { since, missedNim: 25_000 * perNim * (1 - fee), idleNim: 25_000, avgIdleNim: 25_000 }
}

// ── 2. Weekly Payday: ISO week keys and streaks ──────────────────────────────
export function weekKey(t = Date.now()): string {
  const d = new Date(t); d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7))
  const w1 = new Date(d.getFullYear(), 0, 4)
  const week = 1 + Math.round(((d.getTime() - w1.getTime()) / 86_400_000 - 3 + ((w1.getDay() + 6) % 7)) / 7)
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`
}
export function prevWeekKey(key: string): string {
  const [y, w] = key.split('-W').map(Number)
  const jan4 = new Date(y, 0, 4)
  const monday = new Date(jan4.getTime() - ((jan4.getDay() + 6) % 7) * 86_400_000 + (w - 1) * 7 * 86_400_000)
  return weekKey(monday.getTime() - 3 * 86_400_000)
}
/** Consecutive weeks (ending this week) that you were staking. */
export function streak(weeks: string[]): number {
  const set = new Set(weeks)
  let k = weekKey(), n = 0
  while (set.has(k)) { n++; k = prevWeekKey(k) }
  return n
}

// ── 3. Payslip: a message your wallet signs, checkable by anyone ─────────────
export interface Payslip { v: 1, app: 'Payday', net: Net, address: string, staked: number, weekly: number, paid: number | null, rate: number, validator: string, at: number, demo?: boolean }
export const payslipMessage = (p: Payslip) =>
  `Payday payslip\nAccount: ${p.address}\nStaked: ${p.staked.toFixed(5)} NIM\nWeekly pay: ${p.weekly.toFixed(5)} NIM\nYearly rate: ${(p.rate * 100).toFixed(2)}%\nValidator: ${p.validator}\nNetwork: ${p.net}\nDate: ${new Date(p.at).toISOString()}`
export const encodePayslip = (p: Payslip, sig: string, pub: string) => `${b64urlEncode(JSON.stringify(p))}.${sig}.${pub}`
export function decodePayslip(s: string): { p: Payslip, sig: string, pub: string } | null {
  try {
    const [body, sig, pub] = s.split('.')
    const p = JSON.parse(b64urlDecode(body)) as Payslip
    if (p.app !== 'Payday' || !/^[0-9a-f]{128}$/i.test(sig) || !/^[0-9a-f]{64}$/i.test(pub)) return null
    return { p, sig, pub }
  }
  catch { return null }
}

// ── 4. Spend: Lightning invoice amount, partner apps ─────────────────────────
/** Amount in satoshis from a BOLT11 invoice, or null when the invoice has no fixed amount. */
export function bolt11Sats(invoice: string): number | null {
  const m = invoice.trim().toLowerCase().replace(/^lightning:/, '').match(/^ln(bc|tb|bcrt|tbs)(\d+)([munp]?)1/)
  if (!m || !m[2]) return null
  const amount = Number(m[2])
  const mult: Record<string, number> = { '': 1e8, m: 1e5, u: 100, n: 0.1, p: 0.0001 }
  return Math.round(amount * mult[m[3]])
}
export const isLightningInvoice = (s: string) => /^(lightning:)?ln(bc|tb|bcrt|tbs)\d*[munp]?1[0-9a-z]+$/i.test(s.trim())

export const PARTNERS = [
  { name: 'AbaPay', url: 'nim.abapays.com', what: 'Airtime, data, electricity and cable TV in Nigeria, plus top-ups in 140+ countries' },
  { name: 'NimShop', url: 'shop.nimiqbase.com', what: 'Gift cards, eSIMs and mobile top-ups' },
  { name: 'SwapSpace', url: 'swapspace.nimpay.app', what: 'Swap NIM into almost any coin' },
]
export const openInPay = (host: string) => `https://nimpay.app/miniapps/open/${host}`

// ── 5. Circles: a group paycheck that lives in a link ────────────────────────
export interface Circle { id: string, name: string, goal: number, members: { a: string, n: string }[] }
export const encodeCircle = (c: Circle) => b64urlEncode(JSON.stringify({ i: c.id, n: c.name, g: c.goal, m: c.members.map(x => [cleanAddress(x.a), x.n]) }))
export function decodeCircle(s: string): Circle | null {
  try {
    const j = JSON.parse(b64urlDecode(s))
    if (typeof j.n !== 'string' || !Array.isArray(j.m)) return null
    const members = j.m.filter((x: unknown) => Array.isArray(x) && /^NQ\d{2}[0-9A-Z]{32}$/.test(String(x[0])))
      .slice(0, 30).map((x: string[]) => ({ a: formatAddress(x[0]), n: String(x[1] ?? '').slice(0, 24) }))
    return { id: String(j.i ?? '').slice(0, 16) || Math.random().toString(36).slice(2, 10), name: j.n.slice(0, 40), goal: Number(j.g) || 0, members }
  }
  catch { return null }
}
