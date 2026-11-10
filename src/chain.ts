// Read-only access to the Nimiq blockchain (public JSON-RPC) plus validator and price data.
// Nothing here signs or sends anything: all wallet actions go through Nimiq Pay (see wallet.ts).

import { posSupplyAt } from '@nimiq/utils/supply-calculator'

export type Net = 'mainnet' | 'testnet'

const RPC: Record<Net, string> = {
  mainnet: 'https://rpc.nimiqwatch.com',
  testnet: 'https://rpc.testnet.nimiqwatch.com',
}
const VALIDATORS_API = 'https://validators-api-mainnet.nuxt.dev/api/v1/validators'
export const STAKING_CONTRACT = 'NQ77 0000 0000 0000 0000 0000 0000 0000 0001'
export const LUNA = 100_000

export class ChainError extends Error {}

async function rpc<T>(net: Net, method: string, params: unknown[] = []): Promise<T> {
  let last: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 12_000)
    try {
      const res = await fetch(RPC[net], {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctrl.signal,
      })
      if (!res.ok) throw new ChainError(`Network data server answered ${res.status}`)
      const json = await res.json()
      if (json.error) {
        const msg = String(json.error.data ?? json.error.message ?? 'RPC error')
        throw Object.assign(new ChainError(msg), { rpc: true })
      }
      return json.result.data as T
    }
    catch (e) {
      last = e
      if ((e as { rpc?: boolean }).rpc) throw e // real answer, don't retry
    }
    finally { clearTimeout(timer) }
  }
  throw new ChainError(last instanceof Error && last.name === 'AbortError'
    ? 'The Nimiq network took too long to answer.'
    : 'Could not reach the Nimiq network. Check your connection.')
}

export interface Staker {
  address: string
  balance: number // active stake, luna
  delegation: string | null
  inactiveBalance: number
  inactiveFrom: number | null
  retiredBalance: number
}

export async function getStaker(net: Net, address: string): Promise<Staker | null> {
  try { return await rpc<Staker>(net, 'getStakerByAddress', [address]) }
  catch (e) {
    if (e instanceof ChainError && /No staker/i.test(e.message)) return null
    throw e
  }
}

export async function getBalance(net: Net, address: string): Promise<number> {
  try {
    const a = await rpc<{ balance: number }>(net, 'getAccountByAddress', [address])
    return a.balance
  }
  catch (e) {
    if (e instanceof ChainError && /No account|not found/i.test(e.message)) return 0
    throw e
  }
}

/**
 * Nimiq Pay returns two addresses from listAccounts(): the basic account (the staking owner)
 * and a "remote account", an HTLC contract that actually holds the spendable NIM. The basic
 * address alone can read 0 while the wallet holds plenty, so spendable = the sum of both.
 */
export async function getSpendable(net: Net, addresses: string[]): Promise<number> {
  const unique = [...new Map(addresses.map(a => [cleanAddress(a), a])).values()]
  const balances = await Promise.all(unique.map(a => getBalance(net, a)))
  return balances.reduce((s, b) => s + b, 0)
}

export const getTransactionByHash = (net: Net, hash: string) =>
  rpc<Tx & { relatedAddresses?: string[] }>(net, 'getTransactionByHash', [hash])

export const getHead = (net: Net) => rpc<number>(net, 'getBlockNumber')

export interface Policy { blocksPerEpoch: number, minimumStake: number, blockSeparationTime: number, jailEpochs: number }
const policyCache: Partial<Record<Net, Policy>> = {}
export async function getPolicy(net: Net): Promise<Policy> {
  return policyCache[net] ??= await rpc<Policy>(net, 'getPolicyConstants')
}

export interface Tx {
  hash: string, blockNumber: number, timestamp: number, from: string, to: string,
  value: number, recipientData: string, senderData: string, executionResult: boolean
}
export const getTransactions = (net: Net, address: string, max = 500) =>
  rpc<Tx[]>(net, 'getTransactionsByAddress', [address, max, null])

export async function getTotalStaked(net: Net): Promise<number> {
  const a = await rpc<{ balance: number }>(net, 'getAccountByAddress', [STAKING_CONTRACT])
  return a.balance
}

