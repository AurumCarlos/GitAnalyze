// Fonctions partagées entre l'accueil et le tableau de bord.

export const $ = id => document.getElementById(id);
const NF = new Intl.NumberFormat('fr-FR');
export const fmt = n => NF.format(Math.round(n));
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function timeAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'à l\'instant';
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}

/* Thème clair / sombre / automatique, mémorisé dans le navigateur. */
const THEMES = ['auto', 'light', 'dark'];
const LABEL = { auto: 'Auto', light: 'Clair', dark: 'Sombre' };
let theme = 'auto';
try { theme = localStorage.getItem('gitanalyze-theme') || 'auto'; } catch { /* stockage indisponible */ }

function applyTheme() {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  const l = document.getElementById('themeLabel');
  if (l) l.textContent = LABEL[theme];
}
applyTheme();

export function initThemeButton(onChange) {
  applyTheme();
  const btn = document.getElementById('themeBtn');
  if (!btn) return;
  btn.onclick = () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    try { localStorage.setItem('gitanalyze-theme', theme); } catch { /* ignoré */ }
    applyTheme();
    onChange?.();
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (theme === 'auto') onChange?.(); });
}

export const reportUrl = repo => '/report?repo=' + encodeURIComponent(repo.trim());
