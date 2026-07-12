import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const projectRoot = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/adapter-better-sqlite3", "@napi-rs/canvas", "pdf-to-img", "pdfjs-dist"],
  turbopack: {
    root: projectRoot,
  },
};

export default nextConfig;
