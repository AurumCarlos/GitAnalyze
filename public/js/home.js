import { $, esc, fmt, initThemeButton, reportUrl, timeAgo } from './common.js';

initThemeButton();

const input = $('repo');
const error = $('formError');

function go(repo) {
  if (!repo.trim()) {
    error.textContent = 'Collez l\'adresse d\'un dépôt, par exemple https://github.com/expressjs/express';
    error.hidden = false;
    input.focus();
    return;
  }
  location.href = reportUrl(repo);
}

$('form').addEventListener('submit', e => { e.preventDefault(); go(input.value); });
input.addEventListener('input', () => { error.hidden = true; });
document.querySelectorAll('.example').forEach(b => b.addEventListener('click', () => go(b.dataset.repo)));

// Hôtes acceptés par le serveur
fetch('/api/config').then(r => r.json()).then(c => {
  $('hostsNote').textContent = c.hosts === '*' ? 'Tout hôte git public est accepté.' : 'Hôtes acceptés : ' + c.hosts.join(', ') + '.';
}).catch(() => {});

// Analyses récentes
fetch('/api/recent').then(r => r.json()).then(list => {
  if (!list.length) return;
  $('recent').innerHTML = list.map(r => `
    <a class="repo-card" href="${reportUrl(r.key)}">
      <div class="rn">${esc(r.name)}</div>
      <div class="rk">${esc(r.key)}</div>
      <div class="rs">
        <span><b>${fmt(r.commits)}</b> commits</span>
        <span><b>${fmt(r.authors)}</b> auteurs</span>
        ${r.topLanguage ? `<span>${esc(r.topLanguage)}</span>` : ''}
        <span class="muted">${timeAgo(r.finishedAt)}</span>
      </div>
    </a>`).join('');
  $('recentSection').hidden = false;
}).catch(() => {});
