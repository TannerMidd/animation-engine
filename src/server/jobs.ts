import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';

/**
 * Long-running work, tracked so the UI can watch it.
 *
 * Renders take minutes and pass through stages with very different costs, so
 * progress is streamed rather than awaited. One job at a time: synthesis and
 * frame capture both want the machine to themselves, and queueing two renders
 * would just make both slower.
 */

export interface JobEvent {
  type: 'progress' | 'log' | 'done' | 'error';
  stage?: string;
  done?: number;
  total?: number;
  message?: string;
  result?: unknown;
}

export interface Job {
  id: string;
  kind: string;
  scene: string;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  events: JobEvent[];
  result?: unknown;
  error?: string;
  listeners: Set<ServerResponse>;
}

const jobs = new Map<string, Job>();
let active: Job | null = null;

export function activeJob(): Job | null {
  return active && active.status === 'running' ? active : null;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

function emit(job: Job, event: JobEvent): void {
  job.events.push(event);
  // Keep memory bounded on long renders; the UI only ever shows the latest.
  if (job.events.length > 400) job.events.splice(0, job.events.length - 400);

  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of job.listeners) {
    try {
      res.write(payload);
    } catch {
      job.listeners.delete(res);
    }
  }
}

export interface JobHandle {
  progress(event: Omit<JobEvent, 'type'>): void;
  log(message: string): void;
}

export function startJob<T>(
  kind: string,
  scene: string,
  run: (handle: JobHandle) => Promise<T>,
): Job {
  if (active && active.status === 'running') {
    throw new Error(`already running: ${active.kind} for "${active.scene}"`);
  }

  const job: Job = {
    id: randomUUID(),
    kind,
    scene,
    status: 'running',
    startedAt: Date.now(),
    events: [],
    listeners: new Set(),
  };
  jobs.set(job.id, job);
  active = job;

  const handle: JobHandle = {
    progress: (e) => emit(job, { type: 'progress', ...e }),
    log: (message) => emit(job, { type: 'log', message }),
  };

  // Deliberately not awaited — the route returns the job id immediately and the
  // client follows along over SSE.
  void run(handle)
    .then((result) => {
      job.status = 'done';
      job.result = result;
      emit(job, { type: 'done', result });
    })
    .catch((err: unknown) => {
      job.status = 'error';
      job.error = err instanceof Error ? err.message : String(err);
      emit(job, { type: 'error', message: job.error });
    })
    .finally(() => {
      for (const res of job.listeners) res.end();
      job.listeners.clear();
      if (active === job) active = null;
      // Retain briefly so a client that reconnects late still sees the outcome.
      setTimeout(() => jobs.delete(job.id), 10 * 60_000).unref?.();
    });

  return job;
}

/** Attach an SSE listener, replaying what it missed. */
export function subscribe(job: Job, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  for (const event of job.events) res.write(`data: ${JSON.stringify(event)}\n\n`);

  if (job.status !== 'running') {
    res.end();
    return;
  }

  job.listeners.add(res);
  res.on('close', () => job.listeners.delete(res));
}

export function jobSummary(job: Job) {
  return {
    id: job.id,
    kind: job.kind,
    scene: job.scene,
    status: job.status,
    startedAt: job.startedAt,
    result: job.result,
    error: job.error,
    lastEvent: job.events[job.events.length - 1] ?? null,
  };
}
