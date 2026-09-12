/**
 * The Studio welcome surface.
 *
 * This is the screen the existing Studio already had, and its visual identity is
 * preserved: the aurora, the breathing orb, the widely-tracked wordmark, the tagline,
 * all on a near-black field. What is new is that every one of those elements is now
 * driven by theme data and composed from the shared component library, so the same
 * screen renders correctly under three themes.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * No dead controls. A button that does nothing is a promise the product cannot keep,
 * so the only interactive elements on this screen are ones that work: the theme
 * switcher changes the running theme, and the inspector opens a dialog describing the
 * theme that is actually in effect.
 *
 * No dashboard. Instrumentation belongs to the surfaces that will own it, once the
 * services behind them exist.
 */

import { useState } from "react";
import type { ReactNode } from "react";
import { Badge, Button, Divider, Modal, Stack, Surface, Text } from "@omnis/ui";
import { themeToCssVariables } from "@omnis/theme";
import Logo from "../../components/branding/Logo";
import Tagline from "../../components/branding/Tagline";
import Orb from "../../components/effects/Orb";
import RootLayout from "../../components/layout/RootLayout";
import { FOUNDATION_DESCRIPTIONS, FOUNDATION_PACKAGES } from "../../foundation";
import { useStudioTheme } from "../../theme/StudioThemeProvider";

/** Renders the active theme's own values, read from the theme object at runtime. */
function ThemeInspector(): ReactNode {
  const { theme } = useStudioTheme();
  const variables = themeToCssVariables(theme);

  const rows: readonly (readonly [string, string])[] = [
    ["Identifier", theme.id],
    ["Colour scheme", theme.colorScheme],
    ["Published custom properties", String(Object.keys(variables).length)],
    ["Aurora layers", String(theme.effects.aurora.layers.length)],
    ["Orb diameter", theme.effects.orb.size],
    ["Breathing amplitude", `×${theme.effects.orb.breatheScale}`],
    ["Ambient motion", theme.motion.duration.deliberate],
    ["Interaction motion", theme.motion.duration.normal],
    ["Glass blur", theme.surfaces.glass.blur],
    ["Modal layer", String(theme.zIndex.modal)],
  ];

  return (
    <Stack gap={4}>
      <Stack direction="row" gap={2} wrap>
        {(
          [
            ["background", theme.colors.background],
            ["surface", theme.colors.surfaceRaised],
            ["primary", theme.colors.primary],
            ["secondary", theme.colors.secondary],
            ["accent", theme.colors.accent],
            ["success", theme.colors.success],
            ["warning", theme.colors.warning],
            ["danger", theme.colors.danger],
          ] as const
        ).map(([role, value]) => (
          <Surface
            key={role}
            title={`${role}: ${value}`}
            radius="sm"
            bordered
            style={{ width: "2.5rem", height: "2.5rem", background: value }}
          />
        ))}
      </Stack>

      <Divider />

      <dl
        style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.5rem 1rem" }}
      >
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: "contents" }}>
            <dt>
              <Text size="sm" tone="subtle">
                {label}
              </Text>
            </dt>
            <dd style={{ margin: 0, textAlign: "right" }}>
              <Text size="sm" mono>
                {value}
              </Text>
            </dd>
          </div>
        ))}
      </dl>
    </Stack>
  );
}

export default function WelcomePage() {
  const { theme, themeId, available, selectTheme } = useStudioTheme();
  const [inspectorOpen, setInspectorOpen] = useState(false);

  return (
    <RootLayout>
      <Stack as="section" className="welcome" gap={8} align="center">
        <Orb />

        <Stack gap={3} align="center">
          <Logo />
          <Tagline />
        </Stack>

        <Stack direction="row" gap={2} align="center" justify="center" wrap>
          <Badge tone="success" dot>
            Foundation online
          </Badge>
          <Badge tone="primary">Sprint 0</Badge>
          <Badge tone="neutral">{theme.name}</Badge>
        </Stack>

        <Stack gap={2} align="center">
          <Text size="xs" tone="subtle" tracking="wide">
            Interface theme
          </Text>
          <div className="welcome__themes">
            {available.map((option) => {
              const selected = option.id === themeId;
              return (
                <Button
                  key={option.id}
                  size="sm"
                  variant={selected ? "primary" : "ghost"}
                  // `aria-pressed` because this is a toggle among mutually exclusive
                  // options rendered as buttons; a radiogroup would be the alternative
                  // and would require arrow-key handling these controls do not need.
                  aria-pressed={selected}
                  onClick={() => selectTheme(option.id)}
                >
                  {option.name}
                </Button>
              );
            })}
          </div>
        </Stack>

        <Button size="lg" glow onClick={() => setInspectorOpen(true)}>
          Inspect this theme
        </Button>

        <Stack gap={2} align="center">
          <Text size="xs" tone="subtle" tracking="wide">
            Shared foundation packages
          </Text>
          <Text as="p" size="xs" tone="subtle" mono className="welcome__services">
            {FOUNDATION_PACKAGES.join(" · ")}
          </Text>
        </Stack>
      </Stack>

      <Modal
        open={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        title={theme.name}
        description="Every value below is read from the theme object that is in effect right now."
        size="md"
        footer={
          <Button variant="secondary" onClick={() => setInspectorOpen(false)}>
            Close
          </Button>
        }
      >
        <ThemeInspector />

        <Divider />

        <Stack gap={2}>
          {FOUNDATION_PACKAGES.map((name) => (
            <Stack key={name} direction="row" gap={3} align="baseline">
              <Text size="xs" mono tone="primary" style={{ minWidth: "11rem" }}>
                {name}
              </Text>
              <Text size="xs" tone="muted">
                {FOUNDATION_DESCRIPTIONS[name]}
              </Text>
            </Stack>
          ))}
        </Stack>
      </Modal>
    </RootLayout>
  );
}
