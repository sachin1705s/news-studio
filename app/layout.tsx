import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "R24 — Live News Studio",
  description: "A continuous generated news channel driven by live wire feeds.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
