import './style.css'
import {
  type Net, type Staker, type Validator, type Policy, type Currency, CURRENCIES, LUNA,
  getStaker, getBalance, getHead, getPolicy, getEarnings, networkApr, getValidators, getPrices,
  bestValidator, validatorScore, paysStakers, payoutLabel, sameAddress, shortAddress,
} from './chain'
import { type Wallet, WalletError, connectNimiqPay, demoWallet } from './wallet'
import { nim, fiat, pct, duration, esc, parseNim } from './format'

// ── State ────────────────────────────────────────────────────────────────────
type Sheet = null | 'add' | 'validators' | 'withdraw' | 'goal' | 'card' | 'currency' | 'how'
const S = {
  phase: 'loading' as 'loading' | 'outside' | 'error' | 'ready',
  fatal: '',
  wallet: null as Wallet | null,
  net: 'mainnet' as Net,
  balance: 0,
  staker: null as Staker | null,
  principal: null as number | null,
  historyComplete: true,
  apr: null as number | null,
  validators: [] as Validator[],
  pick: null as Validator | null, // validator chosen for a new stake
  prices: {} as Record<string, number>,
  currency: 'usd' as Currency,
  head: 0,
  headAt: Date.now(),
  policy: null as Policy | null,
  sheet: null as Sheet,
  busy: '' as string, // label of the action in flight
  toast: null as null | { text: string, kind: 'ok' | 'err' },
  goalWeekly: 0, // NIM per week
  dataError: '',
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
const totalStaked = () => S.staker ? S.staker.balance + S.staker.inactiveBalance + S.staker.retiredBalance : 0
const paidSoFar = () => S.principal === null || !S.staker ? null : Math.max(0, totalStaked() - S.principal)
const minStake = () => S.policy?.minimumStake ?? 100 * LUNA
const blockMs = () => S.policy?.blockSeparationTime ?? 1000
const headNow = () => S.head + Math.floor((Date.now() - S.headAt) / blockMs())

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

// ── Data loading ─────────────────────────────────────────────────────────────
async function refresh(full = false) {
  const w = S.wallet!
  try {
    if (w.kind === 'demo') {
      const d = w.demo!
      S.balance = d.balance
      S.staker = d.staker ? { ...d.staker } : null
      S.principal = d.principal
      S.head = await getHead('mainnet').catch(() => S.head); S.headAt = Date.now(); d.head = S.head
    }
    else {
      const [bal, staker, head] = await Promise.all([getBalance(S.net, w.address), getStaker(S.net, w.address), getHead(S.net)])
      S.balance = bal; S.staker = staker; S.head = head; S.headAt = Date.now()
      if (staker) {
        const e = await getEarnings(S.net, w.address).catch(() => null)
        S.principal = e ? e.principal : null
        S.historyComplete = e?.complete ?? false
      }
      else { S.principal = null }
    }
    if (full || !S.validators.length) {
      const [vals, apr, policy] = await Promise.all([getValidators(S.net), networkApr(S.net), getPolicy(S.net)])
      S.validators = vals; S.apr = apr; S.policy = policy
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

async function start() {
  S.goalWeekly = store.get('goal', 0)
  render()
  try {
    S.wallet = await connectNimiqPay()
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
  S.phase = 'loading'; render()
  await refresh(true)
  S.phase = 'ready'; render()
  setInterval(() => { if (!document.hidden && !S.busy) refresh() }, 30_000)
}

// ── Actions ──────────────────────────────────────────────────────────────────
function toast(text: string, kind: 'ok' | 'err' = 'ok') {
  S.toast = { text, kind }; render()
  setTimeout(() => { if (S.toast?.text === text) { S.toast = null; render() } }, kind === 'ok' ? 4500 : 7000)
}

async function act(label: string, fn: () => Promise<string>, success: string) {
  if (S.busy) return
  S.busy = label; render()
  try {
    await fn()
    S.sheet = null
    toast(success)
    // The network confirms in about a second; read back the new state.
    await new Promise(r => setTimeout(r, S.wallet?.kind === 'demo' ? 0 : 2500))
    await refresh()
    if (S.wallet?.kind !== 'demo') setTimeout(() => refresh(), 8000)
  }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    toast(msg, (e as WalletError).cancelled ? 'ok' : 'err')
  }
  finally { S.busy = ''; render() }
}

function readAmount(id: string): number {
  const el = document.getElementById(id) as HTMLInputElement | null
  return el ? parseNim(el.value) : NaN
}

function validateStake(luna: number, isNew: boolean): string | null {
  if (!Number.isFinite(luna) || luna <= 0) return 'Enter how much NIM to stake.'
  if (luna > S.balance) return `You only have ${nim(S.balance)} NIM available.`
  if (isNew && luna < minStake()) return `The network minimum to start staking is ${nim(minStake())} NIM.`
  return null
}

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
    const max = el.dataset.max ? Number(el.dataset.max) : S.balance
    input.value = (Math.floor(max * Number(el.dataset.f)) / LUNA).toString()
    input.dispatchEvent(new Event('input', { bubbles: true }))
  },
  pick: el => {
    const v = S.validators.find(x => x.address === el.dataset.addr)
    if (!v) return
    if (S.staker) {
      if (sameAddress(v.address, S.staker.delegation)) { S.sheet = null; render(); return }
      act('Switching', () => S.wallet!.switchValidator(v.address), `Switched to ${v.name}. Your stake moves over at the next epoch (about 12 hours).`)
    }
    else { S.pick = v; S.sheet = null; render() }
  },
  stakeNew: () => {
    const luna = readAmount('amt-new')
    const err = validateStake(luna, true)
    if (err) return toast(err, 'err')
    if (!S.pick) return toast('Pick a validator first.', 'err')
    const v = S.pick
    act('Staking', () => S.wallet!.newStaker(v.address, luna), `Done! ${nim(luna)} NIM is now working for you.`)
  },
  stakeMore: () => {
    const luna = readAmount('amt-add')
    const err = validateStake(luna, false)
    if (err) return toast(err, 'err')
    act('Adding', () => S.wallet!.addStake(luna), `Added ${nim(luna)} NIM. Your paycheck just went up.`)
  },
  withdraw: () => {
    const s = S.staker!
    const luna = readAmount('amt-out')
    if (!Number.isFinite(luna) || luna <= 0) return toast('Enter how much NIM to withdraw.', 'err')
    if (luna > s.balance) return toast(`Only ${nim(s.balance)} NIM is actively staked.`, 'err')
    const left = s.balance - luna
    if (left > 0 && left < minStake()) return toast(`Leave at least ${nim(minStake())} NIM staked, or withdraw everything.`, 'err')
    act('Pausing', () => S.wallet!.setActive(left), `${nim(luna)} NIM is cooling down. Come back when the timer ends to unlock it.`)
  },
  retire: () => {
    const s = S.staker!
    act('Unlocking', () => S.wallet!.retire(s.inactiveBalance), 'Unlocked. One last tap moves it to your wallet.')
  },
  remove: () => {
    const s = S.staker!
    const amount = s.retiredBalance
    act('Moving', () => S.wallet!.remove(amount), `${nim(amount)} NIM is back in your wallet.`)
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
      if (navigator.share) { await navigator.share({ title: 'My NIM Payday', text, url }); return }
    }
    catch (e) { if ((e as Error).name === 'AbortError') return }
    try { await navigator.clipboard.writeText(`${text}\n${url}`); toast('Copied. Paste it anywhere.') }
    catch { toast('Sharing is not available here.', 'err') }
  },
  refresh: () => { refresh(true) },
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
})
app.addEventListener('input', e => {
  const el = e.target as HTMLInputElement
  if (el.id === 'amt-new' || el.id === 'amt-add') updateCalc(el)
  if (el.id === 'goal-in') updateGoalCalc()
})
document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.sheet) { S.sheet = null; render() } })

