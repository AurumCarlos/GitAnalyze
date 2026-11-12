/**
 * Analyse d'un dépôt.
 *
 * 1. Le dépôt est cloné une seule fois (clone « bare », sans copie de travail)
 *    dans DATA_DIR/repos/<id>.git, puis simplement mis à jour par `git fetch`
 *    lors des analyses suivantes.
 * 2. Seuls les commits absents de l'analyse précédente sont lus
 *    (`git log --numstat`), répartis entre plusieurs processus git en parallèle.
 * 3. Le contenu de HEAD est lu d'un bloc via `git cat-file --batch`.
 */
import { availableParallelism } from 'node:os';
import { access, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { git, gitOr, gitSpawn } from './git.ts';
import { languageOf } from './languages.ts';
import { UserError, type RepoRef } from './repoUrl.ts';

export type Stage = 'queued' | 'clone' | 'history' | 'files' | 'done' | 'error';
export type ProgressFn = (stage: Stage, percent: number, message: string) => void;

/** Commit compact : [jour, heure, auteur, ajouts, suppressions, fichiers, merge, hash, sujet, timestamp] */
export type CommitRow = [number, number, number, number, number, number, 0 | 1, string, string, number];
type ChurnRow = [string, number, number, number];

export interface Report {
  name: string;
  key: string;
  url: string;
  web: string;
  branch: string;
  headCommit: string;
  generated: number;
  durationMs: number;
  allCommits: number;
  branches: number;
  tags: number;
  gitSize: number;
  authors: [string, string][];
  commits: CommitRow[];
  churn: ChurnRow[];
  churnTotal: number;
  head: { files: number; binary: number; binaryBytes: number; lines: number; blank: number; bytes: number };
  langs: [string, number, number, number, number][];
  bigFiles: [string, number, number][];
}

/** Ce qu'il faut garder d'une analyse pour pouvoir la compléter la fois suivante. */
export interface HistoryState {
  headCommit: string;
  authors: [string, string][];
  commits: CommitRow[];
  churn: ChurnRow[]; // complet, pas seulement le top 100 du rapport
}

/** Délai maximal de clonage / fetch. 0 (par défaut) = pas de limite. */
const CLONE_TIMEOUT_MS = Number(process.env.CLONE_TIMEOUT_MS ?? 0);
const LOG_WORKERS = Math.max(1, Number(process.env.LOG_WORKERS ?? Math.min(8, availableParallelism())));
const MIN_COMMITS_PER_WORKER = 1500;
const HISTORY_FORMAT = '--pretty=format:@@@%x1f%H%x1f%an%x1f%ae%x1f%at%x1f%ai%x1f%P%x1f%s';

const exists = (p: string) => access(p).then(() => true, () => false);

export async function analyzeRepo(
  ref: RepoRef,
  repoDir: string,
  previous: HistoryState | null,
  progress: ProgressFn,
): Promise<{ report: Report; state: HistoryState }> {
  const started = Date.now();

  /* 1. Clone ou mise à jour */
  let updated = false;
  if (await exists(join(repoDir, 'HEAD'))) {
    try {
      await fetchRepo(ref, repoDir, progress);
      updated = true;
    } catch (e) {
      if (e instanceof UserError) throw e;   // dépôt supprimé, devenu privé…
      await rm(repoDir, { recursive: true, force: true, maxRetries: 3 }); // clone abîmé : on recommence
    }
  }
  if (!updated) {
    previous = null;
    const tmp = repoDir + '.partial';
    await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
    try {
      await cloneRepo(ref, tmp, progress);
      await rm(repoDir, { recursive: true, force: true, maxRetries: 3 });
      await rename(tmp, repoDir);
    } catch (e) {
      await rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      throw e;
    }
  }

  /* 2. Historique */
  progress('history', 0, 'Lecture de l\'historique…');
  const headCommit = (await gitOr(['rev-parse', 'HEAD'], repoDir)).trim();
  if (!headCommit) throw new UserError('Ce dépôt est vide : il ne contient aucun commit.', 422);

  const [branch, all, heads, tags, objects] = await Promise.all([
    gitOr(['symbolic-ref', '--short', 'HEAD'], repoDir, 'HEAD'),
    gitOr(['rev-list', '--all', '--count'], repoDir, '0'),
    gitOr(['for-each-ref', '--format=x', 'refs/heads'], repoDir),
    gitOr(['for-each-ref', '--format=x', 'refs/tags'], repoDir),
    gitOr(['count-objects', '-v'], repoDir),
  ]);
  let gitSize = 0;
  for (const line of objects.split('\n')) {
    const m = /^(size|size-pack): (\d+)/.exec(line);
    if (m) gitSize += Number(m[2]) * 1024;
  }

  // On ne relit que les nouveaux commits si l'ancien HEAD est toujours un ancêtre
  // (sinon l'historique a été réécrit, par exemple par un force-push).
  let base: HistoryState | null = null;
  if (previous?.headCommit) {
    const stillAncestor = previous.headCommit === headCommit
      || await git(['merge-base', '--is-ancestor', previous.headCommit, headCommit], repoDir).then(() => true, () => false);
    if (stillAncestor) base = previous;
  }
  const range = base ? (base.headCommit === headCommit ? [] : [`${base.headCommit}..${headCommit}`]) : [headCommit];
  const revs = range.length ? (await git(['rev-list', ...range], repoDir)).split('\n').filter(Boolean) : [];
  const state = await readHistory(repoDir, revs, base, headCommit, progress);

  /* 3. Contenu actuel */
  progress('files', 0, 'Analyse des fichiers…');
  const head = await readHead(repoDir, progress);

  const churnTop = state.churn.slice()
    .sort((x, y) => y[1] - x[1] || (y[2] + y[3]) - (x[2] + x[3]))
    .slice(0, 100);

  const report: Report = {
    name: ref.name,
    key: ref.key,
    url: ref.cloneUrl,
    web: ref.webUrl,
    branch: branch.trim() || 'HEAD',
    headCommit,
    generated: Math.floor(Date.now() / 1000),
    durationMs: Date.now() - started,
    allCommits: Number(all) || 0,
    branches: heads.split('\n').filter(Boolean).length,
    tags: tags.split('\n').filter(Boolean).length,
    gitSize,
    authors: state.authors,
    commits: state.commits,
    churn: churnTop,
    churnTotal: state.churn.length,
    ...head,
  };
  return { report, state };
}

/* ------------------------------------------------------------------ */
/* Clonage et mise à jour                                             */
/* ------------------------------------------------------------------ */

const TRANSFER_PHASES: Record<string, [number, number, string]> = {
  Counting: [0, 3, 'Préparation du dépôt distant…'],
  Compressing: [3, 5, 'Compression côté serveur…'],
  Receiving: [5, 85, 'Téléchargement des objets'],
  Resolving: [85, 100, 'Reconstruction de l\'historique…'],
};

/** Lance un clone ou un fetch et traduit sa progression et ses erreurs. */
function runTransfer(ref: RepoRef, args: string[], cwd: string | undefined, progress: ProgressFn): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = gitSpawn(args, cwd);
    let tail = '';
    let last = -1;
    let timedOut = false;
    const timer = CLONE_TIMEOUT_MS > 0 ? setTimeout(() => { timedOut = true; p.kill(); }, CLONE_TIMEOUT_MS) : undefined;

    p.stdout.resume();
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (chunk: string) => {
      tail = (tail + chunk).slice(-4000);
      for (const line of chunk.split(/[\r\n]+/)) {
        const m = /(Counting|Compressing|Receiving|Resolving) [a-z]+:\s+(\d+)%(?:[^,]*,\s*([\d.]+ [KMG]iB))?/.exec(line);
        if (!m) continue;
        const [from, to, label] = TRANSFER_PHASES[m[1]];
        const pct = Math.floor(from + (to - from) * Number(m[2]) / 100);
        if (pct === last) continue;
        last = pct;
        progress('clone', pct, m[3] ? `${label} (${m[3].replace('iB', 'o')})…` : label.endsWith('…') ? label : label + '…');
      }
    });
    p.on('error', err => { clearTimeout(timer); reject(err); });
    p.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      if (timedOut) return reject(new UserError('Le téléchargement a dépassé le délai autorisé : le dépôt est sans doute trop volumineux.', 413));
      if (/not found|could not read Username|Authentication failed|terminal prompts disabled|returned error: 40[134]/i.test(tail)) {
        return reject(new UserError('Dépôt introuvable ou privé. Seuls les dépôts publics peuvent être analysés.', 404));
      }
      if (/Could not resolve host|Failed to connect|timed out/i.test(tail)) {
        return reject(new UserError(`Impossible de joindre ${ref.host}. Réessayez dans un instant.`, 502));
      }
      const lastLine = tail.trim().split('\n').pop() ?? '';
      reject(new Error('git a échoué : ' + lastLine));
    });
  });
}

