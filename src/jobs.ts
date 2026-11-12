/**
 * File d'attente des analyses + cache disque.
 *
 * - Une seule analyse à la fois par dépôt (les visiteurs suivants rejoignent
 *   l'analyse en cours).
 * - Au plus MAX_CONCURRENT analyses simultanées, les autres attendent.
 * - Les résultats sont stockés compressés dans data/cache/<id>.json.gz et
 *   réutilisés pendant CACHE_TTL_MS.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { analyzeRepo, type Stage } from './analyze.ts';
import { UserError, type RepoRef } from './repoUrl.ts';

const gzipAsync = promisify(gzip);

export const CACHE_DIR = join(process.env.DATA_DIR ?? 'data', 'cache');
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? 2);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS ?? 6 * 3600_000);

export interface JobEvent {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  stage: Stage;
  percent: number;
  message: string;
  error?: string;
}

export interface Summary {
  id: string;
  key: string;
  name: string;
  web: string;
  commits: number;
  authors: number;
  lines: number;
  topLanguage: string;
  finishedAt: number;
  sizeBytes: number;
}

interface Job extends JobEvent {
  ref: RepoRef;
  listeners: Set<(e: JobEvent) => void>;
  summary?: Summary;
}

const jobs = new Map<string, Job>();
const queue: Job[] = [];
let running = 0;

export const jobId = (key: string) => createHash('sha1').update(key).digest('hex').slice(0, 16);
export const dataPath = (id: string) => join(CACHE_DIR, id + '.json.gz');
const metaPath = (id: string) => join(CACHE_DIR, id + '.meta.json');

function publicState(j: Job): JobEvent {
  const { id, status, stage, percent, message, error } = j;
  return { id, status, stage, percent, message, error };
}

function emit(j: Job) {
  const e = publicState(j);
  for (const l of j.listeners) l(e);
}

/** Recharge les résumés des analyses déjà en cache au démarrage. */
export async function loadCache(): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  for (const f of await readdir(CACHE_DIR)) {
    if (!f.endsWith('.meta.json')) continue;
    try {
      const summary = JSON.parse(await readFile(join(CACHE_DIR, f), 'utf8')) as Summary & { ref: RepoRef };
      jobs.set(summary.id, {
        id: summary.id, status: 'done', stage: 'done', percent: 100, message: 'Analyse terminée.',
        ref: summary.ref, listeners: new Set(), summary,
      });
    } catch { /* fichier corrompu : ignoré */ }
  }
}

export function getJob(id: string): JobEvent | undefined {
  const j = jobs.get(id);
  return j && publicState(j);
}

export function subscribe(id: string, fn: (e: JobEvent) => void): () => void {
  const j = jobs.get(id);
  if (!j) return () => {};
  j.listeners.add(fn);
  return () => j.listeners.delete(fn);
}

/** Démarre (ou rejoint) l'analyse d'un dépôt. */
export function startAnalysis(ref: RepoRef, force = false): JobEvent {
  const id = jobId(ref.key);
  const existing = jobs.get(id);
  if (existing) {
    if (existing.status === 'queued' || existing.status === 'running') return publicState(existing);
    const fresh = existing.status === 'done' && existing.summary && Date.now() - existing.summary.finishedAt < CACHE_TTL_MS;
    if (fresh && !force) return publicState(existing);
  }
  const job: Job = {
    id, ref, status: 'queued', stage: 'queued', percent: 0, message: 'En attente…',
    listeners: existing?.listeners ?? new Set(), summary: existing?.summary,
  };
  jobs.set(id, job);
  queue.push(job);
  updateQueuePositions();
  pump();
  return publicState(job);
}

function updateQueuePositions() {
  queue.forEach((j, i) => {
    j.message = i === 0 && running < MAX_CONCURRENT ? 'Démarrage…' : `En file d'attente (position ${i + 1})…`;
    emit(j);
  });
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift()!;
    running++;
    run(job).finally(() => { running--; updateQueuePositions(); pump(); });
  }
}

async function run(job: Job) {
  job.status = 'running';
  let lastEmit = 0;
  try {
    const report = await analyzeRepo(job.ref, (stage, percent, message) => {
      job.stage = stage; job.percent = percent; job.message = message;
      const now = Date.now();
      if (now - lastEmit > 150 || percent === 0) { lastEmit = now; emit(job); }
    });

    job.stage = 'files'; job.percent = 100; job.message = 'Enregistrement du rapport…'; emit(job);
    const gz = await gzipAsync(JSON.stringify(report));
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(dataPath(job.id) + '.tmp', gz);
    await rename(dataPath(job.id) + '.tmp', dataPath(job.id));

    const summary: Summary = {
      id: job.id, key: job.ref.key, name: report.name, web: report.web,
      commits: report.commits.length, authors: report.authors.length, lines: report.head.lines,
      topLanguage: report.langs[0]?.[0] ?? '', finishedAt: Date.now(), sizeBytes: gz.length,
    };
    await writeFile(metaPath(job.id), JSON.stringify({ ...summary, ref: job.ref }));
    job.summary = summary;
    job.status = 'done'; job.stage = 'done'; job.percent = 100;
    job.message = `Analyse terminée en ${(report.durationMs / 1000).toFixed(1)} s.`;
  } catch (e) {
    job.status = 'error'; job.stage = 'error';
    job.error = e instanceof UserError ? e.message : 'Erreur interne pendant l\'analyse.';
    job.message = job.error;
    if (!(e instanceof UserError)) console.error(`[${job.ref.key}]`, e);
  }
  emit(job);
}

/** Dernières analyses terminées, pour la page d'accueil. */
export function recentAnalyses(limit = 12): Summary[] {
  return [...jobs.values()]
    .filter(j => j.status === 'done' && j.summary)
    .map(j => j.summary!)
    .sort((a, b) => b.finishedAt - a.finishedAt)
    .slice(0, limit);
}

export function jobSummary(id: string): Summary | undefined {
  return jobs.get(id)?.summary;
}
