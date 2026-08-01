/* Rank Tracker dashboard — no build step, no dependencies. */

const $ = (sel) => document.querySelector(sel);
const el = {
  projectSelect: $('#project-select'),
  emptyState: $('#empty-state'),
  dashboard: $('#dashboard'),
  title: $('#project-title'),
  sub: $('#project-sub'),
  sections: $('#sections'),
  regionSelect: $('#region-select'),
  runPanel: $('#run-panel'),
  runBar: $('#run-bar'),
  runLog: $('#run-log'),
  runCount: $('#run-count'),
  runTitle: $('#run-title'),
  btnRun: $('#btn-run'),
  btnCancel: $('#btn-cancel'),
  btnExport: $('#btn-export'),
  backdrop: $('#modal-backdrop'),
  modal: $('#modal'),
};

const state = {
  boot: null,
  projectId: null,
  keywords: [],
  availability: null,
  runActive: false,
};

/**
 * Per-engine presentation. The two engines measure different things, so each
 * gets its own section, its own columns and its own wording. Nothing is ever
 * compared across them.
 *
 * Order matters: Search Console first, because it is Google's own data.
 */
const ENGINE_UI = {
  gsc: {
    label: 'Google Search Console',
    kind: 'Real Google data',
    subtitle: '28-day average position · your verified properties only',
    columns: ['Avg position', 'Change', 'Impressions', 'Clicks', 'CTR', 'Trend', 'Last checked'],
    absent: () => 'no impressions',
    snapshotHeading: 'Your ranking pages',
    disclaimer:
      'Google’s own data for properties you have verified — the average position across every impression ' +
      'in the last 28 days, lagging about 2 days. A value of 7.4 means “averaged 7.4”, not “ranked 7th today”. ' +
      '“No impressions” means nobody saw you for that exact query in the window, which is close to but not ' +
      'the same as “not ranking”.',
  },
  duckduckgo: {
    label: 'DuckDuckGo',
    kind: 'Live SERP',
    subtitle: 'Position read from a real browser · works for any domain',
    columns: ['Position', 'Change', 'Trend', 'Last checked'],
    absent: (check, kw) => `not in top ${check.results_parsed || kw.depth}`,
    snapshotHeading: 'Latest SERP snapshot',
    disclaimer:
      'Live SERP positions read from a real Chrome window, for any domain — yours or a competitor’s. ' +
      'DuckDuckGo is not Google: treat these as a directional signal for whether your content is gaining ' +
      'or losing ground, not as literal Google positions. Blocked and errored checks are stored as “no data” ' +
      'and never plotted as a rank drop.',
  },
};

/** Render order for the sections. */
const ENGINE_ORDER = ['gsc', 'duckduckgo'];

/** Pre-selected region for new keywords. */
const DEFAULT_REGION = { country: 'au', language: 'en' };

/**
 * Column label → sort key. Sorting is a *view* over the list; your manual
 * drag order is the underlying truth, which a third click restores.
 */
const SORT_KEYS = {
  Keyword: 'keyword',
  Region: 'region',
  Position: 'position',
  'Avg position': 'position',
  Change: 'delta',
  Impressions: 'impressions',
  Clicks: 'clicks',
  CTR: 'ctr',
  'Last checked': 'checked',
};

/** Per-section sort state; null means "manual order". */
const sortState = { gsc: null, duckduckgo: null };

/** Sort value for a keyword row. `null` always sinks to the bottom. */
function sortValue(kw, engine, key) {
  const s = kw.engines[engine];
  const l = s.latest;
  switch (key) {
    case 'keyword': return kw.keyword.toLowerCase();
    case 'region': return `${kw.country}-${kw.language}`;
    case 'position': return l?.status === 'found' ? l.position : null;
    case 'delta': return s.delta ?? null;
    case 'impressions': return l?.status === 'found' ? l.impressions ?? null : null;
    case 'clicks': return l?.status === 'found' ? l.clicks ?? null : null;
    case 'ctr': return l?.status === 'found' ? l.ctr ?? null : null;
    case 'checked': return l?.checked_at ? new Date(l.checked_at).getTime() : null;
    default: return null;
  }
}

function sortedKeywords(engine) {
  const sort = sortState[engine];
  if (!sort) return state.keywords; // manual drag order
  const dir = sort.dir === 'asc' ? 1 : -1;
  return state.keywords.slice().sort((a, b) => {
    const av = sortValue(a, engine, sort.key);
    const bv = sortValue(b, engine, sort.key);
    // Rows with no data stay at the bottom in both directions — flipping the
    // sort shouldn't fill the top with blanks.
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === 'string') return av.localeCompare(bv) * dir;
    return (av - bv) * dir;
  });
}

