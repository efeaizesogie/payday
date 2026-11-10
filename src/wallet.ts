// Wallet layer. Inside Nimiq Pay every action goes through the official Mini App SDK and the user
// approves it in a native dialog. Outside Nimiq Pay we offer a clearly-labelled demo with fake
// balances so anyone can explore the app without a wallet; demo mode never touches the chain.

import { init, getHostNetwork, getHostFiat, getHostLanguage, NimiqProviderError, type NimiqProvider } from '@nimiq/mini-app-sdk'
import type { Net, Staker } from './chain'

export type WalletKind = 'nimiq-pay' | 'demo'

export interface Wallet {
  kind: WalletKind
  net: Net
  fiat?: string
  language?: string
  address: string
  newStaker(delegation: string, luna: number): Promise<string>
  addStake(luna: number): Promise<string>
  setActive(luna: number): Promise<string>
  retire(luna: number): Promise<string>
  remove(luna: number): Promise<string>
  switchValidator(delegation: string): Promise<string>
  // demo only
  demo?: DemoState
}

export class WalletError extends Error {
  cancelled: boolean
  constructor(message: string, cancelled = false) { super(message); this.cancelled = cancelled }
}

function explain(e: unknown): never {
  if (NimiqProviderError.is(e)) {
    switch (e.type) {
      case 'PERMISSION_DENIED': throw new WalletError('You cancelled. Nothing was sent.', true)
      case 'INVALID_TRANSACTION': throw new WalletError(`Nimiq Pay rejected this transaction: ${e.message}`)
      case 'NETWORK_ERROR': throw new WalletError('Network problem while sending. Wait a minute and refresh before trying again, it may still have gone through.')
      case 'UNKNOWN_REQUEST': throw new WalletError('Your Nimiq Pay version does not support this yet. Please update Nimiq Pay.')
      default: throw new WalletError(e.message || 'Nimiq Pay could not complete this request.')
    }
  }
  throw new WalletError(e instanceof Error ? e.message : String(e))
}

const wrap = <A extends unknown[]>(fn: (...a: A) => Promise<string>) => async (...a: A) => {
  try { return await fn(...a) }
  catch (e) { explain(e) }
}

export async function connectNimiqPay(): Promise<Wallet> {
  let nimiq: NimiqProvider
  try { nimiq = await init({ timeout: 4_000 }) }
  catch { throw new WalletError('NOT_IN_NIMIQ_PAY') }
  let accounts: string[]
  try { accounts = await nimiq.listAccounts() }
  catch (e) { explain(e) }
  if (!accounts.length) throw new WalletError('No Nimiq account was shared.')
  return {
    kind: 'nimiq-pay',
    net: getHostNetwork() ?? 'mainnet',
    fiat: getHostFiat()?.toLowerCase(),
    language: getHostLanguage(),
    address: accounts[0],
    newStaker: wrap((delegation: string, value: number) => nimiq.sendNewStakerTransaction({ delegation, value })),
    addStake: wrap((value: number) => nimiq.sendStakeTransaction({ value })),
    setActive: wrap((newActiveBalance: number) => nimiq.sendSetActiveStakeTransaction({ newActiveBalance })),
    retire: wrap((retireStake: number) => nimiq.sendRetireStakeTransaction({ retireStake })),
    remove: wrap((value: number) => nimiq.sendRemoveStakeTransaction({ value })),
    switchValidator: wrap((newDelegation: string) => nimiq.sendUpdateStakerTransaction({ newDelegation, reactivateAllStake: true })),
  }
}

// ── Demo wallet ──────────────────────────────────────────────────────────────
export interface DemoState { balance: number, staker: Staker | null, principal: number, stakedSince: number | null, head: number }
export const DEMO_ADDRESS = 'NQ00 DEMO 0000 0000 0000 0000 0000 0000 0000'

export function demoWallet(head: number): Wallet {
  const d: DemoState = { balance: 25_000 * 1e5, staker: null, principal: 0, stakedSince: null, head }
  const ok = async () => { await new Promise(r => setTimeout(r, 700)); return 'demo-' + Math.random().toString(16).slice(2) }
  const staker = () => { if (!d.staker) throw new WalletError('No stake yet.'); return d.staker }
  return {
    kind: 'demo', net: 'mainnet', address: DEMO_ADDRESS, demo: d,
    async newStaker(delegation, luna) {
      if (luna > d.balance) throw new WalletError('Not enough NIM in this wallet.')
      d.balance -= luna; d.principal += luna; d.stakedSince = Date.now()
      d.staker = { address: DEMO_ADDRESS, balance: luna, delegation, inactiveBalance: 0, inactiveFrom: null, retiredBalance: 0 }
      return ok()
    },
    async addStake(luna) {
      if (luna > d.balance) throw new WalletError('Not enough NIM in this wallet.')
      d.balance -= luna; d.principal += luna; staker().balance += luna; return ok()
    },
    async setActive(luna) {
      const s = staker(); const total = s.balance + s.inactiveBalance
      s.balance = luna; s.inactiveBalance = total - luna; s.inactiveFrom = d.head + 30; return ok()
    },
    async retire(luna) { const s = staker(); s.inactiveBalance -= luna; s.retiredBalance += luna; if (!s.inactiveBalance) s.inactiveFrom = null; return ok() },
    async remove(luna) {
      const s = staker(); s.retiredBalance -= luna; d.balance += luna; d.principal -= luna
      if (!s.balance && !s.inactiveBalance && !s.retiredBalance) d.staker = null
      return ok()
    },
    async switchValidator(delegation) { staker().delegation = delegation; return ok() },
  }
}
