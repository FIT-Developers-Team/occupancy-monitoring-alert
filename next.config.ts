import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["duckdb", "nodemailer"],
  experimental: {},
};

export default nextConfig;
