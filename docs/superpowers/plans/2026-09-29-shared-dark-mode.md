# Shared Dark Mode Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for independent styling and integration tasks. No commits before localhost review, per user instruction.

**Goal:** Make the approved shared dark mode available on every generated page.

**Architecture:** A synchronous shared theme script selects and applies `data-theme` before CSS loads, then binds the toggle on DOMContentLoaded. A focused stylesheet extends shared palette tokens and fixes component colors. The site generator includes the shared assets and button everywhere; portfolio-specific theme logic is removed.

**Tech Stack:** Static HTML, CSS, browser JavaScript, Node site generator, Puppeteer browser checks.

- [x] Create `tools/template/theme.js`: validate `iv-theme` and legacy `pf-theme`, otherwise use matchMedia; apply `data-theme`; safely persist explicit choices; update button labels; follow OS and storage events.
- [x] Update `tools/build-site.mjs`: load `/assets/theme.js` before CSS on every page, add the header toggle, copy the shared assets. Remove the portfolio-only initialization. Remove theme handlers from `tools/template/portfolio.js` to avoid double toggles.
- [x] Create `tools/template/theme.css` and adapt the existing portfolio dark block in `site.css`: share root tokens, fix yellow foregrounds, header, code, tables, status colors and mobile toggle sizing. Theme figure controls while keeping diagram colors intact.
- [x] Add focused behavioral browser tests in `tools/theme.test.mjs`: test selection, legacy migration, navigation/reload, OS updates, blocked storage, keyboard, and mobile overflow. Run against localhost.
- [x] Build with `node tools/build-site.mjs`; run `node tools/check-site.mjs`, existing tests, and new browser tests. Inspect desktop/mobile screenshots of Vault, an article, progress, and portfolio.
- [x] Open localhost for user review and report the preview links. Do not commit.

Verification: 22 tests pass, 127 document pages build with zero missing diagrams; site link/asset/anchor checks and motion checks pass. Desktop/mobile screenshots inspected. Preview is served at http://localhost:4173/; changes remain uncommitted for review.
