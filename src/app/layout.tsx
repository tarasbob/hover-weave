import type { Metadata, Viewport } from "next";
import { Orbitron, Space_Grotesk } from "next/font/google";
import "./globals.css";

const orbitron = Orbitron({
  variable: "--font-orbitron",
  subsets: ["latin"],
  weight: ["400", "500", "700", "900"],
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Hover Weave — Thread the Impossible",
  applicationName: "Hover Weave",
  description:
    "Race a hovercraft through an endless neon landscape. Weave impossible gaps, build Flow, and chase the daily course in this free, skill-only browser runner.",
  openGraph: {
    title: "Hover Weave — Thread the Impossible",
    description:
      "Thread impossible gaps, build Flow, and chase the daily course in an endless neon hovercraft runner.",
    siteName: "Hover Weave",
    type: "website",
  },
  // Installed-to-home-screen iOS runs chrome-free (see app/manifest.ts).
  appleWebApp: {
    capable: true,
    title: "Hover Weave",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#07060f",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  // Draw edge-to-edge under the notch; HUD respects safe-area insets.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${orbitron.variable} ${spaceGrotesk.variable} h-full antialiased`}
    >
      <body className="h-full overflow-hidden bg-[#07060f] text-white">{children}</body>
    </html>
  );
}
