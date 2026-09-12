# OMNIS Studio

The operator surface of the OMNIS AI operating system: where a human watches characters,
agents, production runs, publications and analytics — and approves the actions that need a
signature.

Sprint 0 delivers the **foundation**: the AI Studio aesthetic, the branding, the layout and
the theme/component wiring. No product features yet; see
[docs/PROJECT_STATUS.md](../../docs/PROJECT_STATUS.md).

## Stack

| Concern            | Choice                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| UI                 | React 19 + TypeScript (strict)                                                                            |
| Build / dev server | Vite 8                                                                                                    |
| Animation          | `framer-motion` 12 — **not** `motion`; see [ADR-0004](../../docs/07-decisions/ADR-0004-frontend-stack.md) |
| Design system      | `@omnis/theme` (tokens as pure data) + `@omnis/ui` (components, `ThemeProvider`)                          |
| Styling            | `--omnis-*` CSS custom properties emitted from theme tokens; no CSS-in-JS runtime, no utility framework   |
| Tests              | Vitest 5 + happy-dom + Testing Library — 54 tests                                                         |

## Commands

```bash
pnpm install          # from the repository root
pnpm --filter studio run dev        # HMR dev server
pnpm --filter studio run build      # tsc -b && vite build
pnpm --filter studio run typecheck  # tsc -b
pnpm --filter studio run lint       # eslint src vite.config.ts vitest.config.ts
pnpm --filter studio run test       # vitest run
pnpm --filter studio run preview    # preview the production build
```

From the repository root, `pnpm dev` and `pnpm check` cover this app along with everything
else.

## Structure

```text
src/
├── main.tsx                     entry: mounts the app, loads OMNIS global styles
├── App.tsx                      route composition
├── foundation.ts                honest capability flags for surfaces not yet implemented
├── components/
│   ├── branding/                Logo, Tagline — animated identity
│   ├── effects/                 AuroraBackground, Orb — the signature ambience
│   └── layout/                  RootLayout — responsive shell
├── lib/motionTokens.ts          motion values derived from theme tokens
├── pages/Welcome/               WelcomePage
├── styles/globals.css           OMNIS global styles (tokens are emitted by the theme)
├── theme/                       studioTheme + StudioThemeProvider (composes @omnis/theme)
└── __tests__/                   foundation, styles, theme, motion tokens, welcome page
```

## Rules that apply here

1. **Consume tokens, never raw values.** A component that hard-codes a colour, spacing step
   or duration cannot be themed, and `styles.test.ts` / `motionTokens.test.ts` exist to
   catch it.
2. **Use `@omnis/ui` before writing a new control.** If a component is missing, add it to
   the library — Studio is not where shared controls are invented.
3. **Preserve the visual direction.** Aurora, orb, futuristic typography, animated branding,
   dark AI-Studio aesthetic, responsive layout and motion are product decisions, not
   decoration. A change that flattens them into a generic dashboard is a regression.
4. **No domain logic, no data fetching in components.** Studio composes contracts; the
   platform owns behaviour.
5. **No secrets, ever.** Nothing in this bundle may hold a credential — provider access
   happens behind server-side adapters. See
   [docs/01-architecture/SECURITY_BOUNDARIES.md](../../docs/01-architecture/SECURITY_BOUNDARIES.md).
6. **`foundation.ts` tells the truth.** Surfaces that are not implemented are declared as
   not implemented; presenting them as running would be a claim the platform cannot keep.

## Where to read next

- [docs/01-architecture/PLATFORM_FOUNDATION.md](../../docs/01-architecture/PLATFORM_FOUNDATION.md) — packages and layering
- [docs/07-decisions/ADR-0004-frontend-stack.md](../../docs/07-decisions/ADR-0004-frontend-stack.md) — why this stack
- [docs/05-implementation/MONOREPO.md](../../docs/05-implementation/MONOREPO.md) — commands, pitfalls, known constraints
- [packages/ui](../../packages/ui) and [packages/theme](../../packages/theme) — the design system
