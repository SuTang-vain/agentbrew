#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCENARIO=existing
INIT_ONLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --scenario)
      [[ $# -ge 2 ]] || { echo "--scenario requires a value" >&2; exit 2; }
      SCENARIO=$2
      shift 2
      ;;
    --init-only)
      INIT_ONLY=1
      shift
      ;;
    *)
      echo "unknown sandbox option: $1" >&2
      exit 2
      ;;
  esac
done

node "$REPO_ROOT/scripts/sandbox.mjs" --scenario "$SCENARIO" >/dev/null

if [[ "$INIT_ONLY" == 1 ]]; then
  echo "Agentbrew $SCENARIO sandbox initialized at $REPO_ROOT/.sandbox"
  exit 0
fi

export AGENTBREW_SANDBOX="$REPO_ROOT/.sandbox"
export HOME="$AGENTBREW_SANDBOX/home"
export PI_AGENT_DIR="$HOME/.pi/agent"
export AGENTBREW_STATE_DIR="$AGENTBREW_SANDBOX/state"
export XDG_CONFIG_HOME="$AGENTBREW_SANDBOX/config"
export XDG_CACHE_HOME="$AGENTBREW_SANDBOX/cache"
export XDG_STATE_HOME="$AGENTBREW_SANDBOX/xdg-state"
export PATH="$AGENTBREW_SANDBOX/bin:$PATH"
export PS1="(agentbrew-sandbox) \u@\h:\w\\$ "

METADATA_PID=""
if [[ "$SCENARIO" == bundle ]]; then
  node "$REPO_ROOT/scripts/sandbox-metadata.mjs" --ready "$AGENTBREW_SANDBOX/metadata.json" &
  METADATA_PID=$!
  for _ in {1..50}; do
    [[ -f "$AGENTBREW_SANDBOX/metadata.json" ]] && break
    if ! kill -0 "$METADATA_PID" 2>/dev/null; then
      echo "sandbox metadata service stopped before becoming ready" >&2
      exit 1
    fi
    sleep 0.1
  done
  [[ -f "$AGENTBREW_SANDBOX/metadata.json" ]] || { echo "sandbox metadata service did not become ready" >&2; exit 1; }
  METADATA_ORIGIN=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).origin)' "$AGENTBREW_SANDBOX/metadata.json")
  export AGENTBREW_PI_RELEASE_URL="$METADATA_ORIGIN/release"
  export AGENTBREW_NPM_REGISTRY_URL="$METADATA_ORIGIN/registry"
fi
cleanup() {
  if [[ -n "$METADATA_PID" ]]; then
    kill "$METADATA_PID" 2>/dev/null || true
    wait "$METADATA_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

cat <<EOF
Agentbrew sandbox ready ($SCENARIO). This shell uses only mock Pi/npm/herdr commands.
Your real configuration is not used.

Try:
  agentbrew init
  agentbrew init --verbose
  agentbrew inspect
  agentbrew diff
  agentbrew doctor

Non-interactive Repair example for the default existing scenario:
  agentbrew init --expect repairable --mode repair \
    --resource pi.host-links --resource herdr.pi-integration --apply

Available scenarios: existing, empty, healthy, broken, no-host, bundle.
Start with: npm run sandbox -- --scenario empty

Useful files:
  \$AGENTBREW_SANDBOX/commands.log
  \$AGENTBREW_STATE_DIR/last-result.json

Type 'exit' to return. Running this command again resets the selected scenario.
Do not run repository npm build/test commands inside this mock shell.
EOF

if [[ "$SCENARIO" == bundle ]]; then
  cat <<'EOF'

Bundle scenario (with a loopback-only metadata service):
  agentbrew source set --layer public="$AGENTBREW_SANDBOX/layers/public.json"
  agentbrew source list
  agentbrew resolve
  agentbrew update --dry-run
  agentbrew update
  agentbrew diff
  agentbrew doctor
  agentbrew source clear

Layer explanation and selective personal-layer apply:
  agentbrew explain --layer public="$AGENTBREW_SANDBOX/layers/public.json" \
    --layer team="$AGENTBREW_SANDBOX/layers/team.json" \
    --layer personal="$AGENTBREW_SANDBOX/layers/personal.json"
  agentbrew diff --layer personal="$AGENTBREW_SANDBOX/layers/personal.json" \
    --mode manage --resource npm:pi-subagents \
    --plan-out "$AGENTBREW_SANDBOX/bundle-plan.json"
  agentbrew apply --plan "$AGENTBREW_SANDBOX/bundle-plan.json"
  agentbrew adopt --resource npm:pi-subagents \
    --output "$AGENTBREW_SANDBOX/adoption-proposal.json"
EOF
fi

cd "$HOME"
bash --noprofile --norc -i
