/* =============================================================================
   app-canvas.js — the white canvas: lane layout, edge routing, pan/zoom,
   semantic zoom (overview → names → detail) and minimap.

   Layout model
     · One lane per architecture layer (L1…L6), stacked top to bottom.
     · Inside a lane, entities are ordered so that related ones sit next to
       each other (greedy clustering over intra-lane relationships), then
       wrapped into rows. The column count is chosen per viewport to
       maximise the fit scale.
     · Edges are orthogonal and travel only in the gutters: horizontal in
       the corridor between rows, vertical in the street between columns.
       Specialisation edges ("A specializes B") use the corridor *under*
       the row so they never hide under a typed relationship.

   View ownership
     Only one tween owns the view at a time (cv.animToken). When a tier
     change re-flows the layout mid-tween, the anchor shift is applied to
     the tween's endpoints rather than starting a competing animation.
   ========================================================================== */
window.DEA = window.DEA || {};
(function (DEA) {
  'use strict';

  var M = DEA.model;
  var SVGNS = 'http://www.w3.org/2000/svg';
  var HTMLNS = 'http://www.w3.org/1999/xhtml';

  function svg(tag, attrs, parent) {
    var n = document.createElementNS(SVGNS, tag);
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function ease(t) { return 1 - Math.pow(1 - t, 3); }
  function f(n) { return Math.round(n * 10) / 10; }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function cx(p) { return p.x + p.w / 2; }
  function cy(p) { return p.y + p.h / 2; }

  var CAN_ANIMATE_D = false;
  try { CAN_ANIMATE_D = window.CSS && CSS.supports('d', 'path("M0 0")'); } catch (e) { /* optional */ }

  /* ---------- geometry tokens ---------------------------------------------- */
  var G = {};
  var COL_CHOICES = [3, 4, 5, 6, 7, 8, 9, 11];
  function readGeometry() {
    var cs = getComputedStyle(document.documentElement);
    function n(name, fb) { var v = parseFloat(cs.getPropertyValue(name)); return isNaN(v) ? fb : v; }
    G = {
      cw: n('--cv-card-w', 180), ch: n('--cv-card-h', 44), chd: n('--cv-card-h-detail', 112),
      colGap: n('--cv-col-gap', 40), rowGap: n('--cv-row-gap', 24), head: n('--cv-lane-head', 30),
      padX: n('--cv-lane-pad-x', 16), padB: n('--cv-lane-pad-b', 12), laneGap: n('--cv-lane-gap', 36),
      margin: n('--cv-margin', 32), fitPad: n('--cv-fit-pad', .96),
      tNames: n('--cv-tier-names', .7), tDetail: n('--cv-tier-detail', 1.35),
      zMin: n('--cv-zoom-min', .12), zMax: n('--cv-zoom-max', 3)
    };
  }
  function cardHeight(tier) { return tier === 'detail' ? G.chd : G.ch; }

  /* =============================================================================
     Layout
     ========================================================================== */
  function orderLane(ids, rels) {
    var inLane = {}, W = {};
    ids.forEach(function (a) { inLane[a] = true; });
    var key = function (a, b) { return a < b ? a + '|' + b : b + '|' + a; };
    rels.forEach(function (r) {
      if (inLane[r.f] && inLane[r.t]) {
        var k = key(r.f, r.t);
        W[k] = (W[k] || 0) + (r.cat === 'derived' ? 1.5 : 1);
      }
    });
    var w = function (a, b) { return W[key(a, b)] || 0; };
    var rest = ids.slice().sort(function (a, b) { return M.degree(b) - M.degree(a) || a.localeCompare(b); });
    var out = [rest.shift()];
    while (rest.length) {
      var last = out[out.length - 1], best = rest[0], bestScore = -Infinity;
      rest.forEach(function (q) {
        var s = w(last, q) * 4, i;
        for (i = Math.max(0, out.length - 4); i < out.length - 1; i++) s += w(out[i], q);
        s = s * 1000 + M.degree(q);                    // ties → busier entity, then alphabetical
        if (s > bestScore) { bestScore = s; best = q; }
      });
      out.push(best); rest.splice(rest.indexOf(best), 1);
    }
    return out;
  }

  function computeLayout(sc, maxCols, cardH) {
    var byLane = {};
    M.layers.forEach(function (l) { byLane[l.id] = []; });
    sc.entities.forEach(function (e) { byLane[e.l].push(e.a); });
    var laneIds = M.layers.map(function (l) { return l.id; }).filter(function (id) { return byLane[id].length; });
    var x0 = G.margin, y = G.margin, lanes = [], nodes = {}, widest = 0;
    laneIds.forEach(function (id, li) {
      var ordered = orderLane(byLane[id], sc.rels);
      var rows = Math.max(1, Math.ceil(ordered.length / maxCols));
      var cols = Math.max(1, Math.ceil(ordered.length / rows));
      var isLast = li === laneIds.length - 1;
      var rowsTop = y + G.head;
      var h = G.head + rows * cardH + (rows - 1) * G.rowGap + G.padB;
      var w = G.padX * 2 + cols * G.cw + (cols - 1) * G.colGap;
      ordered.forEach(function (a, i) {
        var r = Math.floor(i / cols), c = i % cols;
        nodes[a] = {
          a: a, x: x0 + G.padX + c * (G.cw + G.colGap), y: rowsTop + r * (cardH + G.rowGap),
          w: G.cw, h: cardH, row: r, col: c, rows: rows, cols: cols, lane: id, laneIndex: li,
          gapAbove: r > 0 ? G.rowGap : G.head,
          gapBelow: r < rows - 1 ? G.rowGap : G.padB + (isLast ? 0 : G.laneGap + G.head)
        };
      });
      lanes.push({ layer: M.layerById[id], x: x0, y: y, w: w, h: h, rows: rows, cols: cols, count: ordered.length, ids: ordered });
      widest = Math.max(widest, w);
      y += h + G.laneGap;
    });
    return {
      nodes: nodes, lanes: lanes, cardH: cardH, cols: maxCols,
      width: widest + G.margin * 2,
      height: (lanes.length ? y - G.laneGap : 0) + G.margin * 2
    };
  }

  /** Routing direction + port fractions. A relationship is in exactly one
      exit group and one entry group, so pOut / pIn never collide. */
  function computePorts(sc, L) {
    var groups = { downOut: {}, upOut: {}, topIn: {}, botIn: {} };
    function add(map, a, r) { (map[a] = map[a] || []).push(r); }
    sc.rels.forEach(function (r) {
      var a = L.nodes[r.f], b = L.nodes[r.t];
      if (!a || !b) return;
      if (a.y === b.y) {                                      // same row
        if (r.cat === 'derived') { r.dir = 'sameBottom'; add(groups.downOut, r.f, r); add(groups.botIn, r.t, r); }
        else { r.dir = 'sameTop'; add(groups.upOut, r.f, r); add(groups.topIn, r.t, r); }
      } else if (b.y > a.y) { r.dir = 'down'; add(groups.downOut, r.f, r); add(groups.topIn, r.t, r); }
      else { r.dir = 'up'; add(groups.upOut, r.f, r); add(groups.botIn, r.t, r); }
    });
    function assign(map, prop, other) {
      Object.keys(map).forEach(function (a) {
        map[a].sort(function (p, q) { return other(p) - other(q); });
        map[a].forEach(function (r, i) { r[prop] = (i + 1) / (map[a].length + 1); });
      });
    }
    assign(groups.downOut, 'pOut', function (r) { return L.nodes[r.t].x; });
    assign(groups.upOut, 'pOut', function (r) { return L.nodes[r.t].x; });
    assign(groups.topIn, 'pIn', function (r) { return L.nodes[r.f].x; });
    assign(groups.botIn, 'pIn', function (r) { return L.nodes[r.f].x; });
  }

  /** Always the same six commands (M V H V H V) so `d` can be tweened. */
  function edgePath(r, L) {
    var a = L.nodes[r.f], b = L.nodes[r.t];
    var x0 = a.x + a.w * r.pOut, x1 = b.x + b.w * r.pIn, stx, y0, y1, c1, c2;
    if (r.dir === 'down') {
      y0 = a.y + a.h; y1 = b.y; c1 = y0 + a.gapBelow / 2; c2 = y1 - b.gapAbove / 2;
      stx = cx(a) <= cx(b) ? b.x - G.colGap / 2 : b.x + b.w + G.colGap / 2;
    } else if (r.dir === 'up') {
      y0 = a.y; y1 = b.y + b.h; c1 = y0 - a.gapAbove / 2; c2 = y1 + b.gapBelow / 2;
      stx = cx(a) <= cx(b) ? b.x - G.colGap / 2 : b.x + b.w + G.colGap / 2;
    } else if (r.dir === 'sameTop') {
      y0 = a.y; y1 = b.y; c1 = c2 = a.y - a.gapAbove / 2; stx = x1;
    } else {
      y0 = a.y + a.h; y1 = b.y + b.h; c1 = c2 = y0 + a.gapBelow / 2; stx = x1;
    }
    return {
      d: 'M' + f(x0) + ' ' + f(y0) + 'V' + f(c1) + 'H' + f(stx) + 'V' + f(c2) + 'H' + f(x1) + 'V' + f(y1),
      label: { x: (x0 + stx) / 2, y: c1 }
    };
  }

  /** Entities named in the overview: the busiest per lane, kept apart so
      labels never collide. rank 0 is shown at every zoom. */
  function computeHubs(L) {
    var out = [];
    L.lanes.forEach(function (lane) {
      var used = [], rank = 0;
      lane.ids.slice().sort(function (a, b) { return M.degree(b) - M.degree(a) || a.localeCompare(b); })
        .forEach(function (a) {
          if (rank >= 3) return;
          var p = L.nodes[a];
          var clear = used.every(function (u) { return !(u.row === p.row && Math.abs(u.col - p.col) < 2); });
          if (clear) { used.push(p); out.push({ a: a, rank: rank++ }); }
        });
    });
    return out;
  }

  /* =============================================================================
     Canvas state
     ========================================================================== */
  var cv = {
    view: { k: 1, tx: 0, ty: 0 }, tier: 'overview',
    hover: null, hoverEdge: null, sel: null, trace: null,
    atFit: true, fitK: 1, animToken: 0, raf: 0, anim: null,
    lastPointer: null, nodeEls: {}, edgeEls: {}, edgeList: [], laneEls: {},
    csLanes: {}, csHubs: {}
  };

  function vw() { return cv.host.clientWidth || 1; }
  function vh() { return cv.host.clientHeight || 1; }

  function init(host, callbacks) {
    readGeometry();
    cv.host = host; cv.cb = callbacks || {};
    var root = svg('svg', { 'class': 'cv__svg', role: 'img',
      'aria-label': 'Metamodel canvas: six architecture lanes with their entities and relationships' }, host);
    cv.defs = svg('defs', null, root);
    buildMarkers();
    cv.world = svg('g', { 'class': 'cv__world' }, root);
    cv.gLanes = svg('g', { 'class': 'cv__lanes' }, cv.world);
    cv.gEdges = svg('g', { 'class': 'cv__edges' }, cv.world);
    cv.gNodes = svg('g', { 'class': 'cv__nodes' }, cv.world);
    cv.gLabels = svg('g', { 'class': 'cv__labels' }, cv.world);
    cv.eLabel = svg('g', { 'class': 'elabel' }, cv.gLabels);
    cv.eLabelRect = svg('rect', { 'class': 'elabel__bg', height: 24, rx: 6 }, cv.eLabel);
    cv.eLabelText = svg('text', { 'class': 'elabel__text', 'text-anchor': 'middle', y: 16 }, cv.eLabel);
    buildMinimap();
    bind();
    cv.host.dataset.tier = cv.tier;
    cv.host.dataset.hubs = 'min';
    if (window.ResizeObserver) cv.resize = new ResizeObserver(function () { schedule('resize', 140); });
    if (cv.resize) cv.resize.observe(host);
    return api;
  }

  function buildMarkers() {
    ['structural', 'behavioral', 'governance', 'coupling', 'derived', 'up', 'down'].forEach(function (cat) {
      [['s', 7], ['l', 4.4]].forEach(function (pair) {
        var size = pair[1];
        var m = svg('marker', { id: 'ah' + pair[0] + '-' + cat, markerUnits: 'userSpaceOnUse', markerWidth: size, markerHeight: size,
                                 refX: size - .6, refY: size / 2, orient: 'auto' }, cv.defs);
        svg('path', { 'class': 'ah ah--' + cat, d: 'M0 0L' + size + ' ' + size / 2 + 'L0 ' + size + 'Z' }, m);
      });
    });
  }

  /* ---------- build / rebuild ---------------------------------------------- */
  function pickCols() {
    var best = COL_CHOICES[0], bestK = 0;
    COL_CHOICES.forEach(function (c) {
      var L = computeLayout(cv.sc, c, G.ch);
      var k = Math.min(vw() * G.fitPad / L.width, vh() * G.fitPad / L.height);
      if (k > bestK * 1.02) { bestK = k; best = c; }
    });
    return best;
  }

  function setScope(sc, opts) {
    opts = opts || {};
    stopAnim();
    cv.sc = sc; cv.hover = null; cv.hoverEdge = null; hideEdgeLabel();
    cv.cols = pickCols();
    cv.L = computeLayout(sc, cv.cols, cardHeight(cv.tier));
    computePorts(sc, cv.L);
    cv.L.hubs = computeHubs(cv.L);
    cv.csLanes = {}; cv.csHubs = {};
    buildLanes(); buildNodes(); buildEdges(); buildHubs(); paintMinimapLanes();
    paint(false);
    applyZoomParam(opts.zoom, opts.instant ? false : true);
  }

  function laneHead(lane) {
    var g = svg('g', { 'class': 'lane__head', role: 'button', tabindex: 0,
                       'aria-label': 'Focus lane ' + lane.layer.code + ' · ' + lane.layer.name });
    var parts = {
      pill: svg('rect', { 'class': 'lane__pill', height: 24, rx: 12, y: -12 }, g),
      dot: svg('circle', { 'class': 'lane__dot', cx: 14, cy: 0, r: 4 }, g),
      code: svg('text', { 'class': 'lane__code', x: 23, y: 3.5 }, g),
      name: svg('text', { 'class': 'lane__name', y: 3.5 }, g),
      cntBg: svg('rect', { 'class': 'lane__countbg', height: 16, rx: 8, y: -8 }, g),
      cnt: svg('text', { 'class': 'lane__count', y: 3.5 }, g),
      zoom: svg('g', { 'class': 'lane__zoom' }, g)
    };
    parts.code.textContent = lane.layer.code;
    parts.cnt.textContent = lane.count;
    parts.fullName = lane.layer.id === 'DIM' ? 'Cross-cutting dimensions' : lane.layer.name;
    parts.zoom.innerHTML = '<circle class="lane__zoombg" r="9"/><path class="lane__zoomico" d="M-2.4 2.4 2.4-2.4M-2.4-2.4h4.8v4.8"/>';
    g.__parts = parts;
    return g;
  }

  function buildLanes() {
    cv.gLanes.textContent = ''; cv.laneEls = {}; cv.csLanes = {};
    cv.L.lanes.forEach(function (lane) {
      var g = svg('g', { 'class': 'lane', 'data-layer': lane.layer.id }, cv.gLanes);
      var rect = svg('rect', { 'class': 'lane__bg', rx: 12 }, g);
      var head = laneHead(lane); g.appendChild(head);
      cv.laneEls[lane.layer.id] = { g: g, rect: rect, head: head, lane: lane };
      cv.csLanes[lane.layer.id] = head;
      head.__lane = lane;
    });
  }

  function cardHtml(e) {
    var core = e.m && e.m[0] === 'core';
    return '<div xmlns="' + HTMLNS + '" class="ecard' + (e.abs ? ' is-abstract' : '') + '" data-layer="' + e.l + '">' +
      '<div class="ecard__main"><span class="tag">' + e.a + '</span><span class="ecard__name">' + esc(e.n) + '</span></div>' +
      '<div class="ecard__meta"><span class="ecard__bb">' + esc(e.bb || 'Dimension') + '</span>' +
      '<span class="badge" data-status="' + (e.s || 'planned') + '">' + esc(e.s || 'planned') + '</span></div>' +
      '<div class="ecard__foot"><span class="ecard__io"><b>' + M.inbound[e.a].length + '</b> in · <b>' +
      M.outbound[e.a].length + '</b> out</span>' + (core ? '<span class="ecard__core">CORE</span>' : '') + '</div></div>';
  }

  function buildNodes() {
    cv.gNodes.textContent = ''; cv.nodeEls = {};
    var hubRank = {};
    cv.L.hubs.forEach(function (h) { hubRank[h.a] = h.rank; });
    cv.sc.entities.forEach(function (e) {
      var g = svg('g', { 'class': 'node', 'data-id': e.a, 'data-layer': e.l, tabindex: '0', role: 'button' }, cv.gNodes);
      if (hubRank[e.a] !== undefined) g.setAttribute('data-hub', hubRank[e.a]);
      var hit = svg('circle', { 'class': 'node__hit' }, g);
      var dot = svg('circle', { 'class': 'node__dot' }, g);
      var ring = svg('circle', { 'class': 'node__ring' }, g);
      var fo = svg('foreignObject', { 'class': 'node__fo' }, g);
      fo.innerHTML = cardHtml(e);
      g.setAttribute('aria-label', e.n + ' (' + e.a + '), ' + M.layerById[e.l].name);
      cv.nodeEls[e.a] = { g: g, fo: fo, dot: dot, hit: hit, ring: ring, card: fo.firstChild };
    });
  }

  function buildEdges() {
    cv.gEdges.textContent = ''; cv.edgeEls = {}; cv.edgeList = [];
    cv.sc.rels.forEach(function (r) {
      var p = svg('path', { 'class': 'edge edge--' + r.cat, 'data-id': r.id }, cv.gEdges);
      var h = svg('path', { 'class': 'edge__hit', 'data-id': r.id }, cv.gEdges);
      var rec = { r: r, p: p, h: h, label: null };
      cv.edgeEls[r.id] = rec; cv.edgeList.push(rec);
    });
  }

  function buildHubs() {
    cv.csHubs = {};
    cv.L.hubs.forEach(function (h) {
      var g = svg('g', { 'class': 'hub' + (h.rank ? ' hub--minor' : '') }, cv.gLabels);
      var t = svg('text', { 'class': 'hub__text', x: 8, y: 4 }, g);
      t.textContent = M.byId[h.a].n;
      cv.csHubs[h.a] = g;
    });
    cv.gLabels.appendChild(cv.eLabel);                      // keep the edge label on top
  }

  /** Position everything from cv.L. */
  function paint(animated) {
    var L = cv.L;
    L.lanes.forEach(function (lane) {
      var els = cv.laneEls[lane.layer.id];
      els.lane = lane; els.head.__lane = lane;
      els.rect.setAttribute('x', lane.x); els.rect.setAttribute('y', lane.y);
      els.rect.setAttribute('width', lane.w); els.rect.setAttribute('height', lane.h);
    });
    Object.keys(L.nodes).forEach(function (a) {
      var p = L.nodes[a], n = cv.nodeEls[a];
      n.g.setAttribute('transform', 'translate(' + f(p.x) + ' ' + f(p.y) + ')');
      n.fo.setAttribute('width', p.w); n.fo.setAttribute('height', p.h);
    });
    cv.edgeList.forEach(function (rec) {
      var ep = edgePath(rec.r, L);
      setD(rec.p, ep.d); setD(rec.h, ep.d); rec.label = ep.label;
    });
    paintMinimapLanes();
    updateCounterScale(); updateMinimap();
  }
  function setD(el, d) { el.setAttribute('d', d); if (CAN_ANIMATE_D) el.style.d = 'path("' + d + '")'; }

  /* =============================================================================
     View
     ========================================================================== */
  function setView(k, tx, ty) {
    cv.view = { k: k, tx: tx, ty: ty };
    cv.world.setAttribute('transform', 'translate(' + f(tx) + ' ' + f(ty) + ') scale(' + k + ')');
    cv.host.style.backgroundPosition = f(tx % 24) + 'px ' + f(ty % 24) + 'px';
    updateTier();
    updateCounterScale();
    updateMinimap();
    if (cv.cb.onViewChange) cv.cb.onViewChange(getState());
  }

  /** Scale that shows the whole model inside the area the host leaves free. */
  function fitK() {
    return clamp(Math.min((vw() - insetRight()) * G.fitPad / cv.L.width, (vh() - insetTop()) * G.fitPad / cv.L.height), G.zMin, G.zMax);
  }
  function fitTarget() {
    var k = fitK(), top = insetTop();
    return { k: k, tx: (vw() - insetRight() - cv.L.width * k) / 2, ty: top + (vh() - top - cv.L.height * k) / 2 };
  }
  /** Re-fit after the free area changes (inspector opened or closed). */
  function fitIfAtFit() { if (cv.atFit) fit(true); }

  function animateTo(target, ms) {
    var a = { from: { k: cv.view.k, tx: cv.view.tx, ty: cv.view.ty }, target: { k: target.k, tx: target.tx, ty: target.ty },
              t0: performance.now(), ms: ms || 280 };
    cv.anim = a; cv.animToken++;
    var token = cv.animToken;
    stopAnim();
    function step(now) {
      if (token !== cv.animToken) return;
      var t = clamp((now - a.t0) / a.ms, 0, 1), e = ease(t);
      setView(lerp(a.from.k, a.target.k, e), lerp(a.from.tx, a.target.tx, e), lerp(a.from.ty, a.target.ty, e));
      if (t < 1) cv.raf = requestAnimationFrame(step); else { cv.raf = 0; cv.anim = null; }
    }
    cv.raf = requestAnimationFrame(step);
  }
  function stopAnim() { cv.animToken++; if (cv.raf) { cancelAnimationFrame(cv.raf); cv.raf = 0; } cv.anim = null; }

  /** Nudge the view by screen pixels, carrying any running tween along. */
  function shiftView(dx, dy) {
    setView(cv.view.k, cv.view.tx + dx, cv.view.ty + dy);
    if (cv.anim) {
      cv.anim.from.tx += dx; cv.anim.from.ty += dy;
      cv.anim.target.tx += dx; cv.anim.target.ty += dy;
    }
  }

  function tierFor(k) {
    var h = .05, prev = cv.tier;
    if ((prev === 'detail' && k >= G.tDetail - h) || k >= G.tDetail) return 'detail';
    if ((prev === 'names' && k >= G.tNames - h) || k >= G.tNames) return 'names';
    return 'overview';
  }
  function updateTier() {
    var next = tierFor(cv.view.k);
    if (next === cv.tier) return;
    cv.tier = next;
    cv.host.dataset.tier = next;
    relayout(true);
  }

  /** Re-flow for the current tier. With `anchored`, the entity nearest the
      pointer (or the viewport centre) keeps its screen position. */
  function relayout(anchored) {
    var anchor = null;
    if (anchored) {
      var pt = cv.lastPointer || { x: vw() / 2, y: vh() / 2 };
      var w = worldAt(pt.x, pt.y), best = Infinity;
      Object.keys(cv.L.nodes).forEach(function (a) {
        var p = cv.L.nodes[a], d = Math.abs(cx(p) - w.x) + Math.abs(cy(p) - w.y);
        if (d < best) { best = d; anchor = a; }
      });
    }
    var before = anchor ? { x: cx(cv.L.nodes[anchor]), y: cy(cv.L.nodes[anchor]) } : null;
    var hubs = cv.L.hubs;                     // the hub set depends only on ordering, which is unchanged
    cv.L = computeLayout(cv.sc, cv.cols, cardHeight(cv.tier));
    computePorts(cv.sc, cv.L);
    cv.L.hubs = hubs;
    paint(true);
    if (anchor) {
      var after = { x: cx(cv.L.nodes[anchor]), y: cy(cv.L.nodes[anchor]) }, k = cv.view.k;
      shiftView((before.x - after.x) * k, (before.y - after.y) * k);
    }
    applyFocus();
  }

  function worldAt(sx, sy) { return { x: (sx - cv.view.tx) / cv.view.k, y: (sy - cv.view.ty) / cv.view.k }; }
  function screenOf(p) { return { x: cx(p) * cv.view.k + cv.view.tx, y: cy(p) * cv.view.k + cv.view.ty }; }
  /* Space the host UI keeps free: the inspector drawer on the right
     (desktop) and the inspector sheet at the bottom (mobile). */
  function insetRight() { return cv.cb.insetRight ? cv.cb.insetRight() : 0; }
  function insetBottom() { return cv.cb.insetBottom ? cv.cb.insetBottom() : 0; }
  function insetTop() { return cv.cb.insetTop ? cv.cb.insetTop() : 0; }

  function zoomAt(sx, sy, k2) {
    stopAnim();
    k2 = clamp(k2, G.zMin, G.zMax);
    if (k2 === cv.view.k) return;
    var v = cv.view, r = k2 / v.k;
    cv.atFit = false;
    setView(k2, sx - (sx - v.tx) * r, sy - (sy - v.ty) * r);
  }
  function fit(animate) {
    cv.fitK = fitK(); cv.atFit = true;
    var t = fitTarget();
    if (animate === false) { stopAnim(); setView(t.k, t.tx, t.ty); } else animateTo(t, 320);
  }
  function zoomBy(factor) {
    var top = insetTop();
    zoomAt((vw() - insetRight()) / 2, top + (vh() - top - insetBottom()) / 2, cv.view.k * factor);
  }

  /** Bring a world rectangle into the free area at the largest scale that
      still fits, clamped to [minK, maxK]. */
  function zoomToRect(x, y, w, h, minK, maxK, animate) {
    var avail = vw() - insetRight(), top = insetTop(), availH = vh() - top - insetBottom();
    var k = clamp(Math.min(avail * .9 / w, availH * .88 / h), minK || G.zMin, maxK || G.zMax);
    var t = { k: k, tx: avail / 2 - (x + w / 2) * k, ty: top + availH / 2 - (y + h / 2) * k };
    cv.atFit = false;
    if (animate === false) { stopAnim(); setView(t.k, t.tx, t.ty); } else animateTo(t, 340);
  }
  function zoomToEntity(a) { var p = cv.L.nodes[a]; if (p) zoomToRect(p.x, p.y, p.w, p.h, .95, 1.5); }
  function zoomToLane(id) {
    var lane = cv.L.lanes.filter(function (l) { return l.layer.id === id; })[0];
    if (lane) zoomToRect(lane.x, lane.y, lane.w, lane.h, .8, 1.15);
  }
  /** Pan only when the entity would actually be clipped or hidden under the
      inspector — never for cosmetic margin, so a fitted view stays fitted. */
  function ensureVisible(a) {
    var p = cv.L.nodes[a]; if (!p) return;
    var s = screenOf(p), halfW = p.w * cv.view.k / 2 + 8, halfH = p.h * cv.view.k / 2 + 20, dx = 0, dy = 0, m = 8;
    var bottom = vh() - insetBottom(), right = vw() - insetRight(), top = insetTop();
    if (s.x - halfW < m) dx = m - (s.x - halfW);
    if (s.x + halfW > right - m) dx = right - m - (s.x + halfW);
    if (s.y - halfH < top + m) dy = top + m - (s.y - halfH);
    if (s.y + halfH > bottom - m) dy = bottom - m - (s.y + halfH);
    if (dx || dy) { cv.atFit = false; animateTo({ k: cv.view.k, tx: cv.view.tx + dx, ty: cv.view.ty + dy }, 240); }
  }

  /** zoom param: 'fit' | 'overview' | 'names' | 'detail' | a number (scale). */
  function applyZoomParam(p, animate) {
    if (p === undefined || p === null || p === 'fit') return fit(animate !== false);
    var fk = fitK(), k = parseFloat(p);
    if (!isNaN(k)) {
      k = clamp(k, G.zMin, G.zMax);
      return zoomToRect(cx(cv.L) - 1, cy(cv.L) - 1, 2, 2, k, k, animate);
    }
    k = p === 'overview' ? Math.min(fk, G.tNames - .07)
      : p === 'names' ? Math.max(fk, G.tNames + .15) : Math.max(fk, G.tDetail + .25);
    zoomToRect(cv.L.x0 || cv.L.lanes[0].x, cv.L.y, cv.L.width, Math.min(cv.L.height, 420), k, k, animate);
  }

  /* =============================================================================
     Counter-scaled chrome (stays the same size on screen at any zoom)
     ========================================================================== */
  function measureText(el, cache, key) {
    if (cache[key] === undefined) cache[key] = el.getComputedTextLength();
    return cache[key];
  }
  function fitText(text, max) {
    if (text.length * 6.1 <= max) return text;
    var lo = 2, hi = text.length;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if ((text.slice(0, mid) + '…').length * 6.1 <= max) lo = mid; else hi = mid - 1;
    }
    return text.slice(0, lo) + '…';
  }
  function sizeLaneHead(head, lane, k) {
    var parts = head.__parts, m = head.__m || (head.__m = {});
    var onScreen = lane.w * k, narrow = onScreen < 330;
    head.classList.toggle('lane__head--compact', narrow);
    var txt = narrow ? '' : fitText(parts.fullName, clamp(onScreen - 150, 60, 230));
    if (parts.name.textContent !== txt) parts.name.textContent = txt;
    var codeW = measureText(parts.code, m, 'code'), cntW = measureText(parts.cnt, m, 'cnt') + 12;
    var nameW = txt ? measureText(parts.name, m, 'n:' + txt) : 0;
    var nameX = 23 + codeW + 8, afterName = txt ? nameX + nameW + 10 : nameX - 8;
    parts.name.setAttribute('x', f(nameX));
    parts.cntBg.setAttribute('x', f(afterName));
    parts.cnt.setAttribute('x', f(afterName + 6));
    var pillW = Math.max(afterName + cntW + 6, 60);
    parts.pill.setAttribute('width', f(pillW));
    parts.zoom.setAttribute('transform', 'translate(' + f(pillW + 2) + ' 0)');
  }

  function updateCounterScale() {
    var k = cv.view.k, inv = 1 / k;
    cv.L.lanes.forEach(function (lane) {
      var head = cv.csLanes[lane.layer.id]; if (!head) return;
      // The label straddles the lane's top edge, so it never sits on the first row.
      head.setAttribute('transform', 'translate(' + f(lane.x + 6 * inv) + ' ' + f(lane.y) + ') scale(' + inv.toFixed(4) + ')');
      if (head.__k !== k) { head.__k = k; sizeLaneHead(head, lane, k); }
    });
    cv.L.hubs.forEach(function (h) {
      var g = cv.csHubs[h.a]; if (!g) return;
      var p = cv.L.nodes[h.a], left = p.col >= p.cols - 1;
      g.setAttribute('transform', 'translate(' + f(cx(p)) + ' ' + f(cy(p)) + ') scale(' + inv.toFixed(4) + ')');
      if (g.__left !== left) { g.__left = left; g.classList.toggle('hub--left', left); }
    });
    var dotR = f(3 * inv), hubR = f(4.4 * inv), hitR = f(12 * inv), ringR = f(8.5 * inv);
    Object.keys(cv.nodeEls).forEach(function (a) {
      var n = cv.nodeEls[a], p = cv.L.nodes[a], hub = n.g.hasAttribute('data-hub');
      var hx = f(p.w / 2), hy = f(p.h / 2);
      n.dot.setAttribute('r', hub ? hubR : dotR); n.dot.setAttribute('cx', hx); n.dot.setAttribute('cy', hy);
      n.hit.setAttribute('r', hitR); n.hit.setAttribute('cx', hx); n.hit.setAttribute('cy', hy);
      n.ring.setAttribute('r', ringR); n.ring.setAttribute('cx', hx); n.ring.setAttribute('cy', hy);
    });
    cv.host.dataset.hubs = k >= .45 ? 'full' : k >= .4 ? 'min' : 'none';
    if (cv.eLabelOn) placeEdgeLabel();
  }

  function placeEdgeLabel() {
    var rec = cv.edgeEls[cv.eLabelOn]; if (!rec || !rec.label) return;
    cv.eLabel.setAttribute('transform', 'translate(' + f(rec.label.x) + ' ' + f(rec.label.y) + ') scale(' + (1 / cv.view.k).toFixed(4) + ')');
  }
  function showEdgeLabel(id) {
    var rec = cv.edgeEls[id]; if (!rec) return;
    var r = rec.r, def = r.def && M.defs[r.def];
    cv.eLabelText.textContent = r.l + (r.c ? '  ' + r.c : '') + (def ? '  ·  ' + def.name : '');
    var w = cv.eLabelText.getComputedTextLength() + 20;
    cv.eLabelRect.setAttribute('x', f(-w / 2)); cv.eLabelRect.setAttribute('width', f(w));
    cv.eLabelOn = id; cv.eLabel.classList.add('is-on'); placeEdgeLabel();
  }
  function hideEdgeLabel() { cv.eLabelOn = null; cv.eLabel.classList.remove('is-on'); }

  /* =============================================================================
     Focus: selection, hover, impact trace
     ========================================================================== */
  function setSelection(sel, trace) {
    cv.sel = sel; cv.trace = trace || null;
    applyFocus();
    if (sel) ensureVisible(sel);
  }
  function applyFocus() {
    var lit = {}, up = {}, down = {}, related = {}, sel = cv.sel, trace = cv.trace;
    cv.sc.rels.forEach(function (r) {
      if (sel && (r.f === sel || r.t === sel)) { lit[r.id] = true; related[r.f] = related[r.t] = true; }
      if (cv.hover && (r.f === cv.hover || r.t === cv.hover)) lit[r.id] = true;
      if (cv.hoverEdge !== null && r.id === cv.hoverEdge) lit[r.id] = true;
    });
    if (trace) {
      trace.upEdges.forEach(function (r) { if (cv.edgeEls[r.id]) { up[r.id] = true; related[r.f] = related[r.t] = true; } });
      trace.downEdges.forEach(function (r) { if (cv.edgeEls[r.id]) { down[r.id] = true; related[r.f] = related[r.t] = true; } });
      Object.keys(trace.up).forEach(function (a) { related[a] = true; });
      Object.keys(trace.down).forEach(function (a) { related[a] = true; });
    }
    cv.host.classList.toggle('has-focus', !!(sel || trace));
    cv.host.classList.toggle('has-hover', !sel && !!(cv.hover || cv.hoverEdge !== null));
    cv.edgeList.forEach(function (rec) {
      var id = rec.r.id, cl = rec.p.classList;
      cl.toggle('is-lit', !!lit[id] && !up[id] && !down[id]);
      cl.toggle('is-up', !!up[id]);
      cl.toggle('is-down', !!down[id]);
      cl.toggle('is-hover', cv.hoverEdge === id);
    });
    Object.keys(cv.nodeEls).forEach(function (a) {
      var cl = cv.nodeEls[a].g.classList;
      cl.toggle('is-selected', a === sel);
      cl.toggle('is-related', !!related[a]);
      cl.toggle('is-up', !!(trace && trace.up[a] !== undefined));
      cl.toggle('is-down', !!(trace && trace.down[a] !== undefined));
      cl.toggle('is-hover', a === cv.hover);
    });
  }
  function setHover(a) { if (cv.hover === a) return; cv.hover = a; applyFocus(); }
  function setHoverEdge(id) {
    if (cv.hoverEdge === id) return;
    cv.hoverEdge = id;
    if (id === null) hideEdgeLabel(); else showEdgeLabel(id);
    applyFocus();
  }

  /* =============================================================================
     Minimap
     ========================================================================== */
  var MM = { w: 168, h: 104 };
  function buildMinimap() {
    var box = document.createElement('div');
    box.className = 'cv__minimap cv__ui';
    box.setAttribute('aria-hidden', 'true');
    var s = svg('svg', { width: MM.w, height: MM.h, viewBox: '0 0 ' + MM.w + ' ' + MM.h }, box);
    cv.mmLanes = svg('g', { 'class': 'mm__lanes' }, s);
    cv.mmView = svg('rect', { 'class': 'mm__view', rx: 2 }, s);
    cv.mm = box;
    cv.host.appendChild(box);
    box.addEventListener('pointerdown', mmDown);
  }
  function mmScale() {
    var s = Math.min((MM.w - 10) / cv.L.width, (MM.h - 10) / cv.L.height);
    return { s: s, ox: (MM.w - cv.L.width * s) / 2, oy: (MM.h - cv.L.height * s) / 2 };
  }
  function paintMinimapLanes() {
    cv.mmLanes.textContent = '';
    var m = mmScale();
    cv.L.lanes.forEach(function (lane) {
      var r = svg('rect', { 'class': 'mm__lane', 'data-layer': lane.layer.id }, cv.mmLanes);
      r.setAttribute('x', f(m.ox + lane.x * m.s)); r.setAttribute('y', f(m.oy + lane.y * m.s));
      r.setAttribute('width', f(lane.w * m.s)); r.setAttribute('height', f(Math.max(2, lane.h * m.s)));
    });
  }
  function updateMinimap() {
    var m = mmScale(), k = cv.view.k;
    cv.mmView.setAttribute('x', f(m.ox - cv.view.tx / k * m.s));
    cv.mmView.setAttribute('y', f(m.oy - cv.view.ty / k * m.s));
    cv.mmView.setAttribute('width', f(vw() / k * m.s));
    cv.mmView.setAttribute('height', f(vh() / k * m.s));
    cv.host.classList.toggle('is-zoomed', !cv.atFit);
  }
  function mmCenter(e) {
    var m = mmScale(), b = cv.mm.getBoundingClientRect();
    var wx = (e.clientX - b.left - m.ox) / m.s, wy = (e.clientY - b.top - m.oy) / m.s, k = cv.view.k;
    cv.atFit = false; stopAnim();
    setView(k, vw() / 2 - wx * k, vh() / 2 - wy * k);
  }
  function mmDown(e) {
    e.preventDefault(); e.stopPropagation();
    cv.mm.setPointerCapture(e.pointerId);
    var move = function (ev) { mmCenter(ev); }, up = function () {
      cv.mm.removeEventListener('pointermove', move); cv.mm.removeEventListener('pointerup', up); cv.mm.removeEventListener('pointercancel', up);
    };
    cv.mm.addEventListener('pointermove', move); cv.mm.addEventListener('pointerup', up); cv.mm.addEventListener('pointercancel', up);
    mmCenter(e);
    interacted('zoom');
  }

  /* =============================================================================
     Input
     ========================================================================== */
  var pointers = new Map();
  function interacted(kind) { if (cv.cb.onInteract) cv.cb.onInteract(kind); }
  function bind() {
    var host = cv.host;
    host.addEventListener('pointerdown', onDown);
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerup', onUp);
    host.addEventListener('pointercancel', onUp);
    host.addEventListener('wheel', onWheel, { passive: false });
    host.addEventListener('click', onClick);
    host.addEventListener('dblclick', onDblClick);
    host.addEventListener('pointerover', onOver);
    host.addEventListener('pointerout', onOut);
    host.addEventListener('keydown', onKey);
  }
  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    var t = e.target;
    if (t.closest && t.closest('.node, .lane__head, .cv__ui, .edge__hit')) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { cv.host.setPointerCapture(e.pointerId); } catch (err) { /* best-effort */ }
    stopAnim();
    if (pointers.size === 1) {
      cv.drag = { x: e.clientX, y: e.clientY, tx: cv.view.tx, ty: cv.view.ty, moved: false, t: performance.now() };
    } else if (pointers.size === 2) {
      cv.drag = null; cv.pinch = pinchState();
    }
    cv.host.classList.add('is-panning');
    interacted('pointer-down');
  }
  function pinchState() {
    var pts = Array.from(pointers.values()), b = cv.host.getBoundingClientRect();
    return { k: cv.view.k, tx: cv.view.tx, ty: cv.view.ty,
             cx: (pts[0].x + pts[1].x) / 2 - b.left, cy: (pts[0].y + pts[1].y) / 2 - b.top,
             dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1 };
  }
  function onMove(e) {
    var b = cv.host.getBoundingClientRect();
    cv.lastPointer = { x: e.clientX - b.left, y: e.clientY - b.top };
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    cv.atFit = false;
    if (pointers.size >= 2 && cv.pinch) {
      var p = pinchState(), k = clamp(cv.pinch.k * p.dist / cv.pinch.dist, G.zMin, G.zMax), r = k / cv.pinch.k;
      setView(k, p.cx - (cv.pinch.cx - cv.pinch.tx) * r, p.cy - (cv.pinch.cy - cv.pinch.ty) * r);
    } else if (cv.drag) {
      var dx = e.clientX - cv.drag.x, dy = e.clientY - cv.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) cv.drag.moved = true;
      setView(cv.view.k, cv.drag.tx + dx, cv.drag.ty + dy);
    }
  }
  function onUp(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    try { cv.host.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    if (pointers.size < 2) cv.pinch = null;
    if (pointers.size === 0) {
      cv.host.classList.remove('is-panning');
      var d = cv.drag; cv.drag = null;
      if (d && !d.moved && performance.now() - d.t < 450 && cv.cb.onBackgroundTap) cv.cb.onBackgroundTap();
    } else if (pointers.size === 1) {
      var pt = Array.from(pointers.values())[0];
      cv.drag = { x: pt.x, y: pt.y, tx: cv.view.tx, ty: cv.view.ty, moved: true, t: performance.now() };
    }
  }
  function onWheel(e) {
    e.preventDefault();
    var b = cv.host.getBoundingClientRect(), unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? vh() : 1;
    var dy = clamp(e.deltaY * unit, -80, 80);
    cv.lastPointer = { x: e.clientX - b.left, y: e.clientY - b.top };
    zoomAt(e.clientX - b.left, e.clientY - b.top, cv.view.k * Math.exp(-dy * (e.ctrlKey ? .0035 : .0018)));
    interacted('zoom');
  }
  function onClick(e) {
    var node = e.target.closest && e.target.closest('.node');
    if (node) { if (cv.cb.onSelect) cv.cb.onSelect(node.getAttribute('data-id')); interacted('select'); return; }
    var head = e.target.closest && e.target.closest('.lane__head');
    if (head && head.__lane) { zoomToLane(head.__lane.layer.id); interacted('zoom'); }
  }
  function onDblClick(e) {
    var node = e.target.closest && e.target.closest('.node');
    if (node) { e.preventDefault(); zoomToEntity(node.getAttribute('data-id')); interacted('zoom'); }
  }
  function onOver(e) {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    var node = e.target.closest && e.target.closest('.node');
    if (node) { setHover(node.getAttribute('data-id')); if (cv.cb.onHover) cv.cb.onHover(node.getAttribute('data-id')); return; }
    var edge = e.target.closest && e.target.closest('.edge__hit');
    if (edge) setHoverEdge(parseInt(edge.getAttribute('data-id'), 10));
  }
  function onOut(e) {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    if (e.target.closest && e.target.closest('.node')) { setHover(null); if (cv.cb.onHover) cv.cb.onHover(null); }
    else if (e.target.closest && e.target.closest('.edge__hit')) setHoverEdge(null);
  }
  function onKey(e) {
    var node = e.target.closest && e.target.closest('.node');
    if (node && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); if (cv.cb.onSelect) cv.cb.onSelect(node.getAttribute('data-id')); }
    var head = e.target.closest && e.target.closest('.lane__head');
    if (head && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); zoomToLane(head.__lane.layer.id); }
  }

  function schedule(kind, ms) {
    clearTimeout(cv.timer);
    cv.timer = setTimeout(function () {
      if (kind !== 'resize' || !cv.sc) return;
      var cols = pickCols();
      cv.fitK = fitK();
      if (cols !== cv.cols) { cv.cols = cols; relayout(false); }
      if (cv.atFit) fit(false); else updateMinimap();
    }, ms);
  }

  function getState() { return { k: cv.view.k, tier: cv.tier, atFit: cv.atFit, fitK: cv.fitK }; }

  /* =============================================================================
     Export — a standalone SVG of the current scope (no foreignObject, so it
     opens anywhere and rasterises cleanly to PNG).
     ========================================================================== */
  function tok(name) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    var m = v.match(/rgba?\(([^)]+)\)/);
    if (m) {
      var p = m[1].split(/[ ,\/]+/).map(parseFloat);
      v = '#' + [p[0], p[1], p[2]].map(function (n) { return ('0' + Math.round(n).toString(16)).slice(-2); }).join('').toUpperCase();
    }
    return v || '#000';
  }
  function wrapText(text, max) {
    var ctx = wrapText.ctx || (wrapText.ctx = document.createElement('canvas').getContext('2d'));
    ctx.font = '500 13px Geist, -apple-system, Segoe UI, Helvetica, Arial, sans-serif';
    var words = text.split(' '), lines = [], line = '';
    words.forEach(function (w) {
      var t = line ? line + ' ' + w : w;
      if (ctx.measureText(t).width > max && line) { lines.push(line); line = w; } else line = t;
    });
    if (line) lines.push(line);
    if (lines.length > 2) { lines = lines.slice(0, 2); lines[1] = lines[1].replace(/\s+\S*$/, '') + '…'; }
    return lines;
  }
  function layerIndex(id) { return M.layers.indexOf(M.layerById[id]) + 1; }
  function dashFor(cat) { return cat === 'governance' || cat === 'coupling' ? ' stroke-dasharray="5 4"' : cat === 'derived' ? ' stroke-dasharray="1.5 3.5"' : ''; }

  function buildSvgExport(opts) {
    opts = opts || {};
    var L = cv.L, pad = 48, legend = opts.legend !== false, legendH = legend ? 44 : 0;
    var W = Math.round(L.width + pad * 2), H = Math.round(L.height + pad * 2 + legendH);
    var font = 'font-family="Geist, -apple-system, Segoe UI, Helvetica, Arial, sans-serif"';
    var out = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" ' + font + '>',
      '<title>DEA Metamodel ' + esc(M.meta.version) + '</title>',
      '<desc>' + esc(cv.sc.entities.length + ' entities · ' + cv.sc.rels.length + ' relationships · exported from the DEA Web Viewer') + '</desc>'];
    if (opts.fontCss) out.push('<style>' + opts.fontCss + '</style>');
    out.push('<defs>');
    ['structural', 'behavioral', 'governance', 'coupling', 'derived'].forEach(function (cat) {
      out.push('<marker id="ah-' + cat + '" markerUnits="userSpaceOnUse" markerWidth="7" markerHeight="7" refX="6.4" refY="3.5" orient="auto">' +
        (cat === 'derived'
          ? '<path d="M0 0L7 3.5L0 7Z" fill="#FFFFFF" stroke="' + tok('--edge-derived') + '" stroke-width="1"/>'
          : '<path d="M0 0L7 3.5L0 7Z" fill="' + tok('--edge-' + cat) + '"/>') + '</marker>');
    });
    out.push('</defs>', '<rect width="100%" height="100%" fill="#FFFFFF"/>');
    L.lanes.forEach(function (lane) {
      var i = layerIndex(lane.layer.id), x = lane.x + pad, y = lane.y + pad;
      out.push('<rect x="' + x + '" y="' + y + '" width="' + lane.w + '" height="' + lane.h + '" rx="12" fill="' + tok('--layer-' + i + '-soft') + '" stroke="' + tok('--layer-' + i + '-line') + '"/>',
        '<circle cx="' + (x + 18) + '" cy="' + (y + 16) + '" r="4" fill="' + tok('--layer-' + i) + '"/>',
        '<text x="' + (x + 28) + '" y="' + (y + 20) + '" font-size="11" font-weight="600" fill="' + tok('--layer-' + i + '-ink') + '">' +
        esc(lane.layer.code + ' · ' + lane.layer.name + ' · ' + lane.count) + '</text>');
    });
    cv.sc.rels.forEach(function (r) {
      out.push('<path d="' + edgePath(r, L).d + '" fill="none" stroke="' + tok('--edge-' + r.cat) + '" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"' +
        dashFor(r.cat) + ' marker-end="url(#ah-' + r.cat + ')" opacity=".7"/>');
    });
    cv.sc.entities.forEach(function (e) {
      var p = L.nodes[e.a], i = layerIndex(e.l), x = p.x + pad, y = p.y + pad, mid = y + p.h / 2;
      var lines = wrapText(e.n, p.w - 72), two = lines.length > 1;
      out.push('<rect x="' + x + '" y="' + y + '" width="' + p.w + '" height="' + p.h + '" rx="8" fill="#FFFFFF" stroke="' + tok('--gray-300') + '"/>',
        '<rect x="' + x + '" y="' + (y + 5) + '" width="3" height="' + (p.h - 10) + '" rx="1.5" fill="' + tok('--layer-' + i) + '"/>',
        '<rect x="' + (x + 12) + '" y="' + (mid - 10) + '" width="30" height="20" rx="5" fill="' + tok('--layer-' + i + '-soft') + '"/>',
        '<text x="' + (x + 27) + '" y="' + (mid + 3.5) + '" font-size="10" font-weight="600" text-anchor="middle" fill="' + tok('--layer-' + i + '-ink') + '">' + esc(e.a) + '</text>');
      lines.forEach(function (line, li) {
        out.push('<text x="' + (x + 50) + '" y="' + (mid + (two ? (li ? 9 : -5) : 4.5)) + '" font-size="13" font-weight="500" fill="' + tok('--gray-900') + '"' +
          (e.abs ? ' font-style="italic"' : '') + '>' + esc(line) + '</text>');
      });
    });
    if (legend) {
      var ly = H - 22, cats = ['behavioral', 'structural', 'governance', 'coupling', 'derived'];
      var names = { behavioral: 'Behavioural', structural: 'Structural', governance: 'Governance', coupling: 'Coupling', derived: 'Specializes (derived)' };
      out.push('<g font-size="11" font-weight="500" fill="' + tok('--gray-600') + '">');
      cats.forEach(function (cat, i) {
        var x = pad + i * 210;
        out.push('<line x1="' + x + '" y1="' + ly + '" x2="' + (x + 30) + '" y2="' + ly + '" stroke="' + tok('--edge-' + cat) + '" stroke-width="1.4"' + dashFor(cat) + '/>',
          '<text x="' + (x + 38) + '" y="' + (ly + 4) + '">' + esc(names[cat]) + '</text>');
      });
      out.push('</g>');
    }
    return out.join('\n') + '\n</svg>';
  }

  var api = {
    init: init, setScope: setScope, fit: fit, fitIfAtFit: fitIfAtFit, zoomBy: zoomBy, zoomToEntity: zoomToEntity, zoomToLane: zoomToLane,
    ensureVisible: ensureVisible, applyZoomParam: applyZoomParam, setSelection: setSelection,
    setHover: setHover, setHoverEdge: setHoverEdge, getState: getState,
    getLayout: function () { return cv.L; },
    buildSvgExport: buildSvgExport, tok: tok,
    state: cv
  };
  DEA.Canvas = api;
})(window.DEA);
