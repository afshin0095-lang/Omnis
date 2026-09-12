# ADR-0004: Frontend Stack

- Status: Accepted
- Date: 2026-09-11
- Sprint: 0
- Related: [ADR-0001](ADR-0001-monorepo-and-toolchain.md),
  [ADR-0002](ADR-0002-domain-boundaries.md),
  [PLATFORM_FOUNDATION.md](../01-architecture/PLATFORM_FOUNDATION.md)

## Context

Studio is the operator surface of an autonomous platform: it will show characters being
created, agents executing, content moving through a factory, publications being approved and
analytics feeding a learning loop. Three constraints shaped the stack.

1. **The visual direction already existed and had to be preserved.** The Aurora background,
   the animated orb, the futuristic typographic branding and the dark AI-Studio aesthetic
   were the one part of the pre-Sprint-0 application worth keeping. A stack change that
   flattened it into a generic dashboard would have been a product regression dressed as
   engineering.
2. **The theme had to survive a future beyond the browser.** OMNIS clients will include
   desktop and mobile surfaces. Design tokens locked inside a React provider or a CSS
   pipeline cannot serve them.
3. **The repository was broken.** `apps/studio/src/main.tsx` imported a leftover Vite
   template stylesheet rather than OMNIS styles, several components imported `motion/react`
   — a package that does not exist in this workspace — and the app shipped starter assets
   (`react.svg`, `vite.svg`, `hero.png`) beside real ones.

## Decision

### Framework and build

| Concern                  | Choice                                   | Version          |
| ------------------------ | ---------------------------------------- | ---------------- |
| UI library               | React                                    | 19.3             |
| Bundler / dev server     | Vite                                     | 8.1              |
| React plugin             | `@vitejs/plugin-react`                   | 6.0              |
| Animation                | **`framer-motion`**                      | 12.42            |
| Class composition        | `clsx`                                   | 2.1              |
| Component tests          | Vitest + happy-dom + Testing Library     | 5 / 20.14 / 16.3 |
| Module resolution (apps) | `Bundler` + `allowImportingTsExtensions` | —                |

### 1. `framer-motion`, not `motion`

The unresolved `motion/react` imports were the visible symptom. The workspace installs
`framer-motion@12`, whose API is what the Studio components are written against; adding the
`motion` package alongside it would put **two copies of the same animation engine** in the
dependency graph, with two spring implementations and two sets of motion values. Imports read
`from "framer-motion"`, and the catalog comment in `pnpm-workspace.yaml` says so where a
contributor would otherwise re-introduce the mistake.

### 2. The theme is pure data; the provider lives in the UI package

`@omnis/theme` (layer 0) contains tokens and themes and **nothing else** — no React, no CSS
pipeline, no runtime dependency. It supports runtime composition (`mergeTheme`) and
token resolution (`resolveToken`), so a user-customisable theme is a data problem, not a
framework problem. `ThemeProvider` lives in `@omnis/ui`, which is the only layer allowed to
know about React. `@omnis/theme` emits the canonical `--omnis-*` custom properties
(`css/variables.ts`), and that naming scheme is the single source of truth for CSS.

### 3. Styling is tokens plus CSS custom properties — no CSS-in-JS runtime, no utility framework

Components read `CSS_VARS.*` (typed references to `--omnis-*`) and compose class names with
`cn`. Consequences: a component cannot invent a pixel value, a theme change reaches every
component without an edit, and there is no runtime style engine to ship to the operator's
browser. Tailwind was rejected because the design vocabulary is a token system with semantic
names (`surfaceActive`, `textOnPrimary`, `shadowGlow`), which utility classes express worse,
not better.

### 4. Components are accessible by construction

