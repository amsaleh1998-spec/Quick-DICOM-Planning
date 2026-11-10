// The plan the demo carries out on the demo scan (frame coordinates: mm from the volume centre,
// x = patient left, y = posterior, z = up). Found by inspecting the scan in the app.
const plan = {
  /** axial level (mm above the volume centre) at which the maxillary ridge is drawn: 23 wheel notches up */
  levelNotches: 23,
  /** freehand stroke along the maxillary arch, patient right -> left, through the ridge centre */
  arch: [
    [-28.4, 9.5], [-31.0, -5.0], [-28.2, -19.5], [-19.2, -30.3], [-6.8, -36.1], [0, -37.4], [6.9, -36.1],
    [11.6, -32.9], [14.8, -28.8], [16.64, -24.92], [18.63, -19.45], [19.97, -13.68], [21.38, -7.61], [22.7, -0.8], [23.6, 9.5],
  ],

  /**
   * Where the intraoral scans lie in the CBCT (scan -> volume mm, 3×4 row-major): the app's own
   * surface match of the upper scan on the AI-segmented teeth (100 % within 0.5 mm, RMS 0.14 mm).
   * The scenes use it to click the same tooth on the CBCT as on the scan.
   */
  scanToCbct: [0.9996, -0.02804, 0.00202, 55.14227, 0.02811, 0.99841, -0.04893, 31.74312, -0.00065, 0.04897, 0.9988, 53.41351],
  /** patches for the match, as fractions of the scan pane: upper right central incisor, left molar, right molar */
  scanPatches: [[0.468, 0.291], [0.715, 0.631], [0.256, 0.631]],

  /** Ctrl+wheel zoom of the panoramic onto the upper left quadrant (arc length mm, height mm, wheel notches) */
  panoZoom: { s: 88, c: 21, notches: 3 },
  /** Ctrl+wheel zoom of the cross-sections onto the implant, and of the tangential view */
  crossZoom: 4,
  tangZoom: 2,
  brand: 'Straumann',
  /**
   * 24: on the ridge 6 mm behind the canine (its root tip leans distally: 1.6 mm clear of it),
   * placed at its centre height, then tilted 20° with the ridge (apex palatal).
   */
  i24: { tooth: '24', s: 89.6, cCenter: 18.45, tilt: 20 },
  /** 26: parallel to 24, platform on the ridge centre just under the crest, a wider implant */
  i26: { tooth: '26', s: 98.5, cPlat: 13.4, size: '4.5 × 10 mm' },

  /** 3D: app time per frame (above the 300 ms after which the app renders at full quality), orbit drags (px), zoom (hundreds of px of Ctrl + wheel: 1.9 = 1.6x closer) */
  hero: { appMs: 320, orbit1: [-145, -30], zoom: 1.9, orbit2: [-45, 10] },
};

/** Catmull-Rom through the points, sampled every `step` mm: a smooth hand stroke. */
function spline(pts, step = 0.25) {
  const P = [pts[0], ...pts, pts[pts.length - 1]];
  const out = [];
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    const n = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map((d) => 0.5 * (2 * p1[d] + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3)));
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

module.exports = { plan, spline };
