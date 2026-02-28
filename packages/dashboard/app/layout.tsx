import type { Metadata } from "next";
import { Sidebar } from "@/components/sidebar";
import { LayoutProviders } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "KarnEvil9 Dashboard",
  description: "KarnEvil9 agent runtime dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <LayoutProviders>
          <Sidebar />
          <main className="ml-56 min-h-screen p-6">{children}</main>
        </LayoutProviders>
      </body>
    </html>
  );
}
