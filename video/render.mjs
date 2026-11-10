// Render frames from a canvas into an MP4 — crash-safe and resumable.
// Frames are encoded in chunks (default 5 s). Each finished chunk is kept on disk, so if the
// laptop dies mid-render, running the same command again skips every finished chunk and carries on.
// When all chunks exist they are joined losslessly (stream copy), the audio is muxed, chunks are removed.
import { createCanvas } from '@napi-rs/canvas';
import { spawn, spawnSync } from 'node:child_process';
import { renameSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// ffmpeg: $FFMPEG, else the winget link (PATH may not be refreshed in this shell), else PATH
const WG = (process.env.LOCALAPPDATA || '') + '/Microsoft/WinGet/Links/';
export const FFMPEG = process.env.FFMPEG || (existsSync(WG + 'ffmpeg.exe') ? WG + 'ffmpeg.exe' : 'ffmpeg');
export const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');

/** Fingerprint of the files a render depends on — chunks from older code are thrown away, never mixed in. */
export function fingerprint(files) {
  const h = createHash('sha1');
  for (const f of files) h.update(f + '\0' + (existsSync(f) ? readFileSync(f) : 'missing'));
  return h.digest('hex').slice(0, 12);
}

async function encodeRange({ W, H, fps, f0, f1, draw, out }) {
  const cv = createCanvas(W, H), ctx = cv.getContext('2d');
  const tmp = out.replace(/\.mp4$/, '.part.mp4');
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', `${fps}`, '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '5.2', tmp];
  const ff = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'inherit'] });
  const closed = new Promise(r => ff.on('close', r));
  for (let f = f0; f < f1; f++) {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.filter = 'none';
    draw(ctx, f / fps, f);
    const buf = Buffer.from(ctx.getImageData(0, 0, W, H).data.buffer);
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  if ((await closed) !== 0) throw new Error('ffmpeg failed on ' + out);
  renameSync(tmp, out);           // only complete chunks ever get the final name
}

/**
 * renderClip({ W, H, fps, dur, out, draw, audio, deps, chunk })
 *   deps  — files whose content defines the picture (scene, brand, kit, words.json…); changes invalidate old chunks
 *   chunk — frames per chunk (150 = 5 s at 30 fps). Use chunk: 0 for a single pass (previews).
 */
export async function renderClip({ W, H, fps = 30, dur, out, draw, audio = null, deps = [], chunk = 150 }) {
  const N = Math.round(dur * fps);
  if (!chunk) {   // single pass (quick previews)
    await encodeRange({ W, H, fps, f0: 0, f1: N, draw, out: out.replace(/\.mp4$/, '.video.mp4') });
    return mux(out.replace(/\.mp4$/, '.video.mp4'), null, out, dur, true);
  }
  const dir = out.replace(/\.mp4$/, '.chunks'); mkdirSync(dir, { recursive: true });
  const sig = `${W}x${H}@${fps} frames=${N} chunk=${chunk} code=${fingerprint(deps)}`;
  const sigFile = join(dir, 'signature.txt');
  if (existsSync(sigFile) && readFileSync(sigFile, 'utf8') !== sig) {
    console.log('scene changed since the last attempt — discarding old chunks');
    for (const f of readdirSync(dir)) unlinkSync(join(dir, f));
  }
  writeFileSync(sigFile, sig);
  const nC = Math.ceil(N / chunk), names = [];
  let done = 0;
  for (let c = 0; c < nC; c++) {
    const name = `chunk-${String(c).padStart(4, '0')}.mp4`, file = join(dir, name); names.push(name);
    if (existsSync(file)) { done++; continue; }
    const t0 = Date.now(), f0 = c * chunk, f1 = Math.min(N, f0 + chunk);
    await encodeRange({ W, H, fps, f0, f1, draw, out: file });
    console.log(`chunk ${c + 1}/${nC} done (${(f0 / fps).toFixed(1)}–${(f1 / fps).toFixed(1)} s) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  if (done) console.log(`resumed: ${done}/${nC} chunks were already finished`);
  writeFileSync(join(dir, 'list.txt'), names.map(n => `file '${n}'`).join('\n'));
  mux(join(dir, 'list.txt'), audio, out, dur, false);
  rmSync(dir, { recursive: true, force: true });
  return out;
}

function mux(input, audio, out, dur, single) {
  const tmp = out.replace(/\.mp4$/, '.part.mp4');
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  if (single) args.push('-i', input); else args.push('-f', 'concat', '-safe', '0', '-i', input);
  if (audio) args.push('-i', audio, '-map', '0:v', '-map', '1:a', '-c:a', 'copy');
  args.push('-c:v', 'copy', '-t', dur.toFixed(3), '-movflags', '+faststart', tmp);
  const r = spawnSync(FFMPEG, args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('mux failed');
  renameSync(tmp, out);
  if (single) unlinkSync(input);
  return out;
}
