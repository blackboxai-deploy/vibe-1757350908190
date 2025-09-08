import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "4D Nexus Convergence Map",
  description: "Interactive 4D visualization showing dynamic stream convergence in space-time with advanced mathematical algorithms and real-time controls.",
  keywords: "4D visualization, three.js, convergence, streams, mathematics, interactive",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}