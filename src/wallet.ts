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
  /** Staking owner (the basic account). */
  address: string
  /** Every address Pay shared: basic account plus its remote HTLC account that holds the NIM. */
  accounts: string[]
  synced(): Promise<boolean>
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

/** True when running inside Nimiq Pay (it injects its host context before page scripts run). */
export const insideNimiqPay = () => typeof window !== 'undefined' && (!!window.nimiqPay || !!window.nimiq)

export async function connectNimiqPay(onAccounts: (accounts: string[]) => void): Promise<Wallet> {
  let nimiq: NimiqProvider
  // Inside Pay the provider can take a while on a cold start; outside, fail fast.
  try { nimiq = await init({ timeout: insideNimiqPay() ? 15_000 : 2_500 }) }
  catch { throw new WalletError(insideNimiqPay() ? 'Nimiq Pay did not respond. Close Payday and open it again.' : 'NOT_IN_NIMIQ_PAY') }
  let accounts: string[]
  try { accounts = await nimiq.listAccounts() }
  catch (e) {
    // The user tapped Cancel on Nimiq Pay's "share your account" prompt: offer to connect again.
    if (NimiqProviderError.is(e) && e.type === 'PERMISSION_DENIED') throw new WalletError('NOT_CONNECTED', true)
    explain(e)
  }
  if (!accounts?.length) throw new WalletError('NOT_CONNECTED', true)
  // Pay rotates its remote (HTLC) account and announces the new list.
  try { nimiq.on('accountsChanged', (a: string[]) => { if (a?.length) { wallet.address = a[0]; wallet.accounts = a; onAccounts(a) } }) }
  catch { /* older host without the event */ }
  const wallet: Wallet = {
    kind: 'nimiq-pay',
    net: getHostNetwork() ?? 'mainnet',
    fiat: getHostFiat()?.toLowerCase(),
    language: getHostLanguage(),
    address: accounts[0],
    accounts,
    synced: async () => { try { return await nimiq.isConsensusEstablished() } catch { return true } },
    newStaker: wrap((delegation: string, value: number) => nimiq.sendNewStakerTransaction({ delegation, value })),
    addStake: wrap((value: number) => nimiq.sendStakeTransaction({ value })),
    setActive: wrap((newActiveBalance: number) => nimiq.sendSetActiveStakeTransaction({ newActiveBalance })),
    retire: wrap((retireStake: number) => nimiq.sendRetireStakeTransaction({ retireStake })),
    remove: wrap((value: number) => nimiq.sendRemoveStakeTransaction({ value })),
    switchValidator: wrap((newDelegation: string) => nimiq.sendUpdateStakerTransaction({ newDelegation, reactivateAllStake: true })),
  }
  return wallet
}

// ── Demo wallet ──────────────────────────────────────────────────────────────
export interface DemoState { balance: number, staker: Staker | null, principal: number, stakedSince: number | null, head: number }
export const DEMO_ADDRESS = 'NQ00 DEMO 0000 0000 0000 0000 0000 0000 0000'

export function demoWallet(head: number): Wallet {
  const d: DemoState = { balance: 25_000 * 1e5, staker: null, principal: 0, stakedSince: null, head }
  const ok = async () => { await new Promise(r => setTimeout(r, 700)); return 'demo-' + Math.random().toString(16).slice(2) }
  const staker = () => { if (!d.staker) throw new WalletError('No stake yet.'); return d.staker }
  return {
    kind: 'demo', net: 'mainnet', address: DEMO_ADDRESS, accounts: [DEMO_ADDRESS], demo: d,
    synced: async () => true,
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
      if (luna > total) throw new WalletError('That is more than you have staked.')
      s.balance = luna; s.inactiveBalance = total - luna
      s.inactiveFrom = s.inactiveBalance ? d.head + 30 : null
      return ok()
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
