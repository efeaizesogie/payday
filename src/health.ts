// Stake checkup: plain-language health checks on a staking position, each with a fix.
import { type Staker, type Validator, paysStakers, validatorScore, sameAddress } from './chain'

export type Level = 'ok' | 'warn' | 'bad'
export interface Check { level: Level, title: string, detail: string, fix?: { label: string, action: string } }

export function checkup(s: Staker, v: Validator | null, all: Validator[], apr: number): Check[] {
  const out: Check[] = []
  if (!s.delegation || !v) {
    out.push({ level: 'warn', title: 'Validator unknown', detail: 'Payday could not find your validator in the active list. It may have retired.', fix: { label: 'Choose a validator', action: 'validators' } })
    return out
  }
  if (!paysStakers(v)) out.push({ level: 'bad', title: 'You are not being paid', detail: `${v.name} is a private validator and does not pay stakers.`, fix: { label: 'Switch', action: 'validators' } })
  else out.push({ level: 'ok', title: 'You are being paid', detail: `${v.name} pays stakers ${v.payoutType === 'restake' ? 'back into your stake, so it compounds' : 'straight to your wallet'}.` })

  if (v.jailedFrom) out.push({ level: 'bad', title: 'Validator is jailed', detail: 'It misbehaved or went offline and earns nothing until released.', fix: { label: 'Switch', action: 'validators' } })
  else if (v.reliability < 0.97) out.push({ level: 'warn', title: 'Uptime is shaky', detail: `${(v.reliability * 100).toFixed(1)}% reliability. Missed blocks mean missed pay.`, fix: { label: 'Compare', action: 'validators' } })
  else out.push({ level: 'ok', title: 'Reliable', detail: `${(v.reliability * 100).toFixed(1)}% reliability score.` })

  if (v.fee > 0.1 && v.fee < 1) out.push({ level: 'warn', title: 'High fee', detail: `It keeps ${(v.fee * 100).toFixed(1)}% of your pay.`, fix: { label: 'Compare', action: 'validators' } })

  if (s.inactiveBalance) out.push({ level: 'warn', title: 'Some NIM is not earning', detail: 'NIM you started withdrawing earns nothing while it cools down.', fix: { label: 'Keep earning', action: 'keepEarning' } })
  if (s.retiredBalance) out.push({ level: 'warn', title: 'Unlocked NIM is waiting', detail: 'Move it to your wallet or stake it again.', fix: { label: 'Move to wallet', action: 'remove' } })

  // Better option: a clearly better validator by what reaches the staker.
  const best = [...all].sort((a, b) => validatorScore(b) - validatorScore(a))[0]
  if (best && !sameAddress(best.address, v.address) && paysStakers(v)) {
    const gain = apr * ((1 - best.fee) - (1 - v.fee)) * (s.balance / 1e5)
    if (validatorScore(best) > validatorScore(v) * 1.02 && gain > 0) {
      out.push({ level: 'warn', title: 'A better validator exists', detail: `${best.name} would pay you about ${Math.round(gain).toLocaleString('en-US')} NIM more a year.`, fix: { label: 'See it', action: 'validators' } })
    }
  }
  return out
}
