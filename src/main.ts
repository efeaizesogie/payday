import './style.css'
import {
  type Net, type Staker, type Validator, type Policy, type Currency, CURRENCIES, LUNA,
  getStaker, getSpendable, getHead, getPolicy, getEarnings, networkStats, getValidators, getPrices, project, type NetStats,
  bestValidator, validatorScore, paysStakers, payoutLabel, sameAddress, shortAddress,
} from './chain'
import { type Wallet, WalletError, connectNimiqPay, demoWallet } from './wallet'
import { nim, fiat, pct, duration, esc, parseNim } from './format'
import { checkup } from './health'
import { LESSONS } from './learn'

// ── State ────────────────────────────────────────────────────────────────────
type Sheet = null | 'add' | 'validators' | 'withdraw' | 'goal' | 'card' | 'currency' | 'how' | 'settings' | 'lesson'
type Tab = 'pay' | 'plan' | 'learn'
type Theme = 'system' | 'light' | 'dark'
interface Activity { t: number, text: string }
interface Paid { amount: number, since: number, tracked: boolean }
const S = {
  phase: 'loading' as 'loading' | 'outside' | 'error' | 'ready',
  fatal: '',
  wallet: null as Wallet | null,
  net: 'mainnet' as Net,
  spendable: 0,
  staker: null as Staker | null,
  paid: null as Paid | null,
  apr: null as number | null,
  validators: [] as Validator[],
  pick: null as Validator | null, // validator chosen for a new stake
  prices: {} as Record<string, number>,
  currency: 'usd' as Currency,
  head: 0,
  headAt: Date.now(),
  policy: null as Policy | null,
  sheet: null as Sheet,
  busy: '', // label of the wallet action waiting for approval
  pending: '', // sent, waiting to see it on chain
  synced: true,
  toast: null as null | { text: string, kind: 'ok' | 'err' },
  goalWeekly: 0, // NIM per week
  dataError: '',
  tab: 'pay' as Tab,
  theme: 'system' as Theme,
  stats: null as NetStats | null,
  lesson: '',
  answered: null as number | null,
  learned: {} as Record<string, boolean>,
  planAmount: 0, // NIM, 0 = use stake or wallet
  planYears: 3,
  planRestake: true,
  activity: [] as Activity[],
}

const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem('payday:' + k); return v === null ? d : JSON.parse(v) } catch { return d } },
  set(k: string, v: unknown) { try { localStorage.setItem('payday:' + k, JSON.stringify(v)) } catch { /* private mode */ } },
}

const app = document.querySelector<HTMLDivElement>('#app')!

// ── Derived numbers ──────────────────────────────────────────────────────────
const myValidator = () => S.staker?.delegation ? S.validators.find(v => sameAddress(v.address, S.staker!.delegation)) ?? null : null
const rateFor = (v: Validator | null) => (S.apr ?? 0) * (1 - Math.min(1, v?.fee ?? 0)) * (v && !paysStakers(v) ? 0 : 1)
const weeklyPay = (stakeLuna: number, v: Validator | null) => stakeLuna * rateFor(v) * 7 / 365
const price = () => S.prices[S.currency]
const totalStaked = (s = S.staker) => s ? s.balance + s.inactiveBalance + s.retiredBalance : 0
const minStake = () => S.policy?.minimumStake ?? 100 * LUNA
const blockMs = () => S.policy?.blockSeparationTime ?? 1000
const headNow = () => S.head + Math.floor((Date.now() - S.headAt) / blockMs())
const isDemo = () => S.wallet?.kind === 'demo'

function releaseBlock(): number | null {
  const s = S.staker
  if (!s || !s.inactiveBalance || s.inactiveFrom === null || !S.policy) return null
  let r = s.inactiveFrom + S.policy.blocksPerEpoch + 1
  const v = myValidator()
  if (v?.jailedFrom) r = Math.max(r, v.jailedFrom + S.policy.jailEpochs * S.policy.blocksPerEpoch + 1)
  return r
}

function guessCurrency(): Currency {
  const list = CURRENCIES as readonly string[]
  const saved = store.get<string>('currency', '')
  if (list.includes(saved)) return saved as Currency
  const host = S.wallet?.fiat
  if (host && list.includes(host)) return host as Currency
  const region = (navigator.language.split('-')[1] || '').toUpperCase()
  const byRegion: Record<string, Currency> = { NG: 'ngn', KE: 'kes', ZA: 'zar', IN: 'inr', BR: 'brl', GB: 'gbp', CR: 'crc', GM: 'gmd', CH: 'chf', CA: 'cad', AU: 'aud', JP: 'jpy', DE: 'eur', FR: 'eur', ES: 'eur', IT: 'eur', NL: 'eur', AT: 'eur', PT: 'eur', IE: 'eur', FI: 'eur', BE: 'eur' }
  return byRegion[region] ?? 'usd'
}

// ── "Paid to you" ────────────────────────────────────────────────────────────
// Preferred: the chain history (stake minus what you put in). When the history can't be
// trusted, Payday tracks from the first time it saw your stake, adjusting for every stake
// or withdrawal made through Payday, so the number is never inflated.
interface Track { base: number, adj: number, at: number }
const trackKey = () => `track:${S.net}:${S.wallet?.address}`
function trackAdjust(delta: number) {
  const t = store.get<Track | null>(trackKey(), null)
  if (t) store.set(trackKey(), { ...t, adj: t.adj + delta })
}
function trackedPaid(total: number): Paid {
  let t = store.get<Track | null>(trackKey(), null)
  if (!t) { t = { base: total, adj: 0, at: Date.now() }; store.set(trackKey(), t) }
  return { amount: Math.max(0, total - t.base - t.adj), since: t.at, tracked: true }
}

// ── Data loading ─────────────────────────────────────────────────────────────
async function refresh(full = false) {
  const w = S.wallet!
  try {
    if (w.kind === 'demo') {
      const d = w.demo!
      S.spendable = d.balance
      S.staker = d.staker ? { ...d.staker } : null
      S.paid = d.staker ? { amount: Math.max(0, totalStaked(d.staker) - d.principal), since: d.stakedSince ?? Date.now(), tracked: false } : null
      S.head = await getHead('mainnet').catch(() => S.head); S.headAt = Date.now(); d.head = S.head
    }
    else {
      const [spendable, staker, head, synced] = await Promise.all([
        getSpendable(S.net, w.accounts), getStaker(S.net, w.address), getHead(S.net), w.synced(),
      ])
      S.spendable = spendable; S.staker = staker; S.head = head; S.headAt = Date.now(); S.synced = synced
      if (staker) {
        const hist = await getEarnings(S.net, w.address, w.accounts).catch(() => null)
        S.paid = hist
          ? { amount: Math.max(0, totalStaked(staker) - hist.principal), since: hist.stakedSince, tracked: false }
          : trackedPaid(totalStaked(staker))
      }
      else { S.paid = null; store.set(trackKey(), null) }
    }
    if (full || !S.validators.length) {
      const [vals, stats, policy] = await Promise.all([getValidators(S.net), networkStats(S.net), getPolicy(S.net)])
      S.validators = vals; S.stats = stats; S.apr = stats.apr; S.policy = policy
      S.pick = S.pick ?? bestValidator(vals) ?? null
    }
    getPrices().then(p => { S.prices = p; render() }).catch(() => {})
    S.dataError = ''
  }
  catch (e) {
    S.dataError = e instanceof Error ? e.message : String(e)
  }
  render()
}