function focusSheet() { setTimeout(() => (document.querySelector('.sheet input') as HTMLInputElement | null)?.focus(), 60) }

function updateCalc(input: HTMLInputElement) {
  const luna = parseNim(input.value)
  const isNew = input.id === 'amt-new'
  const v = isNew ? S.pick : myValidator()
  const base = isNew ? 0 : (S.staker?.balance ?? 0)
  const ok = Number.isFinite(luna) && luna > 0
  const w = weeklyPay(base + (ok ? luna : 0), v)
  const set = (id: string, t: string) => { const n = document.getElementById(id); if (n) n.textContent = t }
  set('calc-week', nim(w))
  set('calc-week-fiat', w ? fiat(w, price(), S.currency) : '')
  set('calc-month', nim(w * 365 / 12 / 7))
  set('calc-year', nim(w * 365 / 7))
  set('calc-err', ok ? validateStake(luna, isNew) ?? '' : '')
}

function updateGoalCalc() {
  const luna = readAmount('goal-in')
  const r = rateFor(myValidator() ?? S.pick) * 7 / 365
  const n = document.getElementById('goal-need')
  if (n) n.textContent = Number.isFinite(luna) && luna > 0 && r > 0 ? `${nim(luna / r)} NIM` : '—'
}

function cardText() {
  const v = myValidator()
  const w = weeklyPay(S.staker?.balance ?? 0, v)
  return `My NIM paid me ${nim(w)} NIM this week while I did nothing. Staking at ${pct(rateFor(v))} a year, paid ${v ? payoutLabel(v) : 'regularly'}. Payday, inside Nimiq Pay:`
}

