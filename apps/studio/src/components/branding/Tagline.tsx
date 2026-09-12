/**
 * The Studio tagline.
 *
 * Kept verbatim from the existing Studio — "Future Starts Today" is established copy
 * and changing it is a brand decision, not an architecture one. What changed is that
 * its size, tracking and colour now come from theme tokens instead of a stylesheet
 * literal, so it follows the active theme.
 *
 * The reveal is a line-mask rise rather than a fade: the text slides up from behind
 * an edge, which reads as the interface assembling itself. It is delayed until the
 * wordmark has finished arriving, because two things entering at once means neither
 * is noticed.
 */

import { motion, useReducedMotion } from "framer-motion";
import { Text, useTheme } from "@omnis/ui";
import { resolveMotion } from "../../lib/motionTokens";

/** The Studio's tagline. */
export const TAGLINE = "Future Starts Today";

export default function Tagline() {
  const { theme, reducedMotion } = useTheme();
  const prefersReducedMotion = useReducedMotion() === true;
  const still = reducedMotion || prefersReducedMotion;
  const motionTokens = resolveMotion(theme.motion);

  return (
    // `overflow: hidden` is the mask: without it the rise is visible from outside the
    // line box and reads as a jump rather than as a reveal.
    <div style={{ overflow: "hidden", display: "block" }}>
      {still ? (
        <Text size="lg" tone="muted" tracking="wide" data-testid="tagline">
          {TAGLINE}
        </Text>
      ) : (
        <motion.div
          initial={{ y: "110%" }}
          animate={{ y: "0%" }}
          transition={{
            delay: motionTokens.normal * 2,
            duration: motionTokens.normal * 3,
            ease: motionTokens.emphasized,
          }}
        >
          <Text size="lg" tone="muted" tracking="wide" data-testid="tagline">
            {TAGLINE}
          </Text>
        </motion.div>
      )}
    </div>
  );
}
