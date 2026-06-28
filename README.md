# Physique interactive

Recueil de **modules de physique** interactifs (HTML/CSS/JS, sans dépendance),
organisés par onglets. Chaque module est une visualisation autonome.

## Utilisation

Ouvrir `index.html` dans un navigateur. Aucune installation requise.

## Modules

| Onglet | Sujet |
|--------|-------|
| **Calcul vectoriel** | gradient ∇f, divergence ∇·F, rotationnel ∇×F et flux associé |

*(d'autres modules viendront s'ajouter ici)*

## Architecture

Le **shell** (`app.js`) tient un registre de modules et gère une barre
d'onglets : un seul module est *monté* à la fois.

- `index.html` — coquille (en-tête, onglets, pied de page) + inclusion des scripts.
- `app.js` — registre `window.Physics`, construction des onglets, cycle de vie.
- `style.css` — styles partagés (coquille, onglets) et propres aux modules.
- `modules/<nom>.js` — un fichier par module.

### Ajouter un module

1. Créer `modules/mon-module.js`.
2. À la fin du fichier, s'enregistrer :

   ```js
   window.Physics.register({
     id: "mon-module",          // identifiant unique (sert à l'ancre #hash)
     title: "Mon module",       // libellé de l'onglet
     subtitle: "…",             // sous-titre affiché sous le titre
     help: "…",                 // texte du pied de page (HTML autorisé)
     mount(root) {
       // injecter le DOM dans `root`, démarrer la boucle d'animation…
       return { unmount() { /* arrêter la rAF, relâcher les refs */ } };
     },
   });
   ```

3. Ajouter `<script src="modules/mon-module.js"></script>` dans `index.html`
   **après** `app.js`.

Le shell appelle `mount(root)` à l'activation de l'onglet et `unmount()` en
quittant. À toi de stopper toute `requestAnimationFrame` dans `unmount` ; le
shell vide `root.innerHTML`, donc les écouteurs attachés aux éléments internes
sont libérés automatiquement. L'onglet actif est reflété dans l'URL (`#id`).

## Module « Calcul vectoriel »

- **Flèches** : le champ de vecteurs (le gradient ∇f, ou le champ F).
- **Fond coloré** : la valeur de l'opérateur (palette divergente — rouge positif,
  bleu négatif).
- **Particules de flux** : elles suivent le champ en temps réel ; elles s'écartent
  d'une *source* (∇·F > 0) et tournent autour d'un *tourbillon* (∇×F ≠ 0).
- **Sonde** : passe la souris sur le champ pour lire les valeurs locales.

Détails d'implémentation : dérivées par différences finies centrées, fond rendu
via `ImageData`, lignes de niveau par *marching squares*, couche statique mise
en cache et particules animées par `requestAnimationFrame`.
