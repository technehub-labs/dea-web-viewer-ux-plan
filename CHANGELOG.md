# Changelog

Versions follow [SemVer](https://semver.org/) for the package as a whole:
major = a new deliverable or a change of direction, minor = more coverage,
patch = corrections.

## [2.0.0] - 2026-11-24

Direction set for this version: white background, one consistent palette, a
corporate layout, intuitive controls and dialogs, a modern type scheme, and
design tokens as the single source of truth. Responsive behaviour is a
requirement, not a phase.

### Added

- **Design tokens** (`tokens.css`): primitives, semantic roles (surfaces, text,
  brand, status, layers, relationships, canvas), typography, spacing, control
  sizes, shell dimensions, radius, elevation, motion, stacking. Contrast is
  verified per token (text ≥ 4.5:1, lines ≥ 3:1 on white).
- **Type scheme**: Geist + Geist Mono, self-hosted variable fonts.
- **UI kit** (`ui.css`): buttons, icon buttons, filter chips, alias tags,
  status badges, fields, segmented control, switch, tabs, cards, rows, key-value
  lists, tables, bars, empty states, modal dialogs, command palette, bottom
  sheets, anchored menus, toasts and tooltips — built only from tokens.
- **Interactive prototype** (`prototype.html`) on the real synced metamodel:
  - Responsive shell: labelled rail on desktop, compact rail on tablet, bottom
    tab bar and sheets on mobile. All six views are reachable at every width.
  - White canvas: per-lane layout that re-flows to maximise fit, orthogonal
    edge routing through gutters, fit-on-load, pan / scroll-zoom / pinch,
    minimap, and semantic zoom (overview → names → detail).
  - Inspector (overlay drawer on desktop, bottom sheet on mobile) with
    Overview, Relations, Impact and Catalog tabs; impact trace on the canvas.
  - Command palette (⌘K or `/`) for entities, views and actions; export
    (SVG, PNG, JSON, PlantUML); share dialog; keyboard shortcuts; legend;
    layer and membership filters with undo.
  - Matrix, Traceability (opens on a real path; suggests alternatives when no
    path exists), Coverage, Catalogs and Viewpoints views.
  - The URL is the source of truth: view, selection, trace, filters, zoom and
    dialogs survive a reload.
- `tools/build-assets.py` to regenerate model data and icons from a
  `dea-web-viewer` checkout.

### Fixed

- Plan: the Coverage finding (F-10) said 60 planned entities; the model has 66.

### Not yet in this version

- The plan document (`index.html`) still uses the 1.0.0 layout and has not
  been restyled onto the tokens.

## [1.0.0] - 2026-11-23

- Audit of the live viewer with evidence: 10 findings (3 P0), among them two
  views unreachable by mouse at every tested width, no layout below desktop,
  and deep links that never restore the view.
- Five strategies with mockups and walkthroughs, a responsive blueprint, a
  three-phase roadmap and acceptance metrics.
