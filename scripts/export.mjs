#!/usr/bin/env node
/**
 * Exports a read-only snapshot of your rankings as a single self-contained HTML
 * file — no server, no database, safe to host anywhere (GitHub Pages, S3, a USB
 * stick). Checking still happens locally; this is just the published view.
 *
 *   node scripts/export.mjs                  # -> docs/index.html
 *   node scripts/export.mjs --out public.html
 *   node scripts/export.mjs --no-metrics     # omit impressions/clicks/CTR
 *   node scripts/export.mjs --project 1      # a single project
 *
 * What is NEVER written into the export: OAuth client id/secret, refresh tokens,
 * or anything else from the settings table. Only keywords and their check
 * history are included.
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import * as db from '../src/db.mjs';
import { ENGINES, ENGINE_ORDER, REGIONS } from '../src/tracker.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const includeMetrics = !flag('--no-metrics');
const outPath = resolve(process.cwd(), value('--out', 'docs/index.html'));
const onlyProject = value('--project') ? Number(value('--project')) : null;

db.openDb();

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const regionLabel = (country, language) =>
  REGIONS.find((r) => r.country === country && r.language === language)?.label ?? `${country}-${language}`;

/** Build the plain-data payload. Nothing from `settings` ever goes in here. */
function buildPayload() {
  const projects = db.listProjects().filter((p) => (onlyProject ? p.id === onlyProject : true));

  return {
    generatedAt: new Date().toISOString(),
    includeMetrics,
    engines: ENGINE_ORDER.map((id) => ({ id, label: ENGINES[id].label })),
    projects: projects.map((project) => ({
      name: project.name,
      domain: project.domain,
      keywords: db.listKeywords(project.id).map((kw) => {
        const engines = {};
        for (const engineId of ENGINE_ORDER) {
          const history = db
            .checkHistory(kw.id, engineId, 120)
            .filter((c) => c.status === 'found' || c.status === 'absent')
            .reverse()
            .map((c) => {
              const point = {
                at: c.checked_at,
                status: c.status,
                position: c.status === 'found' ? c.position : null,
                parsed: c.results_parsed,
              };
              if (includeMetrics && c.status === 'found') {
                point.impressions = c.impressions;
                point.clicks = c.clicks;
                point.ctr = c.ctr;
              }
              return point;
            });

          const latest = history.at(-1) ?? null;
          const priorFound = history.slice(0, -1).reverse().find((h) => h.status === 'found');
          const delta =
            latest?.status === 'found' && priorFound
              ? Math.round((priorFound.position - latest.position) * 10) / 10
              : null;

          engines[engineId] = { latest, delta, history };
        }
        return {
          keyword: kw.keyword,
          region: regionLabel(kw.country, kw.language),
          regionShort: kw.country === 'wt' ? 'WW' : `${kw.country.toUpperCase()}·${kw.language.toUpperCase()}`,
          depth: kw.depth,
          engines,
        };
      }),
    })),
  };
}

const payload = buildPayload();
const css = readFileSync(join(import.meta.dirname, '..', 'public', 'style.css'), 'utf8');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(payload.projects[0]?.name ?? 'Rank Tracker')} — rankings</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📈</text></svg>">
<style>
${css}
body { padding: 0 0 4rem; }
.static-head { max-width: 1180px; margin: 0 auto; padding: 1.6rem 1.2rem .4rem; }
.stamp { font-size: .82rem; color: var(--muted); }
main { padding-top: .6rem; }
</style>
</head>
<body>
<div class="static-head">
  <div class="brand"><span class="mark">▲</span> Rank Tracker <span class="chip">read-only snapshot</span></div>
</div>
<main id="app"></main>
<script id="payload" type="application/json">${JSON.stringify(payload).replace(/</g, '\\u003c')}</script>
<script>
const DATA = JSON.parse(document.getElementById('payload').textContent);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const UI = {
  gsc: { kind: 'Real Google data', sub: '28-day average position',
         cols: DATA.includeMetrics ? ['Avg position','Change','Impressions','Clicks','CTR','Trend','Last checked']
                                   : ['Avg position','Change','Trend','Last checked'],
         absent: () => 'no impressions' },
  duckduckgo: { kind: 'Live SERP', sub: 'Position read from a real browser',
         cols: ['Position','Change','Trend','Last checked'],
         absent: (p, kw) => 'not in top ' + (p.parsed || kw.depth) },
};

