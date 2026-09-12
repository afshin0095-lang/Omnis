/**
 * The OMNIS wordmark.
 *
 * PRESERVED, THEN IMPROVED
 * ------------------------
 * The existing Studio already had this: a display-sized, widely-tracked, bold
 * "OMNIS" that fades up on load. That is the identity, so the type treatment is
 * untouched — size, weight and tracking all come from the same scale, and the
 * tracking value is the one the original stylesheet used.
 *
 * What changed is that the reveal is per glyph with a stagger, and each glyph
 * de-blurs as it arrives. A single block fade looks like a page loading; a stagger
 * looks like a system coming online, which is the feeling the Studio is after.
 *
 * TRACKING AND CENTRING
 * ---------------------
 * `letter-spacing` adds space *after* the final glyph, so a centred wordmark sits
 * half a tracking step to the left of true centre. `.studio-wordmark` compensates
 * with an equal `text-indent`. At the display tracking this theme uses the error is
 * several pixels and plainly visible.
 *
 * SEMANTICS
 * ---------
 * One `<h1>`, containing the product name and nothing else. The glyphs are wrapped in
 * spans for animation, which is why the accessible name is asserted in the tests: a
 * per-glyph reveal must not turn "OMNIS" into "O M N I S" for a screen reader.
 */

import { motion, useReducedMotion } from "framer-motion";
import { Text, useTheme } from "@omnis/ui";
import { resolveMotion } from "../../lib/motionTokens";

/** The wordmark, as glyphs. Kept as data so the stagger has something to iterate. */
const WORDMARK = "OMNIS";

export default function Logo() {
  const { theme, reducedMotion } = useTheme();
  const prefersReducedMotion = useReducedMotion() === true;
  const still = reducedMotion || prefersReducedMotion;
  const motionTokens = resolveMotion(theme.motion);

  return (
    <Text
      as="h1"
      size="display"
      weight="bold"
      tracking="display"
      className="studio-wordmark"
      data-testid="wordmark"
    >
      {/* aria-hidden on the animated glyphs, with the whole word supplied as the
          heading's accessible name, so the reveal cannot be read as five separate
          characters. */}
      <span aria-hidden="true">
        {WORDMARK.split("").map((glyph, index) =>
          still ? (
            <span className="studio-wordmark__glyph" key={glyph}>
              {glyph}
            </span>
          ) : (
            <motion.span
              className="studio-wordmark__glyph"
              key={glyph}
              initial={{ opacity: 0, y: 24, filter: "blur(10px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              transition={{
                delay: index * motionTokens.fast * 0.4,
                duration: motionTokens.normal * 3,
                ease: motionTokens.decelerate,
              }}
            >
              {glyph}
            </motion.span>
          ),
        )}
      </span>
      <span className="visually-hidden">{WORDMARK}</span>
    </Text>
  );
}
