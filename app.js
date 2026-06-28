"use strict";

/* =========================================================================
   Shell de l'application « Physique interactive »
   - Tient un registre de modules (window.Physics.register).
   - Construit la barre d'onglets et gère le cycle de vie mount / unmount :
     un seul module est monté à la fois.
   Pour ajouter un module : créer modules/<nom>.js, appeler
   window.Physics.register({ id, title, subtitle, help, mount }) et inclure
   le script dans index.html. mount(root) doit renvoyer { unmount }.
   ========================================================================= */

window.Physics = (function () {
  const modules = [];
  return {
    modules,
    register(m) { modules.push(m); },
  };
})();

document.addEventListener("DOMContentLoaded", () => {
  const tabsEl = document.getElementById("tabs");
  const rootEl = document.getElementById("module-root");
  const subtitleEl = document.getElementById("subtitle");
  const footerEl = document.getElementById("footer");

  let instance = null;   // contrôleur { unmount } du module courant
  let activeId = null;

  function activate(mod) {
    if (mod.id === activeId) return;
    if (instance && instance.unmount) instance.unmount();
    rootEl.innerHTML = "";

    subtitleEl.textContent = mod.subtitle || "";
    footerEl.innerHTML = mod.help ? `<p>${mod.help}</p>` : "";
    [...tabsEl.children].forEach((b) =>
      b.classList.toggle("active", b.dataset.id === mod.id));

    instance = mod.mount(rootEl) || {};
    activeId = mod.id;
    if (location.hash.slice(1) !== mod.id) {
      history.replaceState(null, "", "#" + mod.id);
    }
  }

  if (!Physics.modules.length) {
    rootEl.innerHTML =
      "<p style='padding:24px;color:var(--muted)'>Aucun module chargé.</p>";
    return;
  }

  Physics.modules.forEach((mod) => {
    const b = document.createElement("button");
    b.className = "tab";
    b.type = "button";
    b.dataset.id = mod.id;
    b.textContent = mod.title;
    b.addEventListener("click", () => activate(mod));
    tabsEl.appendChild(b);
  });

  const fromHash = Physics.modules.find((m) => m.id === location.hash.slice(1));
  activate(fromHash || Physics.modules[0]);

  window.addEventListener("hashchange", () => {
    const m = Physics.modules.find((x) => x.id === location.hash.slice(1));
    if (m) activate(m);
  });
});
