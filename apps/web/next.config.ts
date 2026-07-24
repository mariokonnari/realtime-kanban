import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@realtime-kanban/shared-types"],
};

export default nextConfig;
