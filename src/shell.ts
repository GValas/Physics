import { getModules } from "./registry";
import type { ModuleInstance, PhysicsModule } from "./types";

/* =========================================================================
   Shell : barre d'onglets + cycle de vie mount / unmount.
   Un seul module monté à la fois ; l'onglet actif est reflété dans l'URL.
   ========================================================================= */

export function boot(): void {
  const tabsEl = document.getElementById("tabs")!;
  const rootEl = document.getElementById("module-root")!;
  const subtitleEl = document.getElementById("subtitle")!;
  const footerEl = document.getElementById("footer")!;

  const modules = getModules();
  let instance: ModuleInstance | null = null;
  let activeId: string | null = null;

  function activate(mod: PhysicsModule): void {
    if (mod.id === activeId) return;
    if (instance && instance.unmount) instance.unmount();
    rootEl.innerHTML = "";

    subtitleEl.textContent = mod.subtitle || "";
    footerEl.innerHTML = mod.help ? `<p>${mod.help}</p>` : "";
    Array.from(tabsEl.children).forEach((b) =>
      (b as HTMLElement).classList.toggle(
        "active",
        (b as HTMLElement).dataset.id === mod.id,
      ),
    );

    instance = (mod.mount(rootEl) as ModuleInstance) || {};
    activeId = mod.id;
    if (location.hash.slice(1) !== mod.id) {
      history.replaceState(null, "", "#" + mod.id);
    }
  }

  if (!modules.length) {
    rootEl.innerHTML =
      "<p style='padding:24px;color:var(--muted)'>Aucun module chargé.</p>";
    return;
  }

  modules.forEach((mod) => {
    const b = document.createElement("button");
    b.className = "tab";
    b.type = "button";
    b.dataset.id = mod.id;
    b.textContent = mod.title;
    b.addEventListener("click", () => activate(mod));
    tabsEl.appendChild(b);
  });

  const fromHash = modules.find((m) => m.id === location.hash.slice(1));
  activate(fromHash || modules[0]);

  window.addEventListener("hashchange", () => {
    const m = modules.find((x) => x.id === location.hash.slice(1));
    if (m) activate(m);
  });
}