function applyTheme() {
  const root = document.documentElement
  if (S.theme === 'system') root.removeAttribute('data-theme')
  else root.dataset.theme = S.theme
}
const resolvedDark = () => S.theme === 'dark' || (S.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)

async function start() {
  S.goalWeekly = store.get('goal', 0)
  S.theme = store.get<Theme>('theme', 'system'); applyTheme()
  S.learned = store.get('learned', {})
  render()
  try {
    S.wallet = await connectNimiqPay(() => refresh())
  }
  catch (e) {
    if (e instanceof WalletError && e.message === 'NOT_IN_NIMIQ_PAY') { S.phase = 'outside'; render(); return }
    S.phase = 'error'; S.fatal = e instanceof Error ? e.message : String(e); render(); return
  }
  await enter()
}

async function enter() {
  S.net = S.wallet!.net
  S.currency = guessCurrency()
  S.activity = store.get(activityKey(), [])
  S.phase = 'loading'; render()
  await refresh(true)
  S.phase = 'ready'; render()
  setInterval(() => { if (!document.hidden && !S.busy && !S.pending) refresh() }, 30_000)
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.phase === 'ready') refresh() })
}

// ── Actions ──────────────────────────────────────────────────────────────────
function toast(text: string, kind: 'ok' | 'err' = 'ok') {
  S.toast = { text, kind }; render()
  setTimeout(() => { if (S.toast?.text === text) { S.toast = null; render() } }, kind === 'ok' ? 4500 : 8000)
}

const activityKey = () => `activity:${S.net}:${S.wallet?.address}`
function logActivity(text: string) {
  S.activity = [{ t: Date.now(), text }, ...S.activity].slice(0, 30)
  store.set(activityKey(), S.activity)
}

const fingerprint = () => JSON.stringify(S.staker) + S.spendable

/**
 * Send one wallet action. Nimiq Pay shows its own approval dialog; after approval we keep the
 * screen in a "confirming" state and poll the chain until the change shows up (or 40 s pass),
 * so the user never sees stale numbers and can't send the same thing twice.
 */
async function act(label: string, fn: () => Promise<string>, success: string, after?: () => void) {
  if (S.busy || S.pending) return
  S.busy = label; render()
  try {
    await fn()
    after?.()
    logActivity(success)
    S.sheet = null
    S.busy = ''
    if (isDemo()) { await refresh(); toast(success); return }
    S.pending = success; render()
    const before = fingerprint()
    for (let i = 0; i < 14; i++) {
      await new Promise(r => setTimeout(r, 3000))
      await refresh()
      if (fingerprint() !== before) break
    }
    S.pending = ''
    toast(success)
  }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    toast(msg, (e as WalletError).cancelled ? 'ok' : 'err')
  }
  finally { S.busy = ''; S.pending = ''; render() }
}

function readAmount(id: string): number {
  const el = document.getElementById(id) as HTMLInputElement | null
  return el ? parseNim(el.value) : NaN
}

/** Blocking problems only. Balance is a soft warning: Nimiq Pay has the final say on funds. */
function stakeProblem(luna: number, isNew: boolean): string | null {
  if (!Number.isFinite(luna) || luna <= 0) return 'Enter an amount of NIM.'
  if (isNew && luna < minStake()) return `The network minimum to start staking is ${nim(minStake())} NIM.`
  return null
}
const overBalance = (luna: number) => !isDemo() ? luna > S.spendable && S.spendable > 0 : luna > S.spendable