/* ------------------------------------------------------------------- utils */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'content-type': 'application/json' } : {},
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  document.querySelector('.toast')?.remove();
  const node = document.createElement('div');
  node.className = 'toast' + (isError ? ' err' : '');
  node.textContent = message;
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), isError ? 7000 : 3500);
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 2592000) return `${Math.floor(secs / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

const regionLabel = (country, language) =>
  state.boot?.regions.find((r) => r.country === country && r.language === language)?.label ??
  `${country}-${language}`;

/** Compact form for the table; the full label goes in the tooltip. */
const regionShort = (country, language) =>
  country === 'wt' ? 'WW' : `${country.toUpperCase()}·${language.toUpperCase()}`;

/* ------------------------------------------------------------------ modals */

function openModal(html, onMount) {
  el.modal.innerHTML = html;
  el.backdrop.classList.remove('hidden');
  el.modal.querySelector('.close')?.addEventListener('click', closeModal);
  onMount?.(el.modal);
}
function closeModal() {
  el.backdrop.classList.add('hidden');
  el.modal.innerHTML = '';
}
el.backdrop.addEventListener('click', (e) => {
  if (e.target === el.backdrop) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.backdrop.classList.contains('hidden')) closeModal();
});

/* --------------------------------------------------------------- bootstrap */

async function boot() {
  state.boot = await api('/api/bootstrap');
  renderProjectSelect();
  renderRegionOptions();

  const stored = Number(localStorage.getItem('rt.project'));
  const exists = state.boot.projects.some((p) => p.id === stored);
  const first = state.boot.projects[0]?.id ?? null;
  await selectProject(exists ? stored : first);

  connectRunStream();
  if (state.boot.activeRun) applyRunSnapshot(state.boot.activeRun);
}

function renderProjectSelect() {
  el.projectSelect.innerHTML = state.boot.projects
    .map((p) => `<option value="${p.id}">${esc(p.name)} — ${esc(p.domain)}</option>`)
    .join('');
  el.projectSelect.classList.toggle('hidden', state.boot.projects.length === 0);
}


function renderRegionOptions() {
  el.regionSelect.innerHTML = state.boot.regions
    .map((r, i) => `<option value="${i}"${r.country === DEFAULT_REGION.country && r.language === DEFAULT_REGION.language ? ' selected' : ''}>${esc(r.label)}</option>`)
    .join('');
}

async function refreshBoot() {
  state.boot = await api('/api/bootstrap');
  renderProjectSelect();
  if (state.projectId) el.projectSelect.value = String(state.projectId);
}

/* ---------------------------------------------------------------- projects */

async function selectProject(id) {
  state.projectId = id;
  const hasProject = id != null;
  el.emptyState.classList.toggle('hidden', hasProject);
  el.dashboard.classList.toggle('hidden', !hasProject);
  if (!hasProject) return;

  localStorage.setItem('rt.project', String(id));
  el.projectSelect.value = String(id);

  const project = state.boot.projects.find((p) => p.id === id);
  el.title.textContent = project.name;
  const scope = project.match_subdomains ? 'including subdomains' : 'exact host only';
  el.sub.textContent = `${project.domain} · ${scope}` + (project.gsc_site ? ` · GSC: ${project.gsc_site}` : '');
  el.btnExport.href = `/api/projects/${id}/export.csv`;
  await loadKeywords();
}

el.projectSelect.addEventListener('change', () => selectProject(Number(el.projectSelect.value)));

$('#first-project-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    const project = await api('/api/projects', {
      method: 'POST',
      body: { domain: form.get('domain'), name: form.get('name') },
    });
    await refreshBoot();
    await selectProject(project.id);
    toast(`Created ${project.domain}`);
  } catch (err) {
    toast(err.message, true);
  }
});

$('#btn-new-project').addEventListener('click', () => {
  openModal(
    `<div class="modal-head"><h2>New project</h2><button class="close">×</button></div>
     <form id="np" class="form-grid">
       <label>Domain <input name="domain" placeholder="example.com" required autocomplete="off"></label>
       <label>Name <span class="muted">(optional)</span><input name="name" autocomplete="off"></label>
       <label style="display:flex;gap:.5rem;align-items:center">
         <input type="checkbox" name="subs" checked style="width:auto"> Count subdomains as mine
       </label>
       <div class="modal-actions"><button type="button" class="ghost close">Cancel</button>
       <button class="primary" type="submit">Create</button></div>
     </form>`,
    (root) => {
      root.querySelectorAll('.close').forEach((b) => b.addEventListener('click', closeModal));
      root.querySelector('#np').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        try {
          const p = await api('/api/projects', {
            method: 'POST',
            body: { domain: f.get('domain'), name: f.get('name'), matchSubdomains: f.get('subs') === 'on' },
          });
          closeModal();
          await refreshBoot();
          await selectProject(p.id);
          toast(`Created ${p.domain}`);
        } catch (err) {
          toast(err.message, true);
        }
      });
    },
  );
});

$('#btn-project-settings').addEventListener('click', async () => {
  const project = state.boot.projects.find((p) => p.id === state.projectId);
  let sitesHtml = '<p class="hint">Connect Search Console in Settings ⚙ to pick a property.</p>';
  if (state.boot.gsc.connected) {
    try {
      const sites = await api('/api/gsc/sites');
      sitesHtml = `<label>Search Console property
        <select name="gscSite">
          <option value="">— none —</option>
          ${sites.map((s) => `<option value="${esc(s.siteUrl)}"${s.siteUrl === project.gsc_site ? ' selected' : ''}>${esc(s.siteUrl)}</option>`).join('')}
        </select></label>`;
      if (!sites.length) sitesHtml = '<p class="hint">This Google account has no verified Search Console properties.</p>';
    } catch (err) {
      sitesHtml = `<p class="hint">Could not load properties: ${esc(err.message)}</p>`;
    }
  }

  openModal(
    `<div class="modal-head"><h2>Project settings</h2><button class="close">×</button></div>
     <form id="ps" class="form-grid">
       <label>Name <input name="name" value="${esc(project.name)}"></label>
       <label>Domain <input name="domain" value="${esc(project.domain)}"></label>
       <label style="display:flex;gap:.5rem;align-items:center">
         <input type="checkbox" name="subs" ${project.match_subdomains ? 'checked' : ''} style="width:auto">
         Count subdomains (blog.${esc(project.domain)}) as mine
       </label>
       ${sitesHtml}
       <div class="modal-actions">
         <button type="button" class="danger" id="del-project">Delete project</button>
         <span style="flex:1"></span>
         <button type="button" class="ghost close">Cancel</button>
         <button class="primary" type="submit">Save</button>
       </div>
     </form>`,
    (root) => {
      root.querySelectorAll('.close').forEach((b) => b.addEventListener('click', closeModal));
      root.querySelector('#del-project').addEventListener('click', async () => {
        if (!confirm(`Delete "${project.name}" and all its keywords and history? This cannot be undone.`)) return;
        await api(`/api/projects/${project.id}`, { method: 'DELETE' });
        closeModal();
        localStorage.removeItem('rt.project');
        await refreshBoot();
        await selectProject(state.boot.projects[0]?.id ?? null);
        toast('Project deleted');
      });
      root.querySelector('#ps').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        try {
          await api(`/api/projects/${project.id}`, {
            method: 'PATCH',
            body: {
              name: f.get('name'),
              domain: f.get('domain'),
              matchSubdomains: f.get('subs') === 'on',
              gscSite: f.get('gscSite') ?? project.gsc_site ?? '',
            },
          });
          closeModal();
          await refreshBoot();
          await selectProject(project.id);
          toast('Saved');
        } catch (err) {
          toast(err.message, true);
        }
      });
    },
  );
});

/* ---------------------------------------------------------------- keywords */

$('#keyword-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const region = state.boot.regions[Number(f.get('region'))];
  try {
    const out = await api(`/api/projects/${state.projectId}/keywords`, {
      method: 'POST',
      body: {
        keywords: f.get('keywords'),
        country: region.country,
        language: region.language,
        depth: Number(f.get('depth')),
      },
    });
    e.target.querySelector('textarea').value = '';
    await loadKeywords();
    const skipped = out.skipped.length ? `, ${out.skipped.length} already tracked` : '';
    toast(`Added ${out.added.length} keyword${out.added.length === 1 ? '' : 's'}${skipped}`);
  } catch (err) {
    toast(err.message, true);
  }
});

async function loadKeywords() {
  const data = await api(`/api/projects/${state.projectId}/keywords`);
  state.keywords = data.keywords;
  state.availability = data.availability;
  renderKeywords();
}

function statusCell(kw, summary, engine) {
  const ui = ENGINE_UI[engine];
  const l = summary.latest;
  if (!l) return { pos: '<span class="chip">not checked</span>', title: 'This keyword has never been checked on this engine' };
  if (l.status === 'found') return { pos: `<span class="pos">${l.position}</span>`, title: l.url || '' };
  if (l.status === 'absent')
    return { pos: `<span class="chip absent">${esc(ui.absent(l, kw))}</span>`, title: l.message || '' };
  if (l.status === 'blocked')
    return { pos: '<span class="chip blocked">blocked</span>', title: l.message || 'The engine served a challenge page' };
  return { pos: '<span class="chip error">error</span>', title: l.message || 'Check failed' };
}

function deltaCell(summary, engine) {
  const outLabel = engine === 'gsc' ? 'Lost all impressions' : 'Fell out of the tracked depth';
  if (summary.deltaKind === 'entered') return '<span class="delta up" title="Entered the results">↑ new</span>';
  if (summary.deltaKind === 'dropped-out') return `<span class="delta down" title="${outLabel}">↓ out</span>`;
  if (summary.delta === null || summary.delta === undefined) return '<span class="muted">—</span>';
  if (summary.delta === 0) return '<span class="delta flat">0</span>';
  const up = summary.delta > 0;
  return `<span class="delta ${up ? 'up' : 'down'}" title="Previously ${summary.previous?.position}">${up ? '↑' : '↓'} ${Math.abs(summary.delta)}</span>`;
}

const num = (v) => (v === null || v === undefined ? '<span class="muted">—</span>' : v.toLocaleString());

/** Tiny inline sparkline. Y is inverted because position 1 is the top. */
function sparkline(history) {
  const points = history.filter((h) => h.position != null);
  if (points.length < 2) return '<span class="muted">—</span>';
  const w = 70, h = 22, pad = 2;
  const values = points.map((p) => p.position);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const d = points
    .map((p, i) => {
      const x = pad + (i * (w - pad * 2)) / (points.length - 1);
      const y = pad + ((p.position - min) / span) * (h - pad * 2);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const flat = max === min ? ' class="flat"' : '';
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-label="${points.length} checks"><path${flat} d="${d}"/></svg>`;
}

