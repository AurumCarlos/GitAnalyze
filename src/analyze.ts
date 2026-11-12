/**
 * Analyse d'un dépôt : clone « bare » dans un dossier temporaire, lecture de
 * l'historique (git log --numstat) et du contenu de HEAD (git cat-file --batch),
 * puis production du rapport consommé par le tableau de bord.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { git, gitOr, gitSpawn } from './git.ts';
import { languageOf } from './languages.ts';
import { UserError, type RepoRef } from './repoUrl.ts';

export type Stage = 'queued' | 'clone' | 'history' | 'files' | 'done' | 'error';
export type ProgressFn = (stage: Stage, percent: number, message: string) => void;

/** Commit compact : [jour, heure, auteur, ajouts, suppressions, fichiers, merge, hash, sujet, timestamp] */
type CommitRow = [number, number, number, number, number, number, 0 | 1, string, string, number];

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
  churn: [string, number, number, number][];
  churnTotal: number;
  head: { files: number; binary: number; binaryBytes: number; lines: number; blank: number; bytes: number };
  langs: [string, number, number, number, number][];
  bigFiles: [string, number, number][];
}

const CLONE_TIMEOUT_MS = Number(process.env.CLONE_TIMEOUT_MS ?? 10 * 60_000);

export async function analyzeRepo(ref: RepoRef, progress: ProgressFn): Promise<Report> {
  const started = Date.now();
  const dir = await mkdtemp(join(tmpdir(), 'gitanalyze-'));
  try {
    await clone(ref, dir, progress);

    progress('history', 0, 'Lecture de l\'historique…');
    const headCommit = (await gitOr(['rev-parse', 'HEAD'], dir)).trim();
    if (!headCommit) throw new UserError('Ce dépôt est vide : il ne contient aucun commit.', 422);

    const [branch, total, all, heads, tags, objects] = await Promise.all([
      gitOr(['symbolic-ref', '--short', 'HEAD'], dir, 'HEAD'),
      gitOr(['rev-list', '--count', 'HEAD'], dir, '0'),
      gitOr(['rev-list', '--all', '--count'], dir, '0'),
      gitOr(['for-each-ref', '--format=x', 'refs/heads'], dir),
      gitOr(['for-each-ref', '--format=x', 'refs/tags'], dir),
      gitOr(['count-objects', '-v'], dir),
    ]);
    let gitSize = 0;
    for (const line of objects.split('\n')) {
      const m = /^(size|size-pack): (\d+)/.exec(line);
      if (m) gitSize += Number(m[2]) * 1024;
    }

    const history = await readHistory(dir, Number(total) || 0, progress);
    progress('files', 0, 'Analyse des fichiers…');
    const head = await readHead(dir, progress);

    return {
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
      ...history,
      ...head,
    };
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Clonage                                                            */
/* ------------------------------------------------------------------ */

const CLONE_PHASES: Record<string, [number, number, string]> = {
  Counting: [0, 3, 'Préparation du dépôt distant…'],
  Compressing: [3, 5, 'Compression côté serveur…'],
  Receiving: [5, 85, 'Téléchargement des objets'],
  Resolving: [85, 100, 'Reconstruction de l\'historique…'],
};

function clone(ref: RepoRef, dir: string, progress: ProgressFn): Promise<void> {
  return new Promise((resolve, reject) => {
    progress('clone', 0, 'Connexion à ' + ref.host + '…');
    const p = gitSpawn(['clone', '--bare', '--progress', '--', ref.cloneUrl, dir]);
    let tail = '';
    let last = -1;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill(); }, CLONE_TIMEOUT_MS);

    p.stdout.resume();
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (chunk: string) => {
      tail = (tail + chunk).slice(-4000);
      for (const line of chunk.split(/[\r\n]+/)) {
        const m = /(Counting|Compressing|Receiving|Resolving) [a-z]+:\s+(\d+)%(?:[^,]*,\s*([\d.]+ [KMG]iB))?/.exec(line);
        if (!m) continue;
        const [from, to, label] = CLONE_PHASES[m[1]];
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
      if (timedOut) return reject(new UserError('Le clonage a dépassé le délai autorisé : le dépôt est sans doute trop volumineux.', 413));
      if (/not found|could not read Username|Authentication failed|terminal prompts disabled|returned error: 40[134]/i.test(tail)) {
        return reject(new UserError('Dépôt introuvable ou privé. Seuls les dépôts publics peuvent être analysés.', 404));
      }
      if (/Could not resolve host|Failed to connect|timed out/i.test(tail)) {
        return reject(new UserError(`Impossible de joindre ${ref.host}. Réessayez dans un instant.`, 502));
      }
      const lastLine = tail.trim().split('\n').pop() ?? '';
      reject(new UserError('Échec du clonage : ' + lastLine.replace(/^fatal:\s*/, ''), 502));
    });
  });
}