async function cloneRepo(ref: RepoRef, dir: string, progress: ProgressFn) {
  progress('clone', 0, 'Connexion à ' + ref.host + '…');
  try {
    await runTransfer(ref, ['clone', '--bare', '--progress', '--', ref.cloneUrl, dir], undefined, progress);
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError('Échec du clonage : ' + (e as Error).message.replace(/^git a échoué : (fatal: )?/, ''), 502);
  }
}

async function fetchRepo(ref: RepoRef, dir: string, progress: ProgressFn) {
  progress('clone', 0, 'Recherche de nouveaux commits…');
  await runTransfer(ref, [
    'fetch', '--progress', '--prune', '--force', '--update-head-ok', '--no-write-fetch-head', '--',
    ref.cloneUrl, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*',
  ], dir, progress);
}

/* ------------------------------------------------------------------ */
/* Historique                                                         */
/* ------------------------------------------------------------------ */

/**
 * Lit les commits `revs` (du plus récent au plus ancien) et les ajoute devant
 * ceux de `base`. Les commits sont répartis en blocs contigus, chacun lu par
 * son propre `git log --no-walk --stdin` : le calcul des diffs, qui domine le
 * temps d'analyse, profite ainsi de tous les cœurs.
 */
export async function readHistory(dir: string, revs: string[], base: HistoryState | null, headCommit: string, progress: ProgressFn): Promise<HistoryState> {
  const authors: [string, string][] = base ? base.authors.slice() : [];
  const authorIndex = new Map<string, number>();
  authors.forEach((a, i) => authorIndex.set(a[0].toLowerCase(), i));
  const churn = new Map<string, ChurnRow>();
  for (const c of base?.churn ?? []) churn.set(c[0], [c[0], c[1], c[2], c[3]]);

  const workers = Math.max(1, Math.min(LOG_WORKERS, Math.ceil(revs.length / MIN_COMMITS_PER_WORKER)));
  const size = Math.ceil(revs.length / workers);
  const chunks: string[][] = [];
  for (let i = 0; i < revs.length; i += size) chunks.push(revs.slice(i, i + size));

  let done = 0;
  let lastReport = 0;
  const onCommit = () => {
    done++;
    if (done - lastReport >= 500) {
      lastReport = done;
      progress('history', Math.min(99, Math.floor(100 * done / revs.length)),
        `Lecture de l'historique (${done.toLocaleString('fr-FR')} / ${revs.length.toLocaleString('fr-FR')} commits)…`);
    }
  };
  if (revs.length && base) progress('history', 0, `${revs.length.toLocaleString('fr-FR')} nouveau${revs.length > 1 ? 'x' : ''} commit${revs.length > 1 ? 's' : ''} à lire…`);

  const results = await Promise.all(chunks.map(chunk => readChunk(dir, chunk, authors, authorIndex, churn, onCommit)));
  const commits = results.flat();
  if (base) for (const c of base.commits) commits.push(c);

  return { headCommit, authors, commits, churn: [...churn.values()] };
}

