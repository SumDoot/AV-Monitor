// OSD-based signal quality.
//
// The flight controller draws the on-screen display (OSD) onto the video before it is
// transmitted, so the OSD crosses the same radio link and capture card as the picture, but
// we know exactly what it should look like. The two vertical dotted lines never change, so we
// compare them with a reference built from a clean clip (tools/build_reference.py).
//
//   contrast  how well the bright dots stand out from their dark outline (1.0 = as clean).
//             Drops when the picture is blurred, dim or gone.
//   jitter    how much each dot wanders sideways from its neighbours, in pixels. A straight
//             vertical line shows horizontal sync trouble (line tearing) and noise.
//   shift     how far the whole OSD has moved, in pixels.
//   noise     grain on the flat white dots, in brightness levels (0-255).
//   error     overall difference from the reference. Catches everything.
//
// Everything here is tuned on synthetic damage and one clean clip. The numbers in QUALITY
// are a starting point: change them once you have real weak-signal footage.

export const QUALITY = {
  errBad: 0.5,                          // error at which the score reaches 0
  contrastLow: 0.2, contrastOk: 0.95,   // contrast at which the score is 0 / full
  jitterOk: 0.3, jitterBad: 1.5,        // jitter (px) at which the score is full / 0
  noiseRange: 45,                       // grain above normal at which the score reaches 0
  good: 85, fair: 60,                   // score thresholds for the labels
  lostFound: 0.5, lostContrast: 0.5,    // below both: the OSD is not visible at all
  flatSpread: 4,                        // brightness spread below which the screen counts as flat
  softContrast: 0.85, wobbleJitter: 0.4, shiftPx: 0.6, noisyBy: 8,
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));
function median(a) {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function createEvaluator(ref, T = QUALITY) {
  const dots = ref.dots;
  const crefMean = dots.reduce((s, d) => s + d.cref, 0) / dots.length;

  // data: RGBA pixels (e.g. ImageData.data) of width `width`; (ox, oy) is where the top-left
  // pixel of `data` sits in the full frame, so a cropped region can be passed in.
  function evaluate(data, width, ox = 0, oy = 0) {
    const rows = data.length / 4 / width;
    const Y = (px, py) => {
      const i = ((py - oy) * width + (px - ox)) * 4;
      return (77 * data[i] + 150 * data[i + 1] + 29 * data[i + 2]) >> 8;
    };
    let se = 0, n = 0, nss = 0, nn = 0, ys = 0, yq = 0, yn = 0;
    const con = [], dxs = [], dys = [];
    for (const d of dots) {
      if (d.x < ox || d.y < oy || d.x + d.w > ox + width || d.y + d.h > oy + rows) continue;
      let cs = 0, rs = 0, rsum = 0, rsq = 0;
      for (let k = 0; k < d.core.length; k++) {
        const i = d.core[k];
        const v = Y(d.x + (i % d.w), d.y + ((i / d.w) | 0));
        cs += v;
        const e = v - d.refCore[k];
        se += e * e;
        rsum += e;
        rsq += e * e;
      }
      nss += rsq - (rsum * rsum) / d.core.length;   // spread around this dot's own offset
      nn += d.core.length - 1;
      for (let k = 0; k < d.ring.length; k++) {
        const i = d.ring[k];
        const v = Y(d.x + (i % d.w), d.y + ((i / d.w) | 0));
        rs += v;
        const e = v - d.refRing[k];
        se += e * e;
      }
      n += d.core.length + d.ring.length;
      con.push((cs / d.core.length - rs / d.ring.length) / d.cref);

      let sw = 0, sx = 0, sy = 0;
      for (let y = 0; y < d.h; y++) {
        for (let x = 0; x < d.w; x++) {
          const v = Y(d.x + x, d.y + y);
          ys += v; yq += v * v; yn++;
          const w = v - d.mid;
          if (w > 0) { sw += w; sx += w * (d.x + x); sy += w * (d.y + y); }
        }
      }
      if (sw >= 1) { dxs.push(sx / sw - d.cx); dys.push(sy / sw - d.cy); }
    }
    if (!n) return { score: 0, state: 'lost', notes: ['reference does not fit this frame size'] };

    const err = Math.sqrt(se / n) / crefMean;
    const noise = Math.sqrt(Math.max(0, nss) / Math.max(1, nn));
    const contrast = median(con);
    const found = con.filter((c) => c > 0.5).length / con.length;
    const shiftX = median(dxs), shiftY = median(dys);
    const jitter = dxs.length ? 1.4826 * median(dxs.map((v) => Math.abs(v - shiftX))) : NaN;

    const spread = Math.sqrt(Math.max(0, yq / yn - (ys / yn) ** 2));
    const flat = spread < T.flatSpread;     // one solid colour: the card's 'no signal' screen
    const lost = found < T.lostFound && contrast < T.lostContrast;
    const errTerm = clamp01((T.errBad - err) / (T.errBad - (ref.errClean ?? 0.15)));
    const conTerm = clamp01((contrast - T.contrastLow) / (T.contrastOk - T.contrastLow));
    const jitTerm = Number.isFinite(jitter) ? clamp01(1 - (jitter - T.jitterOk) / (T.jitterBad - T.jitterOk)) : 0;
    const noiseOk = ref.noiseClean ?? 14;
    const noiseTerm = clamp01(1 - (noise - noiseOk) / T.noiseRange);
    const score = lost ? 0 : Math.round(100 * Math.min(errTerm, conTerm, jitTerm, noiseTerm));
    const state = lost ? 'lost' : score >= T.good ? 'good' : score >= T.fair ? 'fair' : 'poor';

    const notes = [];
    if (lost) notes.push(flat ? 'no picture (flat screen from the capture card)' : 'OSD not readable (heavy blur, or the OSD is switched off)');
    else {
      if (contrast < T.softContrast) notes.push('soft or dim OSD');
      const noisy = noise > noiseOk + T.noisyBy;
      if (noisy) notes.push(`grainy picture (noise ${Math.round(noise)} levels)`);
      else if (jitter > T.wobbleJitter) notes.push('wobbling edges (line tearing)');
      if (Math.abs(shiftX) > T.shiftPx || Math.abs(shiftY) > T.shiftPx) {
        notes.push(`picture shifted ${shiftX.toFixed(1)}, ${shiftY.toFixed(1)} px`);
      }
      if (!notes.length && score < T.good) notes.push('noisy');
    }
    return { score, state, flat, err, contrast, found, jitter, noise, shiftX, shiftY, notes };
  }

  return { roi: ref.roi, width: ref.width, height: ref.height, evaluate };
}
