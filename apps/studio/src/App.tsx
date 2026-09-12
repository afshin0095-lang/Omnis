/**
 * The Studio application root.
 *
 * Deliberately thin: it owns the theme selection and renders the current page. When
 * routing arrives it belongs here, and this component is the only one that should
 * have to change.
 */

import type { Theme } from "@omnis/theme";
import WelcomePage from "./pages/Welcome/WelcomePage";
import { StudioThemeProvider } from "./theme/StudioThemeProvider";

export interface AppProps {
  /** The theme applied during bootstrap, so the first render matches the paint. */
  initialTheme?: Theme;
}

export default function App({ initialTheme }: AppProps) {
  return (
    <StudioThemeProvider initialTheme={initialTheme}>
      <WelcomePage />
    </StudioThemeProvider>
  );
}
