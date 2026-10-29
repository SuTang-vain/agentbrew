# Agentbrew

Agentbrew is a local-first CLI for Pi/herdr configuration, selective initialization, compatibility-resolved updates, and health checks. Shared files describe resource intent; each machine keeps its own Pi host links, resolved packages, ownership, plans, and health evidence.

This repository implements **M1a + M1b + M2a + M2b-0 + M2b-1 + M2c**. It is not the complete product described in `docs/PRD.md`.

## What works now

- A resident, read-only-by-default TUI opened by bare `agentbrew`, with Overview, Health, Differences, Update preview, Sources, and Help pages; `agentbrew --write` explicitly enables confirmed resolved Bundle updates.
- Read-only `inspect`, `diff`, `doctor`, `explain`, and `resolve`.
- Guided `init`: Observe, Adopt, Repair, Manage, and selective Fresh install.
- Bundle `update` with target-host resolution, host-first execution, exact extension versions, locking, snapshots, and final health verification.
- The previous native `update` for configurations without explicit or registered layers.
- Per-target `source set/list/clear` bindings for everyday commands, with explicit-layer precedence and fail-closed validation.
- Public/team/personal/machine layers with explicit whole-resource overrides, tombstones, and team required/forbidden policy.
- Separate `adopt` proposals, typed Bundle plans, and selective `apply`.
- Static checks of both npm declarations and installed package versions for Bundle resources.
- Target-host and extension resolution using the native Pi release channel, npm peer metadata, and registry integrity evidence.
- Pi-style keyboard menus with accessible numbered fallbacks and versioned JSON output.

Not implemented: fixed Bundle Releases, complete Pi host artifact verification, remote Git refresh, non-managed Pi host upgrades, SSH deployment, restore, a registry, generic herdr plugin installation, and generic skills/MCP providers. The M2a `fixed` policy is a local declaration guard, not a team Release.

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

## Interactive workspace

Run `agentbrew` in a capable interactive terminal. It opens a foreground, full-screen workspace rather than a daemon. The workspace is read-only by default:

- **Overview** summarizes the local target, Pi/herdr, health, differences, and active sources.
- **Health** and **Differences** reuse doctor and diff without repairing anything.
- **Update preview** uses the same update path with `dryRun=true`; opening it may fetch release/npm metadata for a Bundle and reports each request while it resolves, but never acquires the write lock or installs anything. The page states `preview: ready · N update(s) · no writes` (or `up to date`), labels `r` as re-check, and without registered sources explains how to obtain a resolved plan. The last successful preview is cached for the session and shows its age; `r` forces a fresh resolution.
- **Sources** explains explicit or registered layers. **Help** lists keyboard controls and explicit commands for other write operations.

Use ↑/↓ and Enter to navigate, `1`–`6` to jump straight to a page, `r` to refresh, and q or Ctrl+C to exit. `?` opens Help without discarding the page behind it, and Esc returns to that page (or to Overview from a result page). While a preview is resolving, Esc aborts its metadata requests and restores the previous page with a cancellation notice. A requested exit still waits for an active read-only preview to settle; that footer also shows elapsed time, and hint text shrinks on narrow terminals instead of hiding the exit key. Re-opening a resolved preview serves the cached result with a `cached Ns ago` line until `r` refreshes it; nothing is persisted. Normal q/EOF exit returns `0`; page health or update results do not change the workspace exit status, so automation must use the explicit structured commands instead.

Applying from the workspace is opt-in: start it with `agentbrew --write` in a capable TTY, without a subcommand, JSON, or another execution option. Only a successful resolved Bundle preview containing a Pi host or external npm package version update offers `u apply`. Native, failed, blocked, up-to-date, and repairs-only previews cannot be applied from the TUI; use the explicit CLI commands for those cases.

The `u apply` confirmation screen lists host and package version changes, any planned herdr rebuild, and the facts that selftest is not run and rollback is not automatic. Cancel is selected by default; Cancel or Esc writes nothing. After confirmation, the update re-resolves metadata and revalidates current sources and local state before writing—the cached preview is not an authorization. The write cannot be cancelled, and an exit request waits for it to settle. The result page reports the actual outcome and reminds you to restart Pi when the host or extensions changed.

Startup and ordinary refreshes perform only local read-only checks, even with `--write`. Without `--write`, the workspace has no executable write action and never runs a real update, init, typed-plan apply, source set/clear, selftest, Reset, or Agentbrew self-update. With `--write`, only the confirmed resolved Bundle update described above can write; all other supported operations remain explicit CLI commands. Non-TTY bare invocation prints help, while non-TTY `--write` is a usage error. Terminals without visual/raw-mode support retain the line-oriented init fallback for ordinary bare invocation; JSON and explicit subcommands never open the TUI.

## Try it without touching real configuration