function timeAgo(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return Math.max(1, Math.floor(s/60)) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  if (s < 2592000) return Math.floor(s/86400) + 'd ago';
  return new Date(iso).toLocaleDateString();
}

function spark(history) {
  const pts = history.filter(h => h.position != null);
  if (pts.length < 2) return '<span class="muted">—</span>';
  const w=70,h=22,pad=2, vals=pts.map(p=>p.position);
  const min=Math.min(...vals), max=Math.max(...vals), span=(max-min)||1;
  const d = pts.map((p,i)=>{
    const x=pad+(i*(w-pad*2))/(pts.length-1);
    const y=pad+((p.position-min)/span)*(h-pad*2);
    return (i?'L':'M')+x.toFixed(1)+','+y.toFixed(1);
  }).join(' ');
  return '<svg class="spark" width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'"><path'+(max===min?' class="flat"':'')+' d="'+d+'"/></svg>';
}

function chart(history, engine) {
  const pts = history;
  const found = pts.filter(p=>p.status==='found').map(p=>p.position);
  if (found.length < 2) return '<p class="hint">Not enough data yet for a trend.</p>';
  const w=640,h=240,padL=40,padR=14,padT=16,padB=30;
  const best=Math.max(0,Math.floor(Math.min(...found)-1)), worst=Math.ceil(Math.max(...found)+1), span=(worst-best)||1;
  const x=i=>padL+(i*(w-padL-padR))/Math.max(pts.length-1,1);
  const y=p=>padT+((p-best)/span)*(h-padT-padB);
  const segs=[]; let cur=[];
  pts.forEach((p,i)=>{ if(p.status==='found') cur.push((cur.length?'L':'M')+x(i).toFixed(1)+','+y(p.position).toFixed(1));
                       else { if(cur.length>1) segs.push(cur.join(' ')); cur=[]; } });
  if (cur.length>1) segs.push(cur.join(' '));
  const dots = pts.map((p,i)=>{
    const detail = p.status==='found'
      ? (engine==='gsc'?'avg position ':'position ')+p.position + (p.impressions!=null?' · '+p.impressions.toLocaleString()+' impressions':'')
      : (engine==='gsc'?'no impressions':'not in top '+(p.parsed||'?'));
    const cy = p.status==='found'? y(p.position) : h-padB;
    const cls = p.status==='found' ? 'class="dot"' : 'fill="var(--muted)" opacity=".55"';
    return '<g><title>'+esc(new Date(p.at).toLocaleString())+' — '+esc(detail)+'</title><circle '+cls+' cx="'+x(i).toFixed(1)+'" cy="'+cy.toFixed(1)+'" r="3.2"/></g>';
  }).join('');
  const ticks=[...new Set([best,Math.round((best+worst)/2),worst])].map(v=>
    '<line class="grid" x1="'+padL+'" y1="'+y(v)+'" x2="'+(w-padR)+'" y2="'+y(v)+'"/><text class="lbl" x="4" y="'+(y(v)+3)+'">'+(engine==='gsc'?'':'#')+v+'</text>').join('');
  const idx=[...new Set([0,Math.floor((pts.length-1)/2),pts.length-1])];
  const labels=idx.map(i=>{
    const a = i===0?'start':(i===pts.length-1?'end':'middle');
    return '<text class="lbl" x="'+x(i).toFixed(1)+'" y="'+(h-8)+'" text-anchor="'+a+'">'+esc(new Date(pts[i].at).toLocaleDateString([], {day:'numeric',month:'short'}))+'</text>';
  }).join('');
  return '<svg class="chart" viewBox="0 0 '+w+' '+h+'">'+ticks+segs.map(d=>'<path class="line" d="'+d+'"/>').join('')+dots+labels+'</svg>';
}

function deltaCell(d) {
  if (d === null || d === undefined) return '<span class="muted">—</span>';
  if (d === 0) return '<span class="delta flat">0</span>';
  return '<span class="delta '+(d>0?'up':'down')+'">'+(d>0?'↑':'↓')+' '+Math.abs(d)+'</span>';
}

