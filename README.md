# DEA Web Viewer — UX Improvement Plan

Visual plan and strategy review for https://technehub-labs.github.io/dea-web-viewer/
(audited live at v1.0.0 on 2026-11-23, cross-checked against the source in
`~/Developer/dea-web-viewer`).

## View the plan

Open `index.html` in any browser (works from disk, no server needed — all
styles and mockups are inline; evidence screenshots load from `assets/`).

A loopback preview server may also be running from the review session:
`http://127.0.0.1:8791/` (start: `python3 -m http.server 8791` in this folder;
stop: `kill` the python process or just close the terminal).

## What's inside

| Section | Content |
|---|---|
| §1 Audit | 10 findings (3 × P0) with live evidence screenshots in `assets/` |
| §2 Strategies | S1 responsive shell & IA · S2 fit-on-load + progressive disclosure · S3 guided starts · S4 unified inspection loop · S5 deep links & viewpoints — each with mockups at desktop/tablet/mobile and a step-by-step walkthrough |
| §3 Responsive blueprint | Component-by-component breakpoint contract (390 → 2560) |
| §4 Roadmap | Phase 0 quick wins (days) → Phase 1 shell + inspector (1–2 wks) → Phase 2 canvas craft + personas (2–4 wks) |
| §5 Metrics | Measurable acceptance criteria (7/7 views clickable, <1 s to see the model, 100 % deep-link restore, …) |

## Headline findings (P0)

1. **F-01** — Coverage and Viewpoints tabs are painted over by the search box at
   1440/1920/2560 px; unreachable by mouse (DOM-rect verified).
2. **F-02** — No responsive layout: at 390 px the header eats ~250 px and 6 of 7
   views are unreachable; "Press Esc" hint shown on touch.
3. **F-03** — `?view=` deep links are parsed but never applied
   (`src/App.tsx:65` vs hydration at lines 99–101); URL is then rewritten, so
   every shared link lands on Canonical SVG.

## Status

For review — nothing here has been implemented. Approve/edit strategies, then
implementation would follow the roadmap phases as PRs against
`technehub-labs/dea-web-viewer`.