// ── Rendering ────────────────────────────────────────────────────────────────
const logo = `<svg viewBox="0 0 32 32" class="logo" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F7C948"/><stop offset="1" stop-color="#E58A1F"/></linearGradient></defs><path d="M9.6 2h12.8a3 3 0 0 1 2.6 1.5l6.4 11a3 3 0 0 1 0 3l-6.4 11A3 3 0 0 1 22.4 30H9.6A3 3 0 0 1 7 28.5l-6.4-11a3 3 0 0 1 0-3L7 3.5A3 3 0 0 1 9.6 2z" fill="url(#lg)"/><path d="M12.4 9.5h4.9a3.9 3.9 0 0 1 0 7.8h-2.4v5.2h-2.5zm2.5 2.3v3.2h2.3a1.6 1.6 0 0 0 0-3.2z" fill="#1F2348"/></svg>`

function header() {
  const pill = S.wallet?.kind === 'demo' ? '<span class="pill demo">Demo</span>' : S.net === 'testnet' ? '<span class="pill test">Testnet</span>' : ''
  return `<header class="top">
    <div class="brand">${logo}<span>Payday</span>${pill}</div>
    ${S.phase === 'ready' ? `<button class="chip" data-a="sheet" data-sheet="currency" aria-label="Change currency">${S.currency.toUpperCase()}</button>` : ''}
  </header>`
}

function validatorRow(v: Validator, opts: { selected?: boolean, action?: string } = {}) {
  const mark = v.logo ? `<img src="${esc(v.logo)}" alt="" class="vlogo">` : `<span class="vlogo" style="background:${esc(v.color)}">${esc(v.name.slice(0, 1))}</span>`
  const fee = v.fee >= 1 ? 'private' : `${pct(v.fee, (v.fee * 1000) % 10 ? 1 : 0)} fee`
  return `<div class="vrow ${opts.selected ? 'sel' : ''}" ${opts.action ? `data-a="${opts.action}" data-addr="${esc(v.address)}" role="button" tabindex="0"` : ''}>
    ${mark}
    <div class="vmain"><div class="vname">${esc(v.name)}</div>
      <div class="vmeta">${paysStakers(v) ? `Pays you ${esc(payoutLabel(v))}` : 'Does not pay stakers'} · ${fee}</div></div>
    <div class="vright"><div class="vrate">${pct(rateFor(v))}</div><div class="vmeta">${(v.reliability * 100).toFixed(1)}% up</div></div>
  </div>`
}