function bannerHtml(engine) {
  const info = state.availability?.[engine];
  if (!info || info.available) return '';
  const fix = state.boot.gsc.connected ? 'project-settings' : 'settings';
  return `<div class="banner">
    <strong>Not being checked.</strong> <span>${esc(info.reason)}</span>
    <button class="link-btn act-fix" data-fix="${fix}">${fix === 'settings' ? 'Open Settings' : 'Project settings'}</button>
  </div>`;
}

function rowHtml(kw, engine, sorted = false) {
  const ui = ENGINE_UI[engine];
  const summary = kw.engines[engine];
  const s = statusCell(kw, summary, engine);
  const l = summary.latest;
  const dash = '<span class="muted">—</span>';

  // Search Console carries traffic metrics that have no DuckDuckGo equivalent.
  const metrics =
    engine === 'gsc'
      ? `<td class="num">${l?.status === 'found' ? num(l.impressions) : dash}</td>
         <td class="num">${l?.status === 'found' ? num(l.clicks) : dash}</td>
         <td class="num">${l?.status === 'found' && l.ctr != null ? (l.ctr * 100).toFixed(1) + '%' : dash}</td>`
      : '';

  return `<tr class="${kw.active ? '' : 'inactive'}" data-id="${kw.id}">
    <td class="drag-cell">${
      sorted
        ? '<span class="drag-handle off" title="Clear the column sort to drag rows">⠿</span>'
        : '<span class="drag-handle" draggable="true" title="Drag to reorder" aria-label="Drag to reorder">⠿</span>'
    }</td>
    <td>
      <span class="kw-cell">${esc(kw.keyword)}</span>
      ${l?.url ? `<span class="kw-url" title="${esc(l.url)}">${esc(l.url)}</span>` : ''}
    </td>
    <td class="muted nowrap" title="${esc(regionLabel(kw.country, kw.language))}">${esc(regionShort(kw.country, kw.language))}</td>
    <td class="num" title="${esc(s.title)}">${s.pos}</td>
    <td class="num">${deltaCell(summary, engine)}</td>
    ${metrics}
    <td><button class="spark-btn act-detail" title="Open the full trend chart"${summary.history.length ? '' : ' disabled'}>${sparkline(summary.history)}</button></td>
    <td class="muted nowrap">${esc(timeAgo(l?.checked_at))}</td>
    <td>
      <div class="row-actions">
        <button class="link-btn act-detail" title="${esc(ui.label)} history for this keyword">Details</button>
        <button class="link-btn act-run" title="Re-check this keyword on every engine">Check</button>
        <button class="link-btn act-toggle" title="${kw.active ? 'Pause' : 'Resume'}">${kw.active ? '⏸' : '▶'}</button>
        <button class="link-btn act-del danger-btn" title="Delete “${esc(kw.keyword)}” and its history">🗑</button>
      </div>
    </td>
  </tr>`;
}

