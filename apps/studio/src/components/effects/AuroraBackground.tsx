/**
 * The aurora: the animated background the whole Studio aesthetic is built on.
 *
 * WHY IT IS THEME DATA AND NOT A CSS FILE
 * ---------------------------------------
 * The gradient stops come from `theme.effects.aurora.layers`. The previous
 * implementation hard-coded three `rgba()` stops in `globals.css`, which meant a
 * theme switch could not change the single most recognisable element of the product.
 * Reading the layers from the theme means the light and AI Studio themes each bring
 * their own sky, with no component change.
 *
 * WHY THE LAYERS MOVE INDEPENDENTLY
 * ---------------------------------
 * Three static radial gradients look like a stain. Drifting them at different rates
 * and amplitudes produces parallax, which is what makes the background read as depth
 * rather than as decoration — and depth is what makes the glass panels above it mean
 * something.
 *
 * The whole thing is `aria-hidden` and `pointer-events: none`: it is decoration, it
 * must never be announced, and it must never intercept a click meant for a control.
 */

import { motion, useReducedMotion } from "framer-motion";
import { auroraBackground } from "@omnis/theme";
import { useTheme } from "@omnis/ui";
import { resolveMotion } from "../../lib/motionTokens";

/** Per-layer drift, as a fraction of the viewport. */
const LAYER_DRIFT: readonly { readonly x: string; readonly y: string; readonly scale: number }[] = [
  { x: "4%", y: "-3%", scale: 1.08 },
  { x: "-5%", y: "3%", scale: 1.12 },
  { x: "3%", y: "4%", scale: 1.05 },
  { x: "-3%", y: "-4%", scale: 1.1 },
];

export default function AuroraBackground() {
  const { theme, reducedMotion } = useTheme();
  // framer-motion's own query, so a component that animates imperatively still
  // honours the preference even if the theme did not ask it to.
  const prefersReducedMotion = useReducedMotion() === true;
  const still = reducedMotion || prefersReducedMotion;
  const motionTokens = resolveMotion(theme.motion);
  const layers = theme.effects.aurora.layers;

  return (
    <div className="aurora" aria-hidden="true" data-testid="aurora">
      {/* The page colour sits underneath so the gradients composite over the theme's
          own background rather than over whatever the browser defaulted to. */}
      <div
        className="aurora__base"
        style={{ position: "absolute", inset: 0, background: auroraBackground(theme) }}
      />

      {layers.map((layer, index) => {
        const drift = LAYER_DRIFT[index % LAYER_DRIFT.length];
        if (drift === undefined || still) {
          return (
            <div
              key={`${index}-${layer.slice(0, 24)}`}
              className="aurora__layer"
              style={{ background: layer }}
            />
          );
        }
        // Each layer gets a different duration derived from the same token, so a
        // theme that lengthens ambient motion slows the whole sky rather than one
        // part of it.
        const duration = motionTokens.ambient * (1 + index * 0.35);
        return (
          <motion.div
            key={`${index}-${layer.slice(0, 24)}`}
            className="aurora__layer"
            style={{ background: layer }}
            animate={{
              x: ["0%", drift.x, "0%"],
              y: ["0%", drift.y, "0%"],
              scale: [1, drift.scale, 1],
            }}
            transition={{
              duration,
              repeat: Number.POSITIVE_INFINITY,
              ease: motionTokens.standard,
              delay: index * 0.6,
            }}
          />
        );
      })}

      <div className="aurora__vignette" />
    </div>
  );
}
