export interface CronJob {
  name: string;
  schedule: string;
  handler: () => Promise<void>;
  enabled?: boolean;
}

export interface CronOptions {
  /** Auto-start on register (default: true) */
  autoStart?: boolean;
  /** Timezone (default: 'UTC') */
  timezone?: string;
}

export class CronScheduler {
  private jobs = new Map<string, { job: CronJob; timer: ReturnType<typeof setInterval> | null }>();
  private autoStart: boolean;

  constructor(options: CronOptions = {}) {
    this.autoStart = options.autoStart ?? true;
  }

  register(job: CronJob): void {
    if (this.jobs.has(job.name)) {
      throw new Error(`Cron job "${job.name}" already registered`);
    }

    const entry = { job, timer: null as ReturnType<typeof setInterval> | null };
    this.jobs.set(job.name, entry);

    if (this.autoStart && job.enabled !== false) {
      this.start(job.name);
    }
  }

  start(name: string): void {
    const entry = this.jobs.get(name);
    if (!entry || entry.timer) return;

    const schedule = entry.job.schedule.trim();
    const runHandler = async () => {
      try {
        await entry.job.handler();
      } catch (err) {
        console.error(`[pledgestack] Cron job "${name}" failed:`, err);
      }
    };

    if (isStandardCron(schedule)) {
      // Standard cron: compute the delay to the next matching time and
      // reschedule after each run (a fixed interval can't represent e.g.
      // "0 2 * * *", which previously threw "Invalid cron schedule").
      const scheduleNext = () => {
        const current = this.jobs.get(name);
        if (!current) return;
        const delay = cronNextDelay(schedule, new Date());
        current.timer = setTimeout(async () => {
          await runHandler();
          scheduleNext();
        }, delay);
      };
      scheduleNext();
    } else {
      const intervalMs = this.parseSchedule(schedule);
      entry.timer = setInterval(runHandler, intervalMs);
    }
  }

  stop(name: string): void {
    const entry = this.jobs.get(name);
    if (!entry || !entry.timer) return;
    // clearTimeout and clearInterval both accept a Node Timeout handle, so this
    // works whether the job was scheduled via setTimeout (cron) or setInterval.
    clearTimeout(entry.timer as ReturnType<typeof setTimeout>);
    entry.timer = null;
  }

  stopAll(): void {
    for (const name of this.jobs.keys()) {
      this.stop(name);
    }
  }

  list(): Array<{ name: string; schedule: string; running: boolean }> {
    return Array.from(this.jobs.entries()).map(([name, entry]) => ({
      name,
      schedule: entry.job.schedule,
      running: entry.timer !== null,
    }));
  }

  private parseSchedule(schedule: string): number {
    const match = schedule.match(/^every-(\d+)-(seconds?|minutes?|hours?|days?)$/);
    if (match) {
      const n = parseInt(match[1], 10);
      if (isNaN(n) || n <= 0) throw new Error(`Invalid cron schedule: ${schedule}. N must be a positive integer`);
      const unit = match[2].toLowerCase();
      const multiplier = unit.startsWith('second') ? 1000
        : unit.startsWith('minute') ? 60 * 1000
        : unit.startsWith('hour') ? 60 * 60 * 1000
        : 24 * 60 * 60 * 1000;
      return n * multiplier;
    }
    throw new Error(`Invalid cron schedule: ${schedule}. Use standard cron (e.g. "0 2 * * *") or every-N-seconds|minutes|hours|days`);
  }
}

/** Whether a schedule string is a standard 5-field cron expression. */
function isStandardCron(schedule: string): boolean {
  if (schedule.startsWith('every-')) return false;
  return schedule.trim().split(/\s+/).length === 5;
}

/** Parse one cron field (with *, ranges, lists, and steps) into its value set. */
function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    let step = 1;
    let range = part;
    const slash = part.split('/');
    if (slash.length === 2) {
      range = slash[0];
      step = parseInt(slash[1], 10) || 1;
    }
    let lo = min;
    let hi = max;
    if (range !== '*') {
      const dash = range.split('-');
      if (dash.length === 2) {
        lo = parseInt(dash[0], 10);
        hi = parseInt(dash[1], 10);
      } else {
        lo = hi = parseInt(range, 10);
      }
    }
    if (Number.isNaN(lo) || Number.isNaN(hi)) continue;
    for (let v = lo; v <= hi; v += step) {
      if (v >= min && v <= max) values.add(v);
    }
  }
  return values;
}

/** Compute milliseconds from `from` until the next time the cron expression matches. */
function cronNextDelay(expr: string, from: Date): number {
  const [m, h, dom, mon, dow] = expr.trim().split(/\s+/);
  const minutes = parseCronField(m, 0, 59);
  const hours = parseCronField(h, 0, 23);
  const doms = parseCronField(dom, 1, 31);
  const months = parseCronField(mon, 1, 12);
  const dows = parseCronField(dow, 0, 6);
  const domRestricted = dom.trim() !== '*';
  const dowRestricted = dow.trim() !== '*';

  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // start from the next whole minute

  // Search up to ~4 years of minutes for the next match (bounded safety net).
  for (let i = 0; i < 4 * 366 * 24 * 60; i++) {
    // Vixie-cron day rule: if both day-of-month and day-of-week are restricted,
    // a match on EITHER counts; otherwise both restrictions (if any) must hold.
    let dayMatch: boolean;
    if (domRestricted && dowRestricted) {
      dayMatch = doms.has(d.getDate()) || dows.has(d.getDay());
    } else {
      dayMatch = (domRestricted ? doms.has(d.getDate()) : true) && (dowRestricted ? dows.has(d.getDay()) : true);
    }
    if (minutes.has(d.getMinutes()) && hours.has(d.getHours()) && months.has(d.getMonth() + 1) && dayMatch) {
      return d.getTime() - from.getTime();
    }
    d.setMinutes(d.getMinutes() + 1);
  }
  throw new Error(`Cron expression never matches within 4 years: ${expr}`);
}
