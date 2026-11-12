// Rendu du tableau de bord à partir du rapport produit par le serveur.
// Tous les calculs dépendant des filtres (période, auteur, merges) sont faits
// ici, dans le navigateur : changer un filtre ne refait aucune requête.
import { $, esc, fmt } from './common.js';

const pct = (a, b) => b ? (100 * a / b).toFixed(1).replace('.', ',') + ' %' : '–';
const dayStr = d => new Date(d * 864e5).toISOString().slice(0, 10);
const strDay = s => Math.floor(Date.parse(s + 'T00:00:00Z') / 864e5);
const wdOf = d => (((d + 3) % 7) + 7) % 7; // 0 = lundi
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const WEEK = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
const dateFr = d => { const t = new Date(d * 864e5); return t.getUTCDate() + ' ' + MONTHS[t.getUTCMonth()] + ' ' + t.getUTCFullYear(); };
function size(b) { const u = ['o', 'Ko', 'Mo', 'Go']; let i = 0; while (b >= 1024 && i < 3) { b /= 1024; i++; } return (i ? b.toFixed(1).replace('.', ',') : b) + ' ' + u[i]; }
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const SERIES = () => ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'].map(css);

// Champs d'un commit : [jour, heure, auteur, ajouts, suppressions, fichiers, merge, hash, sujet, timestamp]
const DAY = 0, HR = 1, AU = 2, ADD = 3, DEL = 4, MERGE = 6, HASH = 7, SUBJ = 8;
const TYPES = ['feat', 'fix', 'docs', 'test', 'refactor', 'perf', 'chore', 'ci', 'build', 'style', 'revert'];
const TYPE_RE = /^([a-zA-Z]+)(\([^)]*\))?!?:/;

let D = null, C = [], ctype = [], minDay = 0, maxDay = 0, WEB = '';
let state = null;
let lastAuthorRows = [];
const charts = {};
let wired = false;

const commitLink = h => WEB ? `<a class="mono" href="${WEB}/commit/${h}" target="_blank" rel="noopener">${h}</a>` : `<span class="mono">${h}</span>`;
const fileLink = p => WEB
  ? `<a href="${WEB}/blob/${encodeURIComponent(D.branch)}/${p.split('/').map(encodeURIComponent).join('/')}" target="_blank" rel="noopener" title="${esc(p)}">${esc(p)}</a>`
  : `<span title="${esc(p)}">${esc(p)}</span>`;

export function renderDashboard(data) {
  D = data;
  C = D.commits;
  WEB = D.web || '';
  minDay = Infinity; maxDay = -Infinity;
  for (const c of C) { if (c[DAY] < minDay) minDay = c[DAY]; if (c[DAY] > maxDay) maxDay = c[DAY]; }
  if (!C.length) minDay = maxDay = Math.floor(Date.now() / 864e5);
  ctype = C.map(c => {
    const m = TYPE_RE.exec(c[SUBJ] || '');
    if (!m) return -1;
    const t = m[1].toLowerCase();
    return TYPES.indexOf(t === 'feature' ? 'feat' : t);
  });
  state = { from: minDay, to: maxDay, author: -1, merges: true, gran: 'auto', sortKey: 'commits', sortDir: -1, search: '' };

  renderHeader();
  wireFilters();
  setAuthorChip();
  setPresetUI('all');
  $('authorSearch').value = '';
  $('merges').checked = true;
  rerender();
}

export function rerender() {
  if (!D) return;
  renderFiltered();
  renderStatic();
}

/* ------------------------------------------------------------------ */

