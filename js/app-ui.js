/* =============================================================================
   app-ui.js — the prototype's controller: responsive shell, views, the
   inspector, the command palette, dialogs, filters, popovers, toasts, and
   the URL as the single source of truth for state.
   ========================================================================== */
window.DEA = window.DEA || {};
(function (DEA) {
  'use strict';

  var M = DEA.model, ICONS = window.DEA_ICONS, SVGNS = 'http://www.w3.org/2000/svg';
  var C = null, booted = false;

  /* ---------- helpers ------------------------------------------------------ */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function icon(name) { return '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name] || '') + '</svg>'; }
  function hydrateIcons(root) {
    $$('[data-icon]', root).forEach(function (n) {
      var s = document.createElementNS(SVGNS, 'svg');
      s.setAttribute('class', 'ico'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
      s.innerHTML = ICONS[n.getAttribute('data-icon')] || '';
      n.replaceWith(s);
    });
  }
  function li(l) { return M.layers.indexOf(M.layerById[l]) + 1; }            // 1..6 → layer token suffix
  function tag(a) { return '<span class="tag" data-layer="' + M.byId[a].l + '">' + a + '</span>'; }
  function layerChip(l) { return '<span class="tag" data-layer="' + l.id + '">' + l.code + ' · ' + esc(l.name) + '</span>'; }
  function statusBadge(s) { return '<span class="badge" data-status="' + esc(s) + '">' + esc((s || 'planned').replace('-', ' ')) + '</span>'; }
  function scoped() { return M.scope(S.layers, S.scope); }
  function anyDialogOpen() { return !!$('dialog[open]'); }
  function isTyping(e) { var t = e.target; return !!(t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')); }
  function mqOn(mq, fn) { if (mq.addEventListener) mq.addEventListener('change', fn); else mq.addListener(fn); }
  function pageHead(title, desc) {
    return '<div class="card__head"><h2 class="card__title">' + esc(title) + '</h2><p class="card__desc">' + desc + '</p></div>';
  }

  /* ---------- state -------------------------------------------------------- */
  var mqMobile = window.matchMedia('(max-width: 767px)');
  var mqTablet = window.matchMedia('(min-width: 768px) and (max-width: 1179px)');
  var S = {
    view: 'canvas', sel: null, trace: null, tab: 'overview',
    layers: new Set(M.layers.map(function (l) { return l.id; })), scope: null,
    rail: 'expanded', railOverlay: false, zoom: 'fit', start: false, startParam: false, embed: false,
    from: 'SO', to: 'APC', cell: null, q: '', flayer: '', fstatus: '', dialog: null
  };
  try { if (sessionStorage.getItem('dea.rail') === 'compact') S.rail = 'compact'; } catch (e) { /* storage is optional */ }

  var VIEW_META = {
    canvas: ['Canvas', 'workflow', 'The whole model at a glance'],
    matrix: ['Matrix', 'grid-3x3', 'Relationships between lanes'],
    trace: ['Traceability', 'route', 'Directional paths through the model'],
    coverage: ['Coverage', 'bar-chart-3', 'Programme health of the catalog'],
    catalogs: ['Catalogs', 'book-open', 'Entity → catalog repository'],
    viewpoints: ['Viewpoints', 'users', 'Curated scopes per persona']
  };
  var LAYER_COUNTS = {};
  M.entities.forEach(function (e) { LAYER_COUNTS[e.l] = (LAYER_COUNTS[e.l] || 0) + 1; });
  var PRESETS = [
    { from: 'SO', to: 'APC', label: 'Objective to application' },
    { from: 'TNT', to: 'CTL', label: 'Governance chain' },
    { from: 'CAP', to: 'APC', label: 'Capability delivery' },
    { from: 'VS', to: 'JT', label: 'Value stream to touchpoint' },
    { from: 'FR', to: 'OU', label: 'Funding to ownership' }
  ];
  var STATUS_ORDER = ['existing', 'existing-extended', 'scaffold', 'proposed', 'planned'];
  var STATUS_COLOR = {
    existing: 'var(--success-solid)', 'existing-extended': 'var(--violet-500)', scaffold: 'var(--warning-solid)',
    proposed: 'var(--info-solid)', planned: 'var(--neutral-solid)'
  };

  /* =============================================================================
     Boot
     ========================================================================== */
  function boot() {
    if (booted) return; booted = true;
    hydrateIcons(document);
    var p = M.parseUrl(location.search);
    Object.keys(p).forEach(function (k) { S[k] = p[k]; });
    // The URL parser speaks in link terms (entity, trace=1); the app keeps
    // a selection in S.sel and a computed trace result in S.trace.
    S.sel = p.entity || null;
    delete S.entity;
    S.trace = p.trace === true && S.sel ? M.impact(S.sel) : null;
    if (S.trace && !p.tab) S.tab = 'impact';              // a traced link opens on its trace
    if (p.layers) S.layers = new Set(p.layers);
    if (!p.start) {
      var dismissed = false; try { dismissed = sessionStorage.getItem('dea.start') === '1'; } catch (e) { /* optional */ }
      S.start = !dismissed && !p.entity && !p.scope && !p.layers && p.zoom === undefined && p.view === undefined;
      S.startParam = false;
    }
    $('#syncSub').textContent = M.entities.length + ' entities · ' + M.rels.length + ' relationships';

    C = DEA.Canvas.init($('#cv'), {
      onSelect: function (a) { select(a); },
      onHover: function (a) {
        $('#statusHover').textContent = a ? M.byId[a].n + ' · ' + a + ' · ' + M.layerById[M.byId[a].l].code + ' ' + M.layerById[M.byId[a].l].name : '';
      },
      onBackgroundTap: function () { if (S.sel) select(null); },
      onInteract: function () { dismissStart(); },
      onViewChange: onViewChange,
      insetRight: function () { return (!mqMobile.matches && S.sel && S.view === 'canvas') ? Math.min(384, $('#stage').clientWidth) : 0; },
      insetTop: function () { return mqMobile.matches ? 60 : 0; },        // room for the zoom toolbar
      insetBottom: function () {
        if (!mqMobile.matches || !S.sel || S.view !== 'canvas') return 0;
        var d = $('#dlgSheet'); return d.open ? d.querySelector('.sheet__panel').offsetHeight : 0;
      }
    });

    buildKeys(); buildExport(); buildLegend(); buildScrim();
    bind();
    mqOn(mqMobile, onBreakpoint); mqOn(mqTablet, onBreakpoint);
    applyRail();
    go(S.view, true);
    refreshScope(false, true);
    if (S.sel) { C.setSelection(S.sel, S.trace); mountInspector(); openInspector(); renderInspector(); }
    if (S.dialog) openDialog(S.dialog);
    syncUrl();
  }

  /* =============================================================================
     Navigation & shell
     ========================================================================== */
  function go(view, silent) {
    if (!VIEW_META[view]) view = 'canvas';
    S.view = view;
    document.body.dataset.view = view;
    $$('.shell [data-nav]').forEach(function (a) { a.classList.toggle('is-active', a.getAttribute('data-nav') === view); });
    var meta = VIEW_META[view];
    $('#viewTitle').textContent = meta[0];
    $('#viewSub').textContent = view === 'canvas' ? '' : meta[2];
    $('.statusbar__hint').innerHTML = view === 'canvas'
      ? 'Drag to pan · Scroll to zoom · Click an entity to inspect · <span class="kbd">?</span> shortcuts'
      : '<span class="kbd">?</span> shortcuts';
    $$('[data-panel]').forEach(function (p) {
      var is = p.getAttribute('data-panel') === view;
      p.hidden = !is;
      if (is && view !== 'canvas') renderView(view);
    });
    if (view === 'canvas') { if (S.sel) openInspector(); }
    else closeInspectorPanels();
    renderTools(); updateCounts(); renderStart();
    if (!silent) syncUrl();
  }
  function renderView(view) {
    if (view === 'matrix') renderMatrix();
    else if (view === 'trace') renderTrace();
    else if (view === 'coverage') renderCoverage();
    else if (view === 'catalogs') renderCatalogs();
    else if (view === 'viewpoints') renderViewpoints();
  }
  function updateCounts() {
    if (S.view !== 'canvas') return;
    var sc = scoped();
    $('#viewSub').textContent = sc.entities.length + ' entities · ' + sc.rels.length + ' relationships' +
      (S.layers.size < M.layers.length ? ' · ' + S.layers.size + ' layers' : ' · all layers') +
      (S.scope ? ' · ' + M.scopeLabel(S.scope) + ' scope' : '');
  }
  function renderTools() {
    var host = $('#viewTools');
    if (S.view !== 'canvas') { host.innerHTML = ''; return; }
    var filtersActive = S.layers.size < M.layers.length || !!S.scope;
    var active = (M.layers.length - S.layers.size) + (S.scope ? 1 : 0);
    host.innerHTML =
      '<div class="chipgroup chipgroup--layers desktop-only"><span class="overline chipgroup__label">Layers</span>' +
      M.layers.map(function (l) {
        return '<button class="chip chip--toggle" data-action="layer" data-layer="' + l.id + '" data-dot="' + l.id + '" aria-pressed="' + S.layers.has(l.id) +
          '" data-tip="' + esc(l.code + ' · ' + l.name + ' · ' + LAYER_COUNTS[l.id] + ' entities') + '">' +
          '<span class="chip__dot"></span>' + l.code + '<span class="chip__count">' + LAYER_COUNTS[l.id] + '</span></button>';
      }).join('') + '</div>' +
      '<div class="chipgroup desktop-only"><button class="select-btn" data-action="scope" aria-haspopup="menu" data-tip="Membership scope">' +
      '<span class="select-btn__label">Scope</span><span>' + esc(M.scopeLabel(S.scope)) + '</span>' + icon('chevron-down') + '</button></div>' +
      (filtersActive ? '<button class="btn btn--ghost btn--sm desktop-only" data-action="reset-filters">' + icon('rotate-ccw') + 'Reset</button>' : '') +
      '<button class="btn btn--ghost btn--sm mobile-only" data-action="filters">' + icon('sliders-horizontal') + '<span>Filters</span>' +
      (active ? '<span class="badge badge--brand">' + active + '</span>' : '') + '</button>';
  }
  function applyRail() {
    var shell = $('#shell');
    shell.classList.toggle('rail-compact', mqTablet.matches || (!mqMobile.matches && S.rail === 'compact'));
    shell.classList.toggle('rail-open', mqTablet.matches && S.railOverlay);
    $('.topbar__rail').setAttribute('aria-pressed', String(mqTablet.matches ? S.railOverlay : S.rail === 'expanded'));
  }
  function onBreakpoint() {
    applyRail();
    if (S.sel && S.view === 'canvas') { closeInspectorPanels(); mountInspector(); openInspector(); }
  }
  function onViewChange(st) {
    $('#zoomLabel').textContent = Math.round(st.k * 100) + '%';
    S.zoom = st.atFit ? 'fit' : String(Math.round(st.k * 100) / 100);
    scheduleUrl();
  }

  /* ---------- URL ---------------------------------------------------------- */
  var urlTimer = 0;
  function linkState(over) {
    return Object.assign({}, S, { entity: S.sel, trace: S.trace ? true : null }, over || {});
  }
  function syncUrl() {
    clearTimeout(urlTimer); urlTimer = 0;
    var qs = M.serialize(linkState());
    try { history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '')); } catch (e) { /* file:// may not allow history writes */ }
  }
  function scheduleUrl() { if (!urlTimer) urlTimer = setTimeout(syncUrl, 160); }

  /* =============================================================================
     Filters
     ========================================================================== */
  function refreshScope(fit, instant) {
    var sc = scoped();
    if (S.sel && !sc.entities.some(function (e) { return e.a === S.sel; })) { S.sel = null; S.trace = null; closeInspectorPanels(); }
    C.setScope(sc, { zoom: fit ? 'fit' : S.zoom, instant: !!instant });
    if (fit) S.zoom = 'fit';
    renderTools(); updateCounts(); renderStart(); scheduleUrl();
  }
  function toggleLayer(id) {
    if (S.layers.has(id) && S.layers.size === 1) { toast('Keep at least one layer visible', { icon: 'info' }); return; }
    if (S.layers.has(id)) S.layers.delete(id); else S.layers.add(id);
    S.trace = null; C.setSelection(S.sel, null);
    refreshScope(true);
  }
  function setScope(key) {
    S.scope = key || null; S.trace = null; closePopovers();
    if ($('#dlgFilters').open && S.embed) closeDialog($('#dlgFilters'));
    C.setSelection(S.sel, null);
    refreshScope(true);
    toast(key ? 'Scope: ' + M.scopeLabel(key) + ' · ' + scoped().entities.length + ' entities' : 'Scope: all memberships', { icon: 'check' });
  }
  function resetFilters() {
    var prev = { layers: Array.from(S.layers), scope: S.scope };
    if (prev.layers.length === M.layers.length && !prev.scope) return;
    S.layers = new Set(M.layers.map(function (l) { return l.id; })); S.scope = null; S.trace = null;
    C.setSelection(S.sel, null);
    refreshScope(true);
    toast('Filters reset', { action: { label: 'Undo', fn: function () { S.layers = new Set(prev.layers); S.scope = prev.scope; refreshScope(true); } } });
  }

  /* =============================================================================
     Start panel
     ========================================================================== */
  function hideStart() { var p = $('#startPanel'); p.hidden = true; p.innerHTML = ''; }
  function dismissStart() {
    if (!S.start) return;
    S.start = false; hideStart();
    if (!S.startParam) { try { sessionStorage.setItem('dea.start', '1'); } catch (e) { /* optional */ } }
  }
  function renderStart() {
    if (S.view !== 'canvas' || !S.start) { hideStart(); return; }
    var p = $('#startPanel'); p.hidden = false;
    p.innerHTML =
      '<div class="start__head"><span class="overline">Start here</span><span class="start__sub">' + scoped().entities.length + ' entities fit the view at a glance</span>' +
      '<button class="icon-btn icon-btn--sm start__close" data-action="dismiss-start" aria-label="Dismiss">' + icon('x') + '</button></div>' +
      '<div class="start__grid">' +
      '<button class="start__item" data-action="search"><span class="start__icon">' + icon('search') + '</span><span class="start__name">Find an entity</span><span class="start__desc">Names, aliases and descriptions</span></button>' +
      '<button class="start__item" data-action="scope-core"><span class="start__icon">' + icon('target') + '</span><span class="start__name">OpenDEA Core</span><span class="start__desc">The 9 anchor entities</span></button>' +
      '<button class="start__item" data-action="goto-trace"><span class="start__icon">' + icon('route') + '</span><span class="start__name">Trace a path</span><span class="start__desc">Objective → application component</span></button>' +
      '<button class="start__item" data-action="goto-viewpoints"><span class="start__icon">' + icon('users') + '</span><span class="start__name">Pick a viewpoint</span><span class="start__desc">' + M.VIEWPOINTS.length + ' persona scopes</span></button>' +
      '</div><div class="start__tip">' + icon('info') + '<span>Scroll to zoom in · click a lane label to focus that lane</span></div>';
  }

  /* =============================================================================
     Selection & inspector
     ========================================================================== */
  function select(a, opts) {
    opts = opts || {};
    if (!a) {
      S.sel = null; S.trace = null; C.setSelection(null, null);
      closeInspectorPanels(); if (!mqMobile.matches) C.fitIfAtFit();
      syncUrl(); return;
    }
    if (S.sel !== a) S.trace = null;
    S.sel = a; S.tab = opts.tab || 'overview';
    if (S.view !== 'canvas') go('canvas', true);
    C.setSelection(a, S.trace);
    openInspector(); renderInspector();
    if (!mqMobile.matches) C.fitIfAtFit();
    scheduleUrl();
  }
  function runTrace(a) {
    if (S.trace && S.trace.source === a) { S.trace = null; }
    else {
      S.trace = M.impact(a);
      toast('Impact of ' + M.byId[a].n + ': ' + Object.keys(S.trace.up).length + ' upstream · ' + Object.keys(S.trace.down).length + ' downstream', { icon: 'zap' });
    }
    S.tab = 'impact';
    C.setSelection(a, S.trace); renderInspector(); syncUrl();
  }
  function mountInspector() {
    var body = $('#inspectorBody');
    if (!body) { body = document.createElement('div'); body.id = 'inspectorBody'; body.className = 'inspector__wrap'; }
    var host = mqMobile.matches ? $('#sheetHost') : $('#inspector');
    if (body.parentNode !== host) host.appendChild(body);
  }
  function openInspector() {
    if (S.view !== 'canvas' || !S.sel) return;
    mountInspector();
    if (mqMobile.matches) {
      var d = $('#dlgSheet'); d.classList.remove('is-expanded');
      if (!d.open) d.show();
    } else {
      $('#inspector').hidden = false; $('#stage').classList.add('has-inspector');
    }
  }
  function closeInspectorPanels() {
    var d = $('#dlgSheet'); if (d.open) d.close();
    d.classList.remove('is-expanded');
    $('#inspector').hidden = true; $('#stage').classList.remove('has-inspector');
  }

  function renderInspector() {
    if (!S.sel) return;
    var e = M.byId[S.sel], l = M.layerById[e.l], core = e.m && e.m[0] === 'core';
    var tabs = [['overview', 'Overview', 0], ['relations', 'Relations', M.inbound[e.a].length + M.outbound[e.a].length], ['impact', 'Impact', 0], ['catalog', 'Catalog', 0]];
    $('#inspectorBody').innerHTML =
      '<div class="inspector__head" style="--lane: var(--layer-' + li(e.l) + ')">' +
      '<div class="inspector__stripe"></div>' + tag(e.a) +
      '<h2 class="inspector__title"' + (e.abs ? ' style="font-style:italic"' : '') + '>' + esc(e.n) + '</h2>' +
      '<div class="inspector__chips">' + layerChip(l) + statusBadge(e.s) + (core ? '<span class="badge badge--brand">core</span>' : '') +
      (e.abs ? '<span class="badge">abstract</span>' : '') + '</div>' +
      '<button class="icon-btn inspector__close" data-action="close-inspector" aria-label="Close inspector">' + icon('x') + '</button></div>' +
      '<div class="tabs inspector__tabs" role="tablist" aria-label="Entity details">' + tabs.map(function (t) {
        return '<button class="tabs__tab" role="tab" aria-selected="' + (S.tab === t[0]) + '" data-action="tab" data-tab="' + t[0] + '">' + t[1] +
          (t[2] ? '<span class="tabs__count">' + t[2] + '</span>' : '') + '</button>';
      }).join('') + '</div>' +
      '<div class="inspector__body">' + inspectorTab(e) + '</div>' +
      '<div class="inspector__foot">' +
      '<button class="btn" data-action="copy-link">' + icon('link') + 'Copy link</button>' +
      '<button class="btn ' + (S.trace ? '' : 'btn--primary') + '" data-action="trace" aria-pressed="' + (!!S.trace) + '">' + icon('zap') + (S.trace ? 'Clear trace' : 'Trace impact') + '</button></div>';
  }
  function relRow(r, other, incoming) {
    var o = M.byId[other];
    return '<button class="irel" data-action="open-entity" data-id="' + o.a + '" data-tip="' + esc(r.l + (r.c ? ' · ' + r.c : '')) + '">' +
      icon(incoming ? 'arrow-down' : 'arrow-up') + tag(o.a) + '<span class="irel__name">' + esc(o.n) + '</span>' +
      '<span class="irel__label">' + esc(r.l) + '</span><span class="irel__card">' + esc(r.c || '') + '</span></button>';
  }
  function inspectorTab(e) {
    if (S.tab === 'relations') {
      var inc = M.inbound[e.a], out = M.outbound[e.a];
      return '<section class="isec"><div class="isec__title"><span class="overline">Incoming · drives it</span><span class="mono muted">' + inc.length + '</span></div>' +
        (inc.length ? '<div class="ilist">' + inc.map(function (r) { return relRow(r, r.f, true); }).join('') + '</div>' : '<div class="iempty">Top of chain — nothing drives it.</div>') + '</section>' +
        '<section class="isec"><div class="isec__title"><span class="overline">Outgoing · depends on</span><span class="mono muted">' + out.length + '</span></div>' +
        (out.length ? '<div class="ilist">' + out.map(function (r) { return relRow(r, r.t, false); }).join('') + '</div>' : '<div class="iempty">Leaf — it depends on nothing.</div>') + '</section>';
    }
    if (S.tab === 'impact') {
      if (!S.trace) return '<section class="isec"><div class="empty" style="padding:24px 8px"><div class="empty__icon">' + icon('zap') +
        '</div><div class="empty__title">Trace the full impact chain</div><p class="empty__text">Highlights everything upstream (amber) and downstream (teal) of ' + esc(e.n) +
        ' on the canvas.</p><div class="empty__actions"><button class="btn btn--primary" data-action="trace">' + icon('zap') + 'Run trace</button></div></div></section>';
      var t = S.trace;
      return '<section class="isec"><div class="isec__title"><span class="overline">Upstream · drivers</span><span class="badge badge--up">' + Object.keys(t.up).length + '</span></div>' + hopGroups(t.up) + '</section>' +
        '<section class="isec"><div class="isec__title"><span class="overline">Downstream · dependents</span><span class="badge badge--down">' + Object.keys(t.down).length + '</span></div>' + hopGroups(t.down) + '</section>';
    }
    if (S.tab === 'catalog') {
      if (!e.repo) return '<section class="isec"><div class="empty" style="padding:24px 8px"><div class="empty__icon">' + icon('book-open') +
        '</div><div class="empty__title">Not catalogued yet</div><p class="empty__text">' + esc(e.n) + ' is on the catalog backlog — ' + M.coverage().backlog.length +
        ' entities have no catalog repository.</p></div></section>';
      return '<section class="isec"><dl class="kv"><dt>Repository</dt><dd class="mono">' + esc(e.repo) + '</dd>' +
        (e.cs ? '<dt>Entries</dt><dd class="tnum">' + e.cs[0].toLocaleString() + '</dd><dt>Canonical</dt><dd class="tnum">' + e.cs[1] + '</dd><dt>Candidates</dt><dd class="tnum">' + e.cs[2] + '</dd>'
              : '<dt>Content</dt><dd>No entries published yet</dd>') + '</dl></section>' +
        '<a class="btn" style="width:100%" href="' + esc(e.url || 'https://github.com/technehub-labs/' + e.repo) + '" target="_blank" rel="noopener">' + icon('external-link') + 'Open catalog on GitHub</a>';
    }
    var kids = M.children[e.a] || [];
    return '<section class="isec"><p class="idesc">' + esc(e.d || '—') + '</p></section>' +
      '<section class="isec"><div class="isec__title"><span class="overline">Attributes</span><span class="mono muted">' + e.at.length + '</span></div>' +
      (e.at.length ? '<div class="iattrs">' + e.at.map(function (a) { return '<div class="iattr"><b>+ ' + esc(a[0]) + '</b><span>' + esc(a[1]) + '</span></div>'; }).join('') + '</div>' : '<div class="iempty">No attributes declared.</div>') + '</section>' +
      '<section class="isec"><div class="isec__title" style="margin-bottom:8px"><span class="overline">Classification</span></div><dl class="kv">' +
      '<dt>Entity ID</dt><dd class="mono">' + esc(e.eid || '—') + '</dd>' +
      (e.bb ? '<dt>Building block</dt><dd>' + esc(e.bb) + '</dd>' : '') +
      '<dt>Membership</dt><dd>' + esc(e.m ? (e.m[0] === 'core' ? 'Core' : M.scopeLabel('profile:' + e.m[1])) : 'Unassigned') + '</dd>' +
      (e.sp ? '<dt>Specializes</dt><dd><button class="link" data-action="open-entity" data-id="' + e.sp + '">' + esc(M.byId[e.sp].n) + '</button></dd>' : '') +
      (kids.length ? '<dt>Specialized by</dt><dd>' + kids.map(function (k) { return '<button class="link" data-action="open-entity" data-id="' + k + '">' + esc(k) + '</button>'; }).join(' ') + '</dd>' : '') +
      '</dl></section>';
  }
  function hopGroups(map) {
    var hops = {};
    Object.keys(map).forEach(function (a) { (hops[map[a]] = hops[map[a]] || []).push(a); });
    return '<div class="ihops">' + Object.keys(hops).sort(function (a, b) { return a - b; }).map(function (h) {
      return '<div class="ihop"><div class="ihop__label"><span>' + (h === 1 ? 'Direct' : h + ' hops away') + '</span><span class="ihop__line"></span></div><div class="ichips">' +
        hops[h].map(function (a) { return '<button class="ichip" data-action="open-entity" data-id="' + a + '">' + tag(a) + esc(M.byId[a].n) + '</button>'; }).join('') + '</div></div>';
    }).join('') + '</div>';
  }

  /* =============================================================================
     Views
     ========================================================================== */
  /* ---------- Matrix ------------------------------------------------------- */
  function renderMatrix() {
    var mx = M.matrix(M.rels), max = 1;
    Object.keys(mx.cells).forEach(function (k) { max = Math.max(max, mx.cells[k].length); });
    var html = '<div class="page__inner"><div class="grid--matrix"><div class="card card--pad">' +
      pageHead('Cross-layer traceability matrix', 'Relationships connecting lanes. Rows are the source, columns the target. Select a cell to inspect it.') +
      '<div class="tscroll"><table class="xmatrix"><thead><tr><th scope="col"></th>' + M.layers.map(function (l) { return '<th scope="col">' + l.code + '</th>'; }).join('') + '</tr></thead><tbody>';
    M.layers.forEach(function (lf) {
      html += '<tr><th class="rowh" scope="row"><span class="dot" style="--sw:var(--layer-' + li(lf.id) + ')"></span>' + lf.code + ' · ' + esc(lf.name) + '</th>';
      M.layers.forEach(function (lt) {
        var rels = mx.cells[lf.id + '>' + lt.id], key = lf.id + '>' + lt.id;
        if (!rels.length) { html += '<td><span class="xcell is-empty" aria-label="none">·</span></td>'; return; }
        var p = Math.max(8, Math.round(Math.pow(rels.length / max, .7) * 100));
        html += '<td><button class="xcell' + (S.cell === key ? ' is-selected' : '') + '" data-action="cell" data-cell="' + key +
          '" style="--heat:color-mix(in srgb, var(--brand) ' + p + '%, #fff)" aria-label="' + lf.code + ' to ' + lt.code + ': ' + rels.length + ' relationships" aria-pressed="' + (S.cell === key) + '">' + rels.length + '</button></td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table></div></div><aside class="card card--pad xdetail" aria-label="Cell details">' + matrixDetail() + '</aside></div></div>';
    $('#pageMatrix').innerHTML = html;
  }
  function matrixDetail() {
    if (!S.cell) return pageHead('Cell details', 'Select a cell to list the relationships it contains.') +
      '<div class="empty" style="padding:16px 8px"><div class="empty__icon">' + icon('grid-3x3') + '</div><div class="empty__title">No cell selected</div></div>';
    var rels = M.matrix(M.rels).cells[S.cell] || [], pair = S.cell.split('>'), f = M.layerById[pair[0]], t = M.layerById[pair[1]];
    return pageHead(f.code + ' → ' + t.code, esc(f.name) + ' → ' + esc(t.name)) +
      '<div class="xdetail__count">' + rels.length + '</div><div class="overline" style="margin:4px 0 10px">relationships</div><div>' +
      rels.slice(0, 14).map(function (r) {
        return '<button class="xrel" data-action="open-entity" data-id="' + r.f + '">' + tag(r.f) +
          '<span class="xrel__path">' + esc(M.byId[r.f].n) + ' → ' + esc(M.byId[r.t].n) + '</span><span class="irel__label">' + esc(r.l) + '</span></button>';
      }).join('') + (rels.length > 14 ? '<div class="iempty">+' + (rels.length - 14) + ' more — export JSON for the full list</div>' : '') + '</div>';
  }

  /* ---------- Traceability ------------------------------------------------- */
  function picker(role) {
    var a = role === 'from' ? S.from : S.to, e = M.byId[a], l = M.layerById[e.l];
    return '<div class="picker picker--' + role + '"><span class="overline">' + (role === 'from' ? 'Source' : 'Target') + '</span>' +
      '<button class="picker__btn" data-action="pick" data-role="' + role + '" aria-haspopup="dialog">' + tag(a) +
      '<span class="picker__name">' + esc(e.n) + '</span><span class="picker__layer">' + l.code + ' · ' + esc(l.name) + '</span>' + icon('chevron-down') + '</button></div>';
  }
  function pathChain(path) {
    var out = [];
    path.nodes.forEach(function (a, i) {
      out.push('<button class="pnode" data-layer="' + M.byId[a].l + '" data-action="open-entity" data-id="' + a + '" data-tip="Open on the canvas">' +
        '<span class="mono" style="opacity:.6">' + a + '</span>' + esc(M.byId[a].n) + '</button>');
      if (i < path.rels.length) {
        var r = path.rels[i];
        out.push('<span class="parrow" data-cat="' + r.cat + '" data-tip="' + esc(r.l + (r.c ? ' · ' + r.c : '')) + '">' + icon('arrow-right') + '<span>' + esc(r.l) + '</span></span>');
      }
    });
    return '<div class="pathchain">' + out.join('') + '</div>';
  }
  function traceResult() {
    var list = M.paths(S.from, S.to, 4, 6), A = M.byId[S.from], B = M.byId[S.to];
    if (list.length) {
      return pageHead(list.length === 1 ? 'Shortest path' : list.length + ' paths, shortest first', 'Each hop is a directed relationship. Select any node to open it on the canvas.') +
        '<button class="btn btn--primary" data-action="show-path">' + icon('zap') + 'Show on canvas</button>' +
        '<div style="display:grid;gap:12px;margin-top:16px">' + list.map(function (p, i) {
          return '<div class="card" style="padding:14px 16px"><div class="pathmeta"><span class="pathmeta__n">Path ' + (i + 1) + '</span>' +
            '<span class="muted" style="font-size:12px">' + p.rels.length + (p.rels.length === 1 ? ' hop' : ' hops') + '</span></div>' + pathChain(p) + '</div>';
        }).join('') + '</div>';
    }
    var s = M.pathSuggestions(S.from, S.to);
    var html = '<div class="empty"><div class="empty__icon">' + icon('route') + '</div><div class="empty__title">No path from ' + esc(A.n) + ' to ' + esc(B.n) + '</div>' +
      '<p class="empty__text">Relationships flow one way, and nothing leads from the source to the target within six hops.</p>';
    if (s.reverse) html += '<div class="sugg" style="margin-top:8px"><span class="muted" style="font-size:12px">A path exists the other way:</span>' + pathChain(s.reverse) + '</div>';
    if (s.via.length) html += '<div class="sugg" style="margin-top:12px"><span class="muted" style="font-size:12px">One hop away, and it reaches the target:</span>' + s.via.map(function (v) {
      return '<button class="chip chip--select" data-action="pick-id" data-id="' + v.rel.t + '">' + esc(v.rel.l) + ' → ' + esc(M.byId[v.rel.t].n) + '</button>'; }).join('') + '</div>';
    if (s.shared.length) html += '<div class="sugg" style="margin-top:12px"><span class="muted" style="font-size:12px">Both trace down to:</span>' + s.shared.map(function (a) {
      return '<button class="ichip" data-action="open-entity" data-id="' + a + '">' + tag(a) + esc(M.byId[a].n) + '</button>'; }).join('') + '</div>';
    return html + '<div class="empty__actions"><button class="btn" data-action="swap">' + icon('arrow-left-right') + 'Reverse direction</button>' +
      '<button class="btn btn--primary" data-action="pick" data-role="from">' + icon('search') + 'Change source</button></div></div>';
  }
  function renderTrace() {
    $('#pageTrace').innerHTML = '<div class="page__inner"><div class="card card--pad">' +
      pageHead('Traceability & lineage', 'Follow directed relationships from a source to a target, or start from a known-good pair.') +
      '<div class="trace__pickers">' + picker('from') +
      '<button class="icon-btn icon-btn--outline" data-action="swap" aria-label="Swap source and target" data-tip="Swap direction" style="height:40px;width:40px">' + icon('arrow-left-right') + '</button>' +
      picker('to') + '</div>' +
      '<div class="trace__presets"><span class="overline">Presets</span>' + PRESETS.map(function (p) {
        return '<button class="chip chip--select" data-action="preset" data-from="' + p.from + '" data-to="' + p.to + '" aria-pressed="' + (p.from === S.from && p.to === S.to) + '">' + esc(p.label) + '</button>';
      }).join('') + '</div></div><div class="card card--pad">' + traceResult() + '</div></div>';
  }
  function setPair(from, to) { S.from = from; S.to = to; renderTrace(); syncUrl(); }

  /* ---------- Coverage ----------------------------------------------------- */
  function kpi(label, value, note, warn) {
    return '<div class="kpi' + (warn ? ' kpi--warn' : '') + '"><span class="overline kpi__label">' + esc(label) + '</span><div class="kpi__value">' + value +
      '</div><div class="kpi__note">' + esc(note) + '</div></div>';
  }
  function renderCoverage() {
    var c = M.coverage(), pct = Math.round(c.cataloged / c.total * 100);
    var present = STATUS_ORDER.filter(function (s) { return c.statusCounts[s]; });
    var maxLayer = Math.max.apply(null, c.layerCounts.map(function (x) { return x.count; }));
    var maxScope = Math.max.apply(null, c.scopes.map(function (g) { return g.count; }));
    function hbar(label, dot, width, fill, n) {
      return '<div class="hbar"><span class="hbar__label">' + (dot ? '<span class="dot" style="--sw:' + dot + '"></span>' : '') + label + '</span>' +
        '<span class="bar"><i style="' + (fill ? '--bar:' + fill + ';' : '') + 'width:' + width + '%"></i></span><span class="hbar__value">' + n + '</span></div>';
    }
    $('#pageCoverage').innerHTML = '<div class="page__inner">' +
      '<div class="kpis">' + kpi('Entities', c.total, 'in the synced model') + kpi('Cataloged', c.cataloged, pct + '% have a catalog repo') +
      kpi('Catalog backlog', c.backlog.length, 'entities without a catalog repo', true) + kpi('Awaiting layer', 0, 'nothing pending allocation') +
      kpi('ECF coordinates', c.withEcf.length, 'mapped to the 7×7 framework', true) + '</div>' +
      '<div class="grid--coverage"><div class="card card--pad">' + pageHead('Status distribution', 'Lifecycle state of every entity.') +
      '<div class="stackbar">' + present.map(function (s) {
        return '<i style="width:' + (c.statusCounts[s] / c.total * 100) + '%;background:' + STATUS_COLOR[s] + '" title="' + esc(s) + ': ' + c.statusCounts[s] + '"></i>'; }).join('') + '</div>' +
      '<div class="legend">' + present.map(function (s) {
        return '<span class="legend__item"><span class="legend__sw" style="--sw:' + STATUS_COLOR[s] + '"></span>' + esc(s.replace('-', ' ')) + ' <span class="legend__n">' + c.statusCounts[s] + '</span></span>'; }).join('') + '</div></div>' +
      '<div class="card card--pad">' + pageHead('Layer coverage', 'Entities per architecture lane.') + '<div class="hbars">' + c.layerCounts.map(function (x) {
        return hbar(esc(x.layer.code + ' · ' + x.layer.name), 'var(--layer-' + li(x.layer.id) + ')', x.count / maxLayer * 100, 'var(--layer-' + li(x.layer.id) + ')', x.count); }).join('') + '</div></div>' +
      '<div class="card card--pad">' + pageHead('Live catalog content', 'Published entries per catalog at the last sync.') + '<div>' + c.liveCatalogs.map(function (e) {
        return '<button class="linkrow" data-action="open-entity" data-id="' + e.a + '">' + tag(e.a) + '<span class="linkrow__name">' + esc(e.n) + '</span>' +
          '<span class="linkrow__n">' + e.cs[0].toLocaleString() + ' entries</span>' + icon('chevron-right') + '</button>'; }).join('') + '</div></div>' +
      '<div class="card card--pad">' + pageHead('Catalog backlog · ' + c.backlog.length, 'Entities with no catalog repository yet.') + '<div class="chipcloud">' + c.backlog.map(function (e) {
        return '<button class="chip chip--static" data-action="open-entity" data-id="' + e.a + '" data-tip="' + esc(e.n) + '">' + e.a + '</button>'; }).join('') + '</div>' +
      '<div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border-subtle)"><div class="card__head"><h3 class="card__title" style="font-size:14px">Membership</h3>' +
      '<p class="card__desc">Core anchors, profiles and unassigned entities.</p></div><div class="hbars">' + c.scopes.map(function (g) {
        return hbar(esc(g.label), '', g.count / maxScope * 100, '', g.count); }).join('') + '</div></div></div></div></div>';
  }

  /* ---------- Catalogs ----------------------------------------------------- */
  function renderCatalogs() {
    var q = S.q.trim(), pool = M.entities.filter(function (e) { return (!S.flayer || e.l === S.flayer) && (!S.fstatus || e.s === S.fstatus); });
    var hits = q ? M.search(q, pool, 200).map(function (h) { return h.entity; })
                 : pool.slice().sort(function (a, b) { return li(a.l) - li(b.l) || a.n.localeCompare(b.n); });
    $('#pageCatalogs').innerHTML = '<div class="page__inner">' +
      '<div class="catbar"><div class="field field--lg">' + icon('search') + '<input id="catQ" type="search" placeholder="Search catalogs…" value="' + esc(q) + '" aria-label="Search catalogs"></div>' +
      '<div class="field field--lg catbar__select"><select id="catLayer" aria-label="Filter by layer"><option value="">All layers</option>' +
      M.layers.map(function (l) { return '<option value="' + l.id + '"' + (S.flayer === l.id ? ' selected' : '') + '>' + l.code + ' · ' + esc(l.name) + '</option>'; }).join('') + '</select>' + icon('chevron-down') + '</div>' +
      '<div class="field field--lg catbar__select catbar__select--sm"><select id="catStatus" aria-label="Filter by status"><option value="">All statuses</option>' +
      STATUS_ORDER.map(function (s) { return '<option value="' + s + '"' + (S.fstatus === s ? ' selected' : '') + '>' + esc(s.replace('-', ' ')) + '</option>'; }).join('') + '</select>' + icon('chevron-down') + '</div>' +
      '<span class="catbar__count">' + hits.length + ' of ' + M.entities.length + '</span></div>' +
      '<div class="catgrid">' + hits.map(function (e) {
        return '<button class="catcard" data-action="open-entity" data-id="' + e.a + '"><div class="catcard__head">' + tag(e.a) + '<span class="catcard__name">' + esc(e.n) + '</span>' + statusBadge(e.s) + '</div>' +
          '<p class="catcard__desc">' + esc(e.d) + '</p><div class="catcard__foot"><span>' + M.layerById[e.l].code + ' · ' + esc(M.layerById[e.l].name) + '</span>' +
          (e.cs ? '<span class="mono">' + e.cs[0].toLocaleString() + ' entries</span>' : '') + icon('arrow-up-right') + '</div></button>';
      }).join('') + '</div>' +
      (hits.length ? '' : '<div class="empty"><div class="empty__icon">' + icon('search') + '</div><div class="empty__title">No catalogs match</div>' +
        '<p class="empty__text">Try a different term or clear the filters.</p><div class="empty__actions"><button class="btn" data-action="cat-clear">Clear filters</button></div></div>') + '</div>';
  }

  /* ---------- Viewpoints --------------------------------------------------- */
  function renderViewpoints() {
    $('#pageViewpoints').innerHTML = '<div class="page__inner"><div class="card__head" style="max-width:720px"><h2 class="card__title">A viewpoint is a curated scope</h2>' +
      '<p class="card__desc">Each one applies a layer and membership filter to the canvas and deep-links as a URL. Applying one never changes the model.</p></div><div class="vpgrid">' +
      M.VIEWPOINTS.map(function (v) {
        return '<article class="vpcard"><span class="overline vpcard__aud">' + esc(v.audience) + '</span><h3 class="vpcard__name">' + esc(v.label) + '</h3>' +
          '<p class="vpcard__desc">' + esc(v.desc) + '</p>' +
          '<div class="vpscope" aria-hidden="true">' + v.perLayer.map(function (n, i) { return n ? '<i style="--sw:var(--layer-' + (i + 1) + ');flex:' + n + '"></i>' : ''; }).join('') + '</div>' +
          '<div class="vpcard__meta"><span><b>' + v.count + '</b> entities</span><span>·</span><span>' + v.layers.map(function (l) { return M.layerById[l].code; }).join(', ') + ' · ' + esc(M.scopeLabel(v.scope)) + '</span></div>' +
          '<div class="vpcard__actions"><button class="btn btn--primary" data-action="vp-apply" data-id="' + v.id + '">' + icon('check') + 'Apply</button>' +
          '<button class="btn" data-action="vp-link" data-id="' + v.id + '">' + icon('link') + 'Copy link</button></div></article>';
      }).join('') + '</div></div>';
  }
  function applyViewpoint(id) {
    var v = M.VIEWPOINTS.filter(function (x) { return x.id === id; })[0]; if (!v) return;
    S.layers = new Set(v.layers); S.scope = v.scope; S.sel = null; S.trace = null; dismissStart();
    closeInspectorPanels(); go('canvas', true); refreshScope(true);
    toast('Viewpoint applied: ' + v.label + ' · ' + scoped().entities.length + ' entities', { icon: 'check' });
  }

  /* =============================================================================
     Command palette (search + entity picker)
     ========================================================================== */
  var cmd = { mode: 'search', role: 'from', items: [], active: 0 };
  function openSearch(mode, role) {
    cmd.mode = mode || 'search'; cmd.role = role || 'from';
    $('#cmdInput').value = '';
    $('#cmdInput').placeholder = cmd.mode === 'pick' ? (cmd.role === 'from' ? 'Choose a source entity…' : 'Choose a target entity…') : 'Search entities, views and actions…';
    openDialog('search');
    renderCmd('');
    if (!S.embed) { $('#cmdInput').focus(); }
  }
  function cmdItems(q) {
    q = q.trim();
    var out = [];
    var hits = q ? M.search(q, M.entities, 7).map(function (h) { return h.entity; })
                 : M.entities.filter(function (e) { return e.m && e.m[0] === 'core'; }).slice(0, 5);
    if (hits.length) {
      out.push({ group: q ? 'Entities' : 'OpenDEA Core anchors' });
      hits.forEach(function (e) {
        out.push({ type: 'entity', id: e.a, html: tag(e.a) + '<span class="cmd__item-name">' + esc(e.n) + '</span><span class="cmd__item-meta">' + M.layerById[e.l].code + '</span><span class="kbd">↵</span>' });
      });
    }
    if (cmd.mode !== 'pick') {
      var ql = q.toLowerCase();
      var match = function (s) { return !q || s.toLowerCase().indexOf(ql) >= 0; };
      var views = M.VIEWS.filter(function (v) { return match(VIEW_META[v][0]) || match(VIEW_META[v][2]); });
      var acts = [['export', 'Export…', 'SVG, PNG, JSON or PlantUML', 'download', 'E'], ['share', 'Share a link to this view', 'State lives in the URL', 'link', 'S'],
                  ['fit', 'Fit the canvas to the view', 'Zoom', 'maximize', '0'], ['legend', 'Show the legend', 'Lanes and relationships', 'layers', 'L'],
                  ['keys', 'Keyboard shortcuts', 'Help', 'circle-help', '?']].filter(function (a) { return match(a[1]) || match(a[2]); });
      if (views.length) {
        out.push({ group: 'Go to' });
        views.forEach(function (v) { out.push({ type: 'view', id: v, html: icon(VIEW_META[v][1]) + '<span class="cmd__item-name">' + esc(VIEW_META[v][0]) + '</span><span class="cmd__item-meta">' + esc(VIEW_META[v][2]) + '</span><span class="kbd">↵</span>' }); });
      }
      if (acts.length) {
        out.push({ group: 'Actions' });
        acts.forEach(function (a) { out.push({ type: 'action', id: a[0], html: icon(a[3]) + '<span class="cmd__item-name">' + esc(a[1]) + '</span><span class="cmd__item-meta">' + esc(a[2]) + '</span><span class="kbd">' + a[4] + '</span>' }); });
      }
    }
    if (!out.length) out.push({ group: '', type: 'none', html: '<div class="empty" style="padding:20px 8px"><div class="empty__title" style="font-size:13px">No matches for “' + esc(q) + '”</div><p class="empty__text" style="font-size:12px">Try an alias such as <span class="mono">CAP</span> or part of a description.</p></div>' });
    return out;
  }
  function renderCmd(q) {
    cmd.items = cmdItems(q);
    cmd.active = cmd.items.findIndex(function (it) { return it.type && it.type !== 'none'; });
    $('#cmdList').innerHTML = cmd.items.map(function (it, i) {
      if (!it.type) return '<div class="cmd__group overline">' + esc(it.group) + '</div>';
      return '<button class="cmd__item' + (i === cmd.active ? ' is-active' : '') + '" role="option" aria-selected="' + (i === cmd.active) + '" data-cmd="' + i + '">' + it.html + '</button>';
    }).join('');
    var act = $('#cmdList .is-active'); if (act) act.scrollIntoView({ block: 'nearest' });
  }
  function cmdPick(i) {
    var it = cmd.items[i]; if (!it || !it.type || it.type === 'none') return;
    closeDialog($('#dlgSearch'));
    if (it.type === 'entity') {
      if (cmd.mode === 'pick') { setPair(cmd.role === 'from' ? it.id : S.from, cmd.role === 'to' ? it.id : S.to); return; }
      select(it.id); C.zoomToEntity(it.id);
    } else if (it.type === 'view') go(it.id);
    else if (it.id === 'fit') { go('canvas'); C.fit(true); }
    else if (it.id === 'legend') { go('canvas'); openPopover('legend', $('[data-action="legend"]')); }
    else openDialog(it.id);
  }

  /* =============================================================================
     Dialogs & popovers
     ========================================================================== */
  var DIALOGS = { search: '#dlgSearch', export: '#dlgExport', share: '#dlgShare', keys: '#dlgKeys', more: '#dlgMore', filters: '#dlgFilters' };
  function buildScrim() { var d = document.createElement('div'); d.className = 'scrim'; d.setAttribute('aria-hidden', 'true'); document.body.appendChild(d); }
  function scrim(on) { $('.scrim').classList.toggle('is-on', !!on && S.embed); }

  function openDialog(name) {
    var el = $(DIALOGS[name]); if (!el) return;
    closePopovers(); hideTip();
    if (name === 'share') renderShare();
    if (name === 'export') renderExport();
    if (name === 'filters') renderFiltersSheet();
    if (name === 'more') renderMoreSheet();
    if (S.embed) { el.setAttribute('open', ''); scrim(true); }
    else if (!el.open) el.showModal();
    S.dialog = name; syncUrl();
  }
  function closeDialog(el) {
    if (!el) return;
    if (S.embed) { el.removeAttribute('open'); scrim(false); }
    else if (el.open) el.close();
    if (S.dialog && DIALOGS[S.dialog] === '#' + el.id) S.dialog = null;
    syncUrl();
  }

  /* ---------- export ------------------------------------------------------- */
  var EX = { format: 'svg', scope: 'filtered', legend: true, fonts: true };
  function buildExport() {
    $('#exportFormats').innerHTML = [['svg', 'SVG', 'Vector · opens anywhere', 'shapes'], ['png', 'PNG', 'Raster · 2× for slides', 'image'],
                                     ['json', 'JSON', 'Scoped graph + provenance', 'file-json'], ['puml', 'PlantUML', 'Re-renderable source', 'file-code']].map(function (f) {
      return '<button class="optcard" role="radio" aria-checked="' + (EX.format === f[0]) + '" data-ex="format" data-val="' + f[0] + '"><span class="optcard__icon">' + icon(f[3]) +
        '</span><span class="optcard__name">' + f[1] + '</span><span class="optcard__desc">' + f[2] + '</span></button>';
    }).join('');
    $('#exportScope').innerHTML = [['filtered', 'Current scope'], ['all', 'Entire model'], ['selection', 'Selection + neighbours']].map(function (s) {
      return '<label class="optradio"><input type="radio" name="exscope" value="' + s[0] + '"' + (EX.scope === s[0] ? ' checked' : '') + '><span>' + s[1] + '</span></label>';
    }).join('');
    $('#exportOptions').innerHTML = [['legend', 'Include legend'], ['fonts', 'Embed fonts']].map(function (o) {
      return '<label class="optcheck"><button class="switch" role="switch" aria-checked="' + EX[o[0]] + '" data-ex="' + o[0] + '" aria-label="' + o[1] + '"></button>' + o[1] + '</label>';
    }).join('');
  }
  function exportData() {
    if (EX.scope === 'all') return { entities: M.entities, rels: M.rels };
    if (EX.scope === 'selection' && S.sel) {
      var keep = {}; keep[S.sel] = true;
      M.rels.forEach(function (r) { if (r.f === S.sel || r.t === S.sel) keep[r.f] = keep[r.t] = true; });
      return { entities: M.entities.filter(function (e) { return keep[e.a]; }), rels: M.rels.filter(function (r) { return keep[r.f] && keep[r.t]; }) };
    }
    return scoped();
  }
  function renderExport() {
    var sc = exportData(), sel = $('input[name="exscope"][value="selection"]');
    if (sel) sel.disabled = !S.sel;
    $('#exportSummary').textContent = sc.entities.length + ' entities · ' + sc.rels.length + ' relationships';
    $('#exportGoLabel').textContent = 'Export ' + EX.format.toUpperCase();
    $$('[data-ex]').forEach(function (b) {
      var k = b.getAttribute('data-ex');
      b.setAttribute(k === 'format' ? 'aria-checked' : 'aria-checked', String(k === 'format' ? b.getAttribute('data-val') === EX.format : EX[k]));
    });
    $$('.optradio').forEach(function (l) { l.classList.toggle('is-off', l.querySelector('input').disabled); });
  }
  /** Embed the Geist faces so the file looks right on machines without them. */
  function fontCss() {
    if (fontCss.cache !== undefined) return Promise.resolve(fontCss.cache);
    return Promise.all(['assets/fonts/geist-latin.woff2', 'assets/fonts/geist-mono-latin.woff2'].map(function (u) {
      return fetch(u).then(function (r) { return r.arrayBuffer(); });
    })).then(function (bufs) {
      function b64(buf) { var bin = '', b = new Uint8Array(buf); for (var i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(bin); }
      fontCss.cache = "@font-face{font-family:Geist;src:url(data:font/woff2;base64," + b64(bufs[0]) + ") format('woff2')}" +
                      "@font-face{font-family:'Geist Mono';src:url(data:font/woff2;base64," + b64(bufs[1]) + ") format('woff2')}";
      return fontCss.cache;
    }).catch(function () { fontCss.cache = ''; return ''; });
  }
  function download(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }
  function runExport() {
    var data = exportData(), name = 'dea-' + M.slugify(EX.scope === 'filtered' ? (S.scope ? M.scopeLabel(S.scope) : 'all') : EX.scope);
    var done = function (what) { closeDialog($('#dlgExport')); toast('Exported ' + what, { icon: 'check' }); };
    if (EX.format === 'json') {
      download(new Blob([JSON.stringify(M.buildJsonExport(data, { url: location.href, scope: S.scope, layers: Array.from(S.layers) }), null, 2)], { type: 'application/json' }), name + '.json');
      return done(data.entities.length + ' entities and ' + data.rels.length + ' relationships as JSON');
    }
    if (EX.format === 'puml') {
      download(new Blob([M.buildPumlExport(data, { scope: S.scope })], { type: 'text/plain' }), name + '.puml');
      return done(data.entities.length + ' entities as PlantUML');
    }
    // SVG and PNG are drawings of the canvas, so the canvas is scoped to the export set for the moment.
    var live = scoped(), other = EX.scope !== 'filtered';
    if (other) C.setScope(data, { zoom: 'fit', instant: true });
    fontCss().then(function (css) {
      var svgText = C.buildSvgExport({ fontCss: EX.fonts ? css : '', legend: EX.legend });
      if (EX.format === 'svg') { download(new Blob([svgText], { type: 'image/svg+xml' }), name + '.svg'); return done(data.entities.length + ' entities as SVG'); }
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () {
          var c = document.createElement('canvas'); c.width = img.width * 2; c.height = img.height * 2;
          var ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
          c.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error('rasterise failed')); }, 'image/png');
        };
        img.onerror = function () { reject(new Error('SVG rasterise failed')); };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
      }).then(function (blob) { download(blob, name + '.png'); done(data.entities.length + ' entities as PNG'); },
              function () { toast('PNG export is unavailable here — use SVG instead', { icon: 'info' }); });
    }).then(function () { if (other) C.setScope(live, { zoom: 'fit', instant: true }); });
  }

  /* ---------- share -------------------------------------------------------- */
  var SH = { view: true, filters: true, selection: true };
  function shareState() {
    var st = {};
    if (SH.view) st.view = S.view;
    if (SH.filters) { st.layers = S.layers; st.scope = S.scope; }
    if (SH.selection && S.sel) { st.entity = S.sel; st.trace = S.trace || undefined; st.tab = S.tab; }
    if (SH.view && S.view === 'trace') { st.from = S.from; st.to = S.to; }
    return st;
  }
  function renderShare() {
    $('#shareOptions').innerHTML = [['view', 'Current view'], ['filters', 'Layer and scope filters'], ['selection', 'Selected entity']].map(function (o) {
      var off = o[0] === 'selection' && !S.sel;
      return '<label class="optcheck"' + (off ? ' style="opacity:.45"' : '') + '><button class="switch" role="switch" aria-checked="' + (SH[o[0]] && !off) + '" data-sh="' + o[0] + '"' +
        (off ? ' disabled' : '') + ' aria-label="' + o[1] + '"></button>' + o[1] + '</label>';
    }).join('');
    $('#shareUrl').value = location.origin + location.pathname + '?' + M.serialize(shareState());
  }
  function copyText(text, msg) {
    var ok = function () { toast(msg, { icon: 'check' }); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, function () { fallbackCopy(text); ok(); });
    else { fallbackCopy(text); ok(); }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e) { /* best-effort */ } ta.remove();
  }

  /* ---------- static dialog content ---------------------------------------- */
  function buildKeys() {
    var groups = [
      ['Navigate', [['Search anything', ['⌘', 'K']], ['Open the legend', ['L']], ['Keyboard shortcuts', ['?']], ['Export', ['E']], ['Share link', ['S']], ['Close or clear selection', ['Esc']]]],
      ['Canvas', [['Zoom in · out', ['+', '−']], ['Fit to view', ['0']], ['Pan', ['Drag']], ['Zoom at the pointer', ['Scroll']], ['Focus a lane', ['Click a lane label']], ['Zoom to an entity', ['Double-click']], ['Trace impact', ['T']]]]
    ];
    $('#keysGrid').innerHTML = groups.map(function (g) {
      return '<div class="keys__group"><h3 class="overline" style="margin-bottom:8px">' + g[0] + '</h3>' + g[1].map(function (k) {
        return '<div class="keyrow"><span>' + esc(k[0]) + '</span><span class="keyrow__keys">' + k[1].map(function (x) { return '<span class="kbd">' + esc(x) + '</span>'; }).join('') + '</span></div>';
      }).join('') + '</div>';
    }).join('');
  }
  function buildLegend() {
    $('#popLegend').innerHTML =
      '<div class="overline" style="margin-bottom:6px">Lanes</div>' + M.layers.map(function (l) {
        return '<div class="leg__row"><span class="leg__dot" style="--sw:var(--layer-' + li(l.id) + ')"></span><span class="mono" style="font-size:11px;color:var(--layer-' + li(l.id) + '-ink)">' + l.code + '</span>' + esc(l.name) + '<span class="menu__count">' + LAYER_COUNTS[l.id] + '</span></div>'; }).join('') +
      '<div class="leg__group"><div class="overline" style="margin-bottom:6px">Relationships</div>' +
      [['behavioral', 'solid', 'Behavioural — realizes, serves', 'var(--edge-behavioral)'], ['structural', 'solid', 'Structural — composed of', 'var(--edge-structural)'],
       ['governance', 'dashed', 'Governance — steers', 'var(--edge-governance)'], ['coupling', 'dashed', 'Coupling — depends on', 'var(--edge-coupling)'],
       ['derived', 'dotted', 'Specializes — derived', 'var(--edge-derived)']].map(function (e) {
        return '<div class="leg__row"><span class="leg__line" style="--lc:' + e[3] + '" data-dash="' + e[1] + '"></span>' + esc(e[2]) + '</div>'; }).join('') + '</div>' +
      '<div class="leg__group"><div class="overline" style="margin-bottom:6px">Impact trace</div>' +
      '<div class="leg__row"><span class="leg__dot" style="--sw:var(--trace-up)"></span>Upstream — what drives it</div>' +
      '<div class="leg__row"><span class="leg__dot" style="--sw:var(--trace-down)"></span>Downstream — what it affects</div></div>';
  }

  /* ---------- sheets (mobile) ---------------------------------------------- */
  function renderMoreSheet() {
    $('#moreBody').innerHTML = '<div class="overline" style="padding:4px 12px 8px">Views</div>' + M.VIEWS.map(function (v) {
      return '<button class="menu__item" data-nav-go="' + v + '">' + icon(VIEW_META[v][1]) + '<span>' + esc(VIEW_META[v][0]) + '</span>' +
        (S.view === v ? '<span class="menu__check" style="margin-left:auto">' + icon('check') + '</span>' : '') + '</button>';
    }).join('') + '<div class="menu__sep"></div><div class="overline" style="padding:8px 12px 4px">Actions</div>' +
      '<button class="menu__item" data-action="export">' + icon('download') + '<span>Export</span></button>' +
      '<button class="menu__item" data-action="share">' + icon('link') + '<span>Share link</span></button>' +
      '<button class="menu__item" data-action="keys">' + icon('keyboard') + '<span>Keyboard shortcuts</span></button>' +
      '<div class="sheet__sync"><div class="sync">' + icon('database') + '<div><div class="sync__title">Synced · metamodel 1.0.0</div><div class="sync__sub">' + M.entities.length + ' entities · ' + M.rels.length + ' relationships</div></div></div></div>';
  }
  function renderFiltersSheet() {
    $('#filtersBody').innerHTML = '<div class="overline" style="margin-bottom:8px">Layers</div><div class="chipcloud" style="margin-bottom:20px">' + M.layers.map(function (l) {
      return '<button class="chip chip--toggle chip--lg" data-action="layer" data-layer="' + l.id + '" data-dot="' + l.id + '" aria-pressed="' + S.layers.has(l.id) + '"><span class="chip__dot"></span>' +
        l.code + ' · ' + esc(l.name) + '<span class="chip__count">' + LAYER_COUNTS[l.id] + '</span></button>';
    }).join('') + '</div><div class="overline" style="margin-bottom:8px">Scope</div><div class="chipcloud">' +
      [{ key: null, label: 'All', count: M.entities.length }].concat(M.scopeGroups).map(function (g) {
        return '<button class="chip chip--select chip--lg" data-action="scope-set" data-scope="' + esc(g.key || '') + '" aria-pressed="' + (S.scope === g.key) + '">' + esc(g.label) + '<span class="chip__count">' + g.count + '</span></button>';
      }).join('') + '</div>';
  }

  /* ---------- popovers ----------------------------------------------------- */
  var pop = null;
  function positionPopover(el, anchor) {
    el.hidden = false;
    var a = anchor.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight, pad = 8;
    var left = Math.min(Math.max(pad, a.right - w), window.innerWidth - w - pad);
    var top = a.bottom + 6; if (top + h > window.innerHeight - pad) top = Math.max(pad, a.top - h - 6);
    el.style.left = Math.round(left) + 'px'; el.style.top = Math.round(top) + 'px';
  }
  function openPopover(name, anchor) {
    closePopovers();
    var el = $({ legend: '#popLegend', scope: '#popScope' }[name]); if (!el || !anchor) return;
    if (name === 'scope') {
      el.innerHTML = '<div class="overline menu__label">Membership scope</div>' + [{ key: null, label: 'All memberships', count: M.entities.length }].concat(M.scopeGroups).map(function (g) {
        return '<button class="menu__item" role="menuitemradio" aria-checked="' + (S.scope === g.key) + '" data-action="scope-set" data-scope="' + esc(g.key || '') + '"><span class="menu__check">' +
          (S.scope === g.key ? icon('check') : '') + '</span><span>' + esc(g.label) + '</span><span class="menu__count">' + g.count + '</span></button>';
      }).join('');
    }
    positionPopover(el, anchor);
    pop = { name: name, el: el, anchor: anchor };
    anchor.setAttribute('aria-expanded', 'true');
  }
  function togglePopover(name, anchor) { if (pop && pop.name === name) closePopovers(); else openPopover(name, anchor); }
  function closePopovers() {
    if (!pop) return;
    pop.el.hidden = true; pop.anchor.setAttribute('aria-expanded', 'false'); pop = null;
  }

  /* ---------- tooltip ------------------------------------------------------ */
  var tip = { timer: 0, target: null, el: null };
  function initTooltip() {
    tip.el = $('#tooltip');
    document.addEventListener('pointerover', function (e) {
      if ((e.pointerType && e.pointerType !== 'mouse') || S.embed) return;
      var t = e.target.closest && e.target.closest('[data-tip]');
      if (!t) return;
      clearTimeout(tip.timer); tip.target = t;
      tip.timer = setTimeout(function () { if (tip.target === t) showTip(t); }, 320);
    });
    document.addEventListener('pointerout', function (e) { hideTip(); }, true);
    window.addEventListener('scroll', hideTip, true);
    document.addEventListener('pointerdown', hideTip, true);
  }
  function showTip(t) {
    var a = t.getBoundingClientRect(), el = tip.el;
    el.textContent = t.getAttribute('data-tip'); el.hidden = false;
    var w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.round(Math.min(Math.max(8, a.left + a.width / 2 - w / 2), window.innerWidth - w - 8)) + 'px';
    el.style.top = Math.round(a.bottom + 8 + h > window.innerHeight - 8 ? a.top - h - 8 : a.bottom + 8) + 'px';
  }
  function hideTip() { clearTimeout(tip.timer); tip.target = null; if (tip.el) tip.el.hidden = true; }

  /* ---------- toast -------------------------------------------------------- */
  var toastTimer = 0;
  function toast(msg, opts) {
    opts = opts || {};
    var old = $('.toast'); if (old) old.remove();
    var open = $$('dialog[open]'), host = open.length ? open[open.length - 1] : document.body;
    var el = document.createElement('div');
    el.className = 'toast'; el.setAttribute('role', 'status');
    el.innerHTML = icon(opts.icon || 'check') + '<span class="toast__text">' + esc(msg) + '</span>' + (opts.action ? '<button class="toast__action">' + esc(opts.action.label) + '</button>' : '');
    host.appendChild(el);
    if (host.classList.contains('sheet')) el.style.bottom = (host.querySelector('.sheet__panel').offsetHeight + 16) + 'px';
    if (opts.action) el.querySelector('.toast__action').addEventListener('click', function () { opts.action.fn(); el.remove(); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.remove(); }, opts.action ? 6000 : 3200);
  }

  /* =============================================================================
     Events
     ========================================================================== */
  function bind() {
    initTooltip();
    document.addEventListener('pointerdown', function (e) {
      if (pop && !e.target.closest('.menu') && !pop.anchor.contains(e.target)) closePopovers();
    });
    document.addEventListener('click', function (e) {
      var t = e.target;
      var navGo = t.closest('[data-nav-go]');
      if (navGo) { closeDialog($('#dlgMore')); go(navGo.getAttribute('data-nav-go')); return; }
      var nav = t.closest('[data-nav]');
      if (nav) { e.preventDefault(); go(nav.getAttribute('data-nav')); return; }
      var closer = t.closest('[data-close]');
      if (closer) { closeDialog(closer.closest('dialog')); return; }
      var cmdEl = t.closest('[data-cmd]');
      if (cmdEl) { cmdPick(parseInt(cmdEl.getAttribute('data-cmd'), 10)); return; }
      var ex = t.closest('[data-ex]');
      if (ex) {
        var k = ex.getAttribute('data-ex');
        if (k === 'format') EX.format = ex.getAttribute('data-val'); else EX[k] = ex.getAttribute('aria-checked') !== 'true';
        renderExport(); return;
      }
      var sh = t.closest('[data-sh]');
      if (sh && !sh.disabled) { SH[sh.getAttribute('data-sh')] = sh.getAttribute('aria-checked') !== 'true'; renderShare(); return; }
      var act = t.closest('[data-action]');
      if (act) run(act.getAttribute('data-action'), act, e);
    });
    document.addEventListener('change', function (e) {
      var t = e.target;
      if (t.name === 'exscope') { EX.scope = t.value; renderExport(); }
      if (t.id === 'catLayer') { S.flayer = t.value; renderCatalogs(); syncUrl(); }
      if (t.id === 'catStatus') { S.fstatus = t.value; renderCatalogs(); syncUrl(); }
    });
    document.addEventListener('input', function (e) {
      if (e.target.id === 'cmdInput') renderCmd(e.target.value);
      if (e.target.id === 'catQ') { S.q = e.target.value; var pos = e.target.selectionStart; renderCatalogs(); var q = $('#catQ'); q.focus(); try { q.setSelectionRange(pos, pos); } catch (err) { /* n/a */ } syncUrl(); }
    });
    document.addEventListener('keydown', onKeyDown);
    $$('.dialog, .sheet').forEach(function (d) {
      d.addEventListener('close', function () { if (S.dialog && DIALOGS[S.dialog] === '#' + d.id) S.dialog = null; scrim(false); syncUrl(); });
      d.addEventListener('click', function (ev) {                        // click on the backdrop closes
        if (!d.open || S.embed || ev.target !== d) return;
        var r = (d.querySelector('.dialog__panel') || d.querySelector('.sheet__panel')).getBoundingClientRect();
        if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) closeDialog(d);
      });
    });
    // The mobile inspector sheet: tap toggles, drag down collapses or dismisses, drag up expands.
    (function () {
      var zone = $('#sheetGrab'), startY = 0, live = false;
      zone.addEventListener('pointerdown', function (e) { startY = e.clientY; live = true; zone.setPointerCapture(e.pointerId); });
      zone.addEventListener('pointerup', function (e) {
        if (!live) return; live = false;
        var d = $('#dlgSheet'), dy = e.clientY - startY, expanded = d.classList.contains('is-expanded');
        if (dy < -28) d.classList.add('is-expanded');
        else if (dy > 28) { if (expanded) d.classList.remove('is-expanded'); else select(null); }
        else d.classList.toggle('is-expanded');
      });
    })();
    // The plan page toggles whether an embedded frame accepts input.
    window.addEventListener('message', function (e) {
      if (!e.data || e.data.type !== 'dea-embed') return;
      var interactive = !!e.data.interactive, openName = S.dialog;
      if (interactive === !S.embed) return;
      if (openName) closeDialog($(DIALOGS[openName]));
      S.embed = !interactive;
      if (openName) openDialog(openName); else syncUrl();
    });
  }

  function onKeyDown(e) {
    if (e.target.id === 'cmdInput') {
      var idx = cmd.items.map(function (it, i) { return it.type && it.type !== 'none' ? i : -1; }).filter(function (i) { return i >= 0; });
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); if (!idx.length) return;
        cmd.active = idx[(idx.indexOf(cmd.active) + (e.key === 'ArrowDown' ? 1 : idx.length - 1)) % idx.length];
        $$('#cmdList .cmd__item').forEach(function (n) { n.classList.toggle('is-active', parseInt(n.getAttribute('data-cmd'), 10) === cmd.active); });
        var act = $('#cmdList .is-active'); if (act) act.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') { e.preventDefault(); cmdPick(cmd.active); }
      return;
    }
    if (e.key === 'Escape') {
      if (pop) { closePopovers(); return; }
      if (anyDialogOpen() || isTyping(e)) return;
      if (S.sel) select(null);
      return;
    }
    if (isTyping(e) || anyDialogOpen() || e.altKey) return;
    var mod = e.metaKey || e.ctrlKey;
    if (mod) { if (e.key === 'k' || e.key === 'K') { e.preventDefault(); openSearch('search'); } return; }
    switch (e.key) {
      case '/': e.preventDefault(); openSearch('search'); break;
      case '?': e.preventDefault(); openDialog('keys'); break;
      case 'e': case 'E': openDialog('export'); break;
      case 's': case 'S': openDialog('share'); break;
      case 'l': case 'L': if (S.view === 'canvas') togglePopover('legend', $('[data-action="legend"]')); break;
      case '0': if (S.view === 'canvas') { dismissStart(); C.fit(true); } break;
      case '+': case '=': if (S.view === 'canvas') { dismissStart(); C.zoomBy(1.25); } break;
      case '-': case '_': if (S.view === 'canvas') { dismissStart(); C.zoomBy(.8); } break;
      case 't': case 'T': if (S.sel) runTrace(S.sel); break;
    }
  }

  function run(action, el) {
    if (/^(zoom-in|zoom-out|fit|layer|scope-set|reset-filters|scope-core)$/.test(action)) dismissStart();
    switch (action) {
      case 'rail':
        if (mqTablet.matches) S.railOverlay = !S.railOverlay;
        else { S.rail = S.rail === 'compact' ? 'expanded' : 'compact'; try { sessionStorage.setItem('dea.rail', S.rail); } catch (err) { /* optional */ } }
        applyRail(); syncUrl(); break;
      case 'search': openSearch('search'); break;
      case 'export': openDialog('export'); break;
      case 'share': openDialog('share'); break;
      case 'keys': openDialog('keys'); break;
      case 'more': openDialog('more'); break;
      case 'filters': openDialog('filters'); break;
      case 'zoom-in': C.zoomBy(1.25); break;
      case 'zoom-out': C.zoomBy(.8); break;
      case 'fit': C.fit(true); break;
      case 'legend': togglePopover('legend', el); break;
      case 'scope': togglePopover('scope', el); break;
      case 'scope-set': setScope(el.getAttribute('data-scope') || null); break;
      case 'layer': toggleLayer(el.getAttribute('data-layer')); break;
      case 'reset-filters': resetFilters(); break;
      case 'dismiss-start': dismissStart(); syncUrl(); break;
      case 'scope-core': setScope('core'); break;
      case 'goto-trace': dismissStart(); go('trace'); break;
      case 'goto-viewpoints': dismissStart(); go('viewpoints'); break;
      case 'close-inspector': select(null); break;
      case 'tab': S.tab = el.getAttribute('data-tab'); renderInspector(); syncUrl(); break;
      case 'trace': if (S.sel) runTrace(S.sel); break;
      case 'open-entity': { var id = el.getAttribute('data-id'); select(id); C.zoomToEntity(id); break; }
      case 'copy-link': {
        var st = { entity: S.sel, trace: S.trace || undefined, tab: S.tab };
        copyText(location.origin + location.pathname + '?' + M.serialize(st), 'Link copied — opens ' + M.byId[S.sel].n);
        break;
      }
      case 'copy-share': copyText($('#shareUrl').value, 'Link copied'); break;
      case 'export-go': runExport(); break;
      case 'cell': S.cell = S.cell === el.getAttribute('data-cell') ? null : el.getAttribute('data-cell'); renderMatrix(); syncUrl(); break;
      case 'pick': openSearch('pick', el.getAttribute('data-role')); break;
      case 'pick-id': setPair(S.from, el.getAttribute('data-id')); break;
      case 'swap': setPair(S.to, S.from); break;
      case 'preset': setPair(el.getAttribute('data-from'), el.getAttribute('data-to')); break;
      case 'show-path': {
        var p = M.shortestPath(S.from, S.to); if (!p) break;
        var hops = {}; p.nodes.forEach(function (a, i) { if (i) hops[a] = i; });
        var onPath = {}; p.rels.forEach(function (r) { onPath[r.id] = true; });
        S.sel = S.from; S.tab = 'impact';
        S.trace = { source: S.from, up: {}, down: hops, upEdges: [], downEdges: M.rels.filter(function (r) { return onPath[r.id]; }) };
        go('canvas'); C.setSelection(S.from, S.trace); openInspector(); renderInspector(); C.zoomToEntity(S.from); syncUrl();
        break;
      }
      case 'vp-apply': applyViewpoint(el.getAttribute('data-id')); break;
      case 'vp-link': {
        var v = M.VIEWPOINTS.filter(function (x) { return x.id === el.getAttribute('data-id'); })[0];
        copyText(location.origin + location.pathname + '?' + M.serialize({ layers: new Set(v.layers), scope: v.scope }), 'Link copied — ' + v.label + ' viewpoint');
        break;
      }
      case 'cat-clear': S.q = ''; S.flayer = ''; S.fstatus = ''; renderCatalogs(); syncUrl(); break;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(window.DEA);
