import './style.css'
import {
  type Net, type Staker, type Validator, type Policy, type Currency, CURRENCIES, LUNA,
  getStaker, getSpendable, getHead, getPolicy, getEarnings, networkStats, getValidators, getPrices, project, type NetStats,
  bestValidator, validatorScore, paysStakers, payoutLabel, sameAddress, shortAddress, cleanAddress, formatAddress,
} from './chain'
import { type Wallet, WalletError, connectNimiqPay, demoWallet } from './wallet'
import { nim, fiat, pct, duration, esc, parseNim } from './format'
import { checkup } from './health'
import { LESSONS } from './learn'
import {
  type Missed, type Payslip, type Circle, missedEarnings, demoMissed, weekKey, streak, payslipMessage, encodePayslip,
  decodePayslip, bolt11Sats, isLightningInvoice, PARTNERS, openInPay, encodeCircle, decodeCircle,
} from './features'
import { addressFromPublicKey, verifyNimiqMessage } from './crypto'

// ── State ────────────────────────────────────────────────────────────────────
type Sheet = null | 'add' | 'validators' | 'withdraw' | 'goal' | 'card' | 'currency' | 'how' | 'settings' | 'lesson' | 'spend' | 'payslip' | 'newcircle'
type Tab = 'pay' | 'plan' | 'circles' | 'learn'
type Theme = 'system' | 'light' | 'dark'
interface Activity { t: number, text: string }
interface Paid { amount: number, since: number, tracked: boolean }
const S = {
  phase: 'loading' as 'loading' | 'outside' | 'connect' | 'error' | 'ready' | 'verify',
  demoConnect: false, // the connect screen is the demo's walkthrough, not a real decline
  approval: null as null | { title: string, rows: [string, string][], note: string, ok: string, resolve: (ok: boolean) => void },
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
  missed: null as Missed | null,
  weeks: [] as string[],
  reveal: false,
  payslipLink: '',
  verify: null as null | { p: Payslip, sigOk: boolean, addrOk: boolean, live: Staker | null | 'demo' | 'error', liveName: string },
  verifyErr: '',
  circles: [] as Circle[],
  circle: '',
  circleData: {} as Record<string, { staked: number, weekly: number } | null | 'loading'>,
  joinCircle: null as Circle | null,
  invoice: '',
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
    if (S.staker?.balance) {
      const k = weekKey()
      if (!S.weeks.includes(k)) { S.weeks = [...S.weeks, k].slice(-104); store.set(weeksKey(), S.weeks) }
    }
    if (full && S.stats) {
      const fee = (myValidator() ?? S.pick)?.fee ?? 0
      if (w.kind === 'demo') S.missed = demoMissed(S.net, S.stats, fee)
      else missedEarnings(S.net, w.accounts, S.stats, fee).then(m => { S.missed = m; render() }).catch(() => {})
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
  const forced = location.hash.match(/theme=(light|dark)/)
  if (forced) { S.theme = forced[1] as Theme; applyTheme() }
  S.learned = store.get('learned', {})
  S.circles = store.get('circles', [])
  render()
  if (location.hash.startsWith('#verify=')) return showVerify(location.hash.slice(8).split('&')[0])
  try {
    S.wallet = await connectNimiqPay(() => refresh())
  }
  catch (e) {
    if (e instanceof WalletError && e.message === 'NOT_IN_NIMIQ_PAY') {
      // Demo deep links for judges and screenshots: #demo, #demo-staked, &tab=plan|learn, &lesson=<id>
      const h = new URLSearchParams(location.hash.slice(1).replace(/^demo(-staked)?/, m => `mode=${m}`))
      if (location.hash.startsWith('#connect')) {
        S.phase = 'connect'; S.demoConnect = true; render()
        if (location.hash.includes('ask=share')) setTimeout(() => actions.connect(document.body), 300)
        return
      }
      if (h.get('mode')) return startDemoLink(h)
      S.phase = 'outside'; render(); return
    }
    if (e instanceof WalletError && e.message === 'NOT_CONNECTED') { S.phase = 'connect'; S.demoConnect = false; render(); return }
    S.phase = 'error'; S.fatal = e instanceof Error ? e.message : String(e); render(); return
  }
  await enter()
}

/**
 * In the demo, act out what Nimiq Pay does for real: a native approval for every wallet action.
 * The mock is labelled as a demo and only explains; it never asks for anything sensitive.
 */
function askApproval(title: string, rows: [string, string][], note: string, ok = 'Approve'): Promise<boolean> {
  return new Promise(resolve => { S.approval = { title, rows, note, ok, resolve }; render() })
}
const vName = (addr: string) => S.validators.find(v => sameAddress(v.address, addr))?.name ?? shortAddress(addr)
function withDemoApprovals(w: Wallet): Wallet {
  const gate = async <T>(title: string, rows: [string, string][], run: () => Promise<T>): Promise<T> => {
    if (!(await askApproval(title, rows, 'Nimiq Pay shows this before anything is sent. Nothing moves until you approve it there.'))) throw new WalletError('You cancelled. Nothing was sent.', true)
    return run()
  }
  const fee: [string, string] = ['Network fee', '0 NIM']
  return {
    ...w,
    newStaker: (d, l) => gate('Stake NIM', [['Amount', `${nim(l)} NIM`], ['Validator', vName(d)], fee], () => w.newStaker(d, l)),
    addStake: l => gate('Add to stake', [['Amount', `${nim(l)} NIM`], fee], () => w.addStake(l)),
    setActive: l => gate('Change active stake', [['Earning after this', `${nim(l)} NIM`], fee], () => w.setActive(l)),
    retire: l => gate('Unlock stake', [['Amount', `${nim(l)} NIM`], fee], () => w.retire(l)),
    remove: l => gate('Withdraw to wallet', [['Amount', `${nim(l)} NIM`], fee], () => w.remove(l)),
    switchValidator: d => gate('Switch validator', [['New validator', vName(d)], fee], () => w.switchValidator(d)),
    sign: m => gate('Sign a message', [['App', 'Payday'], ['Message', 'Your payslip'], ['Moves NIM', 'No']], () => w.sign(m)),
    payLightning: inv => gate('Pay Lightning invoice', [['Amount', `${(bolt11Sats(inv) ?? 0).toLocaleString('en-US')} sats`], ['Paid with', 'NIM, swapped to BTC'], ['Swap fee', 'shown by Nimiq Pay']], () => w.payLightning(inv)),
  }
}

async function startDemoLink(h: URLSearchParams) {
  const head = await getHead('mainnet').catch(() => 0)
  S.wallet = h.get('mode') === 'demo-staked' ? demoWallet(head) : withDemoApprovals(demoWallet(head))
  await enter()
  if (h.get('mode') === 'demo-staked' && S.pick) {
    await S.wallet.newStaker(S.pick.address, 12_500 * LUNA)
    if (S.goalWeekly === 0) S.goalWeekly = 30
    logActivity('12,500 NIM is now working for you.')
    await refresh()
  }
  const theme = h.get('theme')
  if (theme === 'dark' || theme === 'light') { S.theme = theme; applyTheme() }
  const open = h.get('open')
  const oc = open ? S.circles.find(x => x.id === open) : undefined
  if (oc) { S.tab = 'circles'; S.circle = oc.id; loadCircle(oc) }
  const tab = h.get('tab')
  if (tab === 'plan' || tab === 'learn' || tab === 'circles') S.tab = tab
  const lesson = h.get('lesson')
  if (lesson && LESSONS.some(l => l.id === lesson)) { S.lesson = lesson; S.sheet = 'lesson' }
  const sheet = h.get('sheet')
  if (sheet === 'spend' || sheet === 'payslip' || sheet === 'validators') S.sheet = sheet
  if (h.get('reveal')) { S.reveal = true; revealCounted = false }
  render()
  if (h.get('ask') === 'stake') setTimeout(() => actions.stakeNew(document.body), 300)
}

async function enter() {
  S.net = S.wallet!.net
  S.currency = guessCurrency()
  S.activity = store.get(activityKey(), [])
  S.weeks = store.get(weeksKey(), [])
  if (isDemo() && !S.circles.some(x => x.id === 'demo')) seedDemoCircle()
  S.phase = 'loading'; render()
  await refresh(true)
  S.phase = 'ready'
  const inv = location.hash.match(/circle=([^&]+)/)
  if (inv) { const cc = decodeCircle(inv[1]); if (cc) { S.joinCircle = cc; S.tab = 'circles' } }
  else if (S.staker?.balance && store.get(revealKey(), '') !== weekKey() && !/demo-staked/.test(location.hash)) S.reveal = true
  render()
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
  demo: () => { S.phase = 'connect'; S.demoConnect = true; render() },
  connect: async () => {
    if (S.demoConnect) {
      const ok = await askApproval('Share your account?', [['App', 'Payday'], ['It can see', 'Your account address and balance'], ['It cannot', 'Spend, move or see your keys']], 'This is the first thing a user sees when they open Payday in Nimiq Pay.', 'Allow')
      if (!ok) { toast('Without your address Payday can only show the demo screen. Tap Connect to try again.'); return }
      S.phase = 'loading'; render()
      const head = await getHead('mainnet').catch(() => 0)
      S.wallet = withDemoApprovals(demoWallet(head))
      await enter()
      return
    }
    S.phase = 'loading'; render()
    start()
  },
  revealOpen: () => { S.reveal = true; revealCounted = false; render() },
  revealClose: () => { S.reveal = false; store.set(revealKey(), weekKey()); render() },
  revealPayslip: () => { S.reveal = false; store.set(revealKey(), weekKey()); S.payslipLink = ''; S.sheet = 'payslip'; render() },
  makePayslip: async () => {
    if (S.busy) return
    S.busy = 'Waiting for your signature'; render()
    try {
      const s = S.staker!, v = myValidator()
      const p: Payslip = {
        v: 1, app: 'Payday', net: S.net, address: isDemo() ? 'Demo account' : formatAddress(S.wallet!.address),
        staked: s.balance / LUNA, weekly: weeklyPay(s.balance, v) / LUNA, paid: S.paid ? S.paid.amount / LUNA : null,
        rate: rateFor(v), validator: v?.name ?? 'unknown', at: Date.now(), ...(isDemo() ? { demo: true } : {}),
      }
      const { publicKey, signature } = await S.wallet!.sign(payslipMessage(p))
      S.payslipLink = location.origin + location.pathname + '#verify=' + encodePayslip(p, signature, publicKey)
      logActivity('Signed a payslip.')
    }
    catch (e) { toast(e instanceof Error ? e.message : String(e), (e as WalletError).cancelled ? 'ok' : 'err') }
    finally { S.busy = ''; render() }
  },
  sharePayslip: async () => {
    const url = S.payslipLink
    try { if (navigator.share) { await navigator.share({ title: 'My Payday payslip', text: 'My NIM staking income, signed by my wallet. Check it against the live blockchain:', url }); return } }
    catch (e) { if ((e as Error).name === 'AbortError') return }
    try { await navigator.clipboard.writeText(url); toast('Payslip link copied.') }
    catch { toast('Copy the link from the box instead.', 'err') }
  },
  cashOut: () => {
    const s = S.staker!, amt = cashOutAmount()
    if (amt <= 0) return toast('Nothing earned to cash out yet.', 'err')
    act('Waiting for approval', () => S.wallet!.setActive(s.balance - amt), `${nim(amt)} NIM of earnings is cooling down. Your savings stay staked.`)
  },
  payInvoice: () => {
    const inv = (document.getElementById('ln-in') as HTMLTextAreaElement | null)?.value.trim().replace(/^lightning:/i, '') ?? ''
    if (!isLightningInvoice(inv)) return toast('Paste a Lightning invoice that starts with lnbc.', 'err')
    if (bolt11Sats(inv) === null) return toast('This invoice has no amount. Ask the merchant for one with a fixed amount.', 'err')
    act('Waiting for approval', () => S.wallet!.payLightning(inv), 'Payment sent. The merchant receives bitcoin once the swap completes.', () => { S.invoice = '' })
  },
  newCircle: () => {
    const name = (document.getElementById('c-name') as HTMLInputElement).value.trim()
    const nick = (document.getElementById('c-nick') as HTMLInputElement).value.trim() || 'Me'
    const goal = parseNim((document.getElementById('c-goal') as HTMLInputElement).value)
    if (!name) return toast('Give your circle a name.', 'err')
    const cc: Circle = { id: Math.random().toString(36).slice(2, 10), name, goal: Number.isFinite(goal) ? goal / LUNA : 0, members: [{ a: S.wallet!.address, n: nick }] }
    S.circles = [...S.circles, cc]; store.set('circles', S.circles); S.circle = cc.id; S.sheet = null
    logActivity(`Started the circle ${name}.`); render(); loadCircle(cc)
  },
  joinCircle: () => {
    const cc = S.joinCircle!
    const nick = (document.getElementById('j-nick') as HTMLInputElement).value.trim() || 'Me'
    const me = S.wallet!.address
    const merged: Circle = { ...cc, members: cc.members.some(m => sameAddress(m.a, me)) ? cc.members : [...cc.members, { a: me, n: nick }] }
    S.circles = [...S.circles.filter(x => x.id !== cc.id), merged]; store.set('circles', S.circles)
    S.joinCircle = null; S.circle = merged.id; history.replaceState(null, '', location.pathname)
    logActivity(`Joined the circle ${merged.name}.`); toast('You joined. Share the circle link so everyone sees you.'); render(); loadCircle(merged)
  },
  skipJoin: () => { S.joinCircle = null; history.replaceState(null, '', location.pathname); render() },
  openCircle: el => { const cc = S.circles.find(x => x.id === el.dataset.id); if (cc) { S.circle = cc.id; render(); loadCircle(cc) } },
  closeCircle: () => { S.circle = ''; render() },
  inviteCircle: async () => {
    const cc = S.circles.find(x => x.id === S.circle); if (!cc) return
    const url = `${appLink()}#circle=${encodeCircle(cc)}`
    try { if (navigator.share) { await navigator.share({ title: `Join ${cc.name} on Payday`, text: 'We each stake our own NIM and watch our group paycheck grow. Nobody holds anyone\'s money.', url }); return } }
    catch (e) { if ((e as Error).name === 'AbortError') return }
    try { await navigator.clipboard.writeText(url); toast('Circle link copied. Send it to your group.') }
    catch { toast('Sharing is not available here.', 'err') }
  },
  leaveCircle: () => { S.circles = S.circles.filter(x => x.id !== S.circle); store.set('circles', S.circles); S.circle = ''; render() },
  approve: () => { const a = S.approval; S.approval = null; a?.resolve(true) },
  deny: () => { const a = S.approval; S.approval = null; a?.resolve(false) },
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
  if (el.id === 'ln-in') { S.invoice = el.value; updateInvoice() }
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
// Logo: a calendar whose date is a Nimiq-hexagon coin. The day your NIM pays you.
const logo = `<svg viewBox="0 0 120 120" class="logo" aria-hidden="true"><rect class="logo-tile" width="120" height="120" rx="28"/><rect class="logo-paper" x="25" y="31" width="70" height="64" rx="13"/><path class="logo-gold" d="M25 44a13 13 0 0 1 13-13h44a13 13 0 0 1 13 13v6H25z"/><rect class="logo-ring" x="41" y="21" width="9" height="19" rx="4.5"/><rect class="logo-ring" x="70" y="21" width="9" height="19" rx="4.5"/><polygon class="logo-coin" points="44.5,72.5 52.25,59.1 67.75,59.1 75.5,72.5 67.75,85.9 52.25,85.9"/><polygon class="logo-coin-ring" points="52.5,72.5 56.25,66 63.75,66 67.5,72.5 63.75,79 56.25,79"/></svg>`

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
    ['circles', 'Circles', '<circle cx="9" cy="9" r="3.2"/><circle cx="16.5" cy="10.5" r="2.6"/><path d="M3.5 19c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5M14.5 15.2c2.3-.5 4.6.6 5.5 3.3"/>'],
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
  ${timeMachine()}
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
    <button class="btn" data-a="sheet" data-sheet="spend" ${s.balance ? '' : 'disabled'}>Spend my pay</button>
    <button class="btn" data-a="revealOpen" ${s.balance ? '' : 'disabled'}>This week's payday</button>
    <button class="btn" data-a="sheet" data-sheet="payslip" ${s.balance ? '' : 'disabled'}>Payslip</button>
  </div>
  ${S.spendable >= minStake() ? idleNudge() : ''}
  <div class="actions-quiet">
    <button class="link" data-a="sheet" data-sheet="withdraw" ${locked || !s.balance ? 'disabled' : ''}>Withdraw</button>
    <button class="link" data-a="sheet" data-sheet="how">How it works</button>
  </div>
  ${activityPanel()}`
}

function approvalModal(): string {
  const a = S.approval
  if (!a) return ''
  return `<div class="approval-wrap"><div class="approval" role="alertdialog" aria-modal="true" aria-labelledby="ap-title" aria-describedby="ap-note">
    <p class="approval-tag">Demo of the Nimiq Pay approval</p>
    <h2 id="ap-title">${esc(a.title)}</h2>
    <dl class="approval-rows">${a.rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
    <p class="hint" id="ap-note">${esc(a.note)}</p>
    <div class="actions"><button class="btn" data-a="deny">Cancel</button><button class="btn btn-primary" data-a="approve">${esc(a.ok)}</button></div>
  </div></div>`
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
    case 'spend': spendSheet(o => { title = o.title; body = o.body }); break
    case 'payslip': payslipSheet(o => { title = o.title; body = o.body }); break
    case 'newcircle':
      title = 'Start a circle'
      body = `<p class="lede">Ajo, but nobody holds the money. Everyone stakes their own NIM, and the circle shows your group paycheck so you keep each other going.</p>
      <label class="label" for="c-name">Circle name</label><input class="field" id="c-name" maxlength="40" placeholder="Family savers" autocomplete="off">
      <label class="label" for="c-nick">Your name in the circle</label><input class="field" id="c-nick" maxlength="24" placeholder="Efe" autocomplete="off">
      <label class="label" for="c-goal">Group goal, NIM a week (optional)</label><input class="field" id="c-goal" inputmode="decimal" placeholder="200" autocomplete="off">
      <p class="hint">There's no server. The circle lives in its link, so anyone with the link can see members' staking, which is public on the blockchain anyway.</p>
      <button class="btn btn-primary btn-block" data-a="newCircle">Create circle</button>`
      break
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

// ══ Standout features ═══════════════════════════════════════════════════════
const weeksKey = () => `weeks:${S.net}:${S.wallet?.address}`
const revealKey = () => `revealed:${S.net}:${S.wallet?.address}`
const fmtShort = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

// 1. Time machine ─────────────────────────────────────────────────────────────
function timeMachine(): string {
  const m = S.missed
  if (!m || m.missedNim < 1) return ''
  return `<section class="tm" aria-label="Money left on the table">
    <p class="tm-label">Money left on the table</p>
    <p class="tm-amount"><span class="num">${nim(m.missedNim * LUNA)}</span> NIM</p>
    <p class="tm-fiat">${price() !== undefined ? `${fiat(m.missedNim * LUNA, price(), S.currency)} at today's price` : '&nbsp;'}</p>
    <p class="tm-note">${isDemo() ? 'Demo: 25,000 idle NIM since' : 'What your idle NIM could have earned since'} ${fmtShort(m.since)}, at the network's real rate. ${isDemo() ? '' : 'Rebuilt from your own transactions, and rounded down.'}</p>
  </section>`
}
function idleNudge(): string {
  const r = rateFor(myValidator())
  const w = S.spendable * r * 7 / 365
  return `<section class="panel panel-quiet" aria-label="Idle NIM">
    <span class="label">${nim(S.spendable)} NIM is sitting idle</span>
    <span class="hint">It could be paying you about ${nim(w)} NIM a week.</span>
    <button class="link" data-a="sheet" data-sheet="add">Put it to work</button>
  </section>`
}

// 2. Weekly Payday reveal ─────────────────────────────────────────────────────
function revealModal(): string {
  if (!S.reveal || !S.staker) return ''
  const v = myValidator()
  const weekly = weeklyPay(S.staker.balance, v)
  const st = Math.max(1, streak(S.weeks))
  const paid = S.paid?.amount ?? 0
  let mile = st === 1 ? 'Your first payday with Payday. From now on, your NIM works every week.' : `${st} paydays in a row. Your NIM hasn't missed a week.`
  if (st >= 4) mile = `${st} weeks straight. That's a month of your NIM paying you.`
  if (paid > 0 && S.staker.balance > 0 && paid / S.staker.balance >= 0.01) mile += ` Staking has added ${pct(paid / (S.staker.balance - paid))} to what you put in.`
  const target = weekly / LUNA
  if (!revealCounted) { revealCounted = true; setTimeout(() => countUp('rv-num', target), 60) }
  else setTimeout(() => { const n = document.getElementById('rv-num'); if (n && !counting) n.textContent = target.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }, 0)
  return `<div class="approval-wrap reveal-wrap"><div class="approval reveal" role="dialog" aria-modal="true" aria-labelledby="rv-title">
    <p class="hint">Week of ${new Date(Date.now() - ((new Date().getDay() + 6) % 7) * 86_400_000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</p>
    <h2 id="rv-title" class="reveal-title">It's payday</h2>
    <p class="reveal-amount"><span class="num" id="rv-num">0.00</span> NIM</p>
    <p class="hint">is what your stake pays you this week${price() !== undefined ? `, about ${fiat(weekly, price(), S.currency)}` : ''}.</p>
    <dl class="reveal-stats">
      <div><dt>Streak</dt><dd class="num">${st} wk</dd></div>
      <div><dt>Paid so far</dt><dd class="num">${S.paid ? nim(S.paid.amount) : '–'}</dd></div>
      <div><dt>Yearly rate</dt><dd class="num">${pct(rateFor(v))}</dd></div>
    </dl>
    <p class="reveal-mile">${esc(mile)}</p>
    <div class="actions"><button class="btn" data-a="revealClose">Done</button><button class="btn btn-primary" data-a="revealPayslip">Get my payslip</button></div>
  </div></div>`
}
let revealCounted = false
let counting = false
function countUp(id: string, to: number) {
  const el = document.getElementById(id)
  if (!el) return
  const fmt = (x: number) => x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = fmt(to); return }
  const t0 = performance.now(), dur = 1400
  counting = true
  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / dur), e = 1 - (1 - k) ** 3
    const n = document.getElementById(id); if (!n) { counting = false; return }
    n.textContent = fmt(to * e)
    if (k < 1) requestAnimationFrame(step)
    else counting = false
  }
  requestAnimationFrame(step)
}

