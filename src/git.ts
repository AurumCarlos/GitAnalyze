/**
 * Lancement de git sans shell (arguments passés en tableau : aucune injection
 * possible) avec un environnement verrouillé : pas d'invite de mot de passe,
 * pas d'assistant d'identifiants, HTTPS uniquement.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const SAFE_CONFIG = [
  '-c', 'credential.helper=',
  '-c', 'core.askPass=',
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
  '-c', 'core.quotePath=false',
];

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  LC_ALL: 'C',
};

export function gitSpawn(args: string[], cwd?: string): ChildProcessWithoutNullStreams {
  return spawn('git', [...SAFE_CONFIG, ...args], { cwd, env: GIT_ENV, windowsHide: true });
}

/** Exécute git et renvoie sa sortie standard complète. */
export function git(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = gitSpawn(args, cwd);
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new Error(`git ${args[0]} a échoué (${code}) : ${err.trim().slice(-500)}`));
    });
  });
}

/** Comme git(), mais renvoie une valeur par défaut en cas d'échec. */
export async function gitOr(args: string[], cwd: string, fallback = ''): Promise<string> {
  try { return await git(args, cwd); } catch { return fallback; }
}