function sectionHtml(engine) {
  const ui = ENGINE_UI[engine];
  const sort = sortState[engine];
  const th = (label, extraClass = '') => {
    const key = SORT_KEYS[label];
    if (!key) return `<th class="${extraClass}">${esc(label)}</th>`;
    const active = sort?.key === key;
    const arrow = active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th class="${extraClass} sortable${active ? ' sorted' : ''}" data-sort="${key}"
      title="Sort by ${esc(label)}${active ? ' — click again to clear' : ''}">${esc(label)}<span class="arrow">${arrow}</span></th>`;
  };

  const head =
    `<tr><th class="drag-cell"></th>${th('Keyword', 'col-kw')}${th('Region')}` +
    ui.columns.map((c) => th(c, c === 'Trend' || c === 'Last checked' ? '' : 'num')).join('') +
    `<th></th></tr>`;

  const rows = sortedKeywords(engine);
  const body = rows.map((kw) => rowHtml(kw, engine, Boolean(sort))).join('');

  return `<section class="engine-section" data-engine="${engine}">
    <div class="engine-head">
      <h2>${esc(ui.label)}</h2>
      <span class="engine-kind">${esc(ui.kind)}</span>
      <span class="engine-sub">${esc(ui.subtitle)}</span>
      <button class="engine-run" data-run-engine="${engine}"${state.runActive ? ' disabled' : ''}>Check ${esc(ui.label)}</button>
    </div>
    ${bannerHtml(engine)}
    <div class="panel table-panel">
      <table><thead>${head}</thead><tbody>${body}</tbody></table>
      ${state.keywords.length ? '' : '<p class="muted pad">No keywords yet. Add some above.</p>'}
    </div>
    ${
      sort
        ? `<p class="sort-note">Sorted by ${esc(sort.key)} ${sort.dir === 'asc' ? 'ascending' : 'descending'} —
           <button class="link-btn act-clear-sort">back to my order</button></p>`
        : ''
    }
    <p class="disclaimer">${esc(ui.disclaimer)}</p>
  </section>`;
}

function renderKeywords() {
  el.sections.innerHTML = ENGINE_ORDER.map(sectionHtml).join('');
}

/* ------------------------------------------------------- drag to reorder */

let dragId = null;

/** Row the pointer is currently over, and whether we'd drop above or below it. */
function dropTargetFrom(event) {
  const row = event.target.closest?.('tr[data-id]');
  if (!row) return null;
  const box = row.getBoundingClientRect();
  return { row, after: event.clientY > box.top + box.height / 2 };
}

function clearDropMarks() {
  document.querySelectorAll('.drop-above, .drop-below').forEach((n) => n.classList.remove('drop-above', 'drop-below'));
}

el.sections.addEventListener('dragstart', (e) => {
  const handle = e.target.closest('.drag-handle');
  if (!handle) return e.preventDefault();
  const row = handle.closest('tr[data-id]');
  dragId = Number(row.dataset.id);
  row.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(dragId)); // Firefox needs a payload
});

el.sections.addEventListener('dragover', (e) => {
  if (dragId === null) return;
  const target = dropTargetFrom(e);
  if (!target) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  clearDropMarks();
  target.row.classList.add(target.after ? 'drop-below' : 'drop-above');
});

el.sections.addEventListener('dragend', () => {
  dragId = null;
  clearDropMarks();
  document.querySelectorAll('.dragging').forEach((n) => n.classList.remove('dragging'));
});

el.sections.addEventListener('drop', async (e) => {
  if (dragId === null) return;
  e.preventDefault();
  const target = dropTargetFrom(e);
  clearDropMarks();
  const overId = target ? Number(target.row.dataset.id) : null;
  const moving = dragId;
  dragId = null;
  if (overId === null || overId === moving) return;

  // Reorder the single source of truth, then repaint both sections from it.
  const list = state.keywords.slice();
  const from = list.findIndex((k) => k.id === moving);
  const [item] = list.splice(from, 1);
  let to = list.findIndex((k) => k.id === overId);
  if (target.after) to += 1;
  list.splice(to, 0, item);
  state.keywords = list;
  renderKeywords();

  try {
    await api(`/api/projects/${state.projectId}/keywords/reorder`, {
      method: 'POST',
      body: { ids: list.map((k) => k.id) },
    });
  } catch (err) {
    toast(`Could not save the new order: ${err.message}`, true);
    await loadKeywords(); // fall back to whatever the server actually has
  }
});

el.sections.addEventListener('click', async (e) => {
  // Sortable column header: ascending → descending → back to manual order.
  const header = e.target.closest('th.sortable');
  if (header) {
    const engine = header.closest('.engine-section').dataset.engine;
    const key = header.dataset.sort;
    const current = sortState[engine];
    sortState[engine] =
      !current || current.key !== key
        ? { key, dir: 'asc' }
        : current.dir === 'asc'
          ? { key, dir: 'desc' }
          : null;
    return renderKeywords();
  }

  const button = e.target.closest('button');
  if (!button) return;

  if (button.classList.contains('act-fix')) {
    return (button.dataset.fix === 'settings' ? $('#btn-settings') : $('#btn-project-settings')).click();
  }

  if (button.dataset.runEngine) {
    return startRun(null, [button.dataset.runEngine]);
  }

  if (button.classList.contains('act-clear-sort')) {
    sortState[button.closest('.engine-section').dataset.engine] = null;
    return renderKeywords();
  }

  const row = button.closest('tr');
  if (!row) return;
  const id = Number(row.dataset.id);
  const engine = button.closest('.engine-section').dataset.engine;
  const kw = state.keywords.find((k) => k.id === id);

  try {
    if (button.classList.contains('act-del')) {
      // Deletes immediately, by request — no confirmation dialog. The toast
      // names what went so an accidental click is at least visible.
      await api(`/api/keywords/${id}`, { method: 'DELETE' });
      await loadKeywords();
      toast(`Deleted “${kw.keyword}”`);
    } else if (button.classList.contains('act-toggle')) {
      await api(`/api/keywords/${id}`, { method: 'PATCH', body: { active: !kw.active } });
      await loadKeywords();
    } else if (button.classList.contains('act-run')) {
      await startRun([id]);
    } else if (button.classList.contains('act-detail')) {
      await showDetail(id, engine);
    }
  } catch (err) {
    toast(err.message, true);
  }
});

/* ------------------------------------------------------------ detail modal */

function chart(history, engine) {
  const points = history
    .filter((h) => h.status === 'found' || h.status === 'absent')
    .slice()
    .reverse();
  if (points.length < 2) return '<p class="hint">Not enough data yet — run at least two checks to see a trend.</p>';

  const w = 640, h = 260, padL = 40, padR = 14, padT = 16, padB = 30;
  const found = points.filter((p) => p.status === 'found').map((p) => p.position);
  if (!found.length) return '<p class="hint">No ranking positions recorded yet for this keyword.</p>';

  const best = Math.max(1, Math.floor(Math.min(...found) - 1));
  const worst = Math.ceil(Math.max(...found) + 1);
  const span = worst - best || 1;
  const x = (i) => padL + (i * (w - padL - padR)) / (points.length - 1);
  const y = (pos) => padT + ((pos - best) / span) * (h - padT - padB);

  // Break the line wherever the keyword was absent — a gap, not a plunge to zero.
  const segments = [];
  let current = [];
  points.forEach((p, i) => {
    if (p.status === 'found') current.push(`${current.length ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.position).toFixed(1)}`);
    else {
      if (current.length > 1) segments.push(current.join(' '));
      current = [];
    }
  });
  if (current.length > 1) segments.push(current.join(' '));

  // Wide invisible hit areas so hovering anywhere near a point shows its tooltip,
  // rather than requiring a hit on a 2.6px dot.
  const band = (w - padL - padR) / Math.max(points.length - 1, 1) / 2;
  const dots = points
    .map((p, i) => {
      const when = new Date(p.checked_at).toLocaleString();
      const detail =
        p.status === 'found'
          ? `${engine === 'gsc' ? 'avg position' : 'position'} ${p.position}` +
            (engine === 'gsc' && p.impressions != null ? ` · ${p.impressions.toLocaleString()} impressions · ${p.clicks ?? 0} clicks` : '')
          : engine === 'gsc'
            ? 'no impressions'
            : `not in top ${p.results_parsed || '?'}`;
      const cy = p.status === 'found' ? y(p.position) : h - padB;
      const cls = p.status === 'found' ? 'class="dot"' : 'fill="var(--muted)" opacity=".55"';
      return `<g><title>${esc(when)} — ${esc(detail)}</title>
        <rect x="${(x(i) - band).toFixed(1)}" y="${padT}" width="${(band * 2).toFixed(1)}" height="${(h - padT - padB).toFixed(1)}" fill="transparent"/>
        <circle ${cls} cx="${x(i).toFixed(1)}" cy="${cy.toFixed(1)}" r="3.2"/></g>`;
    })
    .join('');

  const ticks = [best, Math.round((best + worst) / 2), worst]
    .filter((v, i, a) => a.indexOf(v) === i)
    .map((v) => `<line class="grid" x1="${padL}" y1="${y(v)}" x2="${w - padR}" y2="${y(v)}"/>
                 <text class="lbl" x="4" y="${y(v) + 3}">${engine === 'gsc' ? '' : '#'}${v}</text>`)
    .join('');

  // Date ticks along the bottom. Same-day checks get a time instead of a date,
  // so several runs on one day don't render as the same label repeated.
  const sameDay =
    new Date(points[0].checked_at).toDateString() === new Date(points.at(-1).checked_at).toDateString();
  const fmt = (iso) =>
    sameDay
      ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });

  const tickIdx = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  const dateLabels = tickIdx
    .map((i) => {
      const anchor = i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle';
      return `<text class="lbl" x="${x(i).toFixed(1)}" y="${h - 8}" text-anchor="${anchor}">${esc(fmt(points[i].checked_at))}</text>`;
    })
    .join('');

  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Position over time">
    ${ticks}
    ${segments.map((d) => `<path class="line" d="${d}"/>`).join('')}
    ${dots}
    ${dateLabels}
  </svg>
  <p class="hint">Higher on the chart is a better position. Grey dots at the bottom are checks where ${
    engine === 'gsc' ? 'the query got no impressions' : 'the domain was not in the tracked depth'
  }. Blocked and errored checks are excluded entirely.</p>`;
}

