#!/usr/bin/env bash
#
# Build du site puis déploiement sur le NAS Unraid : on synchronise les
# fichiers statiques (dist/) vers un dossier servi par un conteneur nginx.
#
# Configuration (par variable d'environnement, ou via un fichier .env.deploy
# à la racine — voir .env.deploy.example) :
#   NAS_USER  utilisateur SSH du NAS            (défaut : root)
#   NAS_HOST  nom d'hôte ou IP du NAS           (défaut : tower)
#   NAS_PATH  dossier servi par nginx sur le NAS (défaut : /mnt/user/appdata/physics/site)
#   NAS_PORT  port SSH                          (défaut : 22)
#
# Usage :
#   ./deploy.sh              build + déploiement
#   ./deploy.sh --dry-run    montre ce qui serait copié, sans rien écrire
#   NAS_HOST=192.168.1.50 NAS_USER=root ./deploy.sh
#
set -euo pipefail
cd "$(dirname "$0")"

# charge un éventuel fichier de config local (non versionné)
if [ -f .env.deploy ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env.deploy; set +a
fi

NAS_USER="${NAS_USER:-root}"
NAS_HOST="${NAS_HOST:-tower}"
NAS_PATH="${NAS_PATH:-/mnt/user/appdata/physics/site}"
NAS_PORT="${NAS_PORT:-22}"

DRY=""
[ "${1:-}" = "--dry-run" ] && DRY="--dry-run"

echo "==> Build de production (vite)…"
npm run build

if [ ! -f dist/index.html ]; then
  echo "ERREUR : dist/index.html introuvable — le build a-t-il échoué ?" >&2
  exit 1
fi

TARGET="${NAS_USER}@${NAS_HOST}:${NAS_PATH}/"
echo "==> Déploiement vers ${TARGET} (port ${NAS_PORT})…"

# crée le dossier cible au besoin
ssh -p "${NAS_PORT}" "${NAS_USER}@${NAS_HOST}" "mkdir -p '${NAS_PATH}'"

# rsync : --delete pour refléter exactement dist/ (supprime les vieux assets hashés)
rsync -avz ${DRY} --delete \
  -e "ssh -p ${NAS_PORT}" \
  dist/ "${TARGET}"

echo "==> Terminé. Rafraîchis la page (Ctrl+F5) sur http://${NAS_HOST}:<port-nginx>"
