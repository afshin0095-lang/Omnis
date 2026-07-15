type RootLayoutProps = {
  children: React.ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <main className="root-layout">
      {children}
    </main>
  );
}