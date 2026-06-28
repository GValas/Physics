# Physique interactive

Recueil de **modules de physique** interactifs (TypeScript + Canvas 2D, **aucune
dépendance d'exécution**), organisés par onglets. Construit avec **Vite**.

## Modules

| Onglet | Sujet |
|--------|-------|
| **Calcul vectoriel** | gradient ∇f, divergence ∇·F, rotationnel ∇×F et flux associé |
| **Courant électrique** | modèle microscopique : électrons, dérive, intensité, tension, résistance, champ E |
| **Équations de Maxwell** | les 4 équations en **3D** (caméra orbitale) + l'onde EM |
| **Composants RLC** | résistance, condensateur, bobine, circuit RLC : équations, charges, champs E/B, oscilloscope |
| **Relativité générale** | courbure de l'espace-temps (3D), précession des orbites, trou noir & déviation de la lumière |
| **Fluides (Navier-Stokes)** | simulation temps réel (Stable Fluids) : tourbillon interactif, convection, allée de von Kármán |

## Démarrage rapide

```bash
npm install     # installe Vite + TypeScript (dépendances de dev uniquement)
npm run dev     # serveur de dev avec HMR  ->  http://localhost:5173
npm run build   # build de production statique  ->  dist/
npm run preview # sert le contenu de dist/ localement
npm run typecheck   # vérification de types (tsc --noEmit), non bloquante pour le build
```

> Le build (esbuild via Vite) **n'échoue pas sur les erreurs de types** : le site
> se compile toujours. `npm run typecheck` est là pour la rigueur, séparément.

## Dev container

Un dev container est fourni (`.devcontainer/`). Dans VS Code :
*Dev Containers : Reopen in Container*. Il fournit **Node 20 + TypeScript**, les
extensions VS Code utiles (ESLint, Prettier, HTML/CSS, Vite, Docker, paths…), et
exécute `.devcontainer/post-create.sh` à la création :

- `npm install` (Vite + TypeScript) ;
- installation de la **CLI Claude Code** (`@anthropic-ai/claude-code`) ;
- ajout d'un hook qui **lance Claude automatiquement en mode toutes permissions**
  (`claude --dangerously-skip-permissions`) à l'ouverture d'un terminal interactif.

Le port `5173` (Vite) est transféré. Le hook de lancement est protégé (`[ -t 1 ]`
+ variable `CLAUDE_AUTOSTARTED`) pour ne pas se relancer dans les sous-shells.

## Architecture

Le **shell** tient un registre de modules et une barre d'onglets : un seul module
est *monté* à la fois (sa boucle d'animation s'arrête au démontage).

- `index.html` — coquille minimale, charge `src/main.ts` (module ES).
- `src/main.ts` — importe les modules (effet de bord = enregistrement) puis `boot()`.
- `src/registry.ts` — registre `register()` / `getModules()`.
- `src/shell.ts` — onglets + cycle de vie mount/unmount.
- `src/types.ts` — interface `PhysicsModule`.
- `src/style.css` — styles partagés (importé par `main.ts`).
- `src/modules/*.ts` — un fichier par module.

### Ajouter un module

1. Créer `src/modules/mon-module.ts` :

   ```ts
   import { register } from "../registry";

   function mount(root: HTMLElement) {
     // injecter le DOM dans `root`, démarrer la boucle d'animation…
     return { unmount() { /* arrêter la rAF, relâcher les refs */ } };
   }

   register({
     id: "mon-module",
     title: "Mon module",
     subtitle: "…",
     help: "…",
     mount,
   });
   ```

2. L'importer dans `src/main.ts` :
   `import "./modules/mon-module";`

L'onglet actif est reflété dans l'URL (`#id`).

## Déploiement Docker (NAS Unraid)

Le site est **statique** une fois construit : on le sert avec un nginx. L'image
fournie est multi-étapes (build Node → nginx).

### Construire & lancer (n'importe quel hôte Docker)

```bash
docker compose up -d --build      # http://<ip>:8087
# ou, sans compose :
docker build -t physique-interactive .
docker run -d --restart unless-stopped -p 8087:80 --name physics physique-interactive
```

### Sur Unraid — chemin minimal

**Option A — plugin « Docker Compose Manager » (recommandé, build sur le NAS)**

1. Installer *Docker Compose Manager* depuis **Community Applications**.
2. Copier ce dépôt dans un share, p. ex. `/mnt/user/appdata/physics`.
3. Dans Compose Manager : *Add New Stack* → pointer sur le `docker-compose.yml`
   du dossier → **Compose Up**. Unraid construit l'image et démarre le conteneur.
4. Ouvrir `http://<ip-du-nas>:8087`. Change le port hôte dans `docker-compose.yml`
   (`8087:80`) si besoin.

**Option B — sans build sur le NAS (le plus léger)**

Construire ailleurs (`npm run build`), copier `dist/` sur le NAS
(`/mnt/user/appdata/physics/site`), puis ajouter un conteneur **nginx** via
l'onglet *Docker* d'Unraid :

- Repository : `nginx:alpine`
- Port : `8087` (host) → `80` (container)
- Path : `/mnt/user/appdata/physics/site` → `/usr/share/nginx/html` (read-only)

Aucune image custom à construire ; nginx sert directement les fichiers.

**Option C — registre**

Builder puis pousser vers Docker Hub / GHCR, et en mode *Docker* Unraid renseigner
simplement l'image et le mappage de port `8087:80`.

## Détails d'implémentation

Tout est dessiné sur `<canvas>` 2D, sans bibliothèque graphique. Le module Maxwell
embarque un petit moteur 3D maison (projection perspective + caméra orbitale à la
souris : glisser pour orbiter, molette pour zoomer).
