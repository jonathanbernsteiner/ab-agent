import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Hide the floating Next.js dev indicator badge.
  devIndicators: false,
  // Pin the workspace root — there are lockfiles above this directory.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
