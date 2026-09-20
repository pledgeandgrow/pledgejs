export interface Job<T = unknown> {
  id: string;
  data: T;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
  /** Set when the job reaches a terminal state (completed/failed); drives pruning. */
  finishedAt?: number;
}

export interface JobQueueOptions {
  /** Max completed/failed jobs kept for get()/stats (default: 1000). Oldest are pruned first. */
  maxRetained?: number;
  /** Drop completed/failed jobs older than this many ms (default: 1 hour). */
  retentionMs?: number;
}

export interface JobOptions {
  maxAttempts?: number;
  delay?: number;
}

export interface JobResult<T = unknown> {
  id: string;
  status: 'completed' | 'failed';
  result?: T;
  error?: string;
}

export class JobQueue<T = unknown> {
  private jobs = new Map<string, Job<T>>();
  private handler: ((job: Job<T>) => Promise<unknown>) | null = null;
  private processing = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  /** Earliest run time per delayed job (absent = runnable immediately). */
  private runAt = new Map<string, number>();

  private maxRetained: number;
  private retentionMs: number;

  constructor(private concurrency = 1, options: JobQueueOptions = {}) {
    this.maxRetained = options.maxRetained ?? 1000;
    this.retentionMs = options.retentionMs ?? 60 * 60 * 1000;
  }

  /**
   * Drops finished jobs past the retention window / count so a long-lived
   * queue doesn't grow without bound (each retains its data and result).
   */
  private prune(): void {
    const now = Date.now();
    const finished: Job<T>[] = [];
    for (const job of this.jobs.values()) {
      if (job.status !== 'completed' && job.status !== 'failed') continue;
      if (job.finishedAt !== undefined && now - job.finishedAt > this.retentionMs) {
        this.jobs.delete(job.id);
        this.runAt.delete(job.id);
      } else {
        finished.push(job);
      }
    }
    let excess = finished.length - this.maxRetained;
    // Map iteration order is insertion order, i.e. oldest first.
    for (const job of finished) {
      if (excess <= 0) break;
      this.jobs.delete(job.id);
      this.runAt.delete(job.id);
      excess--;
    }
  }

  setHandler(handler: (job: Job<T>) => Promise<unknown>): void {
    this.handler = handler;
    // Jobs added before a handler existed are waiting; start draining them.
    void this.process();
  }

  private duePending(): Job<T>[] {
    const now = Date.now();
    return Array.from(this.jobs.values()).filter(
      (j) => j.status === 'pending' && (this.runAt.get(j.id) ?? 0) <= now,
    );
  }

  async add(data: T, options: JobOptions = {}): Promise<string> {
    const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
    const job: Job<T> = {
      id,
      data,
      attempts: 0,
      maxAttempts: options.maxAttempts ?? 3,
      createdAt: Date.now(),
      status: 'pending',
    };
    this.jobs.set(id, job);

    if (options.delay) {
      this.runAt.set(id, Date.now() + options.delay);
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.process();
      }, options.delay);
      this.timers.add(timer);
    } else {
      this.process();
    }

    return id;
  }

  get(id: string): Job<T> | undefined {
    return this.jobs.get(id);
  }

  getStatus(id: string): Job<T>['status'] | undefined {
    return this.jobs.get(id)?.status;
  }

  private async process(): Promise<void> {
    if (this.processing || !this.handler) return;
    this.processing = true;

    try {
      const batch = this.duePending().slice(0, this.concurrency);

      await Promise.all(batch.map(async (job) => {
        job.status = 'processing';
        job.attempts++;

        try {
          const result = await this.handler!(job);
          job.status = 'completed';
          job.result = result;
          job.finishedAt = Date.now();
        } catch (err) {
          if (job.attempts >= job.maxAttempts) {
            job.status = 'failed';
            job.finishedAt = Date.now();
            job.error = err instanceof Error ? err.message : String(err);
          } else {
            job.status = 'pending';
          }
        }
      }));
    } finally {
      this.processing = false;
      this.prune();
    }

    // Only re-enter for jobs that are actually due — delayed jobs are woken by
    // their own timer (re-entering for them here would spin).
    if (this.duePending().length > 0) {
      void this.process();
    }
  }

  stats(): { pending: number; processing: number; completed: number; failed: number } {
    let pending = 0, processing = 0, completed = 0, failed = 0;
    for (const job of this.jobs.values()) {
      if (job.status === 'pending') pending++;
      else if (job.status === 'processing') processing++;
      else if (job.status === 'completed') completed++;
      else if (job.status === 'failed') failed++;
    }
    return { pending, processing, completed, failed };
  }

  close(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.handler = null;
    this.jobs.clear();
    this.runAt.clear();
  }
}