/* ------------------------------------------------------------------ */
/* Historique                                                         */
/* ------------------------------------------------------------------ */

async function readHistory(dir: string, total: number, progress: ProgressFn) {
  const p = gitSpawn([
    // Un clone « bare » n'a pas de copie de travail : on lit le .gitattributes
    // de HEAD (fichiers marqués -diff, binaires…) comme le ferait un clone normal.
    '-c', 'attr.tree=HEAD',
    'log', '--no-renames', '--numstat', '--no-color',
    '--pretty=format:@@@%x1f%H%x1f%an%x1f%ae%x1f%at%x1f%ai%x1f%P%x1f%s', 'HEAD',
  ], dir);
  const done = new Promise<void>((resolve, reject) => {
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error('git log a échoué : ' + err.slice(-300))));
  });

  const authorIndex = new Map<string, number>();
  const authors: [string, string][] = [];
  const commits: CommitRow[] = [];
  const churn = new Map<string, [number, number, number]>();
  let cur: CommitRow | null = null;

  const rl = createInterface({ input: p.stdout, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    if (line.startsWith('@@@\x1f')) {
      const f = line.slice(4).split('\x1f');
      if (f.length < 7) continue;
      const [hash, name, email, ts, iso, parents] = f;
      const subject = f.slice(6).join(' ');
      const key = (name || email).toLowerCase();
      let a = authorIndex.get(key);
      if (a === undefined) {
        a = authors.length;
        authors.push([name || email, email]);
        authorIndex.set(key, a);
      }
      const y = Number(iso.slice(0, 4)), mo = Number(iso.slice(5, 7)), d = Number(iso.slice(8, 10));
      const day = Math.floor(Date.UTC(y, mo - 1, d) / 864e5);
      const hour = Number(iso.slice(11, 13)) || 0;
      cur = [day, hour, a, 0, 0, 0, parents.includes(' ') ? 1 : 0, hash.slice(0, 10),
        subject.length > 120 ? subject.slice(0, 119) + '…' : subject, Number(ts)];
      commits.push(cur);
      if (commits.length % 2000 === 0 && total) {
        progress('history', Math.min(99, Math.floor(100 * commits.length / total)),
          `Lecture de l'historique (${commits.length.toLocaleString('fr-FR')} / ${total.toLocaleString('fr-FR')} commits)…`);
      }
      continue;
    }
    if (!cur) continue;
    // numstat : "ajouts\tsuppressions\tchemin" ("-" pour un fichier binaire)
    const t1 = line.indexOf('\t'), t2 = line.indexOf('\t', t1 + 1);
    if (t1 < 0 || t2 < 0) continue;
    const add = line[0] === '-' ? 0 : Number(line.slice(0, t1));
    const del = line[t1 + 1] === '-' ? 0 : Number(line.slice(t1 + 1, t2));
    const path = line.slice(t2 + 1);
    cur[3] += add;
    cur[4] += del;
    cur[5]++;
    const c = churn.get(path);
    if (c) { c[0]++; c[1] += add; c[2] += del; } else churn.set(path, [1, add, del]);
  }
  await done;

  const churnTop = [...churn.entries()]
    .sort((x, y) => y[1][0] - x[1][0] || (y[1][1] + y[1][2]) - (x[1][1] + x[1][2]))
    .slice(0, 100)
    .map(([path, [n, add, del]]) => [path, n, add, del] as [string, number, number, number]);

  return { authors, commits, churn: churnTop, churnTotal: churn.size };
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

    const finish = () => {
      if (!cur.binary && seen > 0 && lastByte !== 10) {
        cur.lines++;
        if (!lineHasText) cur.blank++;
      }
      idx++;
      inBody = false;
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
            if (seen < 8000) {
              // Fichier binaire si un octet nul apparaît dans ses 8000 premiers octets (comme git).
              const probeEnd = Math.min(end, off + (8000 - seen));
              if (buf.subarray(off, probeEnd).includes(0)) cur.binary = true;
            }
            if (!cur.binary) {
              for (let i = off; i < end; i++) {
                const b = buf[i];
                if (b === 10) { cur.lines++; if (!lineHasText) cur.blank++; lineHasText = false; }
                else if (b !== 32 && b !== 9 && b !== 13 && b !== 11 && b !== 12) lineHasText = true;
              }
            }
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
        finish();
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
