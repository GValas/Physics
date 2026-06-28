import { defineConfig } from "vite";

export default defineConfig({
  // chemins relatifs : permet de servir le site sous n'importe quel
  // sous-chemin (reverse-proxy Unraid, etc.) sans reconfiguration.
  base: "./",
  server: {
    host: true, // écoute sur 0.0.0.0 (utile dans le dev container)
    port: 5173,
  },
  build: {
    outDir: "dist",
    target: "es2020",
  },
});
