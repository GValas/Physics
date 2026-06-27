# Champs de vecteurs — Gradient, Divergence, Rotationnel

Animation web interactive (HTML/CSS/JS, sans dépendance) qui illustre les trois
opérateurs différentiels du calcul vectoriel et le **flux** associé.

## Utilisation

Ouvrir `index.html` dans un navigateur. Aucune installation requise.

## Ce que l'on voit

- **Flèches** : le champ de vecteurs (le gradient ∇f, ou le champ F).
- **Fond coloré** : la valeur de l'opérateur (palette divergente — rouge positif,
  bleu négatif).
- **Particules de flux** : elles suivent le champ en temps réel ; elles s'écartent
  d'une *source* (∇·F > 0) et tournent autour d'un *tourbillon* (∇×F ≠ 0).
- **Sonde** : passe la souris sur le champ pour lire les valeurs locales et voir
  un indicateur géométrique (flèche du gradient, anneau de divergence, arc de
  rotation).

## Opérateurs

| Mode | Champ affiché | Fond coloré |
|------|---------------|-------------|
| **Gradient ∇f** | gradient d'un champ scalaire `f(x,y)` | valeur de `f` |
| **Divergence ∇·F** | champ de vecteurs `F` | `∇·F` (source / puits) |
| **Rotationnel ∇×F** | champ de vecteurs `F` | `(∇×F)_z` (sens de rotation) |

## Contrôles

Choix de l'opérateur, du champ prédéfini, amplitude, échelle spatiale, densité
des flèches, nombre et vitesse des particules, et bascules d'affichage
(flèches, fond, flux, lignes de niveau, sonde).

## Implémentation

- Dérivées calculées numériquement (différences finies centrées).
- Fond coloré rendu via `ImageData`, lignes de niveau par *marching squares*.
- Couche statique mise en cache, particules animées par `requestAnimationFrame`.

## Fichiers

- `index.html` — structure et contrôles
- `style.css` — mise en forme
- `app.js` — moteur de visualisation
