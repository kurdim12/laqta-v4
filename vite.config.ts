import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The deploy artifact is a folder the owner drags into Cloudflare Pages or Hostinger.
// Base is relative so the build works from any path without being rebuilt for it, and
// deployment never depends on git.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
        },
      },
    },
  },
});
