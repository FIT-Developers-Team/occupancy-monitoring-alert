import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce the minimal production runtime required by Docker. Copying the
  // complete build-time node_modules made the final image exceed 1 GB and
  // caused Coolify's helper to disconnect while exporting image layers.
  output: "standalone",
  serverExternalPackages: ["duckdb", "nodemailer"],
  experimental: {},
};

export default nextConfig;
