#!/usr/bin/env bash
set -euo pipefail

# 1) Dépendances du projet (Vite + TypeScript)
npm install

# 2) Claude Code CLI
npm install -g @anthropic-ai/claude-code

# 3) Lancement automatique de Claude en mode « toutes permissions »
#    à l'ouverture d'un terminal interactif.
#    - [ -t 1 ]            : uniquement les terminaux interactifs (avec TTY)
#                           -> les commandes lancées PAR Claude (sans TTY) ne
#                              relancent donc pas Claude.
#    - CLAUDE_AUTOSTARTED  : garde-fou supplémentaire contre toute récursion.
read -r -d '' LAUNCH <<'SNIPPET' || true

# --- lancement automatique de Claude Code (mode toutes permissions) ---
if [ -z "${CLAUDE_AUTOSTARTED:-}" ] && [ -t 1 ] && command -v claude >/dev/null 2>&1; then
  export CLAUDE_AUTOSTARTED=1
  claude --dangerously-skip-permissions
fi
SNIPPET

for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
  [ -f "$rc" ] || touch "$rc"
  if ! grep -q "CLAUDE_AUTOSTARTED" "$rc"; then
    printf '%s\n' "$LAUNCH" >> "$rc"
    echo "Hook de lancement Claude ajouté à $rc"
  fi
done

echo "Post-création terminée."
