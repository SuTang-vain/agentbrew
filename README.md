# Agentbrew

Agentbrew is a local-first CLI for Pi/herdr configuration, selective initialization, native updates, and health checks. Shared files describe resource intent; each machine keeps its own Pi host links, resolved packages, ownership, plans, and health evidence.

This repository implements **M1a + M1b + M2a**. It is not the complete product described in `docs/PRD.md`.

## What works now

- Read-only `inspect`, `diff`, `doctor`, and `explain`.
- Guided `init`: Observe, Adopt, Repair, Manage, and selective Fresh install.
- Native `update` with per-target ownership checks, locking, snapshots, and final health verification.
- Public/team/personal/machine layers with explicit whole-resource overrides, tombstones, and team required/forbidden policy.
- Separate `adopt` proposals, typed Bundle plans, and selective `apply`.
- Static checks of both npm declarations and installed package versions for Bundle resources.
- Pi-style keyboard menus with accessible numbered fallbacks and versioned JSON output.

Not implemented: fixed Bundle Releases, upstream artifact integrity, remote Git refresh, Pi target-host prediction, SSH deployment, restore, a registry, generic herdr plugin installation, and generic skills/MCP providers. The M2a `fixed` policy is a local declaration guard, not a team Release.

## Requirements

- Node.js 22 or later
- npm
- A working Pi host for Pi operations and Fresh install
- herdr, optional; unavailable herdr operations are reported explicitly

The runtime has no third-party npm dependencies. TypeScript and Node type declarations are development dependencies only.

## Build and test

```bash
npm install
npm test
npm run build
node dist/bin/agentbrew.js --help
```

## Try it without touching real configuration

```bash
cd /Users/4paradigm/projexts/agentbrew
npm run sandbox -- --scenario bundle
```

The sandbox supplies mock Pi/npm/herdr executables and isolated HOME/state directories. It does not use your real Pi, herdr, chezmoi, or global package configuration. Do not run repository build/test commands inside the mock shell because its `npm` is a test double.

Available scenarios:

```bash
npm run sandbox                         # existing repairable configuration
npm run sandbox -- --scenario empty     # host only; no npm configuration
npm run sandbox -- --scenario healthy   # healthy existing configuration
npm run sandbox -- --scenario broken    # malformed npm manifest
npm run sandbox -- --scenario no-host   # no usable Pi host
npm run sandbox -- --scenario bundle    # healthy target plus three config layers
```

Starting a scenario resets its disposable files. Type `exit` to leave.

## Configuration layers

Pass each layer explicitly. At most one file of each kind is accepted; argument order does not change priority: public < team < personal < machine.

```json
{
  "schemaVersion": 1,
  "kind": "agentbrew-layer",
  "layer": "personal",
  "resources": {
    "npm:pi-subagents": {
      "source": { "type": "npm", "spec": "^0.84.0" },
      "update": "compatible"
    },
    "herdr.pi-integration": { "update": "manual" }
  },
  "override": ["npm:pi-subagents"],
  "remove": ["npm:unused-extension"]
}
```

Rules enforced before execution:

- Re-declaring a resource requires `override`; the complete declaration is replaced, never deep-merged.
- `remove` is an explicit tombstone. Re-adding a removed resource also requires `override`.
- `required` and `forbidden` are team-only arrays. Higher layers cannot override/remove required resources or activate forbidden resources.
- External npm resources support exact, `^`, and `~` semver constraints with `compatible`, `fixed`, or `manual` policy. `fixed` requires an exact version.
- Pi host packages and `@earendil-works/pi-*` host dependencies remain machine-local and cannot be exported into shared layers.
- URLs, npm tags, arbitrary commands, unknown fields, unsafe names, and unknown resource types are rejected.
- A shared declaration never grants local Manage ownership.

Inspect the effective declarations and their history:

```bash
agentbrew explain \
  --layer public="$AGENTBREW_SANDBOX/layers/public.json" \
  --layer team="$AGENTBREW_SANDBOX/layers/team.json" \
  --layer personal="$AGENTBREW_SANDBOX/layers/personal.json"
```

Use `--resource <id>` to focus the explanation and `--json` for structured output.

## Adoption proposals

Create a separate personal-layer proposal from existing resources:

```bash
agentbrew adopt \
  --resource npm:pi-subagents \
  --output ./personal.proposed.json
```

Adopt defaults to `manual`; it does not guess compatibility ranges. The output is a new mode-`0600` file, never an overwrite. Creating it does not change npm files, herdr integration, ownership, or Agentbrew state. Review and edit the proposal before using it as an active `--layer` input.

Running `agentbrew adopt` interactively offers resource selection and an output confirmation. Cancelling writes nothing. Local/file dependencies and Pi internal host dependencies are not automatically converted into portable registry declarations.

## Bundle plan and selective apply

The `bundle` sandbox starts with `pi-subagents` declared locally as `^0.83.0` and the personal layer requesting `^0.84.0`.

```bash
agentbrew diff \
  --layer personal="$AGENTBREW_SANDBOX/layers/personal.json" \
  --mode manage \
  --resource npm:pi-subagents \
  --plan-out "$AGENTBREW_SANDBOX/bundle-plan.json"

agentbrew apply --plan "$AGENTBREW_SANDBOX/bundle-plan.json"
```

`diff --plan-out` only creates a plan and exits with `not-executed`. `--mode manage`, explicit repeated `--resource` selections, and a new output file are required.

A Bundle plan contains only typed actions:

- set a selected npm dependency declaration;
- remove a selected dependency with an explicit tombstone;
- ensure the selected herdr Pi integration.

