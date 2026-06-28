import type { PhysicsModule } from "./types";

/* Registre partagé : chaque module s'enregistre via register() à l'import. */
const modules: PhysicsModule[] = [];

export function register(m: PhysicsModule): void {
  modules.push(m);
}

export function getModules(): readonly PhysicsModule[] {
  return modules;
}