function readChunk(
  dir: string,
  revs: string[],
  authors: [string, string][],
  authorIndex: Map<string, number>,
  churn: Map<string, ChurnRow>,
  onCommit: () => void,
): Promise<CommitRow[]> {
  return new Promise((resolve, reject) => {
    const p = gitSpawn([
      // Un clone « bare » n'a pas de copie de travail : on lit le .gitattributes
      // de HEAD (fichiers marqués -diff, binaires…) comme le ferait un clone normal.
      '-c', 'attr.tree=HEAD',
      'log', '--no-walk=unsorted', '--stdin', '--no-renames', '--numstat', '--no-color', HISTORY_FORMAT,
    ], dir);
    const rows: CommitRow[] = [];
    let cur: CommitRow | null = null;
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.stdin.on('error', () => {});
    p.stdin.end(revs.join('\n') + '\n');

    const rl = createInterface({ input: p.stdout, crlfDelay: Infinity });
    rl.on('line', line => {
      if (!line) return;
      if (line.startsWith('@@@\x1f')) {
        const f = line.slice(4).split('\x1f');
        if (f.length < 7) return;
        const [hash, name, email, ts, iso, parents] = f;
        const subject = f.slice(6).join(' ');
        const display = name || email;
        const key = display.toLowerCase();
        let a = authorIndex.get(key);
        if (a === undefined) {
          a = authors.length;
          authors.push([display, email]);
          authorIndex.set(key, a);
        }
        const day = Math.floor(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 864e5);
        cur = [day, Number(iso.slice(11, 13)) || 0, a, 0, 0, 0, parents.includes(' ') ? 1 : 0, hash.slice(0, 10),
          subject.length > 120 ? subject.slice(0, 119) + '…' : subject, Number(ts)];
        rows.push(cur);
        onCommit();
        return;
      }
      if (!cur) return;
      // numstat : "ajouts\tsuppressions\tchemin" ("-" pour un fichier binaire)
      const t1 = line.indexOf('\t'), t2 = line.indexOf('\t', t1 + 1);
      if (t1 < 0 || t2 < 0) return;
      const add = line[0] === '-' ? 0 : Number(line.slice(0, t1));
      const del = line[t1 + 1] === '-' ? 0 : Number(line.slice(t1 + 1, t2));
      const path = line.slice(t2 + 1);
      cur[3] += add;
      cur[4] += del;
      cur[5]++;
      const c = churn.get(path);
      if (c) { c[1]++; c[2] += add; c[3] += del; } else churn.set(path, [path, 1, add, del]);
    });
    // On attend à la fois la fin du processus et la dernière ligne lue.
    let exitCode: number | null | undefined;
    let linesDone = false;
    const finish = () => {
      if (exitCode === undefined || !linesDone) return;
      if (exitCode === 0) resolve(rows);
      else reject(new Error('git log a échoué : ' + err.slice(-300)));
    };
    rl.on('close', () => { linesDone = true; finish(); });
    p.on('error', reject);
    p.on('close', code => { exitCode = code; finish(); });
  });
}