const presets = (target: string, fr: number[], max?: number) =>
  `<div class="presets">${fr.map(f => `<button data-a="preset" data-target="${target}" ${max !== undefined ? `data-max="${max}"` : ''} data-f="${f}">${f === 1 ? (max !== undefined ? 'All' : 'Max') : f * 100 + '%'}</button>`).join('')}</div>`

const payGrid = (label: string) => `<div class="paygrid">
  <div class="big"><span class="k">${label}</span><span class="v"><b id="calc-week">0</b> NIM</span><span class="f" id="calc-week-fiat"></span></div>
  <div><span class="k">Monthly</span><span class="v sm"><b id="calc-month">0</b> NIM</span></div>
  <div><span class="k">Yearly</span><span class="v sm"><b id="calc-year">0</b> NIM</span></div>
</div><p class="err" id="calc-err"></p>`

function homeNotStaking() {
  const v = S.pick
  const low = S.balance < minStake()
  return `
  <section class="hero">
    <p class="eyebrow">Your NIM can pay you</p>
    <h1>Turn your NIM into a <em>paycheck.</em></h1>
    <p class="sub">Stake once. Get paid ${v && paysStakers(v) ? esc(payoutLabel(v)) : 'every few hours'}, automatically. Withdraw any time.</p>
  </section>

  <section class="card calc">
    <label for="amt-new" class="lbl">How much NIM should work for you?</label>
    <div class="amount"><input id="amt-new" inputmode="decimal" autocomplete="off" placeholder="0" value="${low ? '' : Math.floor(S.balance * 0.5 / LUNA)}"><span>NIM</span></div>
    <div class="avail">Available: <b>${nim(S.balance)} NIM</b></div>
    ${presets('amt-new', [0.25, 0.5, 0.75, 1])}
    ${payGrid('Your weekly pay')}
  </section>

  <section class="card">
    <div class="row-h"><span class="lbl">Who pays you</span><button class="link" data-a="sheet" data-sheet="validators">Change</button></div>
    ${v ? validatorRow(v) : '<p class="muted">Loading validators…</p>'}
    <p class="note">Picked for you: high uptime, low fee, and your pay goes straight back into your stake so it compounds.</p>
  </section>

  ${low ? `<div class="banner">${S.net === 'testnet'
    ? `You need at least ${nim(minStake())} NIM. On testnet, tap <b>Get free NIM</b> on the Nimiq Pay home screen.`
    : `You need at least ${nim(minStake())} NIM to start. Top up in Nimiq Pay, then come back.`}</div>` : ''}

  <div class="cta-bar"><button class="cta" data-a="stakeNew" ${S.busy || low || !v ? 'disabled' : ''}>${S.busy ? esc(S.busy) + '…' : 'Start getting paid'}</button></div>
  <button class="link center" data-a="sheet" data-sheet="how">How does this work?</button>`
}

