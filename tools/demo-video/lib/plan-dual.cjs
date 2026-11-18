// The plan for the dual scan example (lib/plan.cjs is the one for the implant demo): what was worked
// out for this case. Frame coordinates: mm from the centre of the patient's CBCT, x = patient left,
// y = posterior. Denture coordinates: mm in the denture's own scan.
const plan = {
  /** the mandibular arch at the level the Plan views open on, patient right -> left */
  arch: [[-36, 26], [-31, 17], [-25, 8], [-18, 1], [-10, -4.5], [0, -6.5], [9, -4], [16, 2], [21, 10], [26, 18], [31, 27]],
  /**
   * The denture was scanned lying on a sheet that the segmentation picks up with it. Where the two
   * touch (lines in the denture scan's x, y; the sheet's underside is at z): the cut brush goes along
   * them, seen from below, and the sheet comes off as an island.
   */
  sheet: { z: 30.14, lines: [[[75.24, 31.25], [40.5, 53.9]], [[63.56, 44.26], [66.87, 49.38]], [[66.42, 48.05], [67.87, 54.19]]] },
  /** looking at the denture from below and a little from the front, for the clean-up */
  below: [0.22, 0.42, 0.88],
  smoothRadius: 2.8,
  /** 3D of the result: app time per frame (see lib/plan.cjs), the turn of the model (px) */
  hero: { appMs: 320, orbit: [-170, -24] },
};

module.exports = { plan };
