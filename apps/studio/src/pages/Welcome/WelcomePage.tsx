import RootLayout from "@/components/layout/RootLayout";
import AuroraBackground from "@/components/effects/AuroraBackground";
import Orb from "@/components/effects/Orb";

import Logo from "@/components/branding/Logo";
import Tagline from "@/components/branding/Tagline";

export default function WelcomePage() {
  return (
    <>
      <AuroraBackground />

      <RootLayout>
        <section className="welcome-content">
          <Orb />

          <Logo />

          <Tagline />
        </section>
      </RootLayout>
    </>
  );
}