// The parts of the plan that undo / redo covers (see history.ts). Not covered: how the scan is
// viewed – navigation, window / level, 3D thresholds, show / hide, selection – and the
// orientation of the volume (applying a crop / rotation starts a new history).

import type { App, Measurement } from './app';
import { Channel, History } from './history';
import { Implant, reserveImplantIds } from './implant';
import type { Vec2 } from './math';
import type { MeshData } from './meshio';
import { Nerve, reserveNerveIds } from './nerve';
import { Scan, reserveScanIds } from './scans';
import type { AiLayer, Cut, Segment } from './segment';

type SavedImplant = Omit<Implant, 'hidden' | 'abutmentHidden'>;
type SavedNerve = Omit<Nerve, 'visible'>;
type SavedSegment = Omit<Segment, 'visible' | 'voxels'>;
type SavedScan = Omit<Scan, 'mesh' | 'visible'>;

function implants(app: App): Channel {
  // show / hide is not part of the history: remembered per implant across undo / redo
  const vis = new Map<number, { hidden: boolean; abutmentHidden: boolean }>();
  return {
    label: 'implants',
    key: () => JSON.stringify(app.implants.map(({ hidden: _h, abutmentHidden: _a, ...rest }): SavedImplant => rest)),
    restore(key) {
      for (const i of app.implants) vis.set(i.id, { hidden: i.hidden, abutmentHidden: i.abutmentHidden });
      const list = JSON.parse(key) as SavedImplant[];
      app.implants = list.map((i) => ({ ...i, hidden: vis.get(i.id)?.hidden ?? false, abutmentHidden: vis.get(i.id)?.abutmentHidden ?? false }));
      reserveImplantIds(Math.max(0, ...app.implants.map((i) => i.id)));
      if (!app.implantById(app.selectedId)) app.selectedId = null;
      if (app.placing) app.placing = null;
      app.followSelected();
      app.changed();
    },
  };
}

function curves(app: App): Channel {
  return {
    label: 'panoramic curve',
    key: () => JSON.stringify(app.curves.map((c) => [c.id, c.name, c.curve.ctrl])),
    restore: (key) => app.restoreCurveList(JSON.parse(key) as [number, string, Vec2[]][]),
  };
}

function measurements(app: App): Channel {
  return {
    label: 'measurement',
    // a ruler with only its first point is not a step yet
    key: () => JSON.stringify(app.measurements.filter((m) => m.id !== app.pendingMeasurement?.m.id)),
    restore: (key) => app.setMeasurements(JSON.parse(key) as Measurement[]),
  };
}

function nerves(app: App): Channel {
  return {
    label: 'nerve',
    key: () => JSON.stringify(app.nerves.map(({ visible: _v, ...rest }): SavedNerve => rest)),
    restore(key) {
      const vis = new Map(app.nerves.map((n) => [n.id, n.visible]));
      app.nerves = (JSON.parse(key) as SavedNerve[]).map((n) => ({ ...n, visible: vis.get(n.id) ?? true }));
      reserveNerveIds(Math.max(0, ...app.nerves.map((n) => n.id)));
      if (!app.activeNerve()) {
        app.activeNerveId = null;
        if (app.segTool === 'nerve') app.segTool = null;
      }
      app.changed();
    },
  };
}

function segments(app: App): Channel {
  // automatic segmentation results are large: kept by reference, named by a token in the key
  const layers = new Map<number, AiLayer>();
  const tokens = new WeakMap<AiLayer, number>();
  let nextToken = 1;
  const token = (a: AiLayer | null) => {
    if (!a) return 0;
    let t = tokens.get(a);
    if (!t) {
      t = nextToken++;
      tokens.set(a, t);
      layers.set(t, a);
    }
    return t;
  };
  type State = { s: SavedSegment[]; c: Cut[]; ai: number };
  // what the label voxels depend on (name, colour and opacity changes need no rebuild)
  const structure = (st: State) => JSON.stringify([st.s.map((g) => [g.id, g.seeds, g.ai ?? null]), st.c, st.ai]);
  const state = (): State => ({
    s: app.seg.segments.map(({ visible: _v, voxels: _n, ...rest }) => rest),
    c: app.seg.cuts,
    ai: token(app.seg.ai),
  });
  return {
    label: 'segmentation',
    key: () => JSON.stringify(state()),
    restore(key) {
      const st = JSON.parse(key) as State;
      const seg = app.seg;
      const vis = new Map(seg.segments.map((g) => [g.id, g.visible]));
      if (structure(st) === structure(state())) {
        for (const saved of st.s) {
          const g = seg.segmentById(saved.id);
          if (!g) continue;
          g.name = saved.name;
          g.color = saved.color;
          if (saved.opacity === undefined) delete g.opacity;
          else g.opacity = saved.opacity;
        }
        app.changed();
      } else {
        const ai = st.ai ? layers.get(st.ai) ?? null : null;
        const list: Segment[] = st.s.filter((g) => !g.ai || ai).map((g) => ({ ...g, visible: vis.get(g.id) ?? true, voxels: 0 }));
        seg.restore(list, st.c);
        seg.setAi(ai);
        app.rebuildSegments('Updating segmentation…');
      }
      if (!seg.segmentById(app.activeSegId)) {
        app.activeSegId = null;
        if (app.segTool === 'grow') app.segTool = null;
      }
    },
  };
}

function scans(app: App): Channel {
  // meshes are kept by reference, so a deleted scan can come back
  const meshes = new Map<number, MeshData>();
  return {
    label: 'scan',
    key() {
      for (const s of app.scans) meshes.set(s.id, s.mesh);
      return JSON.stringify(app.scans.map(({ mesh: _m, visible: _v, ...rest }): SavedScan => rest));
    },
    restore(key) {
      const old = new Map(app.scans.map((s) => [s.id, s]));
      app.scans = (JSON.parse(key) as SavedScan[])
        .filter((m) => old.has(m.id) || meshes.has(m.id))
        .map((m) => {
          const s = old.get(m.id);
          if (s) return Object.assign(s, m);
          return { ...m, mesh: meshes.get(m.id)!, visible: true };
        });
      reserveScanIds(Math.max(0, ...app.scans.map((s) => s.id)));
      if (!app.scans.some((s) => s.id === app.activeScanId)) app.activeScanId = null;
      app.changed();
    },
  };
}

export function planHistory(app: App): History {
  return new History({
    implants: implants(app),
    curves: curves(app),
    measurements: measurements(app),
    nerves: nerves(app),
    segments: segments(app),
    scans: scans(app),
  });
}
