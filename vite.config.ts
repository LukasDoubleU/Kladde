import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

/** WebView2 reads woff2, so the woff and ttf fallbacks in the KaTeX stylesheet would only bloat the build. */
const katexWoff2Only = (): Plugin => ({
  name: "katex-woff2-only",
  enforce: "pre",
  transform(code, id) {
    if (!id.includes("katex") || !id.split("?")[0].endsWith(".css")) return null;
    return code.replace(/,url\([^)]*\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, "");
  },
});

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [svelte(), katexWoff2Only()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // WebView2 on Windows is evergreen Chromium.
    target: "chrome120",
    chunkSizeWarningLimit: 2000,
  },
});
