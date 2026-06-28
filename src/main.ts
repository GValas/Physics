import "./style.css";

/* Import des modules pour leur effet de bord (enregistrement). */
import "./modules/vector-calculus";
import "./modules/electric-current";
import "./modules/maxwell";

import { boot } from "./shell";

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
