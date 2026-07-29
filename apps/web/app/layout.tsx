import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MCAI Sidecar",
  description: "安全、可审计、可回滚的 Minecraft AI 运维层",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = { themeColor: "#071a3d", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
