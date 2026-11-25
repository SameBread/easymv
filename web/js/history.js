// Full undo/redo over immutable state snapshots (strings).
//
// Rapid edits with the same `key` (dragging, wheel-zoom) coalesce into ONE
// undo step so a drag is a single undo, not hundreds.

export class History {
  constructor(limit = 200, { coalesceMs = 600, now = () => Date.now() } = {}) {
    this.limit = limit;
    this.coalesceMs = coalesceMs;
    this.now = now;
    this.reset(null);
  }

  /** Start fresh from `state` (clears both stacks). */
  reset(state, label = 'Initial state') {
    this.past = [];
    this.future = [];
    this.present = { state, label, key: null, time: 0 };
  }

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  /** Label of the action that Undo would revert. */
  get undoLabel() { return this.canUndo ? this.present.label : null; }
  /** Label of the action that Redo would re-apply. */
  get redoLabel() { return this.canRedo ? this.future.at(-1).label : null; }

  /** Every step, oldest first: [{ label, current }]. Index 0 is the initial state; the last is the newest redo step. */
  entries() {
    const all = [...this.past, this.present, ...[...this.future].reverse()];
    const cur = this.past.length;
    return all.map((e, i) => ({ label: e.label, current: i === cur }));
  }
  /** How many steps to undo (negative) or redo (positive) to reach entry `i`. */
  offsetTo(i) { return i - this.past.length; }

  /** Record a new state. Returns false if nothing changed. */
  push(state, label, key = null) {
    if (state === this.present.state) return false;
    const t = this.now();
    const coalesce = key !== null && this.present.key === key && t - this.present.time < this.coalesceMs && this.past.length > 0;
    if (coalesce) {
      this.present = { state, label: this.present.label, key, time: t };
    } else {
      this.past.push(this.present);
      if (this.past.length > this.limit) this.past.shift();
      this.present = { state, label, key, time: t };
    }
    this.future = [];
    return true;
  }

  /** @returns {{state:string,label:string}|null} state to restore + label of what was undone */
  undo() {
    if (!this.canUndo) return null;
    const undone = this.present;
    this.future.push(undone);
    this.present = { ...this.past.pop(), key: null };
    return { state: this.present.state, label: undone.label };
  }

  redo() {
    if (!this.canRedo) return null;
    const redone = this.future.pop();
    this.past.push(this.present);
    this.present = { ...redone, key: null };
    return { state: this.present.state, label: redone.label };
  }
}