// 3. Verifiable payslip ───────────────────────────────────────────────────────
function payslipSheet(set: (o: { title: string, body: string }) => void) {
  const s = S.staker, v = myValidator()
  if (!s) return set({ title: 'Payslip', body: '<p class="lede">Start staking to get a payslip.</p>' })
  const rows: [string, string][] = [
    ['Account', isDemo() ? 'Demo account' : shortAddress(S.wallet!.address)],
    ['Staked', `${nim(s.balance)} NIM`],
    ['Weekly pay', `${nim(weeklyPay(s.balance, v))} NIM`],
    ['Paid so far', S.paid ? `${nim(S.paid.amount)} NIM` : 'not available'],
    ['Yearly rate', pct(rateFor(v))],
    ['Validator', v?.name ?? 'unknown'],
  ]
  set({
    title: 'Your payslip',
    body: `<p class="lede">Proof of what your NIM earns, signed by your wallet. Anyone with the link can check it against the live blockchain.</p>
    <dl class="approval-rows">${rows.map(([k, val]) => `<div><dt>${k}</dt><dd>${esc(val)}</dd></div>`).join('')}</dl>
    ${S.payslipLink
      ? `<label class="label" for="ps-link">Your payslip link</label><input class="field" id="ps-link" readonly value="${esc(S.payslipLink)}">
         <button class="btn btn-primary btn-block" data-a="sharePayslip">Share payslip</button>
         <a class="link link-center" href="${esc(S.payslipLink)}" target="_blank" rel="noopener">Open the check page</a>`
      : `<p class="hint">Signing doesn't move any NIM. Nimiq Pay asks you to approve the message first.</p>
         <button class="btn btn-primary btn-block" data-a="makePayslip" ${S.busy ? 'disabled' : ''}>${S.busy ? esc(S.busy) + '…' : 'Sign and create link'}</button>`}`,
  })
}

