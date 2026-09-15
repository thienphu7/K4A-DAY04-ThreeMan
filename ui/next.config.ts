import type { NextConfig } from "next"

/**
 * `next dev` does not execute api/*.py, so in development the /api routes are
 * proxied to scripts/local_api.py. In production those same paths are real
 * Vercel Python functions and must not be rewritten, which is why the rewrite
 * is gated on NODE_ENV rather than always present.
 */
const nextConfig: NextConfig = {
  experimental: {
    // The dev proxy gives up well before a turn does. A turn is several model
    // calls in a row and routinely runs 15-30s, and vercel.json allows the
    // deployed chat function 60s, so the proxy has to outlast that or local
    // development reports "Could not reach the agent" on turns that in fact
    // completed and were written to the database.
    proxyTimeout: 65_000,
  },
  async rewrites() {
    if (process.env.NODE_ENV !== "development") return []
    return [
      {
        source: "/api/:path*",
        destination: "http://127.0.0.1:8787/api/:path*",
      },
    ]
  },
}

export default nextConfig
