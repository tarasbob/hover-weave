import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Use the WebGPU build of three everywhere so R3F, drei-style helpers and our
  // TSL code all share a single three instance (it includes the WebGL2 fallback).
  turbopack: {
    resolveAlias: {
      three: "./src/shims/three.ts",
    },
  },
};

export default nextConfig;