// ── Addresses ────────────────────────────────────────────────────────────────
const B32 = '0123456789ABCDEFGHJKLMNPQRSTUVXY'
export const cleanAddress = (a: string) => a.replace(/\s+/g, '').toUpperCase()
export const formatAddress = (a: string) => cleanAddress(a).replace(/(.{4})/g, '$1 ').trim()
export const shortAddress = (a: string) => { const c = formatAddress(a).split(' '); return `${c[0]} ${c[1]} … ${c[c.length - 1]}` }
export function addressToHex(a: string): string {
  const body = cleanAddress(a).slice(4)
  let bits = ''
  for (const ch of body) bits += B32.indexOf(ch).toString(2).padStart(5, '0')
  let hex = ''
  for (let i = 0; i + 8 <= bits.length; i += 8) hex += parseInt(bits.slice(i, i + 8), 2).toString(16).padStart(2, '0')
  return hex
}
export const sameAddress = (a?: string | null, b?: string | null) => !!a && !!b && cleanAddress(a) === cleanAddress(b)

// ── Earnings: what the chain says you were actually paid ─────────────────────
// Principal = NIM you moved into the staking contract minus what you took out.
// Pools that "restake" add rewards straight to your stake, so stake − principal = rewards paid to you.
// The history is only trusted when it contains the staker's creation and is not truncated;
// otherwise (e.g. NIM staked from a Nimiq Pay contract we can no longer see) we return null
// and the app falls back to tracking from the first time it saw the stake.
export interface Earnings { principal: number, stakedSince: number }
export async function getEarnings(net: Net, owner: string, sources: string[]): Promise<Earnings | null> {
  const myHex = addressToHex(owner)
  const lists = await Promise.all([...new Set(sources.map(cleanAddress))].map(a => getTransactions(net, a, 500)))
  if (lists.some(l => l.length >= 500)) return null
  const seen = new Set<string>()
  let principal = 0
  let created: number | null = null
  for (const t of lists.flat()) {
    if (!t.executionResult || seen.has(t.hash)) continue
    seen.add(t.hash)
    const mine = sources.some(s => sameAddress(t.from, s))
    if (mine && sameAddress(t.to, STAKING_CONTRACT)) {
      const kind = t.recipientData.slice(0, 2)
      if (kind === '05') created = Math.min(created ?? Infinity, t.timestamp)
      else if (kind === '06' && !t.recipientData.slice(2).toLowerCase().startsWith(myHex)) continue // stake for someone else
      principal += t.value
    }
    else if (sameAddress(t.from, STAKING_CONTRACT) && sources.some(s => sameAddress(t.to, s))) {
      principal -= t.value
    }
  }
  return created === null ? null : { principal, stakedSince: created }
}

// ── Reward rate: today's real emission, not a marketing number ───────────────
export interface NetStats {
  apr: number // yearly rate on staked NIM today, before validator fee
  staked: number // NIM in the staking contract
  supply: number // NIM in existence now
  dailyEmission: number // new NIM per day right now
  inflation: number // yearly supply growth right now
  stakedRatio: number
  net: Net
}
const supplyOpts = (net: Net) => ({ network: net === 'testnet' ? 'test-albatross' as const : 'main-albatross' as const })
export const supplyAt = (net: Net, t: number) => posSupplyAt(t, supplyOpts(net))

export async function networkStats(net: Net): Promise<NetStats> {
  const now = Date.now()
  const supply = supplyAt(net, now)
  const daily = supplyAt(net, now + 86_400_000) - supply
  const staked = (await getTotalStaked(net)) / LUNA
  return { apr: (daily * 365) / staked, staked, supply, dailyEmission: daily, inflation: (daily * 365) / supply, stakedRatio: staked / supply, net }
}

/**
 * Month-by-month projection using Nimiq's real emission curve (rewards decay over time),
 * assuming the share of supply that is staked stays where it is today.
 */
export function project(net: Net, stats: NetStats, amountNim: number, months: number, fee: number, restake: boolean) {
  const start = Date.now()
  const month = 30.44 * 86_400_000
  let bal = amountNim
  let paidOut = 0
  const points: { m: number, staked: number, share: number, idleShare: number }[] = []
  const share0 = amountNim / stats.supply
  for (let m = 0; m <= months; m++) {
    const t = start + m * month
    const supply = supplyAt(net, t)
    points.push({ m, staked: bal + paidOut, share: (bal + paidOut) / supply / share0, idleShare: amountNim / supply / share0 })
    const em = supplyAt(net, t + month) - supply
    const reward = (restake ? bal : amountNim) * em / (stats.stakedRatio * supply) * (1 - fee)
    if (restake) bal += reward
    else paidOut += reward
  }
  return points
}

