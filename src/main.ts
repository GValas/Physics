import "./style.css";

/* Import des modules pour leur effet de bord (enregistrement). */
import "./modules/vector-calculus";
import "./modules/electric-current";
import "./modules/maxwell";
import "./modules/rlc";
import "./modules/general-relativity";
import "./modules/fluids";
import "./modules/heat";
import "./modules/thermodynamics";
import "./modules/young";
import "./modules/inertial-forces";

import { boot } from "./shell";

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