async function showDetail(id, engine) {
  const kw = state.keywords.find((k) => k.id === id);
  const ui = ENGINE_UI[engine];
  openModal(`<div class="modal-head"><h2>${esc(kw.keyword)}</h2><button class="close">×</button></div><p class="hint">Loading…</p>`);
  const data = await api(`/api/keywords/${id}/history?engine=${encodeURIComponent(engine)}`);
  const project = state.boot.projects.find((p) => p.id === state.projectId);

  const rows = data.history
    .slice(0, 25)
    .map(
      (c) => `<tr>
        <td class="muted">${esc(new Date(c.checked_at).toLocaleString())}</td>
        <td>${
          c.status === 'found'
            ? `<strong>${engine === 'gsc' ? '' : '#'}${c.position}</strong>` +
              (engine === 'gsc' && c.impressions != null
                ? ` <span class="muted" style="font-weight:400">· ${c.impressions.toLocaleString()} impr · ${(c.clicks ?? 0).toLocaleString()} clicks</span>`
                : '')
            : c.status === 'absent'
              ? `<span class="chip absent">${esc(ui.absent(c, kw))}</span>`
              : `<span class="chip ${c.status}">${c.status}</span>`
        }</td>
        <td class="muted" style="max-width:22rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.url || c.message || '')}</td>
      </tr>`,
    )
    .join('');

  const serpHeading = ui.snapshotHeading;
  const serp = data.latestSerp.length
    ? `<h2 style="margin-top:1.4rem">${serpHeading}
         <span class="muted" style="font-weight:400;font-size:.8rem">— ${esc(new Date(data.serpCheckedAt).toLocaleString())}</span>
       </h2>
       <ol class="serp-list">${data.latestSerp
         .map((r) => {
           const host = (() => { try { return new URL(r.url).hostname.replace(/^www\./, ''); } catch { return r.url; } })();
           const mine = host === project.domain || host.endsWith('.' + project.domain);
           return `<li class="${mine ? 'mine' : ''}"><span class="n">${r.position}</span><span class="u" title="${esc(r.url)}">${esc(r.title || r.url)}<br><span class="muted">${esc(host)}</span></span></li>`;
         })
         .join('')}</ol>`
    : '';

  openModal(
    `<div class="modal-head">
       <div><h2>${esc(kw.keyword)}</h2>
       <p class="muted" style="margin:.2rem 0 0;font-size:.85rem">${esc(ui.label)} · ${esc(regionLabel(kw.country, kw.language))}${
         engine === 'duckduckgo' ? ` · depth ${kw.depth}` : ''
       }</p></div>
       <button class="close">×</button>
     </div>
     ${chart(data.history, engine)}
     <h2 style="margin-top:1.4rem">Check history</h2>
     <table class="hist-table"><thead><tr><th>When</th><th>Result</th><th>URL / note</th></tr></thead><tbody>${rows}</tbody></table>
     ${serp}`,
  );
}

