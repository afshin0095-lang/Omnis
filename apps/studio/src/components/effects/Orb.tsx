/**
 * The orb: the Studio's focal point and its one piece of signature motion.
 *
 * Everything about it is theme data — diameter, core gradient, breathing amplitude —
 * so the AI Studio theme can make it larger and slower than the product default
 * without this component knowing.
 *
 * THE RINGS
 * ---------
 * Two counter-rotating rings were added around the core. A breathing circle on its
 * own reads as a decorative blob; rings give it an axis and a sense of mechanism,
 * which is the difference between "pretty" and "instrument". They are dashed and
 * low-contrast so they suggest structure without competing with the wordmark.
 *
 * ACCESSIBILITY
 * -------------
 * The orb is decoration and is `aria-hidden`. It conveys no state: a loading
 * indicator that is also the brand mark would be ambiguous, so loading gets a
 * `Spinner` from `@omnis/ui` instead.
 */

import { motion, useReducedMotion } from "framer-motion";
import { useTheme } from "@omnis/ui";
import { resolveMotion } from "../../lib/motionTokens";

export default function Orb() {
  const { theme, reducedMotion } = useTheme();
  const prefersReducedMotion = useReducedMotion() === true;
  const still = reducedMotion || prefersReducedMotion;
  const motionTokens = resolveMotion(theme.motion);
  const { size, core, breatheScale } = theme.effects.orb;

  return (
    <div className="orb" aria-hidden="true" data-testid="orb" style={{ width: size, height: size }}>
      <div className="orb__ring orb__ring--outer" />

      {still ? (
        <div
          className="orb__core"
          style={{
            width: size,
            height: size,
            background: core,
            boxShadow: theme.shadows.glowStrong,
          }}
        />
      ) : (
        <motion.div
          className="orb__core"
          style={{
            width: size,
            height: size,
            background: core,
            boxShadow: theme.shadows.glowStrong,
          }}
          // Breathing, not bouncing: the scale returns to rest and the easing is
          // symmetric, so the motion reads as a system at idle rather than as a
          // notification demanding attention.
          animate={{ scale: [1, breatheScale, 1] }}
          transition={{
            duration: motionTokens.ambient,
            repeat: Number.POSITIVE_INFINITY,
            ease: "easeInOut",
          }}
        />
      )}

      {still ? (
        <div className="orb__ring orb__ring--inner" />
      ) : (
        <motion.div
          className="orb__ring orb__ring--inner"
          animate={{ rotate: 360 }}
          transition={{
            duration: motionTokens.ambient * 6,
            repeat: Number.POSITIVE_INFINITY,
            ease: "linear",
          }}
        />
      )}
    </div>
  );
}