function renderHeader() {
  $('repoName').textContent = D.name;
  $('repoUrl').innerHTML = WEB ? `<a href="${esc(WEB)}" target="_blank" rel="noopener">${esc(D.key || D.url)}</a>` : esc(D.url);
  const pills = [
    ['Branche', esc(D.branch)],
    ['Commits (toutes branches)', fmt(D.allCommits)],
    ['Branches', fmt(D.branches)],
    ['Tags', fmt(D.tags)],
    ['Fichiers', fmt(D.head.files)],
    ['Lignes', fmt(D.head.lines)],
    ['Taille', size(D.gitSize)],
  ];
  $('meta').innerHTML = pills.map(([k, v]) => `<span class="pill">${k} <b>${v}</b></span>`).join('');
  $('footer').textContent = `Analysé le ${new Date(D.generated * 1000).toLocaleString('fr-FR')} en ${(D.durationMs / 1000).toFixed(1).replace('.', ',')} s · commit ${D.headCommit.slice(0, 10)}`;

  const totals = new Array(D.authors.length).fill(0);
  for (const c of C) totals[c[AU]]++;
  const order = D.authors.map((_, i) => i).sort((a, b) => totals[b] - totals[a]);
  $('authorList').innerHTML = order.map(i => `<option value="${esc(D.authors[i][0])}">`).join('');
  $('offline').hidden = typeof window.Chart !== 'undefined';
  if (window.Chart) window.Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
}

function setPresetUI(p) {
  document.querySelectorAll('#presets button').forEach(b => b.classList.toggle('on', b.dataset.p === p));
}

function setAuthor(i) {
  state.author = state.author === i ? -1 : i;
  setAuthorChip();
  rerender();
}

function setAuthorChip() {
  $('authorChip').innerHTML = state.author < 0 ? ''
    : `<span class="chip">${esc(D.authors[state.author][0])}<button title="Retirer le filtre" id="chipX">×</button></span>`;
  if (state.author >= 0) $('chipX').onclick = () => setAuthor(state.author);
}

function wireFilters() {
  if (wired) return;
  wired = true;
  document.querySelectorAll('#presets button').forEach(b => b.onclick = () => {
    const p = b.dataset.p;
    state.to = maxDay;
    state.from = p === 'all' ? minDay : Math.max(minDay, maxDay - Number(p) + 1);
    setPresetUI(p);
    rerender();
  });
  $('from').onchange = e => {
    if (!e.target.value) return;
    state.from = Math.max(minDay, strDay(e.target.value));
    if (state.from > state.to) state.to = state.from;
    setPresetUI(''); rerender();
  };
  $('to').onchange = e => {
    if (!e.target.value) return;
    state.to = Math.min(maxDay, strDay(e.target.value));
    if (state.to < state.from) state.from = state.to;
    setPresetUI(''); rerender();
  };
  $('merges').onchange = e => { state.merges = e.target.checked; rerender(); };
  document.querySelectorAll('#gran button').forEach(b => b.onclick = () => {
    state.gran = b.dataset.g;
    document.querySelectorAll('#gran button').forEach(x => x.classList.toggle('on', x === b));
    rerender();
  });
  $('authorInput').onchange = e => {
    const name = e.target.value.trim();
    const i = D.authors.findIndex(a => a[0] === name);
    if (i >= 0) { state.author = -1; setAuthor(i); e.target.value = ''; }
  };
  $('authorSearch').oninput = e => { state.search = e.target.value.toLowerCase(); renderAuthors(); };

  // Info-bulle partagée (carte de chaleur, barre des langages)
  const tip = $('tip');
  document.addEventListener('mousemove', e => {
    const t = e.target.closest?.('[data-tip]');
    if (!t) { tip.style.opacity = 0; return; }
    tip.textContent = t.dataset.tip;
    tip.style.opacity = 1;
    tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 12) + 'px';
    tip.style.top = (e.clientY + 14) + 'px';
  });
}

/* ---------------- graphiques ---------------- */

function chart(id, cfg) {
  if (!window.Chart) return;
  charts[id]?.destroy();
  charts[id] = new window.Chart($(id), cfg);
}

