// Sound: the voice lines on the timeline, a code-synthesised music bed ducked under them, mastered to -14 LUFS.
import { writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { FFMPEG } from './render.mjs'
import { SCENES, TOTAL } from './timeline.mjs'

mkdirSync('out', { recursive: true })
const SR = 48000, N = Math.ceil((TOTAL + 0.5) * SR)
const L = new Float32Array(N), R = new Float32Array(N)

// Seeded randomness so a re-render sounds identical.
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)

const hz = m => 440 * 2 ** ((m - 69) / 12)
// Warm, hopeful loop: Cmaj9 - Am9 - Fmaj7 - G6sus, 4 s each (60 bpm feel).
const CHORDS = [[48, 55, 59, 62, 64], [45, 52, 55, 59, 60], [41, 48, 52, 57, 60], [43, 50, 55, 57, 62]]
const BAR = 4

// Pad: detuned sines with slow swells per chord.
for (let i = 0; i < N; i++) {
  const t = i / SR, bar = Math.floor(t / BAR), ph = (t % BAR) / BAR
  const ch = CHORDS[bar % 4]
  const env = Math.min(1, ph * 3) * (1 - Math.max(0, ph - 0.85) / 0.15 * 0.6)
  let s = 0
  for (const m of ch) { const f = hz(m); s += Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * f * 1.003 * t) }
  s *= 0.028 * env
  const fadeIn = Math.min(1, t / 2.5), fadeOut = Math.min(1, (TOTAL - t) / 2.5)
  L[i] += s * fadeIn * Math.max(0, fadeOut); R[i] += s * fadeIn * Math.max(0, fadeOut)
}

// Plucks: Karplus-Strong arpeggio, eighth notes, gently panned.
function pluck(at, midi, gain, pan) {
  const f = hz(midi), period = Math.round(SR / f), buf = new Float32Array(period)
  for (let k = 0; k < period; k++) buf[k] = rnd() * 2 - 1
  const start = Math.floor(at * SR), len = Math.floor(1.6 * SR)
  for (let k = 0; k < len && start + k < N; k++) {
    const idx = k % period, next = (idx + 1) % period
    const v = buf[idx]; buf[idx] = 0.996 * 0.5 * (v + buf[next])
    const s = v * gain
    L[start + k] += s * (1 - pan); R[start + k] += s * pan
  }
}
for (let t = 2.0; t < TOTAL - 2.5; t += 0.5) {
  const ch = CHORDS[Math.floor(t / BAR) % 4], step = Math.round(t * 2) % 8
  const pattern = [0, 2, 3, 4, 2, 3, 1, 4]
  pluck(t, ch[pattern[step]] + 12, 0.05 + rnd() * 0.012, 0.35 + rnd() * 0.3)
}
// A soft "ka-ching" chime on the reveal line.
const reveal = SCENES.find(s => s.id === 'reveal')
if (reveal) for (const [dt, m] of [[0, 84], [0.09, 88], [0.18, 91]]) pluck(reveal.voiceAt + 0.9 + dt, m, 0.12, 0.5)

// Write the bed as 16-bit WAV.
const wav = Buffer.alloc(44 + N * 4)
wav.write('RIFF', 0); wav.writeUInt32LE(36 + N * 4, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 4, 28)
wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(N * 4, 40)
for (let i = 0; i < N; i++) {
  wav.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4)
  wav.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4)
}
writeFileSync('out/music.wav', wav)

// Voice bus: each line delayed to its slot; music ducked under the voice; master to -14 LUFS.
const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', 'out/music.wav']
for (const s of SCENES) args.push('-i', s.file)
const delays = SCENES.map((s, k) => `[${k + 1}:a]aresample=48000,adelay=${Math.round(s.voiceAt * 1000)}|${Math.round(s.voiceAt * 1000)},apad[v${k}]`).join(';')
const vmix = SCENES.map((_, k) => `[v${k}]`).join('') + `amix=inputs=${SCENES.length}:normalize=0,atrim=0:${TOTAL.toFixed(3)},asplit=2[voice][key]`
const duck = `[0:a]atrim=0:${TOTAL.toFixed(3)}[bed];[bed][key]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=400[ducked]`
const master = `[voice][ducked]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=9[out]`
args.push('-filter_complex', `${delays};${vmix};${duck};${master}`, '-map', '[out]', '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', 'out/mix.m4a')
const r = spawnSync(FFMPEG, args, { stdio: 'inherit' })
if (r.status !== 0) throw new Error('mix failed')
console.log(`mix done: ${TOTAL.toFixed(2)} s`)