`apply --plan` validates the plan type, source hashes, target, manifest, package-lock, ownership, host links, and integration state before and after acquiring the target lock. It saves a local snapshot, modifies only selected resources, runs npm with `--ignore-scripts --legacy-peer-deps`, records ownership only for successful resources, and finishes with doctor. It never runs a host update, selftest, arbitrary plan command, or unselected convergence.

The same `apply --plan` command also accepts init plans created by `init --plan-out`.

## Native updates with a Bundle

`update` retains the existing native Pi workflow, but adds Bundle guards:

- Declaration drift stops execution and points to the selective plan workflow.
- Bundle updates require initialized local ownership; team/shared intent is not local write authorization.
- Installed `fixed` or `manual` npm resources block `pi update --all`, because that native command cannot exclude them. A native per-resource updater is not implemented.
- Compatible declarations can use the native update when all ownership checks pass. Agentbrew then re-resolves the actual host, repairs managed links, installs dependencies, updates managed integration, and checks health again.
- A manual herdr integration is checked but not regenerated automatically.

A normal native update performs:

1. Validate ownership, Bundle state, host, manifest, dependencies, and replaceable links.
2. Acquire the target lock and re-check target, ownership, and source fingerprints.
3. Save a local snapshot, including the npm manifest and package-lock when present.
4. Run `pi update --all` only when every affected resource is managed and no policy blocker exists.
5. Re-resolve the active host and repair `npm/host-link` plus `npm/host-deps/*`.
6. Use portable `file:host-link` and `file:host-deps/*` declarations, then run npm install.
7. Rebuild herdr integration only when managed and allowed by policy.
8. Verify native links, Bundle declarations, installed package versions, integration, and optional selftest.

Agentbrew does not claim that npm installation alone proves host compatibility or runtime loading.

## First-use initialization

For an existing target, start with:

```bash
agentbrew init
```

Detection is read-only: no lock, state, installation, selftest, or managed change occurs before selection. The modes are:

- **Observe**: report only.
- **Adopt**: record selected resources without updating or normalizing them.
- **Repair**: repair selected generated links and integration only.
- **Manage**: normalize only selected host declarations and record ownership; no full update runs.
- **Fresh**: create selected minimum structure only in a proven-empty target with a working Pi host.

Fresh creates no credentials, extra extensions, or herdr plugins. There is no Reset command, and unknown/damaged content is never cleared.

Non-interactive init requires an explicit assessed class, mode, resource list, and write authorization:

```bash
agentbrew init \
  --expect repairable \
  --mode repair \
  --resource pi.host-links \
  --resource herdr.pi-integration \
  --apply
```

A generic `--yes` cannot replace these choices. Use `init --plan-out <file>` followed by `apply --plan <file>` to separate review from execution.

## Terminal and JSON interaction

In a capable TTY, use ↑/↓ to move, Enter to select, Space to toggle resources, and `a`/`n` to select all/clear optional items. q, Esc, or Ctrl+C cancels. Confirmation pages default to Cancel; required resources cannot be deselected.

The menu preserves the main terminal buffer and restores cursor/input state. Non-TTY streams, `TERM=dumb`, and terminals without raw-mode support use numbered choices and `y/N` confirmation. `NO_COLOR` disables colors. JSON never contains ANSI styling or interactive prompts.

## Health, selftest, and exit status

Without `--selftest`, extension runtime loading is reported as unknown rather than inferred from files. Enable it only after reviewing and trusting the existing configuration:

```bash
agentbrew doctor --selftest
agentbrew update --selftest
```

Bundle doctor statically reads installed package manifests and checks actual versions against the supported exact/caret/tilde constraint. This does not execute the extension or prove host compatibility.

Exit codes:

- `0`: success; no change is valid, and diff may still report differences.
- `1`: validation or execution failure.
- `2`: command-line usage error.
- `3`: partial apply/update; review individual steps and changes.
- `4`: installed or current state is unhealthy.
- `5`: cancelled before authorization; no managed changes.
- `6`: not executed because authorization, ownership, resources, sources, or plan preconditions were insufficient.

## Safety and local state

- External commands use structured argument arrays, not shell-concatenated input.
- Existing non-symlink host links are never replaced; writes reject escaping directory links.
- Plan and proposal files are newly created with private permissions.
- Authentication files are not read or included in results; common credential forms are redacted from command errors.
- Read-only commands do not create Agentbrew state or acquire the write lock. Native tools may maintain their own caches or telemetry.
- Agentbrew does not silently update its own executable.
- Plans, ownership, snapshots, and results are machine-local. Do not commit the state directory as shared configuration.

The operation lock is conservative: an existing lock stops modification. After a crash, first verify no Agentbrew/Pi/npm/herdr process is active, then remove only the stale `operation.lock` for that target. Snapshots are diagnostic backups, not a complete restore format; `restore` is not implemented.

## Development layout

- `src/bundle.ts`: layer validation, composition, declaration drift, and installed-version health.
- `src/bundle-plan.ts`: typed Bundle plans and source/target revalidation.
- `src/bundle-apply.ts`: locked selective Bundle execution.
- `src/adopt.ts`, `src/explain.ts`: read-only proposals and source explanations.
- `src/init.ts`, `src/init-cli.ts`, `src/init-apply.ts`: first-use detection and selective initialization.
- `src/plan.ts`: native update orchestration and read-only commands.
- `src/providers/`: Pi and herdr integrations.
- `src/terminal*.ts`: terminal styling and keyboard menus.
- `test/`: isolated provider/CLI/Bundle/interaction tests, including local npm linking.
- `scripts/sandbox.*`: disposable mock environments.

`docs/PRD.md` contains the long-term product contract and the detailed M2a execution semantics. This README describes only the implemented slice.