function baseOpts(extra) {
  const grid = css('--grid'), muted = css('--text-muted');
  const o = {
    responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: css('--text-primary'), titleColor: css('--bg'), bodyColor: css('--bg'),
        padding: 10, cornerRadius: 8, boxPadding: 4,
        titleFont: { family: 'Inter', weight: '600' }, bodyFont: { family: 'Inter' },
      },
    },
    scales: {
      x: { grid: { display: false }, border: { color: grid }, ticks: { color: muted, font: { family: 'Inter', size: 11 }, maxRotation: 0, autoSkipPadding: 14 } },
      y: { beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { color: muted, font: { family: 'Inter', size: 11 }, callback: v => fmt(v), maxTicksLimit: 6 } },
    },
  };
  extra?.(o);
  return o;
}

const barStyle = color => ({
  backgroundColor: color, hoverBackgroundColor: color, borderRadius: 4, borderSkipped: 'start',
  maxBarThickness: 40, categoryPercentage: 0.86, barPercentage: 0.92,
});

/* ---------------- calculs filtrés ---------------- */

function filtered() {
  const F = [], idx = [];
  for (let i = 0; i < C.length; i++) {
    const c = C[i];
    if (c[DAY] < state.from || c[DAY] > state.to) continue;
    if (state.author >= 0 && c[AU] !== state.author) continue;
    if (!state.merges && c[MERGE]) continue;
    F.push(c); idx.push(i);
  }
  return [F, idx];
}

function buckets(from, to) {
  let g = state.gran;
  const span = to - from + 1;
  if (g === 'auto') g = span <= 92 ? 'day' : span <= 3 * 366 ? 'week' : 'month';
  const list = [];
  if (g === 'day') {
    for (let d = from; d <= to; d++) list.push({ s: d, e: d, label: dateFr(d) });
  } else if (g === 'week') {
    for (let d = from - wdOf(from); d <= to; d += 7) list.push({ s: d, e: d + 6, label: 'Semaine du ' + dateFr(d) });
  } else {
    const f = new Date(from * 864e5);
    let y = f.getUTCFullYear(), m = f.getUTCMonth();
    for (;;) {
      const s = Date.UTC(y, m, 1) / 864e5;
      if (s > to) break;
      list.push({ s, e: Date.UTC(y, m + 1, 1) / 864e5 - 1, label: MONTHS[m] + ' ' + y });
      if (++m === 12) { m = 0; y++; }
    }
  }
  return { g, list };
}

function bucketIndex(bk, d) {
  let lo = 0, hi = bk.list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, b = bk.list[mid];
    if (d < b.s) hi = mid - 1; else if (d > b.e) lo = mid + 1; else return mid;
  }
  return -1;
}

function shortLabel(b, g) {
  const t = new Date(b.s * 864e5);
  if (g === 'month') return MONTHS[t.getUTCMonth()] + ' ' + String(t.getUTCFullYear()).slice(2);
  return t.getUTCDate() + ' ' + MONTHS[t.getUTCMonth()];
}