// ── Validators ───────────────────────────────────────────────────────────────
export interface Validator {
  address: string, name: string, fee: number, payoutType: 'restake' | 'direct' | 'none' | string,
  payoutSchedule: string, reliability: number, stakers: number, logo?: string, color: string, jailedFrom?: number | null,
}

export async function getValidators(net: Net): Promise<Validator[]> {
  const active = await rpc<{ address: string, numStakers: number, jailedFrom: number | null, retired: boolean }[]>(net, 'getActiveValidators')
  const activeSet = new Map(active.map(v => [cleanAddress(v.address), v]))
  if (net === 'mainnet') {
    try {
      const res = await fetch(VALIDATORS_API)
      const list = await res.json() as any[]
      return list
        .filter(v => v.isListed !== false && activeSet.has(cleanAddress(v.address)))
        .map(v => ({
          address: formatAddress(v.address),
          name: v.name,
          fee: typeof v.fee === 'number' ? v.fee : 1,
          payoutType: v.payoutType ?? 'none',
          payoutSchedule: v.payoutSchedule || '',
          reliability: v.score?.total ?? 0,
          stakers: activeSet.get(cleanAddress(v.address))?.numStakers ?? v.stakers ?? 0,
          logo: v.hasDefaultLogo ? undefined : v.logo,
          color: v.accentColor || '#E9B213',
          jailedFrom: activeSet.get(cleanAddress(v.address))?.jailedFrom ?? null,
        }))
    }
    catch { /* fall through to raw list */ }
  }
  // Testnet (or validators API down): the raw on-chain list, no names or fees known.
  return active.filter(v => !v.retired).map((v, i) => ({
    address: formatAddress(v.address),
    name: `${net === 'testnet' ? 'Test validator' : 'Validator'} ${formatAddress(v.address).slice(5, 9)}`,
    fee: 0, payoutType: 'restake', payoutSchedule: '', reliability: v.jailedFrom ? 0.5 : 0.95 - i * 0.001,
    stakers: v.numStakers, color: '#E9B213', jailedFrom: v.jailedFrom,
  }))
}

// Validators that pay stakers nothing ("none" = private node) are never recommended.
export const paysStakers = (v: Validator) => v.payoutType === 'restake' || v.payoutType === 'direct'
export const validatorScore = (v: Validator) =>
  (paysStakers(v) ? 1 : 0) * v.reliability ** 4 * (1 - v.fee) * (v.payoutType === 'restake' ? 1 : 0.985) * (v.jailedFrom ? 0 : 1)
export const bestValidator = (vs: Validator[]) => [...vs].sort((a, b) => validatorScore(b) - validatorScore(a))[0]

export function payoutLabel(v: Validator): string {
  const s = v.payoutSchedule.trim()
  if (/^every/i.test(s)) return s.replace(/^every/i, 'every')
  if (/^0 \*\/(\d+) \* \* \*$/.test(s)) return `every ${s.match(/\*\/(\d+)/)![1]} hours`
  if (s === '0 * * * *') return 'every hour'
  if (s) return s.length > 32 ? 'on its own schedule' : s
  return v.payoutType === 'none' ? 'does not pay stakers' : 'regularly'
}

// ── Prices ───────────────────────────────────────────────────────────────────
export const CURRENCIES = ['usd', 'eur', 'gbp', 'ngn', 'kes', 'zar', 'inr', 'brl', 'crc', 'gmd', 'chf', 'cad', 'aud', 'jpy'] as const
export type Currency = typeof CURRENCIES[number]
let priceCache: { at: number, prices: Record<string, number> } | null = null
export async function getPrices(): Promise<Record<string, number>> {
  if (priceCache && Date.now() - priceCache.at < 5 * 60_000) return priceCache.prices
  const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=nimiq-2&vs_currencies=${CURRENCIES.join(',')}`)
  if (!res.ok) throw new ChainError('Price feed unavailable')
  const json = await res.json()
  priceCache = { at: Date.now(), prices: json['nimiq-2'] ?? {} }
  return priceCache.prices
}
