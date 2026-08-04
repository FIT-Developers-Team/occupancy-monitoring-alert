import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce the minimal production runtime required by Docker. Copying the
  // complete build-time node_modules made the final image exceed 1 GB and
  // caused Coolify's helper to disconnect while exporting image layers.
  output: "standalone",
  serverExternalPackages: ["duckdb", "nodemailer"],
  // Data and local audit artefacts are mounted at runtime. Tracing the live
  // DuckDB file copied >1 GB into every local standalone build.
  outputFileTracingExcludes: {
    // Exact paths also work around picomatch's wildcard handling for Windows
    // backslash paths while remaining the narrowest safe deployment rule.
    "/*": [
      "./db/warehouse_history.duckdb",
      "./db/warehouse_history.duckdb.wal",
      "./db/warehouse_history.duckdb.write-intent",
      "./db/app_state.duckdb",
      "./db/app_state.duckdb.wal",
      "./db/app_state.duckdb.web.lock",
      "./db/.superset-sync-daemon.lock",
      "./db/.superset-sync-heartbeat.json",
      "./db/.superset-sync-status.json",
      "./config/.superset-sync.secrets.json",
    ],
  },

  // No route uses next/image, so the optimiser only adds weight: sharp drags in
  // libvips (~18 MB) that never runs.
  images: { unoptimized: true },

  // Drop client-side console calls in production; server logging is untouched.
  compiler: {
    removeConsole:
      process.env.NODE_ENV === "production" ? { exclude: ["error", "warn"] } : false,
  },
};

export default nextConfig;