function renderFiltered() {
  const [F, FI] = filtered();
  const S = SERIES();
  $('from').value = dayStr(state.from); $('to').value = dayStr(state.to);
  $('from').min = $('to').min = dayStr(minDay);
  $('from').max = $('to').max = dayStr(maxDay);
  $('countNote').textContent = `${fmt(F.length)} commit${F.length > 1 ? 's' : ''} sur ${fmt(C.length)}`;

  /* Indicateurs */
  let add = 0, del = 0, merges = 0;
  const authorsSet = new Set(), days = new Set();
  for (const c of F) { add += c[ADD]; del += c[DEL]; if (c[MERGE]) merges++; authorsSet.add(c[AU]); days.add(c[DAY]); }
  const sortedDays = [...days].sort((a, b) => a - b);
  let best = 0, run = 0, bestEnd = 0;
  sortedDays.forEach((d, i) => { run = i && d === sortedDays[i - 1] + 1 ? run + 1 : 1; if (run > best) { best = run; bestEnd = d; } });
  const perAuthor = new Map();
  for (const c of F) perAuthor.set(c[AU], (perAuthor.get(c[AU]) || 0) + 1);
  const counts = [...perAuthor.values()].sort((a, b) => b - a);
  let acc = 0, bus = 0;
  for (const n of counts) { if (acc * 2 >= F.length) break; acc += n; bus++; }
  const nonMerge = F.length - merges;
  const kpis = [
    ['Commits', fmt(F.length), merges ? fmt(merges) + ' merges' : 'aucun merge'],
    ['Contributeurs actifs', fmt(authorsSet.size), 'sur ' + fmt(D.authors.length) + ' au total'],
    ['Lignes ajoutées', '<span class="dot" style="background:var(--add)"></span>' + fmt(add), 'solde ' + (add - del >= 0 ? '+' : '') + fmt(add - del)],
    ['Lignes supprimées', '<span class="dot" style="background:var(--del)"></span>' + fmt(del), nonMerge ? fmt((add + del) / nonMerge) + ' lignes / commit' : ''],
    ['Jours actifs', fmt(days.size), pct(days.size, state.to - state.from + 1) + ' de la période'],
    ['Plus longue série', fmt(best) + ' j', best ? 'jusqu\'au ' + dateFr(bestEnd) : ''],
    ['Facteur bus', fmt(bus), 'auteurs = 50 % des commits'],
  ];
  $('kpis').innerHTML = kpis.map(([l, v, s]) => `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${s}</div></div>`).join('');

  /* Chronologie */
  const bk = buckets(state.from, state.to);
  const tc = new Array(bk.list.length).fill(0), ta = tc.slice(), td = tc.slice();
  for (const c of F) { const k = bucketIndex(bk, c[DAY]); if (k >= 0) { tc[k]++; ta[k] += c[ADD]; td[k] += c[DEL]; } }
  const labels = bk.list.map(b => shortLabel(b, bk.g));
  const zoomTo = els => {
    if (!els.length) return;
    const b = bk.list[els[0].index];
    state.from = Math.max(minDay, b.s); state.to = Math.min(maxDay, b.e);
    setPresetUI(''); rerender();
  };
  chart('timeline', {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Commits', data: tc, ...barStyle(S[0]) }] },
    options: baseOpts(o => {
      o.onClick = (_e, els) => zoomTo(els);
      o.onHover = (e, els) => { e.native.target.style.cursor = els.length ? 'zoom-in' : 'default'; };
      o.plugins.tooltip.callbacks = { title: it => bk.list[it[0].dataIndex].label, label: it => ' ' + fmt(it.raw) + ' commits' };
    }),
  });
  chart('churnChart', {
    type: 'bar',
    data: {
      labels, datasets: [
        { label: 'Ajouts', data: ta, ...barStyle(css('--add')) },
        { label: 'Suppressions', data: td.map(v => -v), ...barStyle(css('--del')), borderSkipped: 'end' },
      ],
    },
    options: baseOpts(o => {
      o.scales.x.stacked = true; o.scales.y.stacked = true;
      o.scales.y.ticks.callback = v => fmt(Math.abs(v));
      o.onClick = (_e, els) => zoomTo(els);
      o.plugins.tooltip.callbacks = { title: it => bk.list[it[0].dataIndex].label, label: it => ' ' + it.dataset.label + ' : ' + fmt(Math.abs(it.raw)) };
    }),
  });

  /* Contributeurs */
  const A = new Map();
  for (const c of F) {
    let r = A.get(c[AU]);
    if (!r) { r = { i: c[AU], commits: 0, add: 0, del: 0, first: Infinity, last: -Infinity, daySet: new Set() }; A.set(c[AU], r); }
    r.commits++; r.add += c[ADD]; r.del += c[DEL]; r.daySet.add(c[DAY]);
    if (c[DAY] < r.first) r.first = c[DAY];
    if (c[DAY] > r.last) r.last = c[DAY];
  }
  lastAuthorRows = [...A.values()].map(r => ({ ...r, days: r.daySet.size, name: D.authors[r.i][0] }));
  lastAuthorRows.total = F.length;
  renderAuthors();

  const byCommits = lastAuthorRows.slice().sort((a, b) => b.commits - a.commits);
  const top = byCommits.slice(0, 7);
  const rest = byCommits.slice(7).reduce((s, r) => s + r.commits, 0);
  const dl = top.map(r => r.name), dv = top.map(r => r.commits), dc = top.map((_, i) => S[i]);
  if (rest) { dl.push('Autres (' + fmt(byCommits.length - 7) + ')'); dv.push(rest); dc.push(css('--other')); }
  chart('authorsChart', {
    type: 'doughnut',
    data: { labels: dl, datasets: [{ data: dv, backgroundColor: dc, borderColor: css('--surface-1'), borderWidth: 2, hoverOffset: 4 }] },
    options: baseOpts(o => {
      delete o.scales;
      o.cutout = '62%';
      o.interaction = { mode: 'nearest', intersect: true };
      o.plugins.legend = {
        display: true, position: 'right',
        labels: {
          color: css('--text-secondary'), boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 3,
          font: { family: 'Inter', size: 12 },
          generateLabels: () => dl.map((l, i) => ({
            text: (l.length > 22 ? l.slice(0, 21) + '…' : l) + '  ' + pct(dv[i], F.length),
            fillStyle: dc[i], strokeStyle: dc[i], lineWidth: 0, index: i, fontColor: css('--text-secondary'),
          })),
        },
      };
      o.plugins.tooltip.callbacks = { label: it => ' ' + it.label + ' : ' + fmt(it.raw) + ' (' + pct(it.raw, F.length) + ')' };
      o.onClick = (_e, els) => { if (els.length && els[0].index < top.length) setAuthor(top[els[0].index].i); };
    }),
  });
  const avgSubj = F.length ? F.reduce((s, c) => s + (c[SUBJ] || '').length, 0) / F.length : 0;
  $('authorStats').innerHTML = [
    ['Auteur principal', byCommits[0] ? esc(byCommits[0].name) : '–'],
    ['Part de l\'auteur principal', byCommits[0] ? pct(byCommits[0].commits, F.length) : '–'],
    ['Commits par jour actif', days.size ? (F.length / days.size).toFixed(1).replace('.', ',') : '–'],
    ['Longueur moyenne des messages', fmt(avgSubj) + ' car.'],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

  /* Jour / heure / carte de chaleur */
  const wk = new Array(7).fill(0), hr = new Array(24).fill(0);
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const c of F) { const w = wdOf(c[DAY]); wk[w]++; hr[c[HR]]++; heat[w][c[HR]]++; }
  $('weekendNote').textContent = 'Week-end : ' + pct(wk[5] + wk[6], F.length) + ' des commits.';
  const shareTip = o => { o.plugins.tooltip.callbacks = { label: it => ' ' + fmt(it.raw) + ' commits (' + pct(it.raw, F.length) + ')' }; };
  chart('weekday', { type: 'bar', data: { labels: WEEK, datasets: [{ label: 'Commits', data: wk, ...barStyle(S[0]) }] }, options: baseOpts(shareTip) });
  chart('hour', {
    type: 'bar', data: { labels: hr.map((_, i) => i + 'h'), datasets: [{ label: 'Commits', data: hr, ...barStyle(S[0]) }] },
    options: baseOpts(o => { o.scales.x.ticks.autoSkipPadding = 6; shareTip(o); }),
  });
  let hmax = 0;
  heat.forEach(r => r.forEach(v => { if (v > hmax) hmax = v; }));
  let h = '<span></span>' + Array.from({ length: 24 }, (_, i) => `<span class="hl">${i % 6 === 0 ? i + 'h' : ''}</span>`).join('');
  heat.forEach((row, d) => {
    h += `<span class="lab">${WEEK[d]}</span>`;
    row.forEach((v, hh) => {
      const lvl = v ? Math.min(5, Math.ceil(v * 5 / hmax)) : 0;
      h += `<span class="cell" style="background:var(--h${lvl})" data-tip="${WEEK[d]} ${hh}h–${hh + 1}h : ${fmt(v)} commit${v > 1 ? 's' : ''}"></span>`;
    });
  });
  $('heat').innerHTML = h;

  /* Types de commits */
  const tcount = new Array(TYPES.length).fill(0);
  let conv = 0;
  for (const i of FI) { const t = ctype[i]; if (t >= 0) { tcount[t]++; conv++; } }
  const tOrder = TYPES.map((_, i) => i).filter(i => tcount[i]).sort((a, b) => tcount[b] - tcount[a]);
  $('convNote').textContent = conv
    ? pct(conv, F.length) + ' des commits suivent la convention Conventional Commits.'
    : 'Aucun commit au format Conventional Commits sur la période.';
  chart('types', {
    type: 'bar',
    data: { labels: tOrder.map(i => TYPES[i]), datasets: [{ label: 'Commits', data: tOrder.map(i => tcount[i]), ...barStyle(S[0]) }] },
    options: baseOpts(o => {
      o.indexAxis = 'y';
      const xs = o.scales.x; o.scales.x = o.scales.y; o.scales.y = xs;
      o.scales.y.ticks.font = { family: 'JetBrains Mono', size: 12 };
      o.interaction = { mode: 'nearest', axis: 'y', intersect: false };
      o.plugins.tooltip.callbacks = { label: it => ' ' + fmt(it.raw) + ' commits (' + pct(it.raw, conv) + ')' };
    }),
  });

  /* Plus gros commits */
  const big = F.filter(c => !c[MERGE]).sort((a, b) => (b[ADD] + b[DEL]) - (a[ADD] + a[DEL])).slice(0, 25);
  $('bigCommits').innerHTML = '<thead><tr><th>Commit</th><th>Date</th><th>Auteur</th><th class="num">Ajouts</th><th class="num">Suppr.</th><th>Message</th></tr></thead><tbody>' +
    (big.length
      ? big.map(c => `<tr><td>${commitLink(c[HASH])}</td><td class="muted">${dayStr(c[DAY])}</td><td class="trunc" style="max-width:150px">${esc(D.authors[c[AU]][0])}</td>` +
        `<td class="num plus">+${fmt(c[ADD])}</td><td class="num minus">−${fmt(c[DEL])}</td><td class="trunc" title="${esc(c[SUBJ])}">${esc(c[SUBJ])}</td></tr>`).join('')
      : '<tr><td colspan="6" class="empty">Aucun commit</td></tr>') + '</tbody>';
}

