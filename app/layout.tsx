import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Prospects SCI",
  description: "Collecte et gestion de prospects SCI actifs pour BailNotarie",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
