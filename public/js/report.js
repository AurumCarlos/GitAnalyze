// Page /report?repo=... : lance (ou rejoint) l'analyse, affiche la progression,
// puis le tableau de bord.
import { $, initThemeButton, reportUrl } from './common.js';
import { renderDashboard, rerender } from './dashboard.js';

initThemeButton(() => rerender());

const params = new URLSearchParams(location.search);
const repo = (params.get('repo') || '').trim();
const STAGES = ['queued', 'clone', 'history', 'files'];
let jobId = null;
let startedAt = Date.now();
let clock = null;
let source = null;

$('miniForm').addEventListener('submit', e => {
  e.preventDefault();
  const v = $('miniRepo').value.trim();
  if (v) location.href = reportUrl(v);
});

if (!repo) location.replace('/');
else start(params.has('refresh'));

async function start(force) {
  showProgress();
  let res, body;
  try {
    res = await fetch('/api/analyses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: repo, force }),
    });
    body = await res.json();
  } catch {
    return showError('Impossible de contacter le serveur.');
  }
  if (!res.ok) return showError(body.error || 'Erreur inconnue.');

  jobId = body.id;
  document.title = body.repo.name + ' · GitAnalyze';
  $('pName').textContent = body.repo.name;
  $('pKey').textContent = body.repo.key;
  if (force) history.replaceState(null, '', reportUrl(repo));

  if (body.status === 'done') return loadReport();
  update(body);
  listen();
}

function listen() {
  source?.close();
  source = new EventSource(`/api/analyses/${jobId}/events`);
  source.onmessage = ev => {
    const e = JSON.parse(ev.data);
    update(e);
    if (e.status === 'done') { source.close(); loadReport(); }
    if (e.status === 'error') { source.close(); showError(e.error); }
  };
  source.onerror = () => {
    // Le navigateur se reconnecte tout seul ; si le serveur a fermé le flux
    // après la fin, on vérifie l'état final.
    if (source.readyState === EventSource.CLOSED) poll();
  };
}

async function poll() {
  const r = await fetch(`/api/analyses/${jobId}`).then(x => x.json()).catch(() => null);
  if (!r) return;
  if (r.status === 'done') loadReport();
  else if (r.status === 'error') showError(r.error);
  else listen();
}

function showProgress() {
  $('dashView').hidden = true;
  $('progressView').hidden = false;
  $('pError').hidden = true;
  $('pActions').hidden = true;
  $('pBar').classList.add('indeterminate');
  startedAt = Date.now();
  clearInterval(clock);
  clock = setInterval(() => { $('pTime').textContent = Math.floor((Date.now() - startedAt) / 1000) + ' s'; }, 500);
}

function update(e) {
  $('pMsg').textContent = e.message;
  const idx = STAGES.indexOf(e.stage);
  document.querySelectorAll('#pSteps li').forEach((li, i) => {
    li.classList.toggle('done', i < idx || e.stage === 'done');
    li.classList.toggle('active', i === idx);
    li.querySelector('.si').textContent = i < idx || e.stage === 'done' ? '✓' : '';
  });
  // Barre globale : clonage 0-60 %, historique 60-85 %, fichiers 85-100 %.
  const span = { queued: [0, 0], clone: [0, 60], history: [60, 85], files: [85, 100], done: [100, 100] }[e.stage];
  if (!span) return;
  const overall = span[0] + (span[1] - span[0]) * (e.percent || 0) / 100;
  const bar = $('pBar');
  bar.classList.toggle('indeterminate', e.stage === 'queued');
  bar.firstElementChild.style.width = overall + '%';
}

function showError(msg) {
  clearInterval(clock);
  $('progressView').hidden = false;
  $('dashView').hidden = true;
  $('pBar').classList.remove('indeterminate');
  $('pError').textContent = msg;
  $('pError').hidden = false;
  $('pActions').hidden = false;
  document.querySelectorAll('#pSteps li.active').forEach(li => li.classList.remove('active'));
}
$('retryBtn').onclick = () => start(true);

async function loadReport() {
  $('pMsg').textContent = 'Chargement du rapport…';
  $('pBar').classList.add('indeterminate');
  let data;
  try {
    const res = await fetch(`/api/analyses/${jobId}/data`);
    if (!res.ok) throw new Error((await res.json()).error);
    data = await res.json();
  } catch (err) {
    return showError(err.message || 'Impossible de charger le rapport.');
  }
  clearInterval(clock);
  $('progressView').hidden = true;
  $('dashView').hidden = false;
  document.title = data.name + ' · GitAnalyze';
  renderDashboard(data);

  $('refreshBtn').onclick = () => start(true);
  $('exportBtn').onclick = () => {
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `gitanalyze_${data.name}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
}