function homeStaking() {
  const s = S.staker!
  const v = myValidator()
  const weekly = weeklyPay(s.balance, v)
  const paid = paidSoFar()
  const goal = S.goalWeekly * LUNA
  const rel = releaseBlock()
  const leftMs = rel !== null ? (rel - headNow()) * blockMs() : 0
  const released = rel !== null && headNow() >= rel

  let goalCard: string
  if (goal) {
    const p = Math.min(1, weekly / goal)
    const r = rateFor(v) * 7 / 365
    const need = r > 0 ? goal / r - s.balance : 0
    goalCard = `<section class="card goal" data-a="sheet" data-sheet="goal" role="button" tabindex="0">
      <div class="row-h"><span class="lbl">Goal: ${nim(goal)} NIM a week</span><span class="gp">${Math.round(p * 100)}%</span></div>
      <div class="bar"><i style="width:${(p * 100).toFixed(1)}%"></i></div>
      <p class="note">${p >= 1 ? 'Goal reached. Time for a bigger one?' : `Stake ${nim(Math.max(0, need))} more NIM to get there.`}</p>
    </section>`
  }
  else {
    goalCard = `<button class="card goal empty" data-a="sheet" data-sheet="goal"><b>Set a paycheck goal</b><span>How much should your NIM pay you each week?</span></button>`
  }

  return `
  <section class="paycheck">
    <p class="eyebrow">Your weekly paycheck</p>
    <div class="pay"><span class="num">${nim(weekly)}</span><span class="unit">NIM</span></div>
    <p class="payfiat">${price() !== undefined ? fiat(weekly, price(), S.currency) + ' a week' : '&nbsp;'}</p>
    <div class="ticker"><span class="dot"></span>Earned today <b id="ticker">0.0000</b> NIM</div>
  </section>

  <section class="stats">
    <div><span class="k">Working for you</span><span class="v">${nim(s.balance)}</span><span class="f">NIM staked</span></div>
    <div><span class="k">Paid to you</span><span class="v">${paid === null ? '—' : nim(paid)}</span><span class="f">${paid === null ? 'unavailable' : S.historyComplete ? 'NIM so far' : 'NIM (recent)'}</span></div>
    <div><span class="k">Yearly rate</span><span class="v">${pct(rateFor(v))}</span><span class="f">after fee</span></div>
  </section>

  ${s.inactiveBalance || s.retiredBalance ? `
  <section class="card steps">
    <div class="lbl">Withdrawal in progress</div>
    ${s.inactiveBalance ? `<div class="step ${released ? 'ready' : ''}">
      <div><b>${nim(s.inactiveBalance)} NIM</b> ${released ? 'is ready to unlock' : 'is cooling down'}</div>
      ${released ? `<button class="btn primary" data-a="retire" ${S.busy ? 'disabled' : ''}>Unlock</button>` : `<span class="timer">${duration(leftMs)} left</span>`}
    </div>${!released && S.wallet?.kind === 'demo' ? `<button class="link" data-a="skipWait">Skip the wait (demo only)</button>` : ''}<div hidden>
    </div>` : ''}
    ${s.retiredBalance ? `<div class="step ready"><div><b>${nim(s.retiredBalance)} NIM</b> unlocked</div><button class="btn primary" data-a="remove" ${S.busy ? 'disabled' : ''}>Move to wallet</button></div>` : ''}
    <p class="note">The network holds withdrawn NIM for about one epoch (12 hours) so validators stay honest. It never leaves your control.</p>
  </section>` : ''}

  ${goalCard}

  <section class="card">
    <div class="row-h"><span class="lbl">Who pays you</span>${s.balance ? '<button class="link" data-a="sheet" data-sheet="validators">Switch</button>' : ''}</div>
    ${v ? validatorRow(v) : `<p class="muted">${s.delegation ? esc(shortAddress(s.delegation)) : 'Not delegated'}</p>`}
    ${v && !paysStakers(v) ? '<p class="err">This validator does not pay its stakers. Switch to one that does.</p>' : ''}
    ${v?.jailedFrom ? '<p class="err">This validator is jailed and not earning right now. Consider switching.</p>' : ''}
  </section>

  <div class="actions">
    <button class="btn primary" data-a="sheet" data-sheet="add" ${S.busy || S.balance <= 0 ? 'disabled' : ''}>Stake more</button>
    <button class="btn" data-a="sheet" data-sheet="card" ${s.balance ? '' : 'disabled'}>Share my payday</button>
    <button class="btn ghost" data-a="sheet" data-sheet="withdraw" ${S.busy || !s.balance ? 'disabled' : ''}>Withdraw</button>
  </div>
  <button class="link center" data-a="sheet" data-sheet="how">How does this work?</button>`
}