async function showVerify(raw: string) {
  S.phase = 'verify'; render()
  const d = decodePayslip(raw)
  if (!d) { S.verifyErr = 'This payslip link is broken or incomplete. Ask for a fresh one.'; render(); return }
  const sigOk = await verifyNimiqMessage(payslipMessage(d.p), d.sig, d.pub)
  const addrOk = d.p.demo ? true : sameAddress(addressFromPublicKey(d.pub), d.p.address)
  let live: Staker | null | 'demo' | 'error' = 'demo'
  let liveName = ''
  if (!d.p.demo) {
    try {
      const [st, vals] = await Promise.all([getStaker(d.p.net, d.p.address), getValidators(d.p.net).catch(() => [] as Validator[])])
      live = st
      liveName = st?.delegation ? vals.find(v => sameAddress(v.address, st.delegation))?.name ?? shortAddress(st.delegation) : ''
    }
    catch { live = 'error' }
  }
  S.verify = { p: d.p, sigOk, addrOk, live, liveName }
  render()
}

function verifyView(): string {
  if (S.verifyErr) return `<section class="intro"><h1>Payslip check</h1><p class="lede">${esc(S.verifyErr)}</p></section>`
  const r = S.verify
  if (!r) return skeleton()
  const ok = r.sigOk && r.addrOk
  const p = r.p
  const liveRow = r.live === 'demo' ? 'Demo payslip, no real account to check'
    : r.live === 'error' ? 'Could not reach the network. Try again shortly.'
      : r.live === null ? 'No stake found for this account right now'
        : `${nim(r.live.balance)} NIM staked${r.liveName ? ` with ${r.liveName}` : ''}`
  return `<section class="intro"><h1>Payslip check</h1><p class="lede">A Payday payslip, signed by the account's own wallet.</p></section>
  <div class="verdict ${ok ? 'verdict-ok' : 'verdict-bad'}" role="status">
    <span class="check-icon" aria-hidden="true">${ok ? '✓' : '!'}</span>
    <div><b>${ok ? (p.demo ? 'Genuine signature (demo payslip)' : 'Signed by this account') : 'Not verified'}</b>
    <span class="hint">${ok ? 'The signature matches. This payslip has not been changed since it was signed.' : r.sigOk ? 'The signature is real but belongs to a different account.' : 'The signature does not match. Do not trust this payslip.'}</span></div>
  </div>
  <section class="panel">
    <h2 class="label">${ok ? `What was signed on ${fmtShort(p.at)}` : 'What this link claims'}</h2>
    <dl class="approval-rows">
      <div><dt>Account</dt><dd>${esc(p.demo ? 'Demo account' : shortAddress(p.address))}</dd></div>
      <div><dt>Staked</dt><dd>${nim(p.staked * LUNA)} NIM</dd></div>
      <div><dt>Weekly pay</dt><dd>${nim(p.weekly * LUNA)} NIM</dd></div>
      <div><dt>Yearly rate</dt><dd>${pct(p.rate)}</dd></div>
      <div><dt>Validator</dt><dd>${esc(p.validator)}</dd></div>
      <div><dt>Network</dt><dd>${p.net === 'testnet' ? 'Testnet' : 'Mainnet'}</dd></div>
    </dl>
  </section>
  <section class="panel">
    <h2 class="label">Live on the blockchain now</h2>
    <p>${esc(liveRow)}</p>
    <p class="hint">Payday reads this straight from the Nimiq network, so it can't be faked by whoever sent the link.</p>
  </section>
  <a class="btn btn-primary btn-block" href="${appLink()}">Get your own Payday</a>`
}

