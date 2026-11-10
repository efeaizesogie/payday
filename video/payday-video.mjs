// Payday demo video: 3840x2160 @ 30 fps. Real app screens inside a phone, one caption per line, timed to the voice.
//   node payday-video.mjs still <seconds>   -> out/still-<s>.png (check a frame)
//   node payday-video.mjs preview           -> out/preview.mp4 (1/4 size, fast)
//   node payday-video.mjs final             -> out/payday-demo-4k.mp4
import { loadImage, GlobalFonts, createCanvas } from '@napi-rs/canvas'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { renderClip } from './render.mjs'
import { SCENES, TOTAL, INTRO } from './timeline.mjs'

mkdirSync('out', { recursive: true })
GlobalFonts.registerFromPath('fonts/InterDisplay-Black.otf', 'Black')
GlobalFonts.registerFromPath('fonts/InterDisplay-Bold.otf', 'Bold')
GlobalFonts.registerFromPath('fonts/InterDisplay-Medium.otf', 'Medium')

const C = { navy900: '#14173a', navy800: '#1f2348', gold: '#e9b213', paper: '#f6f4ec', soft: 'rgba(246,244,236,0.62)' }
const logo = await loadImage(readFileSync('../public/favicon.svg'))
const shots = {}
for (const s of SCENES) for (const n of s.shots) shots[n] ??= await loadImage(`shots/${n}.png`)

// ── helpers ──────────────────────────────────────────────────────────────────
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x))
const ease = x => { x = clamp(x); return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2 }
const easeOut = x => 1 - (1 - clamp(x)) ** 3
// never a dead stop: 92% eased + 8% linear
const move = x => 0.92 * ease(x) + 0.08 * clamp(x)

function rr(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r)
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath()
}
function wrap(g, text, maxW) {
  const words = text.split(' '), lines = []; let line = ''
  for (const w of words) { const t = line ? line + ' ' + w : w; if (g.measureText(t).width > maxW && line) { lines.push(line); line = w } else line = t }
  if (line) lines.push(line); return lines
}

// ── layout (drawn in 1920x1080 units, scaled 2x to 4K) ───────────────────────
const PH = 930, SW = PH * 1170 / 2532, BEZ = 15, PX = 1350, PY = 540

function background(g, t) {
  const bg = g.createLinearGradient(0, 0, 1920, 1080)
  bg.addColorStop(0, C.navy900); bg.addColorStop(1, C.navy800)
  g.fillStyle = bg; g.fillRect(0, 0, 1920, 1080)
  const gx = PX + Math.sin(t * 0.21) * 40, gy = PY - 80 + Math.cos(t * 0.17) * 30
  const glow = g.createRadialGradient(gx, gy, 0, gx, gy, 760)
  glow.addColorStop(0, 'rgba(233,178,19,0.20)'); glow.addColorStop(1, 'rgba(233,178,19,0)')
  g.fillStyle = glow; g.fillRect(0, 0, 1920, 1080)
  const vig = g.createRadialGradient(960, 540, 420, 960, 540, 1250)
  vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,0.42)')
  g.fillStyle = vig; g.fillRect(0, 0, 1920, 1080)
}

function brandMark(g, alpha) {
  g.globalAlpha = alpha
  g.drawImage(logo, 120, 70, 54, 54)
  g.fillStyle = C.paper; g.font = '34px Bold'; g.textBaseline = 'middle'; g.fillText('Payday', 190, 98)
  g.globalAlpha = 1
}

/** Phone with one or more screens; `layers` = [{img, alpha, pan}] drawn in order. */
function phone(g, t, layers, alpha, dx = 0) {
  const float = Math.sin(t * 0.9) * 6
  const x = PX - SW / 2 + dx, y = PY - PH / 2 + float
  g.save(); g.globalAlpha = alpha
  g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = 70; g.shadowOffsetY = 30
  rr(g, x - BEZ, y - BEZ, SW + 2 * BEZ, PH + 2 * BEZ, 70); g.fillStyle = '#0a0c22'; g.fill()
  g.shadowColor = 'transparent'
  g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,0.14)'; g.stroke()
  g.save(); rr(g, x, y, SW, PH, 56); g.clip()
  for (const L of layers) {
    if (L.alpha <= 0) continue
    g.globalAlpha = alpha * L.alpha
    const visH = L.img.width * PH / SW // source pixels that fit the screen
    const sy = (L.img.height - visH) * (L.pan ?? 0)
    g.drawImage(L.img, 0, sy, L.img.width, visH, x, y, SW, PH)
  }
  g.restore()
  g.restore()
}

function caption(g, text, u, dur) {
  if (!text) return
  const a = easeOut(u / 0.55) * (1 - clamp((u - (dur - 0.35)) / 0.35))
  const rise = (1 - easeOut(u / 0.7)) * 34
  g.save(); g.globalAlpha = a
  g.font = '80px Black'; g.textBaseline = 'alphabetic'
  const lines = wrap(g, text, 760)
  const lh = 92, top = PY - (lines.length * lh) / 2 + 40 + rise
  g.fillStyle = C.gold; rr(g, 150, top - 92, 92 * clamp(u / 0.6) + 0.1, 10, 5); g.fill()
  g.fillStyle = C.paper
  lines.forEach((l, i) => g.fillText(l, 150, top + i * lh))
  g.restore()
}

function demoNote(g, alpha) {
  g.globalAlpha = alpha * 0.55; g.fillStyle = C.paper; g.font = '22px Medium'; g.textBaseline = 'alphabetic'
  g.fillText('Demo with pretend NIM and live network rates', 150, 1010); g.globalAlpha = 1
}

