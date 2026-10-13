// Run: node tests/test_quality.mjs path/to/good-clip.mp4
// Checks the evaluator on clean frames, the card's flat 'no signal' frames, and synthetic damage.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createEvaluator } from '../static/quality.js';

const ref = JSON.parse(readFileSync(new URL('../static/reference.json', import.meta.url)));
const ev = createEvaluator(ref);
const { width: W, height: H } = ref;
const clip = process.argv[2];
if (!clip) { console.error('usage: node tests/test_quality.mjs clip.mp4'); process.exit(2); }

// every 64th frame is enough (the whole clip as RGBA would be over a gigabyte)
const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', clip, '-vf', 'select=not(mod(n\\,64))', '-fps_mode', 'vfr',
  '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 29 });
const FS = W * H * 4, N = Math.floor(raw.length / FS);
const frame = (i) => new Uint8ClampedArray(raw.buffer, raw.byteOffset + i * FS, FS).slice();

let seed = 12345;                                   // small deterministic RNG
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

const damage = {
  'clean': (f) => f,
  'noise sigma 20': (f) => f.map((v) => v + gauss() * 20),
  'noise sigma 60': (f) => f.map((v) => v + gauss() * 60),
  'tearing sd 1px': (f) => shiftRows(f, 1),
  'tearing sd 3px': (f) => shiftRows(f, 3),
  'blur 1px': (f) => boxBlur(f, 1),
  'blur 2px': (f) => boxBlur(f, 2),
  'shift 2px': (f) => shiftAll(f, 2),
  'flat grey': (f) => f.fill(30),
};
function shiftRows(f, sd) {
  const o = new Uint8ClampedArray(f.length);
  for (let y = 0; y < H; y++) {
    const s = Math.round(gauss() * sd);
    for (let x = 0; x < W; x++) {
      const sx = Math.min(W - 1, Math.max(0, x - s));
      o.set(f.subarray((y * W + sx) * 4, (y * W + sx) * 4 + 4), (y * W + x) * 4);
    }
  }
  return o;
}
function shiftAll(f, s) {
  const o = new Uint8ClampedArray(f.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = Math.min(W - 1, Math.max(0, x - s));
    o.set(f.subarray((y * W + sx) * 4, (y * W + sx) * 4 + 4), (y * W + x) * 4);
  }
  return o;
}
function boxBlur(f, r) {
  const o = new Uint8ClampedArray(f.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) {
    let s = 0, k = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < W && yy >= 0 && yy < H) { s += f[(yy * W + xx) * 4 + c]; k++; }
    }
    o[(y * W + x) * 4 + c] = s / k;
  }
  for (let i = 3; i < o.length; i += 4) o[i] = 255;
  return o;
}

const idx = [];                                     // frame 0 is the card's flat startup frame, the rest have a picture
for (let i = 1; i < N; i++) idx.push(i);
const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const results = {};
for (const [name, fn] of Object.entries(damage)) {
  const rs = idx.map((i) => ev.evaluate(fn(frame(i)), W));
  results[name] = rs;
  const states = {};
  rs.forEach((r) => (states[r.state] = (states[r.state] || 0) + 1));
  console.log(name.padEnd(16),
    'score', avg(rs.map((r) => r.score)).toFixed(0).padStart(3),
    ' err', avg(rs.map((r) => r.err || 0)).toFixed(2),
    ' contrast', avg(rs.map((r) => r.contrast || 0)).toFixed(2),
    ' jitter', avg(rs.map((r) => r.jitter || 0)).toFixed(2),
    ' noise', avg(rs.map((r) => r.noise || 0)).toFixed(0).padStart(2),
    ' dx', avg(rs.map((r) => r.shiftX || 0)).toFixed(2),
    ' ', JSON.stringify(states));
}
// the card's startup frames in this clip are flat grey
const startup = ev.evaluate(frame(0), W);
console.log('clip frame 0 (startup)'.padEnd(16), startup.state, startup.notes.join('; '));

const fail = [];
const score = (n) => avg(results[n].map((r) => r.score));
if (score('clean') < 90) fail.push('clean frames should score >= 90');
if (!results['clean'].every((r) => r.state === 'good')) fail.push('every clean frame should be good');
if (results['flat grey'].some((r) => r.state !== 'lost')) fail.push('flat frames must be lost');
if (startup.state !== 'lost' || !startup.flat) fail.push('the clip startup frame must be lost and flat');
if (results['flat grey'].some((r) => !r.flat)) fail.push('flat frames must be reported flat');
if (results['blur 2px'].some((r) => r.flat)) fail.push('a blurred picture is not flat');
for (const n of ['noise sigma 60', 'tearing sd 3px', 'blur 2px']) if (score(n) >= 60) fail.push(`${n} should be poor`);
if (!(score('clean') > score('noise sigma 20') && score('noise sigma 20') > score('noise sigma 60'))) fail.push('more noise must score lower');
if (!(score('tearing sd 1px') > score('tearing sd 3px'))) fail.push('more tearing must score lower');
if (!(score('blur 1px') > score('blur 2px'))) fail.push('more blur must score lower');
if (Math.abs(avg(results['shift 2px'].map((r) => r.shiftX)) - 2) > 0.3) fail.push('2 px shift should be measured as ~2');
console.log(fail.length ? 'FAIL\n  ' + fail.join('\n  ') : 'PASS');
process.exit(fail.length ? 1 : 0);