/* -------------------------------------------------------------------- runs */

async function startRun(keywordIds = null, engines = null) {
  try {
    await api(`/api/projects/${state.projectId}/run`, { method: 'POST', body: { keywordIds, engines } });
    el.runPanel.classList.remove('hidden');
    el.runLog.textContent = '';
    setRunning(true);
  } catch (err) {
    toast(err.message, true);
  }
}

el.btnRun.addEventListener('click', () => startRun(null));
el.btnCancel.addEventListener('click', async () => {
  await api('/api/run/cancel', { method: 'POST' });
  el.btnCancel.disabled = true;
});

function setRunning(running) {
  state.runActive = running;
  el.btnRun.disabled = running;
  el.btnRun.textContent = running ? 'Checking…' : 'Check rankings';
  el.btnCancel.classList.toggle('hidden', !running);
  el.btnCancel.disabled = false;
  // Only one run can be in flight, so every run button has to reflect that —
  // otherwise the other section's button just 409s and looks broken.
  document.querySelectorAll('[data-run-engine]').forEach((b) => {
    b.disabled = running;
  });
}

function applyRunSnapshot(snapshot) {
  if (!snapshot) {
    if (state.runActive) {
      setRunning(false);
      el.runTitle.textContent = 'Run finished';
      loadKeywords().catch(() => {});
    }
    return;
  }
  setRunning(true);
  el.runPanel.classList.remove('hidden');
  el.runTitle.textContent = snapshot.cancelled ? 'Stopping…' : `Checking: ${snapshot.current ?? '…'}`;
  el.runCount.textContent = `${snapshot.done} / ${snapshot.total}`;
  el.runBar.style.width = `${snapshot.total ? (snapshot.done / snapshot.total) * 100 : 0}%`;

  const atBottom = el.runLog.scrollTop + el.runLog.clientHeight >= el.runLog.scrollHeight - 30;
  el.runLog.textContent = snapshot.log
    .map((line) => `${new Date(line.at).toLocaleTimeString()}  ${line.message}`)
    .join('\n');
  if (atBottom) el.runLog.scrollTop = el.runLog.scrollHeight;
}

