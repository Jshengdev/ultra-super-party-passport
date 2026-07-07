import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  output: process.env.STATIC_EXPORT ? "export" : undefined,
  images: { unoptimized: true },
};
export default nextConfig;
