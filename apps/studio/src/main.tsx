/**
 * Studio bootstrap.
 *
 * Order matters here and is the whole content of this file:
 *
 * 1. The structural stylesheet is imported, so the reset and the effect geometry are
 *    parsed before anything renders.
 * 2. The theme is applied to the document **synchronously**, before React exists.
 *    A provider applies its theme in an effect, which runs after the first paint; on
 *    a dark interface that is one frame of white on every load.
 * 3. Only then is the tree rendered, with the provider starting from the theme that
 *    is already on screen.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/globals.css";
import App from "./App";
import { applyBootstrapTheme } from "./theme/studioTheme";

const container = document.getElementById("root");
if (container === null) {
  // Failing loudly is correct: without a mount point nothing can render, and a
  // silent return would leave a blank page with an empty console.
  throw new Error(
    "OMNIS Studio could not start: no #root element. Check that index.html was served unmodified.",
  );
}

const initialTheme = applyBootstrapTheme();

createRoot(container).render(
  <StrictMode>
    <App initialTheme={initialTheme} />
  </StrictMode>,
);