```bash
git clone https://github.com/SuTang-vain/agentbrew.git
cd agentbrew
npm install
npm run sandbox -- --scenario bundle
```

The sandbox supplies mock Pi/npm/herdr executables and isolated HOME/state directories. The `bundle` scenario also starts a loopback-only release/registry metadata service and pre-authorizes its disposable resources for update demonstrations; it serves metadata only, not package tarballs. Everything stops or resets when you leave or restart the sandbox. It does not use your real Pi, herdr, chezmoi, or global package configuration. Do not run repository build/test commands inside the mock shell because its `npm` is a test double.

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

## Registered source inputs

Register an explicit layer list once for the current Pi target:

```bash
agentbrew source set \
  --layer public="$AGENTBREW_SANDBOX/layers/public.json"
agentbrew source list
agentbrew update
agentbrew diff
agentbrew doctor
agentbrew source clear
```

- `source set` validates and atomically replaces the complete binding. It does not append layers, run providers, or change managed resources.
- The binding is stored as `sources.json` with mode `0600` in this target's local state directory. It contains normalized absolute paths and content hashes, not credentials or shared configuration.
- `inspect`, `diff`, `doctor`, `update`, `resolve`, and `explain` can use the registered inputs. A one-shot explicit `--layer` takes precedence without rewriting the binding. `init`, `adopt`, and typed-plan `apply` do not load it implicitly.
- `source list` reports current or changed content. Missing, malformed, cross-target, or unreadable registrations fail explicitly; update never silently falls back to native bulk update when a binding is damaged.
- A damaged binding is never deleted by `source clear`; replace it with `source set --layer …`, or remove `sources.json` by hand. The file lives in the per-target state directory: `$HOME/.local/state/agentbrew/<target-key>/sources.json`, where `<target-key>` is the first 16 hex characters of the SHA-256 of the resolved `agentDir` (`--state-dir` or `AGENTBREW_STATE_DIR` overrides the root). If that path is a directory, remove it manually.
- Registration does not grant Manage ownership, discover the current directory, read Git credentials, or fetch repositories. `source set` and `clear` share the target operation lock with update, so a changed binding invalidates an in-flight plan.
- After `source clear`, or when no binding was ever registered, `update` retains the native compatibility path described below.

## Read-only compatibility resolution

Resolve a target host and compatible npm versions without changing resources:

```bash
agentbrew resolve \
  --layer public="$AGENTBREW_SANDBOX/layers/public.json" \
  --resource npm:pi-subagents \
  --verbose
```

The resolver uses the same `https://pi.dev/api/latest-version` release channel as native Pi, then reads exact host and extension metadata from the npm registry. It selects the newest version satisfying both the Bundle constraint and all declared Pi peer constraints; if the newest candidate is incompatible, it can fall back to an older compatible version. Results include current/target versions, peer evidence, registry integrity, and `ready`/`complete` status.

- Exact, `^`, and `~` Bundle constraints are supported. Peer checks also support `*`, comparison operators, whitespace AND, and `||`; unsupported ranges become unknown rather than compatible.
- Independent npm packument requests are fetched with bounded concurrency (four at a time), so latency follows the slowest request rather than the sum. The host release and manifest stay sequential because they are data-dependent, and per-resource results keep their sorted order.
- `fixed` and `manual` resources evaluate only the installed version and do not select an upgrade.
- Missing peer metadata is never treated as proof of compatibility. A new required resource is blocked; an existing resource can remain with a warning. If the host changes while any existing resource is unknown, `ready=false` and subsequent updates must remain blocked.
- `PI_OFFLINE=1` stops before any network request. Metadata requests use HTTPS, timeouts, and response-size limits; they do not read npm credentials, download package code, create state, or acquire locks.
- Registry integrity is recorded as resolution evidence. During execution, Agentbrew also checks it against the staged external-package lockfile, which npm uses to verify downloaded registry artifacts. Pi host artifact verification is not complete, and installation does not prove runtime loading.

`update` with explicit layers uses this same resolver; there is no separate version-selection implementation for execution.

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

## Resolved Bundle updates

Preview and execute a compatibility-resolved update:

```bash
agentbrew update \
  --layer public="$AGENTBREW_SANDBOX/layers/public.json" \
  --dry-run

agentbrew update --layer public="$AGENTBREW_SANDBOX/layers/public.json"
```

Every affected resource needs explicit local Manage/Generate ownership. Declaration drift stops execution, and every managed external npm package must have an active Bundle declaration so npm cannot silently update an unplanned resource. Layers come from explicit `--layer` inputs or the per-target registration described above; automatic private-configuration discovery and remote refresh are not implemented.

The resolved workflow:

