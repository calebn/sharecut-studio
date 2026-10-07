# Sourced (not run) by .githooks/pre-commit and scripts/worktree-setup.sh.
# Puts the Node major pinned in .nvmrc first on PATH, so hooks and setup never run under
# whatever older `node` a non-interactive shell finds first. Non-interactive shells don't
# load nvm, so this reads nvm's install tree directly instead of sourcing nvm.sh.
want=$(cut -d. -f1 < .nvmrc | tr -d ' v\n')
have=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo none)
if [ "$have" != "$want" ]; then
  pick=$(ls -d "${NVM_DIR:-$HOME/.nvm}/versions/node/v$want."* 2>/dev/null | sort -V | tail -n 1)
  if [ -n "$pick" ] && [ -x "$pick/bin/node" ]; then
    PATH="$pick/bin:$PATH"
    export PATH
  else
    echo "node-env: .nvmrc pins Node $want but found $have; run \`nvm install $want\`." >&2
  fi
fi