// ── scenes ───────────────────────────────────────────────────────────────────
function sceneAt(t) { return SCENES.find(s => t < s.end) ?? SCENES[SCENES.length - 1] }

function layersFor(s, t) {
  const u = t - s.start
  if (s.shots.length === 1) {
    const pan = s.pan ? 0.32 * move((t - s.voiceAt - 0.4) / (s.voiceDur - 0.6)) : 0
    return [{ img: shots[s.shots[0]], alpha: 1, pan }]
  }
  // two shots: switch partway through the line, with a 0.35 s crossfade
  const cut = (s.voiceAt - s.start) + s.voiceDur * 0.42
  const k = clamp((u - cut) / 0.35)
  return [{ img: shots[s.shots[0]], alpha: 1 }, { img: shots[s.shots[1]], alpha: ease(k) }]
}

function draw(g, t) {
  g.setTransform(2, 0, 0, 2, 0, 0)
  background(g, t)
  const s = sceneAt(t)
  const last = SCENES[SCENES.length - 1]

  // Intro: big logo, then it hands over to the layout.
  if (t < INTRO + 0.8) {
    const a = easeOut(t / 0.6) * (1 - clamp((t - INTRO + 0.2) / 0.5))
    const sc = 0.86 + 0.14 * easeOut(t / 0.9)
    g.save(); g.globalAlpha = a; g.translate(960, 470); g.scale(sc, sc)
    g.drawImage(logo, -110, -110, 220, 220)
    g.fillStyle = C.paper; g.font = '96px Black'; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillText('Payday', 0, 210)
    g.font = '34px Medium'; g.fillStyle = C.soft; g.fillText('A Nimiq Pay Mini App', 0, 262)
    g.restore(); g.textAlign = 'left'
  }

  const inA = easeOut((t - INTRO + 0.3) / 0.7) // layout fades in after the intro
  const endStart = last.start
  const outA = 1 - ease((t - endStart) / 0.6)    // layout fades out for the end card
  const layoutA = Math.min(inA, outA)

  if (layoutA > 0) {
    brandMark(g, layoutA)
    const prev = SCENES[s.i - 1]
    const u = t - s.start
    const cross = s.i > 0 && s.id !== 'end' ? clamp(u / 0.4) : 1
    const layers = []
    if (prev && cross < 1 && prev.shots.length) {
      const pl = layersFor(prev, prev.end - 0.001); layers.push(...pl)
    }
    if (s.id !== 'end') for (const L of layersFor(s, t)) layers.push({ ...L, alpha: L.alpha * (layers.length ? ease(cross) : 1) })
    else if (prev) layers.push(...layersFor(prev, prev.end - 0.001))
    const slide = (1 - easeOut((t - INTRO + 0.3) / 0.9)) * 140
    phone(g, t, layers, layoutA, slide)
    if (s.id !== 'end') caption(g, s.cap, s.i === 0 ? u - INTRO + 0.1 : u, s.dur - (s.i === 0 ? INTRO : 0))
    demoNote(g, layoutA)
  }

  // End card.
  if (t > endStart) {
    const u = t - endStart
    const a = easeOut((u - 0.3) / 0.7) * (1 - clamp((t - (TOTAL - 0.7)) / 0.7))
    g.save(); g.globalAlpha = a; g.textAlign = 'center'; g.textBaseline = 'alphabetic'
    const sc = 0.94 + 0.06 * easeOut(u / 1.2)
    g.translate(960, 400); g.scale(sc, sc)
    g.drawImage(logo, -95, -170, 190, 190)
    g.fillStyle = C.paper; g.font = '110px Black'; g.fillText('Payday', 0, 135)
    g.font = '44px Medium'; g.fillStyle = C.soft; g.fillText('Turn your NIM into a weekly paycheck', 0, 205)
    g.font = '40px Bold'; g.fillStyle = C.gold; g.fillText('efeaizesogie.github.io/payday', 0, 330)
    g.font = '30px Medium'; g.fillStyle = C.soft; g.fillText('Open it in Nimiq Pay, under Mini Apps', 0, 385)
    g.restore(); g.textAlign = 'left'
  }
}

// ── modes ────────────────────────────────────────────────────────────────────
const mode = process.argv[2] ?? 'still'
if (mode === 'still') {
  for (const s of process.argv.slice(3).map(Number)) {
    const cv = createCanvas(3840, 2160), g = cv.getContext('2d'); draw(g, s)
    writeFileSync(`out/still-${s}.png`, cv.toBuffer('image/png')); console.log('still', s)
  }
}
else if (mode === 'preview') {
  await renderClip({ W: 960, H: 540, fps: 15, dur: TOTAL, out: 'out/preview.mp4', chunk: 0,
    draw: (g, t) => { g.setTransform(1, 0, 0, 1, 0, 0); const orig = g.setTransform.bind(g); g.setTransform = (a, b, c, d, e, f) => orig(a / 4, b, c, d / 4, e, f); draw(g, t); g.setTransform = orig } })
}
else if (mode === 'final') {
  await renderClip({ W: 3840, H: 2160, fps: 30, dur: TOTAL, out: 'out/payday-demo-4k.mp4', audio: 'out/mix.m4a',
    deps: ['payday-video.mjs', 'timeline.mjs', 'lines.json', 'out/mix.m4a', ...Object.keys(shots).map(n => `shots/${n}.png`)], draw })
  console.log('final done')
}
