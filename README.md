# DEA Web Viewer — UX Plan & Design Prototype

Design work for the [DEA Web Viewer](https://technehub-labs.github.io/dea-web-viewer/):
the audit and strategy plan, a token-driven design system, and a clickable
prototype of the modernised viewer. Nothing here changes the viewer itself —
it is the reference for implementing the plan in
[`technehub-labs/dea-web-viewer`](https://github.com/technehub-labs/dea-web-viewer).

**Current version: 2.0.0** — see [CHANGELOG.md](CHANGELOG.md).

## View it

Published on GitHub Pages:

| URL | What it is |
|---|---|
| <https://technehub-labs.github.io/dea-web-viewer-ux-plan/> | The plan — audit, strategies, responsive blueprint, roadmap, metrics |
| <https://technehub-labs.github.io/dea-web-viewer-ux-plan/prototype.html> | The interactive prototype — start here for the design |

Or run the same static files locally. Serve the folder over HTTP (fonts and
embeds need it; opening from `file://` falls back to system fonts):

```bash
cd dea-web-viewer-ux-plan && python3 -m http.server 8791 --bind 127.0.0.1
```

## What's inside

| Path | Role |
|---|---|
| `tokens.css` | **Design tokens** — the single source of truth for colour, type, space, shape, elevation, motion |
| `fonts.css`, `assets/fonts/` | Geist + Geist Mono, self-hosted (SIL OFL 1.1) |
| `ui.css` | UI kit built only from tokens: buttons, chips, tags, badges, fields, tabs, dialogs, sheets, menus, toasts |
| `prototype.html`, `prototype.css`, `js/app-*.js` | The prototype: responsive shell, white canvas, inspector, command palette, dialogs, six views |
| `index.html` | The plan document (still the 1.0.0 layout — restyling it onto the tokens is the next step) |
| `js/data.js`, `js/icons.js` | Generated — the real synced metamodel, and icon data from the viewer's own lucide version |
| `tools/build-assets.py` | Regenerates the two generated files from a local `dea-web-viewer` checkout |
| `assets/*.png` | Evidence screenshots of the current viewer, captured for the audit |

### The token rule

Components consume **semantic** tokens (`--text-primary`, `--bg-canvas`,
`--brand`, `--layer-3-ink`…), never primitives and never literals. Change a
token in `tokens.css` and the plan, the UI kit and the prototype change
together. Layer hues and their ink colours come from the metamodel's own
published palette; every text token clears 4.5:1 on white and every line or
edge clears 3:1 (figures are noted in the file).

### Keep the data current

The prototype renders the real model (81 entities, 135 relationships). After
the viewer's CI sync pulls a new metamodel:

```bash
python3 -I tools/build-assets.py /path/to/dea-web-viewer
```

## State of the work

- **Done and verified** — tokens, UI kit, and the prototype at desktop, tablet
  and phone widths: shell, canvas (overview → names → detail zoom, minimap,
  impact trace), inspector, search, export, share, shortcuts, legend, filters,
  and the Matrix, Traceability, Coverage, Catalogs and Viewpoints views.
- **Not done** — the plan document itself (`index.html`) has not been moved
  onto the tokens yet, so it still looks like version 1.0.0.

## Licences

Geist and Geist Mono are licensed under the SIL Open Font License 1.1
(`assets/fonts/Geist-OFL.txt`). Icon path data is from
[Lucide](https://lucide.dev) (ISC).