Fifteen components (`Button`, `Card`, `Input`, `Badge`, `Panel`, `Surface`, `Stack`, `Text`,
`Spinner`, `Modal`, `Tooltip`, `Divider`, `IconButton`, `Progress`, `EmptyState`) render
semantic elements, are keyboard operable, accept `className`/`style` extension, consume theme
tokens, and are typed. `Button` renders a real `<button>` unless `as` replaces it, defaults
`type="button"` (React's default `submit` is a form bug waiting to happen), and its loading
state uses `disabled` + `aria-busy` rather than `aria-disabled`, because a button whose
action is in flight must not fire again.

### 5. happy-dom, not jsdom

Faster and sufficient for a component library. Its limits are documented rather than
papered over: no `backdrop-filter`, no `-webkit-line-clamp`, no `color-mix()` inside
shorthand, no `min()` in `width`, `border` shorthand drops `var()`, and its `dataset` proxy
ignores `removeAttribute`. Tests that need a literal style attribute use
`renderToStaticMarkup` and assert longhand properties. `@testing-library/jest-dom` is not
used: its matchers add a dependency for assertions the DOM API already answers.

### 6. Studio keeps its identity

`RootLayout`, `WelcomePage`, `AuroraBackground`, `Orb`, `Logo` and `Tagline` were repaired
rather than replaced, and now consume theme tokens and `@omnis/ui`. Motion is driven by theme
motion tokens (`motionTokens.ts`) rather than hard-coded durations, so the aesthetic is
themeable instead of baked in. Vite starter artefacts and obsolete per-app CSS
(`index.css`, `themes.css`, `tokens.css`, `styles/tokens/*.css`) were removed once nothing
imported them; `styles/globals.css` now loads OMNIS tokens.

### 7. Pre-agreed but unused

`react-router-dom`, `zustand` and `lucide-react` are in the catalog with agreed versions but
**no member depends on them yet**. Sprint 0 has one route and no client state beyond React's
own. Declaring the versions now prevents a future skew argument; adopting them is a Sprint 1+
decision that needs its own justification.

## Alternatives considered

**`motion` (the successor package).** Rejected for Sprint 0: it is the same engine under a
new name and module layout, and migrating means touching every animated component while
carrying two copies mid-migration. Revisit as a single, deliberate migration when a feature
needs it.

**Next.js / Remix.** Rejected: Studio is an authenticated operator surface, not a public
content site. Server-side rendering buys nothing here and adds a runtime, a routing model and
a deployment shape OMNIS has not chosen yet.

**Tailwind CSS.** Rejected: see Decision 3. A semantic token system and utility classes solve
different problems, and the tokens already exist.

**styled-components / Emotion.** Rejected: a runtime style engine in an operator dashboard
that renders long lists of executions and metrics, for styling that is fully expressible as
custom properties.

**jsdom.** Rejected on speed; kept as the fallback if a component ever needs behaviour
happy-dom does not implement.

**Keeping the theme inside `@omnis/ui`.** Rejected: it would force every non-React client to
depend on React to read a colour. See [ADR-0002](ADR-0002-domain-boundaries.md).

## Consequences

**Positive**

- One animation engine, one styling mechanism, one token source.
- The theme can serve a desktop or mobile client unchanged.
- 166 UI tests and 54 Studio tests run in happy-dom in seconds, with no browser in CI.
- The visual direction survived the reset and is now token-driven rather than hard-coded.

**Negative / accepted costs**

- happy-dom's gaps mean some visual behaviour cannot be asserted in unit tests; those need a
  browser-based check later (tracked with the deferred hardening list).
- `framer-motion@12` is not the newest packaging of the library; the migration debt is
  recorded here rather than hidden.
- Typed `CSS_VARS` references must be kept in sync with the theme's emitted variables — the
  `utils.test.ts` assertion that every referenced custom property is published by the theme
  is what makes that safe.

## Compliance

`pnpm verify:workspace` confines React to `@omnis/ui` and `studio` and `framer-motion` to
`studio`. Studio's tests assert that global styles and theme variables are actually loaded,
that motion values come from theme tokens, and that the app composes `@omnis/theme` with
`@omnis/ui` — so a regression to starter-template styling fails the gate.