/* ------------------------------------------------------------------ */
/* Contenu de HEAD                                                    */
/* ------------------------------------------------------------------ */

interface FileStat { path: string; size: number; lines: number; blank: number; binary: boolean }

async function readHead(dir: string, progress: ProgressFn) {
  const tree = await git(['ls-tree', '-r', '-l', '-z', 'HEAD'], dir);
  const files: FileStat[] = [];
  const shas: string[] = [];
  let totalBytes = 0;
  for (const entry of tree.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const [mode, type, sha, size] = entry.slice(0, tab).split(/\s+/);
    if (type !== 'blob' || mode === '120000') continue; // sous-modules et liens symboliques ignorés
    files.push({ path: entry.slice(tab + 1), size: Number(size) || 0, lines: 0, blank: 0, binary: false });
    shas.push(sha);
    totalBytes += Number(size) || 0;
  }
  if (files.length) await countLines(dir, files, shas, totalBytes, progress);

  const langs = new Map<string, [number, number, number, number]>();
  let lines = 0, blank = 0, bytes = 0, binary = 0, binaryBytes = 0;
  for (const f of files) {
    bytes += f.size;
    if (f.binary) { binary++; binaryBytes += f.size; continue; }
    lines += f.lines;
    blank += f.blank;
    const name = languageOf(f.path);
    const l = langs.get(name);
    if (l) { l[0]++; l[1] += f.lines; l[2] += f.blank; l[3] += f.size; } else langs.set(name, [1, f.lines, f.blank, f.size]);
  }

  return {
    head: { files: files.length, binary, binaryBytes, lines, blank, bytes },
    langs: [...langs.entries()].sort((a, b) => b[1][1] - a[1][1])
      .map(([n, [fi, li, bl, by]]) => [n, fi, li, bl, by] as [string, number, number, number, number]),
    bigFiles: files.filter(f => !f.binary).sort((a, b) => b.lines - a.lines).slice(0, 100)
      .map(f => [f.path, f.lines, f.size] as [string, number, number]),
  };
}