function sheet(): string {
  if (!S.sheet) return ''
  const s = S.staker
  let body = ''
  switch (S.sheet) {
    case 'add':
      body = `<h2>Stake more</h2>
      <div class="amount"><input id="amt-add" inputmode="decimal" autocomplete="off" placeholder="0"><span>NIM</span></div>
      <div class="avail">Available: <b>${nim(S.balance)} NIM</b></div>
      ${presets('amt-add', [0.25, 0.5, 0.75, 1])}
      ${payGrid('New weekly pay')}
      <button class="cta" data-a="stakeMore" ${S.busy ? 'disabled' : ''}>${S.busy ? esc(S.busy) + '…' : 'Add to my stake'}</button>`
      break
    case 'withdraw':
      body = `<h2>Withdraw</h2>
      <p class="sub">Withdrawn NIM stops earning and cools down for about 12 hours. Then you unlock it and move it back to your wallet: two more taps.</p>
      <div class="amount"><input id="amt-out" inputmode="decimal" autocomplete="off" placeholder="0"><span>NIM</span></div>
      <div class="avail">Staked: <b>${nim(s?.balance ?? 0)} NIM</b></div>
      ${presets('amt-out', [0.25, 0.5, 1], s?.balance ?? 0)}
      <button class="cta warn" data-a="withdraw" ${S.busy ? 'disabled' : ''}>${S.busy ? esc(S.busy) + '…' : 'Start withdrawal'}</button>`
      break
    case 'validators': {
      const list = [...S.validators].sort((a, b) => validatorScore(b) - validatorScore(a))
      body = `<h2>${s ? 'Switch validator' : 'Choose who pays you'}</h2>
      <p class="sub">Ranked by what actually reaches you: uptime, fee, and whether your pay compounds.${s ? ' Switching keeps your NIM staked; it moves over at the next epoch.' : ''}</p>
      <div class="vlist">${list.map(v => validatorRow(v, { action: 'pick', selected: s ? sameAddress(v.address, s.delegation) : v.address === S.pick?.address })).join('')}</div>`
      break
    }
    case 'goal':
      body = `<h2>Paycheck goal</h2>
      <p class="sub">How much NIM do you want your stake to pay you every week?</p>
      <div class="amount"><input id="goal-in" inputmode="decimal" autocomplete="off" placeholder="100" value="${S.goalWeekly || ''}"><span>NIM / week</span></div>
      <div class="need">You'd need about <b id="goal-need">—</b> staked.</div>
      <button class="cta" data-a="saveGoal">Save goal</button>
      ${S.goalWeekly ? '<button class="link center" data-a="clearGoal">Remove goal</button>' : ''}`
      setTimeout(updateGoalCalc, 0)
      break
    case 'currency':
      body = `<h2>Show values in</h2><div class="curs">${CURRENCIES.map(c => `<button class="${c === S.currency ? 'on' : ''}" data-a="currency" data-cur="${c}">${c.toUpperCase()}</button>`).join('')}</div>
      <p class="note">Prices from CoinGecko, refreshed every few minutes.</p>`
      break
    case 'card': {
      const v = myValidator()
      const w = weeklyPay(s?.balance ?? 0, v)
      body = `<div class="pcard">
        <div class="pc-top">${logo}<span>PAYDAY</span><span class="pc-date">${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span></div>
        <p class="pc-k">My NIM pays me</p>
        <p class="pc-v">${nim(w)}<small> NIM</small></p>
        <p class="pc-k">every week, while I do nothing.</p>
        <div class="pc-foot"><span>${pct(rateFor(v))} a year</span><span>Paid ${v ? esc(payoutLabel(v)) : 'regularly'}</span></div>
      </div>
      <button class="cta" data-a="share">Share</button>`
      break
    }
    case 'how':
      body = `<h2>How Payday works</h2>
      <ol class="how">
        <li><b>You stake NIM</b> with a validator, one of the computers that run the Nimiq network. Your NIM stays under your wallet's control; the validator can never spend it.</li>
        <li><b>The network pays validators</b> for every block. Right now that works out to about ${S.apr ? pct(S.apr) : '8%'} a year on all staked NIM.</li>
        <li><b>Your validator pays you</b> your share minus its fee, on a schedule. Most add it straight back to your stake, so your paycheck grows by itself.</li>
        <li><b>Withdraw any time.</b> Withdrawn NIM cools down for about 12 hours, then you unlock it and it's back in your wallet.</li>
      </ol>
      <p class="note">The rate is live: today's network reward divided by all NIM staked. Payday never holds your NIM and has no server. Every action is approved by you in Nimiq Pay.</p>`
      break
  }
  const fresh = S.sheet !== lastSheet
  return `<div class="backdrop ${fresh ? 'anim' : ''}" data-a="close"><div class="sheet" role="dialog" aria-modal="true"><button class="x" data-a="close" aria-label="Close">×</button>${body}</div></div>`
}