const actions: Record<string, (el: HTMLElement) => void> = {
  demo: async () => {
    S.phase = 'loading'; render()
    const head = await getHead('mainnet').catch(() => 0)
    S.wallet = demoWallet(head)
    await enter()
  },
  retry: () => location.reload(),
  sheet: el => { S.sheet = el.dataset.sheet as Sheet; render(); focusSheet() },
  close: () => { S.sheet = null; render() },
  preset: el => {
    const input = document.getElementById(el.dataset.target!) as HTMLInputElement
    const max = el.dataset.max ? Number(el.dataset.max) : S.spendable
    input.value = (Math.floor(max * Number(el.dataset.f)) / LUNA).toString()
    input.dispatchEvent(new Event('input', { bubbles: true }))
  },
  pick: el => {
    const v = S.validators.find(x => x.address === el.dataset.addr)
    if (!v) return
    if (S.staker) {
      if (sameAddress(v.address, S.staker.delegation)) { S.sheet = null; render(); return }
      act('Switching', () => S.wallet!.switchValidator(v.address), `Switched to ${v.name}. Your stake moves over at the next epoch, in about 12 hours.`)
    }
    else { S.pick = v; S.sheet = null; render() }
  },
  stakeNew: () => {
    const luna = readAmount('amt-new')
    const err = stakeProblem(luna, true)
    if (err) return toast(err, 'err')
    if (isDemo() && overBalance(luna)) return toast(`The demo wallet has ${nim(S.spendable)} NIM.`, 'err')
    const v = S.pick
    if (!v) return toast('Choose a validator first.', 'err')
    act('Waiting for approval', () => S.wallet!.newStaker(v.address, luna), `${nim(luna)} NIM is now working for you.`,
      () => store.set(trackKey(), null))
  },
  stakeMore: () => {
    const luna = readAmount('amt-add')
    const err = stakeProblem(luna, false)
    if (err) return toast(err, 'err')
    if (isDemo() && overBalance(luna)) return toast(`The demo wallet has ${nim(S.spendable)} NIM.`, 'err')
    act('Waiting for approval', () => S.wallet!.addStake(luna), `Added ${nim(luna)} NIM. Your weekly pay just went up.`, () => trackAdjust(luna))
  },
  withdraw: () => {
    const s = S.staker!
    const luna = readAmount('amt-out')
    if (!Number.isFinite(luna) || luna <= 0) return toast('Enter how much NIM to withdraw.', 'err')
    if (luna > s.balance) return toast(`Only ${nim(s.balance)} NIM is earning right now.`, 'err')
    const left = s.balance - luna
    if (left > 0 && left < minStake()) return toast(`Leave at least ${nim(minStake())} NIM staked, or withdraw all of it.`, 'err')
    act('Waiting for approval', () => S.wallet!.setActive(left), `${nim(luna)} NIM is cooling down. Payday will show when it can be unlocked.`)
  },
  keepEarning: () => {
    const s = S.staker!
    act('Waiting for approval', () => S.wallet!.setActive(s.balance + s.inactiveBalance), 'Withdrawal cancelled. All of it is earning again.')
  },
  retire: () => {
    const s = S.staker!
    act('Waiting for approval', () => S.wallet!.retire(s.inactiveBalance), 'Unlocked. One more tap moves it to your wallet.')
  },
  remove: () => {
    const amount = S.staker!.retiredBalance
    act('Waiting for approval', () => S.wallet!.remove(amount), `${nim(amount)} NIM is back in your wallet.`, () => trackAdjust(-amount))
  },
  saveGoal: () => {
    const luna = readAmount('goal-in')
    if (!Number.isFinite(luna) || luna <= 0) return toast('Enter a weekly amount in NIM.', 'err')
    S.goalWeekly = luna / LUNA; store.set('goal', S.goalWeekly); S.sheet = null; render()
  },
  clearGoal: () => { S.goalWeekly = 0; store.set('goal', 0); S.sheet = null; render() },
  currency: el => { S.currency = el.dataset.cur as Currency; store.set('currency', S.currency); S.sheet = null; render() },
  share: async () => {
    const text = cardText()
    const url = appLink()
    try {
      if (navigator.share) { await navigator.share({ title: 'My NIM payday', text, url }); return }
    }
    catch (e) { if ((e as Error).name === 'AbortError') return }
    try { await navigator.clipboard.writeText(`${text}\n${url}`); toast('Copied. Paste it anywhere.') }
    catch { toast('Sharing is not available here. Take a screenshot instead.', 'err') }
  },
  refresh: () => { S.dataError = ''; render(); refresh(true) },
  toggleTheme: () => { S.theme = resolvedDark() ? 'light' : 'dark'; store.set('theme', S.theme); applyTheme(); render() },
  theme: el => { S.theme = el.dataset.theme as Theme; store.set('theme', S.theme); applyTheme(); render() },
  tab: el => { S.tab = el.dataset.tab as Tab; S.sheet = null; render(); window.scrollTo(0, 0) },
  lesson: el => { S.lesson = el.dataset.id!; S.answered = null; S.sheet = 'lesson'; render() },
  answer: el => {
    if (S.answered !== null) return
    S.answered = Number(el.dataset.i)
    const l = LESSONS.find(x => x.id === S.lesson)
    if (l && S.answered === l.q.correct) { S.learned = { ...S.learned, [l.id]: true }; store.set('learned', S.learned) }
    render()
  },
  retryQ: () => { S.answered = null; render() },
  nextLesson: () => {
    const i = LESSONS.findIndex(x => x.id === S.lesson)
    const next = LESSONS.slice(i + 1).find(x => !S.learned[x.id]) ?? LESSONS.find(x => !S.learned[x.id])
    if (next) { S.lesson = next.id; S.answered = null; render(); document.querySelector('.sheet')?.scrollTo(0, 0) }
    else { S.sheet = null; render() }
  },
  years: el => { S.planYears = Number(el.dataset.y); render() },
  restake: el => { S.planRestake = el.dataset.v === '1'; render() },
  fix: el => {
    const a = el.dataset.fix!
    if (a === 'validators') { S.sheet = 'validators'; render() }
    else actions[a]?.(el)
  },
  goStake: () => { S.tab = 'pay'; S.sheet = null; render(); window.scrollTo(0, 0); setTimeout(() => (document.getElementById('amt-new') as HTMLInputElement | null)?.focus(), 50) },
  skipWait: async () => {
    const d = S.wallet?.demo
    if (!d?.staker || !S.policy) return
    d.staker.inactiveFrom = S.head - S.policy.blocksPerEpoch - 2
    await refresh()
  },
}

app.addEventListener('click', e => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')
  if (!el || (el as HTMLButtonElement).disabled) return
  if (el.classList.contains('backdrop') && e.target !== el) return
  actions[el.dataset.a!]?.(el)
})
app.addEventListener('keydown', e => {
  const el = e.target as HTMLElement
  if ((e.key === 'Enter' || e.key === ' ') && el.getAttribute('role') === 'button') { e.preventDefault(); el.click() }
  if (e.key === 'Enter' && el instanceof HTMLInputElement) {
    const map: Record<string, string> = { 'amt-new': 'stakeNew', 'amt-add': 'stakeMore', 'amt-out': 'withdraw', 'goal-in': 'saveGoal' }
    const a = map[el.id]; if (a) { e.preventDefault(); actions[a](el) }
  }
})
app.addEventListener('input', e => {
  const el = e.target as HTMLInputElement
  if (el.id === 'amt-new' || el.id === 'amt-add') updateCalc(el)
  if (el.id === 'amt-out') updateWithdrawCalc()
  if (el.id === 'goal-in') updateGoalCalc()
  if (el.id === 'plan-in') { const v = parseNim(el.value); S.planAmount = Number.isFinite(v) ? v / LUNA : 0; updatePlan() }
})
document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.sheet) { S.sheet = null; render() } })

function focusSheet() { setTimeout(() => (document.querySelector('.sheet input') as HTMLInputElement | null)?.focus(), 60) }
const set = (id: string, t: string) => { const n = document.getElementById(id); if (n) n.textContent = t }

/** "≈ $3.24": the typed NIM amount in the chosen currency. */
function fiatLine(luna: number): string {
  const p = price()
  if (p === undefined) return ''
  return `≈ ${fiat(Number.isFinite(luna) && luna > 0 ? luna : 0, p, S.currency)}`
}
const amtFiat = (id: string) => `<div class="amt-fiat"><span class="num" id="fiat-${id}" aria-live="polite"></span><button class="link" data-a="sheet" data-sheet="settings" aria-label="Change currency, now ${S.currency.toUpperCase()}">${S.currency.toUpperCase()}</button></div>`
const walletLine = (id: string, label: string, luna: number) =>
  `<p class="hint" id="${id}">${label}: ${nim(luna)} NIM${price() !== undefined ? ` (${fiat(luna, price(), S.currency)})` : ''}</p>`

