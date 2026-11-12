/**
 * Serveur web GitAnalyze.
 *
 *   GET  /                          page d'accueil
 *   GET  /report?repo=<adresse>     tableau de bord
 *   POST /api/analyses              { url, force? } -> démarre ou rejoint une analyse
 *   GET  /api/analyses/:id          état de l'analyse
 *   GET  /api/analyses/:id/events   progression en direct (Server-Sent Events)
 *   GET  /api/analyses/:id/data     rapport complet (JSON compressé)
 *   GET  /api/recent                dernières analyses
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  allowedHosts, parseRepoUrl, UserError,
} from './repoUrl.ts';
import {
  dataPath, getJob, jobId, jobSummary, loadCache, recentAnalyses, startAnalysis, subscribe,
} from './jobs.ts';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '1');
app.use(express.json({ limit: '4kb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

/* Limite simple : N analyses lancées par adresse IP et par fenêtre de temps. */
const RATE_LIMIT = Number(process.env.RATE_LIMIT ?? 20);
const RATE_WINDOW_MS = 10 * 60_000;
const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter(t => now - t < RATE_WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  return list.length > RATE_LIMIT;
}

app.post('/api/analyses', (req, res) => {
  const ref = parseRepoUrl(req.body?.url);
  const force = req.body?.force === true;
  const before = getJob(jobId(ref.key));
  const needsWork = !before || before.status === 'error' || force;
  if (needsWork && rateLimited(req.ip ?? 'inconnu')) {
    throw new UserError('Trop d\'analyses demandées. Réessayez dans quelques minutes.', 429);
  }
  const state = startAnalysis(ref, force);
  res.json({ ...state, repo: { key: ref.key, name: ref.name, web: ref.webUrl, host: ref.host } });
});

app.get('/api/analyses/:id', (req, res) => {
  const state = getJob(req.params.id);
  if (!state) throw new UserError('Analyse inconnue.', 404);
  res.json({ ...state, summary: jobSummary(req.params.id) });
});

app.get('/api/analyses/:id/events', (req, res) => {
  const state = getJob(req.params.id);
  if (!state) throw new UserError('Analyse inconnue.', 404);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  send(state);
  if (state.status === 'done' || state.status === 'error') return res.end();
  const unsubscribe = subscribe(req.params.id, e => {
    send(e);
    if (e.status === 'done' || e.status === 'error') { cleanup(); res.end(); }
  });
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
  req.on('close', cleanup);
});

app.get('/api/analyses/:id/data', async (req, res) => {
  const id = req.params.id;
  if (!/^[0-9a-f]{16}$/.test(id) || getJob(id)?.status === undefined) throw new UserError('Analyse inconnue.', 404);
  const file = dataPath(id);
  const info = await stat(file).catch(() => null);
  if (!info) throw new UserError('Rapport indisponible : relancez l\'analyse.', 404);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Vary', 'Accept-Encoding');
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', info.size);
    createReadStream(file).pipe(res);
  } else {
    createReadStream(file).pipe(createGunzip()).pipe(res);
  }
});

app.get('/api/recent', (_req, res) => {
  res.json(recentAnalyses());
});

app.get('/api/config', (_req, res) => {
  res.json({ hosts: allowedHosts() });
});

app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: '1h' }));

app.use('/api', (_req, _res) => { throw new UserError('Route inconnue.', 404); });

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof UserError) return res.status(err.status).json({ error: err.message });
  if (err && typeof err === 'object' && 'type' in err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Requête invalide.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Erreur interne du serveur.' });
});

await loadCache();
app.listen(PORT, HOST, () => {
  console.log(`GitAnalyze prêt sur http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
