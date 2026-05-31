// Root layout applied to every page — sets the HTML metadata and imports global styles.
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Workspace Agent",
  description: "Multi-workspace AI coding assistant",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