function updateCalc(input: HTMLInputElement) {
  const luna = parseNim(input.value)
  const isNew = input.id === 'amt-new'
  const v = isNew ? S.pick : myValidator()
  const base = isNew ? 0 : (S.staker?.balance ?? 0)
  const ok = Number.isFinite(luna) && luna > 0
  const w = weeklyPay(base + (ok ? luna : 0), v)
  set('calc-week', nim(w))
  set('calc-week-fiat', w && price() !== undefined ? fiat(w, price(), S.currency) : '')
  set('calc-month', nim(w * 365 / 12 / 7))
  set('calc-year', nim(w * 365 / 7))
  set(isNew ? 'fiat-new' : 'fiat-add', fiatLine(ok ? luna : 0))
  const problem = ok ? stakeProblem(luna, isNew) : null
  set('calc-err', problem ?? '')
  set('calc-warn', ok && !problem && overBalance(luna)
    ? (isDemo() ? `The demo wallet only has ${nim(S.spendable)} NIM.` : `That's more than Payday can see in your wallet (${nim(S.spendable)} NIM). Nimiq Pay will check before anything is sent.`)
    : '')
  const btn = document.getElementById(isNew ? 'go-new' : 'go-add')
  if (btn && !S.busy && !S.pending) btn.textContent = ok && !problem ? `Stake ${nim(luna)} NIM` : isNew ? 'Start getting paid' : 'Add to my stake'
}

function updateWithdrawCalc() {
  const luna = readAmount('amt-out')
  const s = S.staker
  if (!s) return
  const ok = Number.isFinite(luna) && luna > 0 && luna <= s.balance
  set('fiat-out', fiatLine(luna))
  set('out-week', ok ? `Your weekly pay drops to ${nim(weeklyPay(s.balance - luna, myValidator()))} NIM.` : '')
}

function updateGoalCalc() {
  const luna = readAmount('goal-in')
  const r = rateFor(myValidator() ?? S.pick) * 7 / 365
  set('goal-need', Number.isFinite(luna) && luna > 0 && r > 0 ? `${nim(luna / r)} NIM` : 'a little')
}

function cardText() {
  const v = myValidator()
  const w = weeklyPay(S.staker?.balance ?? 0, v)
  return `My NIM pays me ${nim(w)} NIM every week while I do nothing. Staking at ${pct(rateFor(v))} a year, paid ${v ? payoutLabel(v) : 'regularly'}. Payday, inside Nimiq Pay:`
}

/** Deeplink that opens this Mini App inside Nimiq Pay (keeps the path, e.g. for GitHub Pages). */
function appLink() {
  const path = location.pathname.replace(/index\.html$/, '').replace(/\/$/, '')
  return 'https://nimpay.app/miniapps/open/' + location.host + path
}

// ── Rendering ────────────────────────────────────────────────────────────────
// Logo: a sun rising inside Nimiq's hexagon. The day your NIM pays you, coming up over the horizon.
const logo = `<svg viewBox="0 0 64 64" class="logo" aria-hidden="true"><polygon class="logo-hex" points="6,32 19,9.5 45,9.5 58,32 45,54.5 19,54.5"/><path class="logo-sun" d="M20.5 39a11.5 11.5 0 0 1 23 0z"/><g class="logo-rays"><path d="M32 22.5v-5"/><path d="M43.7 27.3l3.5-3.5"/><path d="M20.3 27.3l-3.5-3.5"/><path d="M14.5 39h35"/><path d="M26.5 46.5h11" stroke-width="3"/></g></svg>`

const fmtDate = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

function header() {
  const tag = isDemo() ? '<span class="tag">Demo</span>' : S.net === 'testnet' ? '<span class="tag">Testnet</span>' : ''
  const dark = resolvedDark()
  const sun = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>`
  const moon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>`
  return `<header class="top">
    <div class="brand">${logo}<span>Payday</span>${tag}</div>
    <div class="top-actions">
      <button class="icon-btn" data-a="toggleTheme" aria-label="Switch to ${dark ? 'light' : 'dark'} mode">${dark ? sun : moon}</button>
      ${S.phase === 'ready' ? `<button class="chip" data-a="sheet" data-sheet="settings" aria-label="Settings: currency ${S.currency.toUpperCase()}">${S.currency.toUpperCase()}</button>` : ''}
    </div>
  </header>`
}

function tabBar() {
  const tabs: [Tab, string, string][] = [
    ['pay', 'Paycheck', '<path d="M3 7h18v12H3zM3 11h18M7 15h4"/>'],
    ['plan', 'Plan', '<path d="M4 19V5M4 19h16M8 15l4-4 3 3 5-6"/>'],
    ['learn', 'Learn', '<path d="M3 6l9-3 9 3-9 3zM7 8v5c0 1.7 2.2 3 5 3s5-1.3 5-3V8"/>'],
  ]
  const left = LESSONS.filter(l => !S.learned[l.id]).length
  return `<nav class="tabbar" aria-label="Sections">${tabs.map(([id, label, path]) =>
    `<button data-a="tab" data-tab="${id}" ${S.tab === id ? 'aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg><span>${label}${id === 'learn' && left ? ` <span class="count" aria-label="${left} lessons left">${left}</span>` : ''}</span></button>`).join('')}</nav>`
}

// ── Plan tab ─────────────────────────────────────────────────────────────────
function planBase(): number {
  if (S.planAmount > 0) return S.planAmount
  if (S.staker?.balance) return S.staker.balance / LUNA
  return Math.max(1000, Math.floor(S.spendable / LUNA))
}

function planChart(): string {
  const st = S.stats
  if (!st) return '<p class="hint">Network data is still loading.</p>'
  const v = myValidator() ?? S.pick
  const amount = planBase()
  const months = S.planYears * 12
  const pts = project(S.net, st, amount, months, v?.fee ?? 0, S.planRestake)
  const end = pts[pts.length - 1]
  const W = 320, H = 160, P = 8
  const maxY = Math.max(end.staked, amount) * 1.04, minY = amount * 0.96
  const x = (m: number) => P + (m / months) * (W - 2 * P)
  const y = (val: number) => H - P - ((val - minY) / (maxY - minY)) * (H - 2 * P)
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.m).toFixed(1)},${y(p.staked).toFixed(1)}`).join('')
  const idle = `M${x(0)},${y(amount)}L${x(months)},${y(amount)}`
  const gain = end.staked - amount
  const idleShareLoss = 1 - end.idleShare
  return `
    <figure class="chart">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Staked NIM grows from ${nim(amount * LUNA)} to ${nim(end.staked * LUNA)} over ${S.planYears} years; unstaked NIM stays flat.">
        <path class="chart-idle" d="${idle}"/>
        <path class="chart-line" d="${line}"/>
        <circle class="chart-dot" cx="${x(months)}" cy="${y(end.staked)}" r="4"/>
      </svg>
      <figcaption class="chart-legend"><span class="key key-staked">Staked</span><span class="key key-idle">Not staked</span></figcaption>
    </figure>
    <dl class="payrows">
      <div class="payrow-main"><dt>After ${S.planYears} year${S.planYears > 1 ? 's' : ''} staked</dt><dd><span class="num">${nim(end.staked * LUNA)}</span> NIM <span class="sub-fiat">+${nim(gain * LUNA)} NIM${price() !== undefined ? `, about ${fiat(gain * LUNA, price(), S.currency)} at today's price` : ''}</span></dd></div>
      <div><dt>Your share of all NIM</dt><dd>${end.share >= 1 ? '+' : ''}${pct(end.share - 1)} if staked</dd></div>
      <div><dt>If you don't stake</dt><dd>${pct(-idleShareLoss)} share</dd></div>
    </dl>
    <p class="hint">Uses Nimiq's real reward schedule, which slowly shrinks each year, ${v ? `${esc(v.name)}'s ${pct(v.fee, (v.fee * 1000) % 10 ? 1 : 0)} fee,` : ''} and assumes ${pct(st.stakedRatio, 0)} of all NIM stays staked. Prices are not predicted.</p>`
}

