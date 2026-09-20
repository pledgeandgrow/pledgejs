/** Largest delay setTimeout supports (2^31 - 1 ms, ~24.8 days). */
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface CronJob {
  name: string;
  schedule: string;
  handler: () => Promise<void>;
  enabled?: boolean;
}

export interface CronOptions {
  /** Auto-start on register (default: true) */
  autoStart?: boolean;
  /**
   * IANA timezone the standard cron expressions are evaluated in
   * (default: 'UTC'), e.g. 'America/New_York'. DST transitions are honored.
   * An unknown timezone throws at construction. Ignored by every-N-* schedules.
   */
  timezone?: string;
}

export class CronScheduler {
  private jobs = new Map<string, { job: CronJob; timer: ReturnType<typeof setInterval> | null; token: object | null }>();
  private autoStart: boolean;
  private timezone: string;

  constructor(options: CronOptions = {}) {
    this.autoStart = options.autoStart ?? true;
    this.timezone = options.timezone ?? 'UTC';
    assertValidTimezone(this.timezone);
  }

  register(job: CronJob): void {
    if (this.jobs.has(job.name)) {
      throw new Error(`Cron job "${job.name}" already registered`);
    }

    const entry = { job, timer: null as ReturnType<typeof setInterval> | null, token: null as object | null };
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
      // `token` identifies this start() call: stop() (or stop()+start()) while a
      // handler is mid-flight must not let the old chain re-arm itself.
      const token = {};
      entry.token = token;
      const isActive = () => entry.token === token && this.jobs.get(name) === entry;
      const arm = (target: number) => {
        // setTimeout delays above 2^31-1 ms fire immediately (busy loop), so
        // long waits are broken into capped hops toward the target time.
        const remaining = target - Date.now();
        const hop = Math.min(Math.max(remaining, 0), MAX_TIMEOUT_MS);
        entry.timer = setTimeout(async () => {
          if (!isActive()) return;
          if (target - Date.now() > 0 && hop === MAX_TIMEOUT_MS) {
            arm(target);
            return;
          }
          await runHandler();
          if (isActive()) scheduleNext();
        }, hop);
      };
      const scheduleNext = () => {
        arm(Date.now() + cronNextDelay(schedule, new Date(), this.timezone));
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
    entry.token = null;
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

function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error(`Invalid cron timezone "${timezone}" — expected an IANA timezone name such as "UTC" or "America/New_York"`);
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** Offset (ms) of `timezone` from UTC at the given instant (positive = ahead of UTC). */
function tzOffsetMs(instant: number, timezone: string): number {
  if (timezone === 'UTC') return 0;
  let fmt = formatterCache.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatterCache.set(timezone, fmt);
  }
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(new Date(instant))) {
    if (part.type !== 'literal') p[part.type] = parseInt(part.value, 10);
  }
  const floored = Math.floor(instant / 1000) * 1000;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second) - floored;
}

/** Convert a wall-clock time (expressed as naive UTC ms) in `timezone` to a real instant. */
function wallToInstant(wall: number, timezone: string): number {
  const o1 = tzOffsetMs(wall, timezone);
  let t = wall - o1;
  const o2 = tzOffsetMs(t, timezone);
  if (o2 !== o1) t = wall - o2;
  return t;
}

/**
 * Compute milliseconds from `from` until the next time the cron expression
 * matches, evaluated on the wall clock of `timezone`.
 */
function cronNextDelay(expr: string, from: Date, timezone = 'UTC'): number {
  const [m, h, dom, mon, dow] = expr.trim().split(/\s+/);
  const minutes = parseCronField(m, 0, 59);
  const hours = parseCronField(h, 0, 23);
  const doms = parseCronField(dom, 1, 31);
  const months = parseCronField(mon, 1, 12);
  const dows = parseCronField(dow, 0, 7);
  // Both 0 and 7 mean Sunday.
  if (dows.delete(7)) dows.add(0);
  for (const [label, set] of [['minute', minutes], ['hour', hours], ['day-of-month', doms], ['month', months], ['day-of-week', dows]] as const) {
    if (set.size === 0) throw new Error(`Invalid cron expression "${expr}": unsupported ${label} field`);
  }
  const domRestricted = dom.trim() !== '*';
  const dowRestricted = dow.trim() !== '*';

  // Scan in wall-clock space: a Date whose UTC getters read as the timezone's
  // local fields. Calendar arithmetic is then DST-free; the match is mapped
  // back to a real instant at the end.
  const fromMs = from.getTime();
  const d = new Date(fromMs + tzOffsetMs(fromMs, timezone));
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1); // start from the next whole minute

  const limit = d.getTime() + 4 * 366 * 24 * 60 * 60 * 1000;
  while (d.getTime() < limit) {
    if (!months.has(d.getUTCMonth() + 1)) {
      d.setUTCMonth(d.getUTCMonth() + 1, 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    // Vixie-cron day rule: if both day-of-month and day-of-week are restricted,
    // a match on EITHER counts; otherwise both restrictions (if any) must hold.
    let dayMatch: boolean;
    if (domRestricted && dowRestricted) {
      dayMatch = doms.has(d.getUTCDate()) || dows.has(d.getUTCDay());
    } else {
      dayMatch = (domRestricted ? doms.has(d.getUTCDate()) : true) && (dowRestricted ? dows.has(d.getUTCDay()) : true);
    }
    if (!dayMatch) {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!hours.has(d.getUTCHours())) {
      d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!minutes.has(d.getUTCMinutes())) {
      d.setUTCMinutes(d.getUTCMinutes() + 1);
      continue;
    }
    const instant = wallToInstant(d.getTime(), timezone);
    if (instant > fromMs) return instant - fromMs;
    // Landed in a DST overlap/gap that maps to the past — keep scanning.
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  throw new Error(`Cron expression never matches within 4 years: ${expr}`);
}