1. Resolve the target host and all npm resources before locking. `PI_OFFLINE=1`, metadata errors, blocked resources, or unknown compatibility during a host change stop before managed writes.
2. Acquire the target lock and re-check source hashes, ownership, host, manifest, package-lock, and installed package manifests. Save the resolution and local snapshot before execution.
3. If the host must change, run `pi update --self`, never `pi update --all`. Re-discover the host and require both its package version and `pi --version` to equal the plan. A failure or mismatch blocks every extension update. Cross-version updates currently require a managed Pi installation.
4. Derive internal Pi dependencies from the actual target host, verify them against registry metadata, and repair managed `host-link`/`host-deps` links. Their exact versions never enter shared layers.
5. Generate a complete lockfile in an isolated temporary directory. Every direct external dependency is pinned to its resolved target or retained current version, including fixed/manual resources. Restore portable semver ranges at the lockfile root, verify exact versions and registry integrity, then install using that lock with `--ignore-scripts --legacy-peer-deps`. The manifest, reviewed lockfile, every installed direct package, and host links are verified afterward.
6. Rebuild managed herdr integration, run selftest only when explicitly enabled, and finish with doctor.

`fixed` and `manual` resources keep their current version after peer compatibility is proven; they are not rejected merely because native bulk update cannot exclude them. With a stable host, an existing unknown resource may be retained, but its skipped upgrade makes the overall update partial rather than successful.

Agentbrew deliberately does not use per-package `npm install --no-save`: real npm can advance another direct dependency and leave a stale lockfile. The staged plan is saved as `last-install-plan.json` and `last-package-lock.plan.json`, and temporary files are removed after execution. npm verifies external registry artifacts against the reviewed lock integrity; complete Pi host artifact verification, fixed Release semantics, and runtime loading remain separate checks or future work.

### Native update without layers

`agentbrew update` without `--layer` retains the previous `pi update --all` compatibility path, followed by link repair, npm install, managed herdr integration, and doctor. It does not claim target-host compatibility resolution or fixed/manual Bundle policy enforcement. Use an explicit Bundle for those guarantees.

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

Guided one-shot menus preserve the main terminal buffer; the resident workspace uses an alternate screen. Both restore cursor and input state, including startup failures and cancellation. Interactive terminals with `TERM=dumb` or without raw-mode support use numbered choices and `y/N` confirmation; non-TTY streams never prompt. `NO_COLOR` disables colors without disabling a capable TUI. JSON never contains ANSI styling or interactive prompts.

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
- The interactive workspace is read-only by default. `agentbrew --write` enables only confirmed resolved Bundle updates; applying requires the confirmation screen and re-resolves before writing. It does not enable selftest, source changes, or other write operations.
- A damaged source binding blocks only the commands that read it (`inspect`, `diff`, `doctor`, `update`, `resolve`, `explain`); `init`, `adopt`, and typed-plan `apply` do not load it. See "Registered source inputs" for recovery.
- Read-only commands do not create Agentbrew state or acquire the write lock. Native tools may maintain their own caches or telemetry.
- Agentbrew does not silently update its own executable.
- Plans, ownership, snapshots, and results are machine-local. Do not commit the state directory as shared configuration.

The operation lock is conservative: an existing lock stops modification. After a crash, first verify no Agentbrew/Pi/npm/herdr process is active, then remove only the stale `operation.lock` for that target. Snapshots are diagnostic backups, not a complete restore format; `restore` is not implemented.

## Development layout

- `src/bundle.ts`: layer validation, composition, declaration drift, and installed-version health.
- `src/bundle-plan.ts`: typed Bundle plans and source/target revalidation.
- `src/bundle-apply.ts`: locked selective Bundle execution.
- `src/adopt.ts`, `src/explain.ts`: read-only proposals and source explanations.
- `src/metadata.ts`, `src/resolve.ts`, `src/resolve-cli.ts`: bounded metadata access and target-host/asset resolution.
- `src/npm-spec.ts`: exact/caret/tilde and peer-range evaluation.
- `src/init.ts`, `src/init-cli.ts`, `src/init-apply.ts`: first-use detection and selective initialization.
- `src/plan.ts`, `src/resolved-update.ts`, `src/immutable-npm.ts`: update path selection, resolved execution, and staged npm lock plans.
- `src/source-state.ts`, `src/sources.ts`, `src/source-cli.ts`, `src/source-context.ts`: strict per-target source registration and repeatable source preparation.
- `src/providers/`: Pi and herdr integrations.
- `src/terminal*.ts`, `src/result-view.ts`: terminal styling, keyboard menus, and shared result presentation.
- `src/tui.ts`, `src/tui-view.ts`: resident read-only-by-default workspace, keyboard parsing, bounded rendering, confirmed updates, and terminal restoration.
- `test/`: isolated provider/CLI/Bundle/interaction tests, including exact npm updates and loopback metadata.
- `scripts/sandbox.*`: disposable mock environments and their loopback metadata service.

`docs/PRD.md` contains the long-term product contract and the detailed M2a/M2b/M2c execution semantics. This README describes only the implemented slice.
