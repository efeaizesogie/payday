// One timeline shared by the picture and the sound: every scene lasts as long as its line plus breathing room.
import { readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { FFPROBE } from './render.mjs'

import { fileURLToPath } from 'node:url'
const here = fileURLToPath(new URL('.', import.meta.url))
export const LINES = JSON.parse(readFileSync(here + 'lines.json', 'utf8'))
const files = readdirSync(here + 'vo').filter(f => f.endsWith('.mp3')).sort()

export const INTRO = 1.4 // logo moment before the first line
const LEAD = 0.25, TAIL = 0.55, END_HOLD = 2.4

let t = 0
export const SCENES = LINES.map((l, i) => {
  const file = here + 'vo/' + files[i]
  const d = Number(spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).stdout.toString().trim())
  const start = t
  const voiceAt = (i === 0 ? INTRO : 0) + start + LEAD
  const dur = (i === 0 ? INTRO : 0) + LEAD + d + (i === LINES.length - 1 ? END_HOLD : TAIL)
  t += dur
  return { ...l, i, file, start, dur, end: start + dur, voiceAt, voiceDur: d }
})
export const TOTAL = t
