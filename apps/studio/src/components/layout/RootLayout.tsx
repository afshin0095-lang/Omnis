/**
 * The application shell.
 *
 * The shell owns the background and the centre-alignment; pages own their content.
 * The previous version left the aurora to the page, which meant every future page had
 * to remember to render it — and the first one that forgot would look broken rather
 * than merely different.
 *
 * `<main>` is used for the content region. It is the one landmark a single-screen
 * application genuinely needs: it gives a screen reader user a way to jump straight
 * past the decorative background to the content, and it is the reason the aurora is
 * rendered as a sibling rather than as a wrapper.
 */

import type { ReactNode } from "react";
import AuroraBackground from "../effects/AuroraBackground";

export interface RootLayoutProps {
  children: ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <>
      <AuroraBackground />
      <main className="studio-root" data-testid="studio-root">
        <div className="studio-root__content">{children}</div>
      </main>
    </>
  );
}
