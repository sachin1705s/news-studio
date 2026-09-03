import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The repo root is this folder, not the parent home directory.
  turbopack: { root: __dirname },
  /* config options here */
};

export default nextConfig;
