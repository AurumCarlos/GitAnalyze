/**
 * Normalisation et validation des adresses de dépôt saisies par l'utilisateur.
 *
 * Formats acceptés :
 *   owner/repo                              (GitHub par défaut)
 *   github.com/owner/repo
 *   https://github.com/owner/repo(.git)     (y compris /tree/main/... copié depuis le navigateur)
 *   git@github.com:owner/repo.git
 *   ssh://git@github.com/owner/repo.git
 *
 * Le dépôt est toujours cloné en HTTPS (le serveur n'a pas de clé SSH) et
 * uniquement depuis un hôte autorisé, pour éviter que le serveur soit utilisé
 * pour atteindre des machines internes.
 */

export class UserError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface RepoRef {
  host: string;
  path: string;      // "owner/repo" (ou "groupe/sous-groupe/repo" sur GitLab)
  key: string;       // identifiant stable, en minuscules : "github.com/owner/repo"
  name: string;      // "repo"
  cloneUrl: string;  // https://host/path.git
  webUrl: string;    // https://host/path
}

const DEFAULT_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org'];

/** Hôtes autorisés : variable ALLOWED_HOSTS ("*" pour tout hôte public). */
export function allowedHosts(): string[] | '*' {
  const env = process.env.ALLOWED_HOSTS?.trim();
  if (!env) return DEFAULT_HOSTS;
  if (env === '*') return '*';
  return env.split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
}

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,100}$/;
/** Hôtes dont l'URL web est toujours /owner/repo/... */
const TWO_SEGMENT_HOSTS = new Set(['github.com', 'bitbucket.org', 'codeberg.org']);

function isForbiddenHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (/^[\d.]+$/.test(host)) return true;           // IPv4 littérale
  if (host.includes(':') || host.startsWith('[')) return true; // IPv6 littérale
  return false;
}

export function parseRepoUrl(raw: unknown): RepoRef {
  if (typeof raw !== 'string') throw new UserError('Adresse manquante.');
  let input = raw.trim();
  if (!input) throw new UserError('Adresse manquante.');
  if (input.length > 300) throw new UserError('Adresse trop longue.');
  if (/\s/.test(input)) throw new UserError('L\'adresse ne doit pas contenir d\'espaces.');

  let host: string;
  let path: string;
  let m: RegExpMatchArray | null;

  if (/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(input)) {
    // "owner/repo" -> GitHub (un nom d'utilisateur GitHub ne contient jamais de point)
    host = 'github.com';
    path = input;
  } else if ((m = input.match(/^[A-Za-z0-9._-]+@([^:/]+):(.+)$/))) {
    // git@host:owner/repo.git
    host = m[1];
    path = m[2];
  } else {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) input = 'https://' + input;
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new UserError('Adresse invalide.');
    }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) {
      throw new UserError(`Protocole non supporté : ${url.protocol}`);
    }
    if (url.password) throw new UserError('Ne mettez pas d\'identifiants dans l\'adresse.');
    host = url.hostname;
    path = decodeURIComponent(url.pathname);
  }

  host = host.toLowerCase().replace(/^www\./, '');
  if (isForbiddenHost(host) || !HOSTNAME_RE.test(host)) throw new UserError(`Hôte invalide : ${host}`);
  const allowed = allowedHosts();
  if (allowed !== '*' && !allowed.includes(host)) {
    throw new UserError(`Hôte non autorisé : ${host}. Hôtes acceptés : ${allowed.join(', ')}.`);
  }

  // Nettoyage du chemin : pages web (/tree/..., /-/..., /blob/...), ".git" final.
  let segs = path.split('/').filter(Boolean);
  const dash = segs.indexOf('-');
  if (dash >= 0) segs = segs.slice(0, dash);
  if (TWO_SEGMENT_HOSTS.has(host)) segs = segs.slice(0, 2);
  if (segs.length) segs[segs.length - 1] = segs[segs.length - 1].replace(/\.git$/i, '');
  if (segs.length < 2) throw new UserError('Indiquez un dépôt complet, par exemple : owner/repo.');
  for (const s of segs) {
    if (!SEGMENT_RE.test(s) || s === '.' || s === '..') throw new UserError(`Chemin invalide : ${s}`);
  }

  const cleanPath = segs.join('/');
  return {
    host,
    path: cleanPath,
    key: `${host}/${cleanPath}`.toLowerCase(),
    name: segs[segs.length - 1],
    cloneUrl: `https://${host}/${cleanPath}.git`,
    webUrl: `https://${host}/${cleanPath}`,
  };
}
