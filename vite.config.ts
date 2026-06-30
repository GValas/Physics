import { defineConfig } from "vite";

// Date de compilation/déploiement, figée à l'instant du build et injectée
// dans le bundle (affichée sous le titre).
const BUILD_DATE = new Date().toLocaleString("fr-FR", {
  day: "2-digit", month: "long", year: "numeric",
  hour: "2-digit", minute: "2-digit",
  timeZone: "Europe/Paris",
});

export default defineConfig({
  define: {
    __BUILD_DATE__: JSON.stringify(BUILD_DATE),
  },
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
