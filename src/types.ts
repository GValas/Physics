/* Contrat commun à tous les modules de physique. */

export interface ModuleInstance {
  /** Appelé quand on quitte l'onglet : arrêter les rAF, relâcher les refs. */
  unmount?: () => void;
}

export interface PhysicsModule {
  /** Identifiant unique (sert d'ancre #hash). */
  id: string;
  /** Libellé de l'onglet. */
  title: string;
  /** Sous-titre affiché sous le titre principal. */
  subtitle?: string;
  /** Texte d'aide du pied de page (HTML autorisé). */
  help?: string;
  /** Monte le module dans `root` ; renvoie un contrôleur { unmount }. */
  mount: (root: HTMLElement) => ModuleInstance | void;
}
