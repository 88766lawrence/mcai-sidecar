import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@mcai/contracts"],
  devIndicators: false,
  async rewrites() {
    return [{
      source: "/api/:path*",
      destination: "http://127.0.0.1:4100/api/:path*",
    }];
  },
};

export default nextConfig;