// 4. Spend your pay ───────────────────────────────────────────────────────────
function cashOutAmount(): number {
  const s = S.staker
  if (!s || !S.paid || S.paid.amount <= 0) return 0
  let amt = Math.min(S.paid.amount, s.balance)
  if (s.balance - amt > 0 && s.balance - amt < minStake()) amt = 0
  return Math.floor(amt)
}
function nimForSats(sats: number): number | null {
  const btc = S.prices.btcUsd, nimUsd = S.prices.usd
  if (!btc || !nimUsd) return null
  return (sats / 1e8) * btc / nimUsd
}
function updateInvoice() {
  const out = document.getElementById('ln-out')
  if (!out) return
  const inv = S.invoice.trim()
  if (!inv) { out.textContent = ''; return }
  if (!isLightningInvoice(inv)) { out.textContent = 'That doesn\'t look like a Lightning invoice. It should start with lnbc.'; return }
  const sats = bolt11Sats(inv)
  if (sats === null) { out.textContent = 'This invoice has no amount. Payday can only pay invoices with a fixed amount.'; return }
  const n = nimForSats(sats)
  const earned = (S.paid?.amount ?? 0) / LUNA
  out.textContent = `${sats.toLocaleString('en-US')} sats${n !== null ? `, about ${Math.ceil(n).toLocaleString('en-US')} NIM plus the swap fee` : ''}. ${n !== null && earned > 0 ? (n <= earned ? 'Covered by what you\'ve earned.' : 'That\'s more than you\'ve earned, so part comes from savings.') : ''}`
}
function spendSheet(set: (o: { title: string, body: string }) => void) {
  const amt = cashOutAmount()
  const lnOk = S.net === 'mainnet'
  set({
    title: 'Spend your pay',
    body: `<p class="lede">Spend what your NIM earned. Your savings stay staked and keep paying you.</p>
    <section class="spend-block">
      <h3 class="label">1. Cash out your earnings</h3>
      <p>${amt > 0 ? `You've earned <b>${nim(amt)} NIM</b>${price() !== undefined ? ` (${fiat(amt, price(), S.currency)})` : ''}. Move exactly that to your wallet; it arrives after the 12-hour cooldown.` : 'Nothing earned to cash out yet. Your first pay usually lands within a day.'}</p>
      <button class="btn btn-block" data-a="cashOut" ${amt > 0 && !S.busy && !S.pending ? '' : 'disabled'}>Cash out ${amt > 0 ? nim(amt) + ' NIM' : 'earnings'}</button>
    </section>
    <section class="spend-block">
      <h3 class="label">2. Pay anything that takes Lightning</h3>
      <p class="hint">Paste a Lightning invoice from any shop, bill or friend. Nimiq Pay pays it with your NIM and the merchant receives bitcoin.</p>
      <textarea class="field" id="ln-in" rows="3" placeholder="lnbc…" autocomplete="off" spellcheck="false" ${lnOk ? '' : 'disabled'}>${esc(S.invoice)}</textarea>
      <p class="msg" id="ln-out" aria-live="polite"></p>
      <button class="btn btn-primary btn-block" data-a="payInvoice" ${lnOk && !S.busy && !S.pending ? '' : 'disabled'}>${S.busy ? esc(S.busy) + '…' : 'Pay invoice'}</button>
      ${lnOk ? '' : '<p class="hint">Lightning payments only work on mainnet.</p>'}
    </section>
    <section class="spend-block">
      <h3 class="label">3. Spend it in other Nimiq Pay apps</h3>
      <ul class="partners">${PARTNERS.map(p => `<li><a href="${openInPay(p.url)}"><b>${p.name}</b><span class="hint">${p.what}</span></a></li>`).join('')}</ul>
    </section>`,
  })
  setTimeout(updateInvoice, 0)
}

// 5. Circles ──────────────────────────────────────────────────────────────────
function seedDemoCircle() {
  const fake = (seed: string) => 'NQ00 ' + seed.padEnd(32, '0').slice(0, 32).replace(/(.{4})/g, '$1 ').trim()
  const cc: Circle = { id: 'demo', name: 'Family savers', goal: 120, members: [
    { a: fake('DEM0AAAA'), n: 'Mama' }, { a: fake('DEM0BBBB'), n: 'Tunde' }, { a: fake('DEM0CCCC'), n: 'Ada' }, { a: fake('DEM0DDDD'), n: 'Kemi' },
  ] }
  S.circles = [...S.circles.filter(x => x.id !== 'demo'), cc]
}
const DEMO_STAKES: Record<string, number> = { Mama: 40_000, Tunde: 18_500, Ada: 0, Kemi: 9_000 }

async function loadCircle(cc: Circle) {
  const rateOf = (deleg: string | null) => rateFor(deleg ? S.validators.find(v => sameAddress(v.address, deleg)) ?? null : null)
  for (const m of cc.members) {
    const key = cleanAddress(m.a)
    if (sameAddress(m.a, S.wallet?.address)) {
      const s = S.staker
      S.circleData[key] = s ? { staked: s.balance, weekly: s.balance * rateOf(s.delegation) * 7 / 365 } : null
      continue
    }
    if (cc.id === 'demo') {
      const st = (DEMO_STAKES[m.n] ?? 0) * LUNA
      S.circleData[key] = st ? { staked: st, weekly: st * (S.apr ?? 0) * 7 / 365 } : null
      continue
    }
    S.circleData[key] = 'loading'
  }
  render()
  await Promise.all(cc.members.filter(m => S.circleData[cleanAddress(m.a)] === 'loading').map(async m => {
    try {
      const st = await getStaker(S.net, m.a)
      S.circleData[cleanAddress(m.a)] = st && st.balance ? { staked: st.balance, weekly: st.balance * rateOf(st.delegation) * 7 / 365 } : null
    }
    catch { S.circleData[cleanAddress(m.a)] = null }
  }))
  render()
}

function circlesView(): string {
  if (S.joinCircle) {
    const cc = S.joinCircle
    return `<section class="intro"><h1>Join ${esc(cc.name)}</h1><p class="lede">${cc.members.length} ${cc.members.length === 1 ? 'person is' : 'people are'} in this circle. Everyone stakes their own NIM; nobody holds anyone's money.</p></section>
    <section class="panel">
      <label class="label" for="j-nick">Your name in the circle</label><input class="field" id="j-nick" maxlength="24" placeholder="Your first name" autocomplete="off">
      <p class="hint">Joining shares your account address with the circle, so they can see your staking. It's public on the blockchain anyway.</p>
      <button class="btn btn-primary btn-block" data-a="joinCircle">Join circle</button>
      <button class="link link-center" data-a="skipJoin">Not now</button>
    </section>`
  }
  const cc = S.circles.find(x => x.id === S.circle)
  if (cc) {
    const data = cc.members.map(m => ({ m, d: S.circleData[cleanAddress(m.a)] }))
    const weekly = data.reduce((s, x) => s + (x.d && x.d !== 'loading' ? x.d.weekly : 0), 0)
    const staking = data.filter(x => x.d && x.d !== 'loading').length
    const goal = cc.goal * LUNA
    const p = goal ? Math.min(1, weekly / goal) : 0
    return `<button class="link" data-a="closeCircle">All circles</button>
    <section class="paycheck" aria-label="${esc(cc.name)} group paycheck">
      <p class="paycheck-label">${esc(cc.name)} earns together</p>
      <p class="paycheck-amount"><span class="num">${nim(weekly)}</span> NIM a week</p>
      <p class="paycheck-fiat">${staking} of ${cc.members.length} members staking${price() !== undefined ? `, about ${fiat(weekly, price(), S.currency)} a week` : ''}</p>
      ${goal ? `<div class="meter meter-dark" role="progressbar" aria-label="Group goal" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p * 100)}"><i style="transform:scaleX(${p.toFixed(3)})"></i></div>
      <p class="paycheck-today">Goal: ${nim(goal)} NIM a week, ${Math.round(p * 100)}% there</p>` : ''}
    </section>
    <section class="panel" aria-label="Members">
      <h2 class="label">Members</h2>
      <ul class="members">${data.sort((a, b) => ((b.d && b.d !== 'loading') ? b.d.weekly : -1) - ((a.d && a.d !== 'loading') ? a.d.weekly : -1)).map(({ m, d }) => `<li>
        <span class="member-avatar" aria-hidden="true">${esc((m.n || '?').slice(0, 1).toUpperCase())}</span>
        <span class="member-text"><b>${esc(m.n || 'Member')}${sameAddress(m.a, S.wallet?.address) ? ' (you)' : ''}</b><span class="hint">${d === 'loading' ? 'checking…' : d ? `${nim(d.staked)} NIM staked` : 'not staking yet'}</span></span>
        <span class="num member-pay">${d && d !== 'loading' ? `${nim(d.weekly)}<small> /wk</small>` : '–'}</span>
      </li>`).join('')}</ul>
      ${data.some(x => x.d === null) ? '<p class="hint">Members who aren\'t staking yet are missing out on their share. Send them the circle link.</p>' : ''}
    </section>
    <div class="actions"><button class="btn btn-primary" data-a="inviteCircle">Invite friends</button><button class="btn" data-a="leaveCircle">Leave circle</button></div>
    <p class="hint">No server: the circle lives in its link. When someone joins, share the newest link so everyone sees them.</p>`
  }
  return `<section class="intro"><h1>Payday Circles</h1><p class="lede">Ajo, but nobody holds the money. Stake together with family and friends, watch your group paycheck, and keep each other going.</p></section>
  ${S.circles.length ? `<ul class="lessons">${S.circles.map(x => `<li><button class="lesson-row" data-a="openCircle" data-id="${esc(x.id)}">
    <span class="lesson-n" aria-hidden="true">${esc(x.name.slice(0, 1).toUpperCase())}</span>
    <span class="lesson-text"><b>${esc(x.name)}</b><span class="hint">${x.members.length} member${x.members.length === 1 ? '' : 's'}${x.goal ? `, goal ${nim(x.goal * LUNA)} NIM a week` : ''}</span></span></button></li>`).join('')}</ul>` : ''}
  <button class="btn btn-primary btn-block" data-a="sheet" data-sheet="newcircle" ${S.wallet ? '' : 'disabled'}>Start a circle</button>
  <ol class="how">
    <li><b>Start a circle</b> and share its link in your group chat.</li>
    <li><b>Everyone stakes their own NIM</b> in their own Nimiq Pay. No one collects money, so no one can run off with it.</li>
    <li><b>Watch the group paycheck grow</b> and see who still needs to start.</li>
  </ol>`
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
  else if (S.phase === 'connect') {
    main = `<section class="intro intro-outside">
      ${S.demoConnect ? '<p class="notice">Demo: this is what a user sees the first time they open Payday in Nimiq Pay.</p>' : ''}
      <h1>Connect your Nimiq Pay account</h1>
      <p class="lede">Payday needs your account address to show your NIM and what it can earn.</p>
      <ul class="trust">
        <li><b>Only your address.</b> Payday never sees your keys or recovery words.</li>
        <li><b>You approve every action.</b> Nimiq Pay asks before any NIM moves.</li>
        <li><b>Nothing to sign up for.</b> No email, no password, no server.</li>
      </ul>
      <button class="btn btn-primary btn-block" data-a="connect">Connect account</button>
    </section>`
  }
  else if (S.phase === 'verify') {
    main = verifyView()
  }
  else if (S.phase === 'error') {
    main = `<section class="intro"><h1>Payday couldn't start</h1><p class="lede">${esc(S.fatal)}</p><button class="btn btn-primary btn-block" data-a="retry">Try again</button></section>`
  }
  else {
    main = (S.dataError ? `<div class="notice notice-err" role="alert"><span>${esc(S.dataError)}</span><button class="link" data-a="refresh">Retry</button></div>` : '')
      + (!S.synced ? '<p class="notice">Nimiq Pay is still syncing with the network. Numbers may lag for a moment.</p>' : '')
      + (isDemo() ? '<p class="notice">Demo with pretend NIM and real network rates. Open Payday in Nimiq Pay to stake for real.</p>' : '')
      + (S.tab === 'plan' ? planView() : S.tab === 'learn' ? learnView() : S.tab === 'circles' ? circlesView()
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
  app.innerHTML = `${header()}<main>${main}</main>${S.phase === 'ready' ? tabBar() : ''}${sheet()}${revealModal()}${approvalModal()}${t}`
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

// Opening a payslip or circle link while Payday is already open: start fresh with that link.
window.addEventListener('hashchange', () => { if (/^#(verify|circle)=/.test(location.hash.replace('#circle', '#circle').replace(/^#.*?(circle=)/, '#circle='))) location.reload() })

start()