const AUTHOR_COLS = [
  ['name', 'Auteur', false], ['commits', 'Commits', true], ['share', 'Part', true], ['add', 'Ajouts', true],
  ['del', 'Suppr.', true], ['days', 'Jours actifs', true], ['first', 'Premier', true], ['last', 'Dernier', true],
];

function renderAuthors() {
  const rows = lastAuthorRows;
  const total = rows.total || 1;
  const key = state.sortKey === 'share' ? 'commits' : state.sortKey;
  let r = rows.slice().sort((a, b) => {
    const x = a[key], y = b[key];
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * state.sortDir;
  });
  if (state.search) r = r.filter(x => x.name.toLowerCase().includes(state.search));
  const max = rows.reduce((m, x) => Math.max(m, x.commits), 1);
  const shown = r.slice(0, 300);
  const head = '<thead><tr><th>#</th>' + AUTHOR_COLS.map(([k, l, num]) =>
    `<th class="sortable ${num ? 'num' : ''} ${state.sortKey === k ? 'sorted' : ''}" data-k="${k}">${l}${state.sortKey === k ? (state.sortDir < 0 ? ' ↓' : ' ↑') : ''}</th>`).join('') + '</tr></thead>';
  const body = shown.map((x, i) => `<tr class="clickable ${state.author === x.i ? 'selected' : ''}" data-i="${x.i}">` +
    `<td class="muted">${i + 1}</td><td class="trunc" style="max-width:220px" title="${esc(D.authors[x.i][1])}">${esc(x.name)}</td>` +
    `<td class="num">${fmt(x.commits)}</td>` +
    `<td class="num"><span class="share" style="width:${Math.max(2, 56 * x.commits / max)}px"></span>${pct(x.commits, total)}</td>` +
    `<td class="num plus">+${fmt(x.add)}</td><td class="num minus">−${fmt(x.del)}</td><td class="num">${fmt(x.days)}</td>` +
    `<td class="num muted">${dayStr(x.first)}</td><td class="num muted">${dayStr(x.last)}</td></tr>`).join('');
  const more = r.length > shown.length ? `<tr><td colspan="9" class="muted" style="text-align:center">… ${fmt(r.length - shown.length)} autres (utilisez la recherche)</td></tr>` : '';
  const table = $('authorsTable');
  table.innerHTML = head + '<tbody>' + (body || '<tr><td colspan="9" class="empty">Aucun auteur</td></tr>') + more + '</tbody>';
  table.querySelectorAll('th.sortable').forEach(th => th.onclick = () => {
    const k = th.dataset.k;
    if (state.sortKey === k) state.sortDir = -state.sortDir;
    else { state.sortKey = k; state.sortDir = k === 'name' ? 1 : -1; }
    renderAuthors();
  });
  table.querySelectorAll('tr.clickable').forEach(tr => tr.onclick = () => setAuthor(Number(tr.dataset.i)));
}