function updatePlan() {
  const box = document.getElementById('plan-out')
  if (box) box.innerHTML = planChart()
}

function planView() {
  return `
  <section class="intro"><h1>Plan your paycheck</h1><p class="lede">See what your NIM grows to, and what standing still costs.</p></section>
  <section class="panel">
    <label for="plan-in" class="label">Amount</label>
    <div class="amount"><input id="plan-in" inputmode="decimal" autocomplete="off" placeholder="${Math.round(planBase())}" value="${S.planAmount || ''}"><span aria-hidden="true">NIM</span></div>
    <div class="seg" role="group" aria-label="Years">${[1, 3, 5].map(y => `<button data-a="years" data-y="${y}" aria-pressed="${S.planYears === y}">${y} year${y > 1 ? 's' : ''}</button>`).join('')}</div>
    <div class="seg" role="group" aria-label="Payout">${[['1', 'Compound'], ['0', 'Paid to wallet']].map(([v, l]) => `<button data-a="restake" data-v="${v}" aria-pressed="${(v === '1') === S.planRestake}">${l}</button>`).join('')}</div>
    <div id="plan-out">${planChart()}</div>
  </section>
  ${!S.staker || !totalStaked() ? '<button class="btn btn-primary btn-block" data-a="goStake">Start staking</button>' : ''}`
}

// ── Learn tab ────────────────────────────────────────────────────────────────
function pulse() {
  const st = S.stats
  if (!st) return ''
  return `<section class="panel" aria-label="Network right now">
    <h2 class="label">The network right now</h2>
    <dl class="pulse">
      <div><dt>Staked</dt><dd class="num">${pct(st.stakedRatio, 0)}</dd><dd class="stat-sub">of all NIM</dd></div>
      <div><dt>Yearly rate</dt><dd class="num">${pct(st.apr)}</dd><dd class="stat-sub">before fees</dd></div>
      <div><dt>New NIM today</dt><dd class="num">${nim(st.dailyEmission * LUNA)}</dd><dd class="stat-sub">paid to stakers</dd></div>
      <div><dt>Validators</dt><dd class="num">${S.validators.length}</dd><dd class="stat-sub">active and listed</dd></div>
    </dl>
  </section>`
}

function learnView() {
  const done = LESSONS.filter(l => S.learned[l.id]).length
  const all = done === LESSONS.length
  return `
  <section class="intro"><h1>Learn staking in five minutes</h1><p class="lede">${all ? 'You finished every lesson. You know more about staking than most holders.' : `${done} of ${LESSONS.length} lessons done. Each ends with one quick question.`}</p></section>
  <div class="meter" role="progressbar" aria-label="Lessons done" aria-valuemin="0" aria-valuemax="${LESSONS.length}" aria-valuenow="${done}"><i style="transform:scaleX(${(done / LESSONS.length).toFixed(3)})"></i></div>
  <ol class="lessons">${LESSONS.map((l, i) => `<li><button class="lesson-row" data-a="lesson" data-id="${l.id}">
    <span class="lesson-n ${S.learned[l.id] ? 'done' : ''}" aria-hidden="true">${S.learned[l.id] ? '✓' : i + 1}</span>
    <span class="lesson-text"><b>${esc(l.title)}</b><span class="hint">${esc(l.summary)}</span></span>
    <span class="sr-only">${S.learned[l.id] ? 'done' : 'not done'}</span></button></li>`).join('')}</ol>
  ${pulse()}`
}

function lessonSheet(): { title: string, body: string } {
  const l = LESSONS.find(x => x.id === S.lesson) ?? LESSONS[0]
  const a = S.answered
  const right = a === l.q.correct
  const idx = LESSONS.indexOf(l)
  const remaining = LESSONS.filter(x => !S.learned[x.id] && x.id !== l.id).length
  return {
    title: l.title,
    body: `<p class="hint">Lesson ${idx + 1} of ${LESSONS.length}</p>
    <div class="prose">${l.body(S.stats)}</div>
    <fieldset class="quiz"><legend>${esc(l.q.text)}</legend>
      ${l.q.options.map((o, i) => `<button class="quiz-opt ${a !== null && i === l.q.correct ? 'right' : ''} ${a === i && !right ? 'wrong' : ''}" data-a="answer" data-i="${i}" ${a !== null ? 'aria-disabled="true"' : ''}>${esc(o)}</button>`).join('')}
    </fieldset>
    ${a === null ? '' : `<p class="msg ${right ? 'ok' : 'err'}" role="status">${right ? 'Correct. ' : 'Not quite. '}${esc(l.q.why)}</p>
      ${right
        ? `<button class="btn btn-primary btn-block" data-a="nextLesson">${remaining ? 'Next lesson' : 'Done'}</button>`
        : '<button class="btn btn-block" data-a="retryQ">Try again</button>'}`}`,
  }
}

// ── Paycheck extras ──────────────────────────────────────────────────────────
function checkupPanel(): string {
  const s = S.staker
  if (!s || !s.balance && !s.inactiveBalance) return ''
  const checks = checkup(s, myValidator(), S.validators, S.apr ?? 0)
  const issues = checks.filter(c => c.level !== 'ok')
  const icon = (l: string) => l === 'ok' ? '✓' : '!'
  return `<section class="panel" aria-label="Stake checkup">
    <div class="row-h"><h2 class="label">Stake checkup</h2><span class="hint">${issues.length ? `${issues.length} to look at` : 'All good'}</span></div>
    <ul class="checks">${checks.map(c => `<li class="check check-${c.level}">
      <span class="check-icon" aria-hidden="true">${icon(c.level)}</span>
      <span class="check-text"><b>${esc(c.title)}</b><span class="hint">${esc(c.detail)}</span></span>
      ${c.fix ? `<button class="link" data-a="fix" data-fix="${c.fix.action}" ${S.busy || S.pending ? 'disabled' : ''}>${esc(c.fix.label)}</button>` : ''}
    </li>`).join('')}</ul>
  </section>`
}

