/* =============================================================================
   app-model.js — pure logic over the real metamodel. No DOM.
   Mirrors the viewer's own libraries so the prototype behaves like the app:
   search scoring (src/lib/search.ts), export schemas (src/lib/export.ts),
   membership groups (src/lib/membership.ts), coverage (src/lib/coverage.ts).
   ========================================================================== */
window.DEA = window.DEA || {};
(function (DEA) {
  'use strict';

  var D = window.DEA_DATA;

  /* ---------- index -------------------------------------------------------- */
  var layers = D.layers;
  var layerById = {};
  layers.forEach(function (l) { layerById[l.id] = l; });

  var entities = D.entities;
  var byId = {};
  entities.forEach(function (e) { byId[e.a] = e; });

  var rels = D.rels.map(function (r, i) {
    return { id: i, f: r.f, t: r.t, l: r.l, k: r.k, c: r.c, dashed: !!r.d, def: r.i, cat: category(r.k) };
  });
  var relByKey = {};                       // "SO>II" → last relationship with that pair
  var inbound = {}, outbound = {};         // alias → relationship[]
  var children = {};                       // parent alias → specialising children
  entities.forEach(function (e) { inbound[e.a] = []; outbound[e.a] = []; });
  rels.forEach(function (r) {
    if (inbound[r.t]) inbound[r.t].push(r);
    if (outbound[r.f]) outbound[r.f].push(r);
    relByKey[r.f + '>' + r.t] = r;
  });
  entities.forEach(function (e) { if (e.sp) (children[e.sp] = children[e.sp] || []).push(e.a); });

  function degree(a) { return inbound[a].length + outbound[a].length; }

  function category(kind) {
    switch (kind) {
      case 'composition': case 'aggregation': return 'structural';
      case 'realization': case 'flow': case 'serving': case 'execution': return 'behavioral';
      case 'governance': case 'contract': return 'governance';
      case 'specialization': return 'derived';
      default: return 'coupling';           // dependency, association, anything new
    }
  }

  /* ---------- membership --------------------------------------------------- */
  function membershipKey(e) {
    if (!e.m) return 'unassigned';
    return e.m[0] === 'core' ? 'core' : 'profile:' + e.m[1];
  }
  var PROFILE_LABELS = {
    'dea:business': 'Business', 'dea:digital': 'Digital & Services', 'dea:data': 'Data & Information',
    'dea:ecosystem': 'Ecosystem', 'dea:governance': 'Governance', 'dea:technology': 'Technology', 'dea:ai': 'AI & Models'
  };
  function scopeLabel(key) {
    if (!key) return 'All';
    if (key === 'core') return 'Core';
    if (key === 'unassigned') return 'Unassigned';
    return PROFILE_LABELS[key.slice(8)] || key.slice(8);
  }
  var scopeGroups = (function () {
    var counts = {};
    entities.forEach(function (e) { var k = membershipKey(e); counts[k] = (counts[k] || 0) + 1; });
    return Object.keys(counts).sort(function (a, b) {
      var rank = function (k) { return k === 'core' ? 0 : k === 'unassigned' ? 2 : 1; };
      return rank(a) - rank(b) || a.localeCompare(b);
    }).map(function (k) { return { key: k, label: scopeLabel(k), count: counts[k] }; });
  })();

  function scopeMatches(e, key) {
    if (!key) return true;
    return membershipKey(e) === key;
  }

  /** Entities + relationships visible under a layer set and a scope key. */
  function scope(visibleLayers, scopeKey) {
    var list = entities.filter(function (e) {
      return visibleLayers.has(e.l) && scopeMatches(e, scopeKey);
    });
    var visible = {};
    list.forEach(function (e) { visible[e.a] = true; });
    return { entities: list, rels: rels.filter(function (r) { return visible[r.f] && visible[r.t]; }) };
  }

  /* ---------- search (same field ranking as src/lib/search.ts) ------------- */
  function subsequenceGap(haystack, needle) {
    var h = haystack.toLowerCase(), hi = 0, gap = 0;
    for (var i = 0; i < needle.length; i++) {
      var found = h.indexOf(needle[i], hi);
      if (found === -1) return -1;
      gap += found - hi; hi = found + 1;
    }
    return gap;
  }
  function termScore(e, qRaw) {
    var q = qRaw.toLowerCase();
    var name = e.n.toLowerCase(), alias = e.a.toLowerCase(), best = -1;
    if (alias === q) { best = 1100; }                            // an exact alias is a direct hit
    else if (name.startsWith(q)) { best = 1000 - name.length; }
    else if (name.indexOf(q) >= 0) { best = 800 - name.length; }
    else { var gap = subsequenceGap(name, q); if (gap >= 0) best = 600 - gap; }
    if (best < 0) {
      if (e.at.some(function (a) { return a[0].toLowerCase().indexOf(q) >= 0; })) best = 500;
      else if (e.d.toLowerCase().indexOf(q) >= 0) best = 400;
    }
    return best;                            // -1 = term not found
  }
  /** Every query term must match; results ranked best first. */
  function search(query, pool, limit) {
    var terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    var hits = [];
    (pool || entities).forEach(function (e) {
      var total = 0, top = null, missed = false;
      terms.forEach(function (q) {
        var s = termScore(e, q);
        if (s < 0) { missed = true; return; }
        total += s;
      });
      if (missed) return;
      hits.push({ entity: e, score: total });
    });
    hits.sort(function (a, b) { return b.score - a.score || a.entity.n.localeCompare(b.entity.n); });
    return hits.slice(0, limit || 12);
  }

  /* ---------- graph walks -------------------------------------------------- */
  function outNeighbors(a) { return outbound[a].map(function (r) { return r.t; }); }
  function inNeighbors(a) { return inbound[a].map(function (r) { return r.f; }); }

  /** Directed BFS from `a`; returns { dist: Map, prevRel: Map }. */
  function bfs(a, next) {
    var dist = {}, prev = {}, queue = [a];
    dist[a] = 0;
    while (queue.length) {
      var cur = queue.shift();
      next(cur).forEach(function (r) {            // r = {node, rel}
        if (dist[r.node] === undefined) { dist[r.node] = dist[cur] + 1; prev[r.node] = r.rel; queue.push(r.node); }
      });
    }
    return { dist: dist, prev: prev };
  }
  var stepDown = function (a) { return outbound[a].map(function (r) { return { node: r.t, rel: r }; }); };
  var stepUp = function (a) { return inbound[a].map(function (r) { return { node: r.f, rel: r }; }); };

  /** Impact trace: everything upstream and downstream of `source`. */
  function impact(source) {
    var up = bfs(source, stepUp), down = bfs(source, stepDown);
    delete up.dist[source]; delete down.dist[source];
    return {
      source: source,
      up: up.dist, down: down.dist,           // alias → hops
      upEdges: Object.keys(up.prev).map(function (a) { return up.prev[a]; }),
      downEdges: Object.keys(down.prev).map(function (a) { return down.prev[a]; })
    };
  }

  /** Shortest directed path from→to as {nodes, rels}; null when unreachable. */
  function shortestPath(from, to) {
    if (from === to) return null;
    var res = bfs(from, stepDown);
    if (res.dist[to] === undefined) return null;
    var nodes = [to], pathRels = [];
    for (var cur = to; cur !== from; cur = res.prev[cur].f) { pathRels.unshift(res.prev[cur]); nodes.unshift(res.prev[cur].f); }
    return { nodes: nodes, rels: pathRels };
  }

  /** Up to `limit` simple paths, shortest first (breadth-first enumeration). */
  function paths(from, to, limit, maxDepth) {
    if (from === to) return [];
    var found = [], queue = [[{ node: from, rel: null }]], seen = 0;
    while (queue.length && found.length < (limit || 5) && seen++ < 6000) {
      var path = queue.shift();
      var tail = path[path.length - 1].node;
      if (tail === to) { found.push(path); continue; }
      if (path.length - 1 >= (maxDepth || 6)) continue;      // path.length counts nodes, not hops
      var onPath = {}; path.forEach(function (s) { onPath[s.node] = true; });
      outbound[tail].forEach(function (r) {
        if (!onPath[r.t]) queue.push(path.concat({ node: r.t, rel: r }));
      });
    }
    return found.map(function (p) { return { nodes: p.map(function (s) { return s.node; }), rels: p.slice(1).map(function (s) { return s.rel; }) }; });
  }

  /** Suggestions for a pair with no path — the "helpful empty" state. */
  function pathSuggestions(from, to) {
    var out = { reverse: null, via: [], shared: [] };
    var rev = shortestPath(to, from);
    if (rev) out.reverse = rev;
    out.via = outbound[from].filter(function (r) { return r.t !== to && shortestPath(r.t, to); })
      .slice(0, 3).map(function (r) { return { rel: r, path: shortestPath(r.t, to) }; });
    var a = bfs(from, stepDown).dist, b = bfs(to, stepDown).dist;
    out.shared = Object.keys(a).filter(function (k) { return b[k] !== undefined; })
      .sort(function (x, y) { return a[x] - a[y]; }).slice(0, 4);
    return out;
  }

  /* ---------- matrix ------------------------------------------------------- */
  function matrix(list) {
    var ids = layers.map(function (l) { return l.id; });
    var cells = {};
    ids.forEach(function (f) { ids.forEach(function (t) { cells[f + '>' + t] = []; }); });
    list.forEach(function (r) {
      var key = byId[r.f].l + '>' + byId[r.t].l;
      if (cells[key]) cells[key].push(r);
    });
    return { ids: ids, cells: cells, total: list.length };
  }

  /* ---------- coverage ----------------------------------------------------- */
  function coverage() {
    var statusCounts = {};
    entities.forEach(function (e) { statusCounts[e.s] = (statusCounts[e.s] || 0) + 1; });
    return {
      total: entities.length,
      cataloged: entities.filter(function (e) { return !!e.repo; }).length,
      backlog: entities.filter(function (e) { return !e.repo; }),
      statusCounts: statusCounts,
      layerCounts: layers.map(function (l) { return { layer: l, count: entities.filter(function (e) { return e.l === l.id; }).length }; }),
      withEcf: entities.filter(function (e) { return e.ecf && typeof e.ecf === 'object'; }),
      liveCatalogs: entities.filter(function (e) { return e.cs; }).sort(function (a, b) { return b.cs[0] - a.cs[0]; }),
      scopes: scopeGroups
    };
  }

  /* ---------- viewpoints (src/lib/viewpoints.ts) --------------------------- */
  var VIEWPOINTS = [
    { id: 'cto', label: 'CTO', audience: 'Technology leadership',
      desc: 'Technology landscape: platforms, infrastructure, integration and the AI/automation surface. L4–L5 plus the governance profile.',
      layers: ['L4', 'L5', 'L3'], scope: 'profile:dea:technology' },
    { id: 'sa', label: 'Solution Architect', audience: 'Solution & platform architecture',
      desc: 'Structural view: the OpenDEA Core anchors plus application components, system functions and integration interfaces.',
      layers: ['L3', 'L4'], scope: 'core' },
    { id: 'ba', label: 'Business Analyst', audience: 'Process & capability design',
      desc: 'Operating model: capabilities, processes, services and the business objects they exchange. L1–L3 business profile.',
      layers: ['L1', 'L2', 'L3'], scope: 'profile:dea:business' },
    { id: 'data', label: 'Data Architect', audience: 'Data & information management',
      desc: 'Information layer: business objects, data subjects, concepts and the semantic dimension overlays.',
      layers: ['L3', 'DIM'], scope: 'profile:dea:data' },
    { id: 'gov', label: 'Governance Lead', audience: 'EA governance & assurance',
      desc: 'Causal/governance chain: guardrails, regulations, risks, controls and the governance profile membership.',
      layers: ['L1', 'L2', 'L5'], scope: 'profile:dea:governance' },
    { id: 'ecosystem', label: 'Ecosystem Manager', audience: 'Partnerships & value networks',
      desc: 'Value network: actors, stakeholders, signals and the ecosystem agreements that bind them.',
      layers: ['L1'], scope: 'profile:dea:ecosystem' },
    { id: 'core', label: 'OpenDEA Core', audience: 'Anyone learning the metamodel',
      desc: 'The stable semantic skeleton: the 9 core anchors across all layers — the minimal complete model.',
      layers: ['L1', 'L2', 'L3', 'L4', 'L5'], scope: 'core' }
  ];
  VIEWPOINTS.forEach(function (v) {
    var set = new Set(v.layers);
    v.count = scope(set, v.scope).entities.length;
    v.perLayer = layers.map(function (l) { return scope(new Set([l.id]), v.scope).entities.length; });
  });

  /* ---------- URL state (src/lib/url-state.ts, with the view param applied) - */
  var VIEWS = ['canvas', 'matrix', 'trace', 'coverage', 'catalogs', 'viewpoints'];
  function parseUrl(search) {
    var p = new URLSearchParams(search.replace(/^\?/, ''));
    var s = {};
    var view = p.get('view'); if (VIEWS.indexOf(view) >= 0) s.view = view;
    if (p.get('entity') && byId[p.get('entity')]) s.entity = p.get('entity');
    if (p.get('trace') === '1') s.trace = true;
    var ls = (p.get('layers') || '').split(',').filter(function (l) { return layerById[l]; });
    if (ls.length && ls.length < layers.length) s.layers = ls;
    if (p.get('scope') && scopeGroups.some(function (g) { return g.key === p.get('scope') || g.key.slice(8) === p.get('scope'); })) {
      s.scope = scopeGroups.filter(function (g) { return g.key === p.get('scope') || g.key.slice(8) === p.get('scope'); })[0].key;
    }
    ['tab', 'rail', 'zoom', 'dialog', 'from', 'to', 'cell', 'q', 'flayer', 'fstatus'].forEach(function (k) {
      var v = p.get(k); if (v) s[k] = v;
    });
    if (p.get('embed') === '1') s.embed = true;
    if (p.get('start') === '1') { s.start = true; s.startParam = true; }   // link-driven start panel
    return s;
  }
  function serialize(s) {
    var p = new URLSearchParams();
    var ls = s.layers instanceof Set ? Array.from(s.layers) : s.layers;
    if (s.view && s.view !== 'canvas') p.set('view', s.view);
    if (s.entity) p.set('entity', s.entity);
    if (s.trace) p.set('trace', '1');
    if (ls && ls.length && ls.length < layers.length) p.set('layers', ls.join(','));
    if (s.scope) p.set('scope', s.scope.slice(0, 8) === 'profile:' ? s.scope.slice(8) : s.scope);
    if (s.tab && s.tab !== 'overview' && s.entity) p.set('tab', s.tab);
    if (s.rail === 'compact') p.set('rail', 'compact');
    if (s.zoom && s.zoom !== 'fit') p.set('zoom', s.zoom);
    if (s.dialog && s.embed) p.set('dialog', s.dialog);
    if (s.view === 'trace') { if (s.from) p.set('from', s.from); if (s.to) p.set('to', s.to); }
    if (s.view === 'matrix' && s.cell) p.set('cell', s.cell);
    if (s.view === 'catalogs') ['q', 'flayer', 'fstatus'].forEach(function (k) { if (s[k]) p.set(k, s[k]); });
    if (s.embed) p.set('embed', '1');
    if (s.startParam) p.set('start', '1');       // only when the link asked for it
    return p.toString();
  }

  /* ---------- exports (schemas from src/lib/export.ts) --------------------- */
  function slugify(text) { return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }
  function buildJsonExport(sc, opts) {
    return {
      schema: 'dea-web-viewer/export/v1',
      generated_at: new Date().toISOString(),
      metamodel_version: D.meta.version,
      source_url: opts.url,
      filters: { membership: opts.scope || null, layers: opts.layers },
      counts: { entities: sc.entities.length, relationships: sc.rels.length },
      entities: sc.entities.map(function (e) {
        return { id: e.a, name: e.n, entity_id: e.eid, layer: layerById[e.l].name, status: e.s,
                 catalog_repo: e.repo, attributes: e.at.map(function (a) { return { name: a[0], type: a[1] }; }) };
      }),
      relationships: sc.rels.map(function (r) { return { from: r.f, to: r.t, label: r.l }; })
    };
  }
  function buildPumlExport(sc, opts) {
    var out = ["' DEA Metamodel scoped export — dea-web-viewer",
      "' metamodel " + D.meta.version + ' · ' + sc.entities.length + ' entities · ' + sc.rels.length + ' relationships'];
    if (opts.scope) out.push("' membership filter: " + opts.scope);
    out.push('');
    sc.entities.forEach(function (e) {
      out.push('entity "' + e.n + '" as ' + e.a + (e.at.length ? ' {' : ''));
      e.at.forEach(function (a) { out.push('  + ' + a[0] + ' : ' + a[1]); });
      if (e.at.length) out.push('}');
    });
    out.push('');
    sc.rels.forEach(function (r) { out.push(r.f + (r.dashed ? '..>' : '-->') + r.t + ' : "' + r.l + '"'); });
    return out.join('\n') + '\n';
  }

  DEA.model = {
    meta: D.meta, layers: layers, layerById: layerById, entities: entities, byId: byId,
    rels: rels, defs: D.defs, relByKey: relByKey, inbound: inbound, outbound: outbound,
    children: children, degree: degree, VIEWS: VIEWS,
    membershipKey: membershipKey, scopeLabel: scopeLabel, scopeGroups: scopeGroups, scope: scope,
    search: search, outNeighbors: outNeighbors, inNeighbors: inNeighbors,
    impact: impact, shortestPath: shortestPath, paths: paths, pathSuggestions: pathSuggestions,
    matrix: matrix, coverage: coverage, VIEWPOINTS: VIEWPOINTS,
    parseUrl: parseUrl, serialize: serialize,
    buildJsonExport: buildJsonExport, buildPumlExport: buildPumlExport, slugify: slugify
  };
})(window.DEA);
