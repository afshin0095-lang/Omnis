/**
 * Component-level tokens.
 *
 * Only dimensions that must stay consistent *across* components live here — a
 * button height that has to match an adjacent input, a card padding that has to
 * match a panel. Anything a single component owns outright stays in that
 * component; putting it here would make this file a second, worse stylesheet.
 */

import type { ComponentTokens } from "../themes/types.js";

export const COMPONENTS: ComponentTokens = {
  button: {
    height: { sm: "32px", md: "40px", lg: "52px" },
    paddingX: { sm: "12px", md: "20px", lg: "28px" },
  },
  card: { padding: "24px", radius: "22px" },
  panel: { padding: "28px", radius: "22px" },
};
