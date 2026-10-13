import { createEvaluator } from '/static/quality.js';

const $ = (id) => document.getElementById(id);
const live = $('live'), review = $('review'), rctx = review.getContext('2d');
const state = { frames: [], fps: 25, pos: 0, inIdx: 0, outIdx: 0, playing: false, raf: 0 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (ms) => {
  const s = ms / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};
const msg = (text, isError = false) => {
  $('msg').textContent = text;
  $('msg').classList.toggle('error', isError);
};
const stamp = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `capture-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const save = (blob, name) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
};

/* ---------------------------------------------------------------- live view */

function startLive() {
  live.src = '/live?' + Date.now();
  live.hidden = false;
  review.hidden = true;
  $('badge').textContent = 'Live';
  $('badge').classList.remove('review', 'lost');
  $('liveControls').hidden = false;
  $('reviewControls').hidden = true;
}

async function pollStatus() {
  try {
    const s = await (await fetch('/api/status', { cache: 'no-store' })).json();
    const [w, h] = s.size.split('x');
    $('screen').style.setProperty('--ar', `${w} / ${h}`);
    if (s.capturing) {
      $('status').textContent = `Capturing at ${s.fps.toFixed(1)} fps, ${Math.round(s.seconds)} s buffered (${s.megabytes} MB)`;
    } else if (s.frames > 1) {
      $('status').textContent = `No signal for ${Math.round(s.signal_lost_for)} s. The last ${Math.round(s.seconds)} s are still in the buffer.`;
    } else {
      $('status').textContent = `No video from the capture device${s.error ? ': ' + s.error : ''}`;
    }
    $('pauseBtn').disabled = s.frames < 2;
    if ($('reviewControls').hidden) { // do not overwrite the "Reviewing" badge
      const q = s.capturing ? lastLive : null;
      let text = s.capturing ? 'Live' : 'No signal', warn = !s.capturing;
      if (q && q.state === 'lost') { text = qlabel(q); warn = true; }
      else if (q && (q.state === 'poor' || q.state === 'fair')) { text = `Live, ${q.state} signal`; warn = true; }
      $('badge').textContent = text;
      $('badge').classList.toggle('lost', warn);
      if (q && s.capturing) $('status').textContent += `, OSD quality ${q.state === 'lost' ? 'none' : q.score + '%'}`;
    }
  } catch {
    $('status').textContent = 'Lost connection to the Pi';
  }
}

/* ------------------------------------------------------ pulling the buffer */

async function loadBuffer(seconds) {
  const res = await fetch('/api/buffer' + (seconds ? `?seconds=${seconds}` : ''), { cache: 'no-store' });
  if (!res.ok) {
    let why = 'Could not load the buffer.';
    try { why = (await res.json()).error || why; } catch {}
    throw new Error(why);
  }
  const total = +res.headers.get('Content-Length') || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) msg(`Loading buffer: ${Math.round((got / total) * 100)}%`);
  }
  const all = new Blob(chunks);
  const view = new DataView(await all.arrayBuffer());
  const count = view.getUint32(0, true);
  const frames = [];
  let off = 4;
  for (let i = 0; i < count; i++) {
    const len = view.getUint32(off, true);
    const ms = view.getUint32(off + 4, true);
    off += 8;
    frames.push({ ms, blob: all.slice(off, off + len, 'image/jpeg') });
    off += len;
  }
  return frames;
}

/* ------------------------------------------------------------ signal quality */
// Compares the OSD's dotted lines with a reference (see tools/build_reference.py).
// Without static/reference.json this whole section stays switched off.

const n1 = (v) => (Math.abs(v) < 0.05 ? 0 : v).toFixed(1);   // avoids "-0.0"
const QCOLOR = { good: '#3f8f7a', fair: '#f2b134', poor: '#d9412b', lost: '#14212b' };
const QLABEL = { good: 'Good', fair: 'Fair', poor: 'Poor', lost: 'No OSD' };
const qlabel = (q) => (q.state === 'lost' && q.flat ? 'No picture' : QLABEL[q.state]);
let evaluator = null, roiCanvas = null, roiCtx = null, qualities = [], analysisToken = 0, lastLive = null;

async function loadReference() {
  try {
    const res = await fetch('/static/reference.json', { cache: 'no-store' });
    if (!res.ok) return;
    evaluator = createEvaluator(await res.json());
    const { roi } = evaluator;
    roiCanvas = document.createElement('canvas');
    roiCanvas.width = roi.w;
    roiCanvas.height = roi.h;
    roiCtx = roiCanvas.getContext('2d', { willReadFrequently: true });
  } catch { evaluator = null; }
}

// Quality of whatever is currently in `source` (an ImageBitmap cropped to the ROI, or the live <img>).
function evaluateSource(source, cropped) {
  const { roi } = evaluator;
  if (cropped) roiCtx.drawImage(source, 0, 0);
  else roiCtx.drawImage(source, roi.x, roi.y, roi.w, roi.h, 0, 0, roi.w, roi.h);
  const px = roiCtx.getImageData(0, 0, roi.w, roi.h);
  return evaluator.evaluate(px.data, roi.w, roi.x, roi.y);
}

function sampleLive() {
  if (!evaluator || live.hidden || !live.naturalWidth) return;
  if (live.naturalWidth !== evaluator.width || live.naturalHeight !== evaluator.height) return;
  try { lastLive = evaluateSource(live, false); } catch { lastLive = null; }
}

function drawStrip() {
  const cv = $('qstrip'), n = state.frames.length;
  const w = cv.clientWidth, h = cv.clientHeight, dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (n < 2) return;
  let last = null;                      // frames not analysed yet inherit the previous result
  for (let x = 0; x < w; x++) {
    const i = Math.round((x / Math.max(1, w - 1)) * (n - 1));
    last = qualities[i] || last;
    if (!last) continue;
    ctx.fillStyle = QCOLOR[last.state];
    ctx.fillRect(x, 0, 1, h);
  }
}

function showQuality() {
  // long buffers are analysed every second frame, so fall back to a neighbour
  const q = qualities[state.pos] || qualities[state.pos - 1] || qualities[state.pos + 1];
  const el = $('qreadout');
  if (!q) { el.hidden = !evaluator; el.textContent = evaluator ? 'Checking signal quality' : ''; return; }
  el.hidden = false;
  const detail = q.state === 'lost' ? '' :
    ` (contrast ${Math.round(q.contrast * 100)}%, jitter ${n1(q.jitter)} px, noise ${Math.round(q.noise)}, shift ${n1(q.shiftX)}/${n1(q.shiftY)} px)`;
  el.innerHTML = `Signal: <span class="q-${q.state}">${qlabel(q)}${q.state === 'lost' ? '' : ' ' + q.score + '%'}</span>${detail}` +
    (q.notes.length ? `: ${q.notes.join(', ')}` : '');
}

function summarize() {
  const done = qualities.filter(Boolean);
  if (!done.length) return;
  const share = (s) => Math.round((done.filter((q) => q.state === s).length / done.length) * 100);
  const flat = Math.round((done.filter((q) => q.flat).length / done.length) * 100);
  const parts = ['good', 'fair', 'poor', 'lost'].filter((s) => share(s) > 0)
    .map((s) => {
      const name = s === 'lost' ? (flat >= share(s) ? 'no picture' : 'no OSD') : QLABEL[s].toLowerCase();
      return `<span class="q-${s}">${share(s)}% ${name}</span>`;
    });
  $('qsummary').hidden = false;
  $('qsummary').innerHTML = `Signal over this clip: ${parts.join(', ')}`;
}

async function analyze(frames) {
  if (!evaluator) return;
  const token = ++analysisToken;
  const { roi } = evaluator;
  qualities = new Array(frames.length).fill(null);
  $('qsummary').hidden = true;
  const step = frames.length > 900 ? 2 : 1;
  for (let i = 0; i < frames.length; i += step) {
    if (token !== analysisToken) return;        // the user left review or loaded a new buffer
    try {
      const bmp = await createImageBitmap(frames[i].blob, roi.x, roi.y, roi.w, roi.h);
      qualities[i] = evaluateSource(bmp, true);
      bmp.close();
    } catch { qualities[i] = null; }
    if (i % 24 === 0) { drawStrip(); showQuality(); await sleep(0); }
  }
  drawStrip();
  showQuality();
  summarize();
}

/* --------------------------------------------------------------- reviewing */

let drawToken = 0;
async function showFrame(i) {
  const token = ++drawToken;
  const bmp = await createImageBitmap(state.frames[i].blob);
  if (token !== drawToken) { bmp.close(); return; }
  if (review.width !== bmp.width || review.height !== bmp.height) {
    review.width = bmp.width;
    review.height = bmp.height;
  }
  rctx.drawImage(bmp, 0, 0);
  bmp.close();
}

function render() {
  const n = state.frames.length, last = n - 1;
  const pct = (i) => (last ? (i / last) * 100 : 0);
  $('head').style.left = pct(state.pos) + '%';
  $('clip').style.left = pct(state.inIdx) + '%';
  $('clip').style.width = pct(state.outIdx) - pct(state.inIdx) + '%';
  $('timeline').setAttribute('aria-valuenow', state.pos);
  const t = (i) => (i / state.fps) * 1000;
  $('readout').innerHTML =
    `${fmt(t(state.pos))} of ${fmt(t(last))} <span>Clip ${fmt(t(state.outIdx - state.inIdx + 1))}</span>`;
  showQuality();
}

function setPos(i) {
  state.pos = Math.max(0, Math.min(state.frames.length - 1, i));
  render();
  showFrame(state.pos);
}

function stop() {
  state.playing = false;
  cancelAnimationFrame(state.raf);
  $('playBtn').textContent = 'Play';
}

function play() {
  if (state.pos < state.inIdx || state.pos >= state.outIdx) state.pos = state.inIdx;
  const startPos = state.pos, startTime = performance.now();
  state.playing = true;
  $('playBtn').textContent = 'Pause';
  const tick = (now) => {
    if (!state.playing) return;
    const idx = startPos + Math.floor(((now - startTime) / 1000) * state.fps);
    if (idx >= state.outIdx) { setPos(state.outIdx); stop(); return; }
    if (idx !== state.pos) setPos(idx);
    state.raf = requestAnimationFrame(tick);
  };
  state.raf = requestAnimationFrame(tick);
}

function enterReview(frames) {
  state.frames = frames;
  const span = (frames[frames.length - 1].ms - frames[0].ms) / 1000;
  state.fps = Math.min(60, Math.max(1, (frames.length - 1) / span));
  state.inIdx = 0;
  state.outIdx = frames.length - 1;
  $('timeline').style.setProperty('--secs', Math.max(1, Math.round(span)));
  $('timeline').setAttribute('aria-valuemax', frames.length - 1);

  live.removeAttribute('src'); // stop the live stream so it does not use up WiFi
  live.hidden = true;
  review.hidden = false;
  $('badge').textContent = 'Reviewing';
  $('badge').classList.remove('lost');
  $('badge').classList.add('review');
  $('liveControls').hidden = true;
  $('reviewControls').hidden = false;
  setPos(0);
  msg('');
  qualities = [];
  $('qsummary').hidden = true;
  $('qstrip').getContext('2d').clearRect(0, 0, 9999, 99);
  analyze(frames);
}

function leaveReview() {
  stop();
  analysisToken++;
  qualities = [];
  state.frames = []; // free the memory
  startLive();
  msg('');
}

$('pauseBtn').onclick = async () => {
  $('pauseBtn').disabled = true;
  msg('Loading buffer');
  try {
    enterReview(await loadBuffer(+$('span').value));
  } catch (e) {
    msg(e.message, true);
  } finally {
    $('pauseBtn').disabled = false;
  }
};
$('liveBtn').onclick = leaveReview;
$('playBtn').onclick = () => (state.playing ? stop() : play());
$('backBtn').onclick = () => { stop(); setPos(state.pos - 1); };
$('fwdBtn').onclick = () => { stop(); setPos(state.pos + 1); };
$('inBtn').onclick = () => {
  state.inIdx = state.pos;
  if (state.outIdx < state.inIdx) state.outIdx = state.frames.length - 1;
  render();
};
$('outBtn').onclick = () => {
  state.outIdx = state.pos;
  if (state.inIdx > state.outIdx) state.inIdx = 0;
  render();
};
$('wholeBtn').onclick = () => { state.inIdx = 0; state.outIdx = state.frames.length - 1; render(); };

const timeline = $('timeline');
const seekTo = (ev) => {
  const r = timeline.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
  setPos(Math.round(frac * (state.frames.length - 1)));
};
timeline.addEventListener('pointerdown', (ev) => { stop(); timeline.setPointerCapture(ev.pointerId); seekTo(ev); });
timeline.addEventListener('pointermove', (ev) => { if (timeline.hasPointerCapture(ev.pointerId)) seekTo(ev); });
document.addEventListener('keydown', (ev) => {
  if ($('reviewControls').hidden || ev.target.matches('select, button')) return;
  if (ev.key === 'ArrowLeft') { stop(); setPos(state.pos - 1); ev.preventDefault(); }
  else if (ev.key === 'ArrowRight') { stop(); setPos(state.pos + 1); ev.preventDefault(); }
  else if (ev.key === ' ') { state.playing ? stop() : play(); ev.preventDefault(); }
});

/* ------------------------------------------------------------------ export */

const canEncode = window.isSecureContext && 'VideoEncoder' in window && 'VideoFrame' in window;
if (!canEncode) {
  $('mp4Btn').disabled = true;
  $('exportNote').hidden = false;
  $('exportNote').textContent = window.isSecureContext
    ? 'This browser cannot encode video, so MP4 saving is off. Save as MJPEG instead.'
    : 'MP4 saving needs a secure connection. Open this page with https:// instead of http://.';
}

const clipFrames = () => state.frames.slice(state.inIdx, state.outIdx + 1);

$('mjpegBtn').onclick = () => {
  const clip = clipFrames();
  save(new Blob(clip.map((f) => f.blob), { type: 'video/x-motion-jpeg' }), `${stamp()}.mjpeg`);
  msg(`Saved ${clip.length} frames. Play it with VLC, or: ffplay -f mjpeg -framerate ${Math.round(state.fps)} file.mjpeg`);
};

async function exportMp4() {
  stop();
  const clip = clipFrames();
  const bitrate = +$('quality').value;
  // Average rate of the selected clip, from the real capture times. It need not be a whole
  // number: the file's timing comes from the frame timestamps below, not from a header value.
  const spanMs = clip[clip.length - 1].ms - clip[0].ms;
  const fps = clip.length > 1 && spanMs > 0
    ? Math.min(60, Math.max(1, ((clip.length - 1) / spanMs) * 1000))
    : state.fps;

  const first = await createImageBitmap(clip[0].blob);
  const w = first.width & ~1, h = first.height & ~1; // H.264 needs even dimensions
  const needsCanvas = w !== first.width || h !== first.height;
  first.close();

  let config = null;
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.420028']) {
    const candidate = { codec, width: w, height: h, bitrate, framerate: fps };
    if ((await VideoEncoder.isConfigSupported(candidate)).supported) { config = candidate; break; }
  }
  if (!config) throw new Error('This browser cannot encode H.264. Save as MJPEG instead.');

  const { Muxer, ArrayBufferTarget } = await import('/static/vendor/mp4-muxer.mjs');
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width: w, height: h }, // frameRate must be an integer, so leave it out
    fastStart: 'in-memory',
  });

  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { failure = e; },
  });
  encoder.configure(config);

  const scratch = needsCanvas ? new OffscreenCanvas(w, h) : null;
  const sctx = scratch && scratch.getContext('2d');
  const usPerFrame = 1e6 / fps;
  const keyEvery = Math.max(1, Math.round(fps * 2));

  $('bar').hidden = false;
  $('bar').value = 0;
  for (let i = 0; i < clip.length; i++) {
    if (failure) throw failure;
    const bmp = await createImageBitmap(clip[i].blob);
    let source = bmp;
    if (sctx) { sctx.drawImage(bmp, 0, 0); source = scratch; }
    const frame = new VideoFrame(source, {
      timestamp: Math.round(i * usPerFrame),
      duration: Math.round(usPerFrame),
    });
    encoder.encode(frame, { keyFrame: i % keyEvery === 0 });
    frame.close();
    bmp.close();
    while (encoder.encodeQueueSize > 6) await sleep(4); // do not flood the encoder
    if (i % 4 === 0) $('bar').value = i / clip.length;
  }
  await encoder.flush();
  if (failure) throw failure;
  encoder.close();
  muxer.finalize();
  return new Blob([target.buffer], { type: 'video/mp4' });
}

$('mp4Btn').onclick = async () => {
  $('mp4Btn').disabled = true;
  $('mjpegBtn').disabled = true;
  msg('Encoding on this device. Keep this tab open.');
  try {
    save(await exportMp4(), `${stamp()}.mp4`);
    msg('Saved.');
  } catch (e) {
    msg(e.message || String(e), true);
  } finally {
    $('bar').hidden = true;
    $('mp4Btn').disabled = !canEncode;
    $('mjpegBtn').disabled = false;
  }
};

/* -------------------------------------------------------------------- init */

startLive();
loadReference().then(() => setInterval(sampleLive, 500));
pollStatus();
setInterval(pollStatus, 2000);
window.addEventListener('resize', () => { if (!$('reviewControls').hidden) drawStrip(); });