function activityPanel(): string {
  if (!S.activity.length) return ''
  return `<section class="panel" aria-label="Your activity">
    <h2 class="label">Your activity</h2>
    <ul class="activity">${S.activity.slice(0, 6).map(a => `<li><span>${esc(a.text)}</span><time class="hint" datetime="${new Date(a.t).toISOString()}">${new Date(a.t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></li>`).join('')}</ul>
  </section>`
}

function validatorRow(v: Validator, opts: { selected?: boolean, action?: string } = {}) {
  const mark = v.logo ? `<img src="${esc(v.logo)}" alt="" class="vlogo">` : `<span class="vlogo vlogo-letter" aria-hidden="true">${esc(v.name.slice(0, 1))}</span>`
  const fee = v.fee >= 1 ? 'private' : `${pct(v.fee, (v.fee * 1000) % 10 ? 1 : 0)} fee`
  const pays = paysStakers(v) ? `Pays ${esc(payoutLabel(v))}, ${fee}` : 'Does not pay stakers'
  const attrs = opts.action ? `data-a="${opts.action}" data-addr="${esc(v.address)}" role="button" tabindex="0" aria-pressed="${opts.selected ? 'true' : 'false'}"` : ''
  return `<div class="vrow ${opts.action ? 'pickable' : ''} ${opts.selected ? 'sel' : ''}" ${attrs}>
    ${mark}
    <div class="vmain"><div class="vname">${esc(v.name)}</div><div class="vmeta">${pays}</div></div>
    <div class="vright"><div class="vrate">${pct(rateFor(v))}</div><div class="vmeta">${(v.reliability * 100).toFixed(1)}% uptime</div></div>
  </div>`
}

const presets = (target: string, fr: number[], max?: number) =>
  `<div class="presets" role="group" aria-label="Quick amounts">${fr.map(f => `<button data-a="preset" data-target="${target}" ${max !== undefined ? `data-max="${max}"` : ''} data-f="${f}">${f === 1 ? (max !== undefined ? 'All' : 'Max') : f * 100 + '%'}</button>`).join('')}</div>`

const payRows = (label: string) => `<dl class="payrows">
  <div class="payrow-main"><dt>${label}</dt><dd><span class="num" id="calc-week">0</span> NIM <span class="sub-fiat" id="calc-week-fiat"></span></dd></div>
  <div><dt>Monthly</dt><dd><span class="num" id="calc-month">0</span> NIM</dd></div>
  <div><dt>Yearly</dt><dd><span class="num" id="calc-year">0</span> NIM</dd></div>
</dl>
<p class="msg err" id="calc-err" role="alert"></p>
<p class="msg warn" id="calc-warn"></p>`

const busyLabel = (idle: string) => S.busy ? `${esc(S.busy)}…` : S.pending ? 'Confirming…' : idle

function homeNotStaking() {
  const v = S.pick
  const low = !isDemo() && S.spendable < minStake()
  return `
  <section class="intro">
    <h1>Turn your NIM into a weekly paycheck</h1>
    <p class="lede">Stake once, get paid ${v && paysStakers(v) ? esc(payoutLabel(v)) : 'every few hours'}, and withdraw whenever you like.</p>
  </section>

  <section class="panel">
    <label for="amt-new" class="label">How much NIM should work for you?</label>
    <div class="amount"><input id="amt-new" inputmode="decimal" autocomplete="off" enterkeyhint="done" placeholder="0" aria-describedby="avail-new" value="${S.spendable >= minStake() ? Math.floor(S.spendable * 0.5 / LUNA) : ''}"><span aria-hidden="true">NIM</span></div>
    ${amtFiat('new')}
    ${walletLine('avail-new', 'In your wallet', S.spendable)}
    ${presets('amt-new', [0.25, 0.5, 0.75, 1])}
    ${payRows('Weekly pay')}
  </section>

  <section class="panel">
    <div class="row-h"><h2 class="label">Who pays you</h2><button class="link" data-a="sheet" data-sheet="validators">Change</button></div>
    ${v ? validatorRow(v) : '<p class="hint">No validators could be loaded.</p>'}
    <p class="hint">Picked for its uptime and low fee. Your pay goes back into your stake, so it compounds.</p>
  </section>

  ${low ? `<p class="notice">${S.net === 'testnet'
    ? `Staking starts at ${nim(minStake())} NIM. On testnet, tap <b>Get free NIM</b> on the Nimiq Pay home screen.`
    : `Staking starts at ${nim(minStake())} NIM. Payday sees ${nim(S.spendable)} NIM in your wallet; if that's wrong, go ahead and Nimiq Pay will check.`}</p>` : ''}

  <div class="cta-bar"><button class="btn btn-primary btn-block" id="go-new" data-a="stakeNew" ${S.busy || S.pending || !v ? 'disabled' : ''}>${busyLabel('Start getting paid')}</button></div>
  <button class="link link-center" data-a="tab" data-tab="learn">New to staking? Learn it in five minutes</button>`
}

function homeStaking() {
  const s = S.staker!
  const v = myValidator()
  const weekly = weeklyPay(s.balance, v)
  const goal = S.goalWeekly * LUNA
  const rel = releaseBlock()
  const leftMs = rel !== null ? (rel - headNow()) * blockMs() : 0
  const released = rel !== null && headNow() >= rel
  const direct = v?.payoutType === 'direct'
  const locked = !!(S.busy || S.pending)

  let paidCell: string
  if (direct) paidCell = `<dt>Paid to you</dt><dd class="stat">to wallet</dd><dd class="stat-sub">this validator pays out directly</dd>`
  else if (!S.paid) paidCell = `<dt>Paid to you</dt><dd class="stat">–</dd><dd class="stat-sub">not available</dd>`
  else paidCell = `<dt>Paid to you</dt><dd class="stat num">${nim(S.paid.amount)}</dd><dd class="stat-sub">since ${new Date(S.paid.since).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</dd>`

  let goalBlock: string
  if (goal) {
    const p = Math.min(1, weekly / goal)
    const r = rateFor(v) * 7 / 365
    const need = r > 0 ? goal / r - s.balance : 0
    goalBlock = `<section class="panel" aria-label="Paycheck goal">
      <div class="row-h"><h2 class="label">Goal: ${nim(goal)} NIM a week</h2><button class="link" data-a="sheet" data-sheet="goal">Edit</button></div>
      <div class="meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p * 100)}"><i style="transform:scaleX(${p.toFixed(3)})"></i></div>
      <p class="hint">${p >= 1 ? 'Reached. Time for a bigger goal?' : `${Math.round(p * 100)}% there. Stake ${nim(Math.max(0, need))} more NIM to reach it.`}</p>
    </section>`
  }
  else {
    goalBlock = `<button class="panel panel-quiet" data-a="sheet" data-sheet="goal"><span class="label">Set a paycheck goal</span><span class="hint">How much should your NIM pay you each week?</span></button>`
  }

  return `
  <section class="paycheck" aria-label="Your paycheck">
    <p class="paycheck-label">Your weekly pay</p>
    <p class="paycheck-amount"><span class="num">${nim(weekly)}</span> NIM</p>
    <p class="paycheck-fiat">${price() !== undefined ? fiat(weekly, price(), S.currency) + ' a week' : '&nbsp;'}</p>
    <p class="paycheck-today">Earned today, about <span class="num" id="ticker">0.0000</span> NIM</p>
  </section>

  ${S.pending ? `<p class="notice" role="status">Sent. Waiting for the network to confirm it…</p>` : ''}

  <dl class="stats panel">
    <div><dt>Staked</dt><dd class="stat num">${nim(s.balance)}</dd><dd class="stat-sub">NIM earning</dd></div>
    <div>${paidCell}</div>
    <div><dt>Yearly rate</dt><dd class="stat num">${pct(rateFor(v))}</dd><dd class="stat-sub">after fee</dd></div>
  </dl>

  ${s.inactiveBalance || s.retiredBalance ? `
  <section class="panel" aria-label="Withdrawal">
    <h2 class="label">Withdrawal</h2>
    ${s.inactiveBalance ? `<div class="step">
      <div><b>${nim(s.inactiveBalance)} NIM</b> ${released ? 'is ready to unlock' : `unlocks in about ${duration(leftMs)}`}</div>
      ${released ? `<button class="btn btn-primary btn-sm" data-a="retire" ${locked ? 'disabled' : ''}>Unlock</button>` : ''}
    </div>
    <div class="step-actions">
      ${!released ? `<button class="link" data-a="keepEarning" ${locked ? 'disabled' : ''}>Keep earning instead</button>` : ''}
      ${!released && isDemo() ? `<button class="link" data-a="skipWait">Skip the wait (demo)</button>` : ''}
    </div>` : ''}
    ${s.retiredBalance ? `<div class="step"><div><b>${nim(s.retiredBalance)} NIM</b> is unlocked</div><button class="btn btn-primary btn-sm" data-a="remove" ${locked ? 'disabled' : ''}>Move to wallet</button></div>` : ''}
    <p class="hint">The network holds withdrawn NIM for about 12 hours so validators stay honest. It stays yours the whole time.</p>
  </section>` : ''}

  ${checkupPanel()}

  ${goalBlock}

  <section class="panel">
    <div class="row-h"><h2 class="label">Who pays you</h2>${s.balance ? '<button class="link" data-a="sheet" data-sheet="validators">Switch</button>' : ''}</div>
    ${v ? validatorRow(v) : `<p class="hint">${s.delegation ? esc(shortAddress(s.delegation)) : 'Not delegated to a validator'}</p>`}
    ${v && !paysStakers(v) ? '<p class="msg err">This validator does not pay its stakers. Switch to one that does.</p>' : ''}
    ${v?.jailedFrom ? '<p class="msg err">This validator is jailed and not earning right now. Consider switching.</p>' : ''}
  </section>

  <div class="actions">
    <button class="btn btn-primary" data-a="sheet" data-sheet="add" ${locked ? 'disabled' : ''}>Stake more</button>
    <button class="btn" data-a="sheet" data-sheet="card" ${s.balance ? '' : 'disabled'}>Share</button>
  </div>
  <div class="actions-quiet">
    <button class="link" data-a="sheet" data-sheet="withdraw" ${locked || !s.balance ? 'disabled' : ''}>Withdraw</button>
    <button class="link" data-a="sheet" data-sheet="how">How it works</button>
  </div>
  ${activityPanel()}`
}

function sheet(): string {
  if (!S.sheet) return ''
  const s = S.staker
  let title = ''
  let body = ''
  switch (S.sheet) {
    case 'add':
      title = 'Stake more'
      body = `<div class="amount"><input id="amt-add" inputmode="decimal" autocomplete="off" enterkeyhint="done" placeholder="0" aria-label="Amount to add" aria-describedby="avail-add"><span aria-hidden="true">NIM</span></div>
      ${amtFiat('add')}
      ${walletLine('avail-add', 'In your wallet', S.spendable)}
      ${presets('amt-add', [0.25, 0.5, 0.75, 1])}
      ${payRows('New weekly pay')}
      <button class="btn btn-primary btn-block" id="go-add" data-a="stakeMore" ${S.busy || S.pending ? 'disabled' : ''}>${busyLabel('Add to my stake')}</button>`
      break
    case 'withdraw':
      title = 'Withdraw'
      body = `<p class="lede">Withdrawn NIM stops earning and cools down for about 12 hours. Then you unlock it and move it to your wallet. You can cancel while it cools down.</p>
      <div class="amount"><input id="amt-out" inputmode="decimal" autocomplete="off" enterkeyhint="done" placeholder="0" aria-label="Amount to withdraw" aria-describedby="avail-out"><span aria-hidden="true">NIM</span></div>
      ${amtFiat('out')}
      ${walletLine('avail-out', 'Staked', s?.balance ?? 0)}
      ${presets('amt-out', [0.25, 0.5, 1], s?.balance ?? 0)}
      <p class="msg" id="out-week"></p>
      <button class="btn btn-ink btn-block" data-a="withdraw" ${S.busy || S.pending ? 'disabled' : ''}>${busyLabel('Start withdrawal')}</button>`
      break
    case 'validators': {
      title = s ? 'Switch validator' : 'Choose who pays you'
      const list = [...S.validators].sort((a, b) => validatorScore(b) - validatorScore(a))
      body = `<p class="lede">Ranked by what reaches you: uptime, fee, and whether your pay compounds.${s ? ' Your NIM stays staked while it moves over.' : ''}</p>
      <div class="vlist">${list.map(v => validatorRow(v, { action: 'pick', selected: s ? sameAddress(v.address, s.delegation) : v.address === S.pick?.address })).join('')}</div>`
      break
    }
    case 'goal':
      title = 'Paycheck goal'
      body = `<p class="lede">How much should your stake pay you every week?</p>
      <div class="amount"><input id="goal-in" inputmode="decimal" autocomplete="off" enterkeyhint="done" placeholder="100" aria-label="Weekly goal in NIM" value="${S.goalWeekly || ''}"><span aria-hidden="true">NIM a week</span></div>
      <p class="hint">You'd need about <b id="goal-need">a little</b> staked.</p>
      <button class="btn btn-primary btn-block" data-a="saveGoal">Save goal</button>
      ${S.goalWeekly ? '<button class="link link-center" data-a="clearGoal">Remove goal</button>' : ''}`
      setTimeout(updateGoalCalc, 0)
      break
    case 'settings':
      title = 'Settings'
      body = `<h3 class="label">Appearance</h3>
      <div class="seg" role="group" aria-label="Appearance">${(['system', 'light', 'dark'] as Theme[]).map(t => `<button data-a="theme" data-theme="${t}" aria-pressed="${S.theme === t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
      <h3 class="label">Show values in</h3>
      <div class="curs" role="group" aria-label="Currency">${CURRENCIES.map(c => `<button class="${c === S.currency ? 'on' : ''}" aria-pressed="${c === S.currency}" data-a="currency" data-cur="${c}">${c.toUpperCase()}</button>`).join('')}</div>
      <p class="hint">Prices from CoinGecko, refreshed every few minutes. Payday stores only these choices, your goal and your lesson progress, on this device.</p>`
      break
    case 'lesson': {
      const ls = lessonSheet(); title = ls.title; body = ls.body
      break
    }
    case 'currency':
      title = 'Show values in'
      body = `<div class="curs" role="group" aria-label="Currency">${CURRENCIES.map(c => `<button class="${c === S.currency ? 'on' : ''}" aria-pressed="${c === S.currency}" data-a="currency" data-cur="${c}">${c.toUpperCase()}</button>`).join('')}</div>
      <p class="hint">Prices from CoinGecko, refreshed every few minutes.</p>`
      break
    case 'card': {
      title = 'Share your payday'
      const v = myValidator()
      const w = weeklyPay(s?.balance ?? 0, v)
      body = `<figure class="pcard">
        <div class="pcard-top">${logo}<span>Payday</span><span class="pcard-date">${fmtDate(Date.now())}</span></div>
        <p class="pcard-line">My NIM pays me</p>
        <p class="pcard-amount"><span class="num">${nim(w)}</span> NIM</p>
        <p class="pcard-line">every week, while I do nothing.</p>
        <figcaption class="pcard-foot"><span>${pct(rateFor(v))} a year</span><span>Paid ${v ? esc(payoutLabel(v)) : 'regularly'}</span></figcaption>
      </figure>
      <button class="btn btn-primary btn-block" data-a="share">Share</button>`
      break
    }
    case 'how':
      title = 'How Payday works'
      body = `<ol class="how">
        <li><b>You stake NIM</b> with a validator, one of the computers that run the Nimiq network. Your NIM stays under your control; the validator can never spend it.</li>
        <li><b>The network pays validators</b> for every block. Right now that is about ${S.apr ? pct(S.apr) : '8%'} a year on all staked NIM.</li>
        <li><b>Your validator pays you</b> your share minus its fee. Most add it straight back to your stake, so your weekly pay grows by itself.</li>
        <li><b>Withdraw any time.</b> Withdrawn NIM cools down for about 12 hours, then you unlock it and it is back in your wallet.</li>
      </ol>
      <p class="hint">The rate is live: today's network reward divided by all NIM staked. Payday has no server and never holds your NIM. You approve every action in Nimiq Pay.</p>`
      break
  }
  const fresh = S.sheet !== lastSheet
  return `<div class="backdrop ${fresh ? 'anim' : ''}" data-a="close"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
    <div class="sheet-head"><h2 id="sheet-title">${title}</h2><button class="x" data-a="close" aria-label="Close">×</button></div>
    ${body}</div></div>`
}

function skeleton() {
  return `<div class="skel" aria-busy="true" aria-label="Loading your NIM">
    <div class="skel-block skel-hero"></div>
    <div class="skel-block"></div>
    <div class="skel-block skel-short"></div>
  </div>`
}

let lastSheet: Sheet = null
function render() {
  let main = ''
  if (S.phase === 'loading') {
    main = skeleton()
  }
  else if (S.phase === 'outside') {
    main = `<section class="intro intro-outside">
      <h1>Turn your NIM into a weekly paycheck</h1>
      <p class="lede">Payday stakes your NIM in one tap and shows what it pays you every week. It runs inside Nimiq Pay.</p>
      <a class="btn btn-primary btn-block" href="${appLink()}">Open in Nimiq Pay</a>
      <button class="btn btn-block" data-a="demo">Try the demo</button>
      <p class="hint">The demo uses pretend NIM with live network rates. Nothing is sent.</p>
    </section>`
  }
  else if (S.phase === 'error') {
    main = `<section class="intro"><h1>Payday couldn't start</h1><p class="lede">${esc(S.fatal)}</p><button class="btn btn-primary btn-block" data-a="retry">Try again</button></section>`
  }
  else {
    main = (S.dataError ? `<div class="notice notice-err" role="alert"><span>${esc(S.dataError)}</span><button class="link" data-a="refresh">Retry</button></div>` : '')
      + (!S.synced ? '<p class="notice">Nimiq Pay is still syncing with the network. Numbers may lag for a moment.</p>' : '')
      + (isDemo() ? '<p class="notice">Demo with pretend NIM and real network rates. Open Payday in Nimiq Pay to stake for real.</p>' : '')
      + (S.tab === 'plan' ? planView() : S.tab === 'learn' ? learnView()
        : !S.validators.length && S.dataError ? '' : S.staker && totalStaked() > 0 ? homeStaking() : homeNotStaking())
  }
  const t = S.toast ? `<div class="toast ${S.toast.kind === 'err' ? 'toast-err' : ''}" role="${S.toast.kind === 'err' ? 'alert' : 'status'}">${esc(S.toast.text)}</div>` : ''
  // keep typed amounts, focus and list scroll across re-renders
  const kept: Record<string, string> = {}
  for (const id of ['amt-new', 'amt-add', 'amt-out', 'goal-in', 'plan-in']) {
    const el = document.getElementById(id) as HTMLInputElement | null
    if (el) kept[id] = el.value
  }
  const focused = document.activeElement?.id
  const listScroll = document.querySelector('.vlist')?.scrollTop ?? 0
  const sheetScroll = S.sheet === lastSheet ? document.querySelector('.sheet')?.scrollTop ?? 0 : 0
  app.innerHTML = `${header()}<main>${main}</main>${S.phase === 'ready' ? tabBar() : ''}${sheet()}${t}`
  const sh = document.querySelector('.sheet'); if (sh && sheetScroll) sh.scrollTop = sheetScroll
  lastSheet = S.sheet
  for (const [id, val] of Object.entries(kept)) {
    const el = document.getElementById(id) as HTMLInputElement | null
    if (el) el.value = val
  }
  for (const id of ['amt-new', 'amt-add']) {
    const el = document.getElementById(id) as HTMLInputElement | null
    if (el) updateCalc(el)
  }
  updateWithdrawCalc()
  const vl = document.querySelector('.vlist')
  if (vl) vl.scrollTop = listScroll
  if (focused) (document.getElementById(focused) as HTMLInputElement | null)?.focus()
}

// Live "earned today": active stake × rate, accrued since local midnight.
function tick() {
  const el = document.getElementById('ticker')
  if (el && S.staker) {
    const perMs = S.staker.balance * rateFor(myValidator()) / (365 * 86_400_000)
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0)
    el.textContent = new Intl.NumberFormat('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(perMs * (Date.now() - midnight.getTime()) / LUNA)
  }
  setTimeout(tick, 250)
}
tick()

start()
