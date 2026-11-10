// Learn: six short lessons about staking NIM, each ending in one question.
// Numbers are live from the network, so lessons never go stale.
import type { NetStats } from './chain'

export interface Lesson {
  id: string
  title: string
  summary: string
  body: (n: NetStats | null) => string
  q: { text: string, options: string[], correct: number, why: string }
}

const p = (r: number) => `${(r * 100).toFixed(1)}%`
const n = (v: number) => Math.round(v).toLocaleString('en-US')

export const LESSONS: Lesson[] = [
  {
    id: 'what',
    title: 'What staking is',
    summary: 'Your NIM helps run the network, and stays yours.',
    body: () => `
      <p>Nimiq is run by <b>validators</b>: computers that check and add new blocks. To be trusted, they need NIM standing behind them.</p>
      <p>When you <b>stake</b>, you put your NIM behind a validator. It never leaves your control: the validator can't spend it, move it or take it. Only you can withdraw it.</p>
      <p>In return, the network pays you for helping keep it secure.</p>`,
    q: { text: 'When you stake, can the validator spend your NIM?', options: ['Yes, it holds it for me', 'No, it stays under my control', 'Only if I give it my recovery words'], correct: 1, why: 'Staked NIM stays in your control. And never give anyone your recovery words: no real validator or app will ask.' },
  },
  {
    id: 'pay',
    title: 'Where the pay comes from',
    summary: 'New NIM is created every second and paid to stakers.',
    body: s => `
      <p>Every block creates a small amount of new NIM. Right now the network creates about <b>${s ? n(s.dailyEmission) : 'two million'} NIM a day</b>.</p>
      <p>All of it goes to the people staking. ${s ? `About <b>${n(s.staked)} NIM</b> is staked today, so each staked NIM earns about <b>${p(s.apr)} a year</b>` : 'That works out to a yearly rate'} before the validator's fee.</p>
      <p>The rate moves: if more people stake, each gets a smaller slice. And the amount created shrinks slowly every year by design.</p>`,
    q: { text: 'If many more people start staking, what happens to your rate?', options: ['It goes up', 'It goes down a little', 'It stays fixed forever'], correct: 1, why: 'The daily reward is shared by everyone staking, so more stakers means a smaller slice each.' },
  },
  {
    id: 'idle',
    title: 'Why not staking costs you',
    summary: 'Idle NIM quietly loses its share of the network.',
    body: s => `
      <p>New NIM is created whether you stake or not, so the total supply grows about <b>${s ? p(s.inflation) : '5%'} a year</b> right now.</p>
      <p>If you hold NIM without staking, your amount stays the same but your <b>share of all NIM shrinks</b> every year. Stakers receive that new NIM instead.</p>
      <p>Staking is how you keep, and grow, your slice. The Plan tab shows both lines side by side.</p>`,
    q: { text: 'You hold 10,000 NIM and never stake. After a year you have…', options: ['More NIM', 'The same NIM, but a smaller share of all NIM', 'Less NIM'], correct: 1, why: 'Your balance stays put while supply grows, so your share of the network shrinks.' },
  },
  {
    id: 'pick',
    title: 'Choosing a validator',
    summary: 'Uptime, fee, and how it pays you.',
    body: () => `
      <p>Three things decide what actually reaches you:</p>
      <ul>
        <li><b>Uptime.</b> A validator that's offline misses blocks, and you miss pay. Look for 99% or more.</li>
        <li><b>Fee.</b> The share it keeps. 0 to 5% is normal.</li>
        <li><b>How it pays.</b> <i>Restake</i> adds your pay to your stake so it compounds. <i>Direct</i> sends it to your wallet. Some private validators pay stakers nothing at all.</li>
      </ul>
      <p>Payday ranks validators by what reaches you, and the Stake checkup warns you if yours slips.</p>`,
    q: { text: 'Which validator is usually best for a long-term staker?', options: ['0% fee, 90% uptime', '3% fee, 99.9% uptime, restakes', '5% fee, private, pays nothing'], correct: 1, why: 'Reliable uptime and compounding beat a zero fee on a validator that keeps going offline.' },
  },
  {
    id: 'out',
    title: 'Getting your NIM back',
    summary: 'Three steps, about 12 hours.',
    body: () => `
      <p>Withdrawing takes three short steps:</p>
      <ol>
        <li><b>Start the withdrawal.</b> That NIM stops earning.</li>
        <li><b>Wait about 12 hours</b> (one epoch). This cooldown keeps validators honest. You can cancel and keep earning.</li>
        <li><b>Unlock, then move it to your wallet.</b> Two taps.</li>
      </ol>
      <p>Payday shows the countdown and tells you when each step is ready.</p>`,
    q: { text: 'You started a withdrawal and changed your mind. What can you do?', options: ['Nothing, it is final', 'Tap "Keep earning instead" while it cools down', 'Contact the validator'], correct: 1, why: 'While NIM is cooling down you can put it back to work in one tap.' },
  },
  {
    id: 'safe',
    title: 'Staying safe',
    summary: 'The rules that keep your NIM yours.',
    body: () => `
      <ul>
        <li><b>Never share your recovery words.</b> Not with a validator, not with support, not with Payday. Nobody legitimate will ask.</li>
        <li><b>Check every approval.</b> Nimiq Pay shows what you're signing. If the amount or action looks wrong, cancel.</li>
        <li><b>Be wary of promises.</b> Anyone offering far more than the network rate is not paying you from staking.</li>
        <li><b>Payday holds nothing.</b> It has no server and never touches your keys. Every action happens in Nimiq Pay, approved by you.</li>
      </ul>`,
    q: { text: 'Someone offers 50% a year if you send them your NIM to "stake for you". This is…', options: ['A great deal', 'Almost certainly a scam', 'Normal for Nimiq'], correct: 1, why: `The real network rate is around ${'8%'} and you never need to send NIM to anyone to stake.` },
  },
]