function render() {
  const app = document.getElementById('app');
  app.innerHTML = DATA.projects.map((project, pi) => {
    const sections = DATA.engines.map(({id, label}) => {
      const ui = UI[id];
      const head = '<tr><th class="col-kw">Keyword</th><th>Region</th>' +
        ui.cols.map(c => '<th class="'+(c==='Trend'||c==='Last checked'?'':'num')+'">'+esc(c)+'</th>').join('') + '</tr>';
      const rows = project.keywords.map((kw, ki) => {
        const s = kw.engines[id], l = s.latest;
        const dash = '<span class="muted">—</span>';
        let pos = '<span class="chip">not checked</span>';
        if (l && l.status === 'found') pos = '<span class="pos">'+l.position+'</span>';
        else if (l && l.status === 'absent') pos = '<span class="chip absent">'+esc(ui.absent(l, kw))+'</span>';
        const metrics = (id==='gsc' && DATA.includeMetrics)
          ? '<td class="num">'+(l&&l.status==='found'&&l.impressions!=null?l.impressions.toLocaleString():dash)+'</td>'+
            '<td class="num">'+(l&&l.status==='found'&&l.clicks!=null?l.clicks.toLocaleString():dash)+'</td>'+
            '<td class="num">'+(l&&l.status==='found'&&l.ctr!=null?(l.ctr*100).toFixed(1)+'%':dash)+'</td>'
          : '';
        return '<tr class="kw-row" data-engine="'+id+'" data-p="'+pi+'" data-k="'+ki+'">'+
          '<td><span class="kw-cell">'+esc(kw.keyword)+'</span></td>'+
          '<td class="muted nowrap" title="'+esc(kw.region)+'">'+esc(kw.regionShort)+'</td>'+
          '<td class="num">'+pos+'</td>'+
          '<td class="num">'+deltaCell(s.delta)+'</td>'+
          metrics+
          '<td>'+spark(s.history)+'</td>'+
          '<td class="muted nowrap">'+esc(timeAgo(l && l.at))+'</td></tr>'+
          '<tr class="detail-row hidden" data-for="'+id+'-'+pi+'-'+ki+'"><td colspan="12"><div class="detail-wrap"></div></td></tr>';
      }).join('');
      return '<section class="engine-section">'+
        '<div class="engine-head"><h2>'+esc(label)+'</h2><span class="engine-kind">'+esc(ui.kind)+'</span>'+
        '<span class="engine-sub">'+esc(ui.sub)+'</span></div>'+
        '<div class="panel table-panel"><table><thead>'+head+'</thead><tbody>'+rows+'</tbody></table></div></section>';
    }).join('');
    return '<div class="project-head"><div><h1>'+esc(project.name)+'</h1>'+
      '<p class="muted">'+esc(project.domain)+'</p></div></div>'+ sections;
  }).join('') +
  '<p class="stamp">Snapshot taken '+esc(new Date(DATA.generatedAt).toLocaleString())+
  ' · click any row for its trend · checks run locally, this page is read-only</p>';

  // Row click expands the trend chart underneath.
  app.querySelectorAll('.kw-row').forEach(row => {
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => {
      const engine = row.dataset.engine, pi = Number(row.dataset.p), ki = Number(row.dataset.k);
      const detail = app.querySelector('[data-for="'+engine+'-'+pi+'-'+ki+'"]');
      const wrap = detail.querySelector('.detail-wrap');
      if (!detail.classList.contains('hidden')) return detail.classList.add('hidden');
      const kw = DATA.projects[pi].keywords[ki];
      wrap.innerHTML = '<strong>'+esc(kw.keyword)+'</strong> — '+esc(UI[engine].sub)+
        chart(kw.engines[engine].history, engine);
      detail.classList.remove('hidden');
    });
  });
}
render();
</script>
<style>
.detail-row td { background: var(--bg); }
.detail-wrap { padding: .6rem .2rem; }
.hidden { display: none; }
</style>
</body>
</html>
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, html);

const kwCount = payload.projects.reduce((n, p) => n + p.keywords.length, 0);
const bytes = Buffer.byteLength(html);
console.log(`Wrote ${outPath}`);
console.log(`  ${payload.projects.length} project(s), ${kwCount} keyword(s), ${(bytes / 1024).toFixed(0)} KB, fully self-contained`);
console.log(`  Traffic metrics (impressions/clicks/CTR): ${includeMetrics ? 'INCLUDED' : 'omitted'}`);
console.log(`  Credentials: never included`);