let lastSheet: Sheet = null
function render() {
  let main = ''
  if (S.phase === 'loading') {
    main = `<div class="center-screen"><div class="spinner"></div><p class="muted">Checking your NIM…</p></div>`
  }
  else if (S.phase === 'outside') {
    const deeplink = appLink()
    main = `<section class="hero outside">
      <p class="eyebrow">A Nimiq Pay Mini App</p>
      <h1>Turn your NIM into a <em>paycheck.</em></h1>
      <p class="sub">Payday stakes your NIM in one tap, shows what it pays you every week, and makes withdrawing simple. It runs inside Nimiq Pay.</p>
      <a class="cta" href="${deeplink}">Open in Nimiq Pay</a>
      <button class="cta ghost" data-a="demo">Try the demo</button>
      <p class="note">The demo uses pretend NIM with live network rates. Nothing is sent.</p>
    </section>`
  }
  else if (S.phase === 'error') {
    main = `<div class="center-screen"><p class="err">${esc(S.fatal)}</p><button class="cta" data-a="retry">Try again</button></div>`
  }
  else {
    main = (S.dataError ? `<div class="banner err" data-a="refresh" role="button" tabindex="0">${esc(S.dataError)} Tap to retry.</div>` : '')
      + (S.wallet?.kind === 'demo' ? '<div class="banner demo">Demo mode: pretend NIM, real network rates. Open in Nimiq Pay to stake for real.</div>' : '')
      + (S.staker && totalStaked() > 0 ? homeStaking() : homeNotStaking())
  }
  const t = S.toast ? `<div class="toast ${S.toast.kind}" role="status">${esc(S.toast.text)}</div>` : ''
  // keep typed amounts across re-renders
  const kept: Record<string, string> = {}
  for (const id of ['amt-new', 'amt-add', 'amt-out', 'goal-in']) {
    const el = document.getElementById(id) as HTMLInputElement | null
    if (el) kept[id] = el.value
  }
  const focused = document.activeElement?.id
  const listScroll = document.querySelector('.vlist')?.scrollTop ?? 0
  app.innerHTML = `${header()}<main>${main}</main>${sheet()}${t}`
  lastSheet = S.sheet
  const vl = document.querySelector('.vlist')
  if (vl) vl.scrollTop = listScroll
  for (const [id, val] of Object.entries(kept)) {
    const el = document.getElementById(id) as HTMLInputElement | null
    if (el) el.value = val
  }
  for (const id of ['amt-new', 'amt-add']) {
    const el = document.getElementById(id) as HTMLInputElement | null
    if (el) updateCalc(el)
  }
  if (focused) (document.getElementById(focused) as HTMLInputElement | null)?.focus()
}

// Live "earned today" ticker: active stake × rate, accrued since local midnight.
function tick() {
  const el = document.getElementById('ticker')
  if (el && S.staker) {
    const perMs = S.staker.balance * rateFor(myValidator()) / (365 * 86_400_000)
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0)
    el.textContent = new Intl.NumberFormat('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(perMs * (Date.now() - midnight.getTime()) / LUNA)
  }
  requestAnimationFrame(tick)
}
requestAnimationFrame(tick)

start()

/** Deeplink that opens this Mini App inside Nimiq Pay (keeps the path, e.g. for GitHub Pages). */
function appLink() {
  const path = location.pathname.replace(/index\.html$/, '').replace(/\/$/, '')
  return 'https://nimpay.app/miniapps/open/' + location.host + path
}