const isSpace = (b: number) => b === 32 || b === 9 || b === 13 || b === 11 || b === 12;

/**
 * Lit tous les blobs via un seul processus « git cat-file --batch » et compte
 * les lignes au fil de l'eau (aucun fichier n'est gardé en mémoire).
 * Format de sortie : "<sha> blob <taille>\n<contenu>\n" pour chaque objet.
 */
function countLines(dir: string, files: FileStat[], shas: string[], totalBytes: number, progress: ProgressFn): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = gitSpawn(['cat-file', '--batch'], dir);
    let buf: Buffer = Buffer.alloc(0);
    let idx = 0;
    let inBody = false;
    let remaining = 0;
    let seen = 0;            // octets déjà lus du fichier courant
    let lineHasText = false;
    let lastByte = 10;
    let processed = 0;
    let lastPct = -1;
    let cur: FileStat = files[0];

    /** Compte les lignes de buf[from, end) en sautant d'un saut de ligne au suivant. */
    const scan = (from: number, end: number) => {
      let i = from;
      while (i < end) {
        if (!lineHasText) {
          const b = buf[i];
          if (b === 10) { cur.lines++; cur.blank++; i++; continue; }
          if (isSpace(b)) { i++; continue; }
          lineHasText = true;
        }
        const nl = buf.indexOf(10, i);
        if (nl < 0 || nl >= end) return;
        cur.lines++;
        lineHasText = false;
        i = nl + 1;
      }
    };

    p.stdout.on('data', (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      let off = 0;
      for (;;) {
        if (!inBody) {
          const nl = buf.indexOf(10, off);
          if (nl < 0) break;
          const header = buf.toString('latin1', off, nl).split(' ');
          off = nl + 1;
          cur = files[idx];
          if (header[1] === 'missing' || !cur) { idx++; continue; }
          remaining = Number(header[2]);
          seen = 0; lineHasText = false; lastByte = 10;
          inBody = true;
        }
        if (remaining > 0) {
          const end = Math.min(buf.length, off + remaining);
          if (end === off) break;
          if (!cur.binary) {
            // Fichier binaire si un octet nul apparaît dans ses 8000 premiers octets (comme git).
            if (seen < 8000 && buf.subarray(off, Math.min(end, off + (8000 - seen))).includes(0)) cur.binary = true;
            else scan(off, end);
          }
          lastByte = buf[end - 1];
          seen += end - off;
          processed += end - off;
          remaining -= end - off;
          off = end;
          if (remaining > 0) break;
        }
        if (off >= buf.length) break; // il manque encore le saut de ligne final
        off++;
        if (!cur.binary && seen > 0 && lastByte !== 10) {
          cur.lines++;
          if (!lineHasText) cur.blank++;
        }
        idx++;
        inBody = false;
      }
      buf = buf.subarray(off);
      const pct = totalBytes ? Math.floor(100 * processed / totalBytes) : 100;
      if (pct !== lastPct) {
        lastPct = pct;
        progress('files', Math.min(99, pct), `Analyse des fichiers (${Math.min(idx, files.length).toLocaleString('fr-FR')} / ${files.length.toLocaleString('fr-FR')})…`);
      }
    });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error('git cat-file a échoué : ' + err.slice(-300))));
    p.stdin.on('error', () => {});
    p.stdin.end(shas.join('\n') + '\n');
  });
}