/* ---------------- état actuel du code (HEAD) ---------------- */

function renderStatic() {
  const S = SERIES();
  const L = D.langs, total = D.head.lines || 1;
  const restLines = L.slice(8).reduce((s, l) => s + l[2], 0);
  const segs = L.slice(0, 8).map((l, i) => ({ name: l[0], v: l[2], c: S[i] }));
  if (restLines) segs.push({ name: 'Autres', v: restLines, c: css('--other') });
  $('langBar').innerHTML = segs.filter(s => s.v).map(s => `<div style="width:${100 * s.v / total}%;background:${s.c}" data-tip="${esc(s.name)} : ${pct(s.v, total)}"></div>`).join('');
  $('langNote').textContent = `${fmt(D.head.files)} fichiers suivis, ${fmt(D.head.lines)} lignes (${pct(D.head.blank, D.head.lines)} vides), ${size(D.head.bytes)}` +
    (D.head.binary ? ` · ${fmt(D.head.binary)} fichiers binaires (${size(D.head.binaryBytes)})` : '');
  $('langTable').innerHTML = '<thead><tr><th>Langage</th><th class="num">Fichiers</th><th class="num">Lignes</th><th class="num">Part</th><th class="num">Taille</th></tr></thead><tbody>' +
    L.map((l, i) => `<tr><td><span class="sw" style="background:${i < 8 ? S[i] : 'var(--other)'}"></span>${esc(l[0])}</td><td class="num">${fmt(l[1])}</td><td class="num">${fmt(l[2])}</td><td class="num">${pct(l[2], total)}</td><td class="num muted">${size(l[4])}</td></tr>`).join('') + '</tbody>';
  $('bigFiles').innerHTML = '<thead><tr><th>Fichier</th><th class="num">Lignes</th><th class="num">Taille</th></tr></thead><tbody>' +
    D.bigFiles.slice(0, 50).map(f => `<tr><td class="trunc mono" style="max-width:480px">${fileLink(f[0])}</td><td class="num">${fmt(f[1])}</td><td class="num muted">${size(f[2])}</td></tr>`).join('') + '</tbody>';
  $('churnNote').textContent = `Nombre de commits ayant touché chaque fichier, sur tout l'historique (${fmt(D.churnTotal)} fichiers ont existé).`;
  const cmax = D.churn.length ? D.churn[0][1] : 1;
  $('churnTable').innerHTML = '<thead><tr><th>Fichier</th><th class="num">Commits</th><th class="num">Ajouts</th><th class="num">Suppr.</th></tr></thead><tbody>' +
    D.churn.slice(0, 50).map(f => `<tr><td class="trunc mono" style="max-width:700px">${fileLink(f[0])}</td><td class="num"><span class="share" style="width:${Math.max(2, 70 * f[1] / cmax)}px"></span>${fmt(f[1])}</td><td class="num plus">+${fmt(f[2])}</td><td class="num minus">−${fmt(f[3])}</td></tr>`).join('') + '</tbody>';
}
