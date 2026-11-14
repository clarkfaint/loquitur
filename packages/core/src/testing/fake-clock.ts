/**
 * A manual clock for tests (F§5.7's injected `Clock`). `now()` only moves when a test calls `advance(ms)`,
 * and every timer due inside the advanced span fires in due order — including a timer scheduled by a
 * callback that has already run inside the same advance.
 */

import type { Clock } from "../player/interfaces";

/** One pending timer: its handle, its due time and what to run. */
interface ScheduledTimer {
  handle: number;
  due: number;
  callback: () => void;
}

export class FakeClock implements Clock {
  private current = 0;
  private nextHandle = 1;
  private timers: ScheduledTimer[] = [];

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.timers.push({ handle, due: this.current + Math.max(0, delayMs), callback });
    return handle;
  }

  clearTimeout(handle: number): void {
    this.timers = this.timers.filter((timer) => timer.handle !== handle);
  }

  /** Move time forward, firing every timer that comes due inside the span. */
  advance(ms: number): void {
    const target = this.current + Math.max(0, ms);
    for (;;) {
      let due: ScheduledTimer | undefined;
      for (const timer of this.timers) {
        if (timer.due > target) continue;
        if (due === undefined || timer.due < due.due || (timer.due === due.due && timer.handle < due.handle)) due = timer;
      }
      if (due === undefined) break;
      const firing = due;
      this.timers = this.timers.filter((timer) => timer.handle !== firing.handle);
      this.current = Math.max(this.current, firing.due);
      firing.callback();
    }
    this.current = target;
  }
}