function connectRunStream() {
  const source = new EventSource('/api/run/stream');
  source.onmessage = (e) => applyRunSnapshot(JSON.parse(e.data));
  source.onerror = () => {
    // EventSource reconnects on its own; fall back to a poll so the UI never sticks.
    setTimeout(async () => {
      try {
        const { active } = await api('/api/run/status');
        applyRunSnapshot(active);
      } catch {
        /* server down; the next SSE retry will recover */
      }
    }, 2000);
  };
}

/* ---------------------------------------------------------------- settings */

$('#btn-settings').addEventListener('click', () => {
  const g = state.boot.gsc;
  openModal(
    `<div class="modal-head"><h2>Settings</h2><button class="close">×</button></div>

     <h2>Daily automatic check</h2>
     <form id="sched-form" class="form-grid" style="max-width:26rem">
       <label style="display:flex;gap:.5rem;align-items:center">
         <input type="checkbox" name="enabled" ${state.boot.schedule.enabled ? 'checked' : ''} style="width:auto">
         Check every keyword on both engines once a day
       </label>
       <label style="max-width:9rem">At (24-hour, local)
         <input type="time" name="time" value="${esc(state.boot.schedule.time)}">
       </label>
       <label style="display:flex;gap:.5rem;align-items:center">
         <input type="checkbox" name="catchUp" ${state.boot.schedule.catchUp ? 'checked' : ''} style="width:auto">
         If the machine was off at that time, run when it next starts
       </label>
       <button class="primary" type="submit" style="justify-self:start">Save schedule</button>
     </form>
     <p class="hint">The dashboard has to be running for this to fire — DuckDuckGo needs a visible
     Chrome window, so a background cron job would only record “blocked”. Keep <code>npm start</code>
     running, or see the README for starting it automatically at login.
     ${state.boot.schedule.lastResult ? `<br><br><strong>Last automatic run:</strong> ${esc(state.boot.schedule.lastResult)}` : ''}</p>

     <h2 style="margin-top:1.8rem">Crawl politeness</h2>
     <form id="delay-form" class="form-grid" style="max-width:20rem">
       <label>Seconds between DuckDuckGo queries
         <input type="number" name="delaySeconds" min="0" max="300" value="${g ? state.boot.delaySeconds : 8}">
       </label>
       <button class="primary" type="submit" style="justify-self:start">Save</button>
     </form>
     <p class="hint">Lower is faster but more likely to trigger a challenge page. 8 seconds is a sane default.</p>

     <h2 style="margin-top:1.8rem">Google Search Console</h2>
     <p class="hint">Gives you real Google average positions for domains you have verified in Search Console.
     It's free, official, and never blocked — but it only covers your own properties.</p>

     ${
       g.connected
         ? `<p class="hint">✅ Connected${g.connectedAt ? ` on ${esc(new Date(g.connectedAt).toLocaleDateString())}` : ''}.
            Pick a property per project under “Project settings”.</p>
            <button id="gsc-disconnect" class="danger">Disconnect</button>`
         : `<ol class="steps">
              <li>Open <a href="https://console.cloud.google.com/apis/library/searchconsole.googleapis.com" target="_blank" rel="noreferrer">Google Cloud Console</a> and enable the <em>Google Search Console API</em>.</li>
              <li>Under <em>APIs &amp; Services → Credentials</em>, create an <strong>OAuth client ID</strong> of type <strong>Web application</strong>.</li>
              <li>Add this exact authorised redirect URI: <code>${esc(g.redirectUri)}</code></li>
              <li>Paste the client ID and secret below, save, then click Connect.</li>
            </ol>
            <form id="gsc-form" class="form-grid" style="margin-top:.8rem">
              <label>Client ID <input name="clientId" autocomplete="off" placeholder="…apps.googleusercontent.com" required></label>
              <label>Client secret <input name="clientSecret" autocomplete="off" type="password" required></label>
              <div style="display:flex;gap:.5rem">
                <button class="primary" type="submit">Save client</button>
                <a class="button ${g.configured ? '' : 'ghost'}" id="gsc-connect" href="/api/gsc/connect">Connect Google account →</a>
              </div>
            </form>`
     }`,
    (root) => {
      root.querySelector('#sched-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        try {
          const saved = await api('/api/schedule', {
            method: 'POST',
            body: { enabled: f.get('enabled') === 'on', time: f.get('time'), catchUp: f.get('catchUp') === 'on' },
          });
          state.boot.schedule = saved;
          toast(saved.enabled ? `Daily check scheduled for ${saved.time}` : 'Daily check turned off');
        } catch (err) {
          toast(err.message, true);
        }
      });

      root.querySelector('#delay-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const value = Number(new FormData(e.target).get('delaySeconds'));
        try {
          await api('/api/settings', { method: 'POST', body: { delaySeconds: value } });
          state.boot.delaySeconds = value;
          toast('Saved');
        } catch (err) {
          toast(err.message, true);
        }
      });

      root.querySelector('#gsc-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        try {
          await api('/api/gsc/client', {
            method: 'POST',
            body: { clientId: f.get('clientId'), clientSecret: f.get('clientSecret') },
          });
          await refreshBoot();
          toast('Client saved — now click “Connect Google account”');
        } catch (err) {
          toast(err.message, true);
        }
      });

      root.querySelector('#gsc-disconnect')?.addEventListener('click', async () => {
        await api('/api/gsc/disconnect', { method: 'POST' });
        closeModal();
        await refreshBoot();
        toast('Disconnected');
      });
    },
  );
});

/* --------------------------------------------------------------------- go */

boot().catch((err) => {
  document.body.innerHTML = `<main><div class="panel"><h1>Could not start</h1><p>${esc(err.message)}</p></div></main>`;
});

// Keep "x minutes ago" honest without a full re-render.
setInterval(() => {
  if (!state.runActive && state.keywords.length) renderKeywords();
}, 60000);
