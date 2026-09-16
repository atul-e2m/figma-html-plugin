# Figma → HTML / JSX Plugin — Research Findings

## Goal
A Figma plugin the user installs in Figma, selects a frame, and converts to
HTML+CSS or JSX/React at Anima-level accuracy. Free, company-wide, no per-use fee.

## Finding 1 — Running INSIDE Figma is the accuracy advantage

The Figma Plugin API gives values the REST API and .fig parsing cannot:

| Data | Plugin API | REST API / .fig |
|---|---|---|
| Resolved auto-layout (flex/gap/padding) | Exact | Partly / inferred |
| Rendered text bounds after wrapping | Exact (`node.height`) | Guessed |
| Computed style inheritance | Resolved | Manual |
| Variables / design tokens bound | Live | Partial |
| Vector export | `exportAsync()` | Re-render |
| Component/variant relationships | Full | Partial |

This is WHY Anima ships a Figma plugin. Not packaging — accuracy.
`auto_layout_inference.py` (256 lines) exists solely to GUESS what the plugin API
returns as fact. Inside Figma, that whole class of error disappears.

## Finding 2 — A plugin export path ALREADY EXISTS in dev-command

- `agents/figma-html-plugin-extractor.md`
- `scripts/extract_plugin_export.py` (SUPPORTED_SCHEMA_MAJOR = "1")

Its own docstring says the plugin export is:
"higher-fidelity than what figma-html-local-extractor computes itself"
and needs "nothing to re-extract, only to NORMALIZE".

The consuming contract (schema_version 1.x):
  - section-specs.json   (auto-layout flex/gap/padding already resolved)
  - tokens.json
  - content.json
  - images/asset-manifest.json
  - per-section + full-page screenshots

=> The new plugin should EMIT THIS SCHEMA. Downstream needs zero changes.

## Finding 3 — Anima's SDK contains no conversion logic
~8 files of HTTP client. Engine is server-side (public-api.animaapp.com).
Nothing to reverse-engineer; nothing copied. Learn from their PRODUCT SURFACE only:
  - styling: plain_css | tailwind | inline_styles
  - enableCompactStructure (reduce wrapper nesting)
  - enableAutoSplit + autoSplitThreshold
  - responsivePages: multiple frame ids -> one page (real frames, not inferred)
  - node gate: FRAME/INSTANCE/COMPONENT/COMPONENT_SET/GROUP only

## Legal
Building our own converter: fully legitimate, free, unlimited.
Figma Plugin API is public and documented.
Copying Anima's proprietary engine: not possible (not shipped) and not attempted.
