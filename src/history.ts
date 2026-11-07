// One undo / redo history for the whole plan.
//
// The plan is split into channels (implants, curves, segments, nerves, scans, measurements). Each
// channel describes its state as text; a step stores the before / after text of only the channels
// that changed, so undoing an implant move never rebuilds the segmentation. Steps are recorded at
// commit points: the start and end of every mouse / touch gesture, before keyboard commands, and
// after edits have settled (typing in a field, sliders). Heavy data that cannot be held as text
// (scan meshes, the automatic segmentation) is kept by reference inside the channel.

export interface Channel {
  /** shown in the status bar: "Undo – <label>" */
  label: string;
  /** current state as comparable text */
  key(): string;
  /** go back / forward to a state captured earlier by key() */
  restore(key: string): void;
}

interface Step {
  before: Record<string, string>;
  after: Record<string, string>;
}

export class History {
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  private committed: Record<string, string> = {};
  /** false while restoring (restores change the state but must not record steps) */
  private live = true;

  constructor(private readonly channels: Record<string, Channel>) {
    this.reset();
  }

  private capture(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, ch] of Object.entries(this.channels)) out[name] = ch.key();
    return out;
  }

  /** Forget everything (new scan, or coordinates changed so old states no longer apply). */
  reset() {
    this.undoStack = [];
    this.redoStack = [];
    this.committed = this.capture();
  }

  /** Record what changed since the last commit as one step. Returns true when there was a change. */
  commit(): boolean {
    if (!this.live) return false;
    const cur = this.capture();
    const step: Step = { before: {}, after: {} };
    let changed = false;
    for (const name of Object.keys(cur)) {
      if (cur[name] === this.committed[name]) continue;
      step.before[name] = this.committed[name];
      step.after[name] = cur[name];
      changed = true;
    }
    if (!changed) return false;
    this.undoStack.push(step);
    this.redoStack = [];
    this.committed = cur;
    return true;
  }

  /** Something changed that has not been recorded yet. */
  private pending(): boolean {
    for (const [name, ch] of Object.entries(this.channels)) if (ch.key() !== this.committed[name]) return true;
    return false;
  }

  get undoCount(): number {
    return this.undoStack.length + (this.live && this.pending() ? 1 : 0);
  }

  get redoCount(): number {
    return this.redoStack.length;
  }

  /** Undo the last step; returns the labels of what changed, or null when there is nothing to undo. */
  undo(): string[] | null {
    this.commit(); // edits not recorded yet are undone first
    const step = this.undoStack.pop();
    if (!step) return null;
    this.apply(step.before);
    this.redoStack.push(step);
    return this.labels(step);
  }

  redo(): string[] | null {
    this.commit();
    const step = this.redoStack.pop();
    if (!step) return null;
    this.apply(step.after);
    this.undoStack.push(step);
    return this.labels(step);
  }

  private apply(states: Record<string, string>) {
    this.live = false;
    try {
      for (const [name, key] of Object.entries(states)) this.channels[name].restore(key);
    } finally {
      this.live = true;
    }
    // the restored state, as the channels describe it now, is the new reference
    this.committed = this.capture();
  }

  private labels(step: Step): string[] {
    return Object.keys(step.before).map((n) => this.channels[n].label);
  }
}
