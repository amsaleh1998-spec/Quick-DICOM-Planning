// Records scenes of the demo into a directory of frames and a log (see README.md):
//   node capture.cjs --data <scan folder> --out out/rec --scenes open,ai,scans,curve,implants,hero,report
//
//   --data <folder>      the DICOM series, with upper.stl and lower.stl beside it
//   --url <url>          the app (default http://127.0.0.1:4174/, see serve.cjs)
//   --preview            small and fast (1x, 30 fps) to check the choreography
//   --draft3d            the 3D scene at the app's draft quality (faster, for previews)
//   --checkpoints        save a project after each scene (<out>/<scene>.qdp.zip)
//   --from <project>     start from a saved project instead of a fresh page (scenes after `open`)
//   --rail <panel>       with --from: the side panel to have open (as a continuous session would)
//   --fit                with --from: fit every view first (for a project saved before its planning views were shown)
const path = require('path');
const fs = require('fs');
const { Stage } = require('./lib/stage.cjs');
const scenes = require('./scenes.cjs');

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i < 0 ? def : process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? true : process.argv[i + 1];
};
const DATA = arg('data', process.env.DEMO_SCAN);
if (!DATA || !fs.existsSync(DATA)) {
  console.error('Pass the folder with the DICOM series, upper.stl and lower.stl: --data <folder> (or DEMO_SCAN=<folder>)');
  process.exit(1);
}
const list = String(arg('scenes', 'open')).split(',');
const outDir = path.resolve(arg('out', 'out/cap'));
const preview = !!arg('preview', false);
const from = arg('from', null);
const checkpoints = !!arg('checkpoints', false);

(async () => {
  const st = await Stage.launch({
    url: arg('url', 'http://127.0.0.1:4174/'),
    outDir,
    // with the 40 px browser bar the editor adds, the window is 16:9
    width: 1664,
    height: 900,
    // the Objects list a little wider than its default, so implant names and sizes fit
    storage: { 'qdp.objects': JSON.stringify({ open: true, width: 294 }) },
    dsf: Number(arg('dsf', preview ? 1 : 2)),
    fps: Number(arg('fps', preview ? 30 : 60)),
  });
  const cfg = {
    outDir,
    dicomFiles: fs.readdirSync(DATA).filter((f) => f.endsWith('.dcm')).sort().map((f) => path.join(DATA, f)),
    upperStl: path.join(DATA, 'upper.stl'),
    lowerStl: path.join(DATA, 'lower.stl'),
    draft3d: !!arg('draft3d', false),
  };
  const idle = (page) => page.waitForFunction(() => !!window.app.vol && document.getElementById('loading').classList.contains('hidden'), null, { timeout: 600_000 });
  const tidy = async (page) => {
    // off-camera set-up leaves no trace: no status message, pointer back where the recording left it
    await page.evaluate(() => (document.getElementById('status-msg').textContent = ''));
    await page.mouse.move(st.x, st.y);
  };
  if (from) {
    await st.offcam(async (page) => {
      await page.setInputFiles('#project-input', path.resolve(from));
      await idle(page);
      await page.waitForTimeout(1500);
      // a project restores every view's zoom, also of views that were never shown: fit them as a fresh session would
      if (arg('fit', false)) await page.keyboard.press('f');
      // the side panel a continuous session would have open here
      const rail = arg('rail', null);
      if (rail) await page.click(`#rail [data-panel="${rail}"]`);
      // a project opened in Plan mode comes up ready to draw a curve, also when it has one: a session that drew it is not
      if (await page.evaluate(() => !!window.app.drawing && !window.app.drawing.length && window.app.curves.length > 0)) await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      await tidy(page);
    });
  } else if (list[0] !== 'open') {
    await st.offcam(async (page) => {
      await page.setInputFiles('#file-input', cfg.dicomFiles);
      await idle(page);
      await page.click('#btn-auto-wl');
      await page.waitForTimeout(800);
      await tidy(page);
    });
  }
  await st.place(st.W * 0.62, st.H * 0.6);
  await st.freeze();
  for (const name of list) {
    const t0 = Date.now();
    await scenes[name](st, cfg);
    st.save();
    console.log(`  ${name}: ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    if (checkpoints) {
      await st.offcam(async (page) => {
        const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 300_000 }), page.click('#btn-save-project')]);
        await dl.saveAs(path.join(outDir, `${name}.qdp.zip`));
        await idle(page);
        await tidy(page);
      });
    }
  }
  await st.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
