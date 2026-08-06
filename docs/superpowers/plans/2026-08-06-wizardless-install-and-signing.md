# Wizard-less Install and Code Signing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make first install a single self-closing progress window instead of a next-next-next wizard, and wire Authenticode signing into CI so it activates the moment Azure Artifact Signing validation clears.

**Architecture:** Tauri's NSIS template already skips every wizard page when `$PassiveMode = 1` — each page carries `MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive`, and only `MUI_PAGE_INSTFILES` has no such guard. So the wizard-less install is a defaulting change in `.onInit` on a vendored copy of the template, not a rewrite. Signing is kept out of `tauri.conf.json` and applied through a config overlay that CI merges only when the signing secrets exist, so builds keep working before the certificate arrives and become signed builds afterwards with no code change.

**Tech Stack:** NSIS (MakeNSIS + NSIS-MUI2), Tauri 2 bundler, `trusted-signing-cli`, GitHub Actions, Azure Artifact Signing.

## Global Constraints

- The vendored template must match the bundler that consumes it. Ours is **`tauri-bundler-v2.9.4`** (from `@tauri-apps/cli` 2.11.0). Re-vendor on every CLI bump.
- The template is a **handlebars template with 81 `{{placeholder}}` tokens**, not a finished script. Every placeholder must survive editing or the bundle breaks at generation time.
- Follow the existing vendoring convention in this repo: mark every local change with an `ALPINE PATCH` comment, as `src-tauri/vendor/*` already does (see `src-tauri/Cargo.toml`'s notes on `hrtf`, `webrtc-audio-processing-sys`, `tauri-plugin-window-state`).
- NSIS stays `currentUser` (`tauri.conf.json` → `bundle.windows.nsis.installMode`). Per-user is what makes the install UAC-free and the silent update possible. Do not change it.
- Windows ships **NSIS only**. Do not reintroduce `--bundles msi`; see the comment in `.github/workflows/build.yml` and [the update-gate plan](2026-08-06-pre-launch-update-gate.md).
- `tauri.conf.json` must remain buildable **without** any signing credentials. A developer with no Azure access must be able to run `bun run tauri build`.
- Do not commit certificate material, account names, or endpoints that are secret. Azure account/profile names go in GitHub secrets.

---

## Background: why this is small

`src-tauri/target/release/nsis/x64/installer.nsi` (generated) shows the page list, each guarded:

```nsis
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_WELCOME
...
!insertmacro MUI_PAGE_INSTFILES        ; <- the only page with no guard
```

and

```nsis
Function SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd
```

With `$PassiveMode = 1`, Welcome, License, Directory, Start-Menu and Finish all abort, leaving one progress window. The install section additionally calls `CreateOrUpdateDesktopShortcut` and sets `SetAutoClose true` under the same condition, so the window closes itself and the shortcut still gets made.

The updater already relies on this: `installMode: "quiet"` sends `/S /R`. This plan makes an ordinary double-click behave like `/P` instead of like a wizard.

## File Structure

**Create:**
- `src-tauri/vendor/nsis/installer.nsi` — vendored fork of the upstream template. Lives beside the existing `src-tauri/vendor/*` crates so the "we patch upstream here, marked `ALPINE PATCH`" convention is in one place.
- `src-tauri/tauri.signing.conf.json` — config overlay carrying only `bundle.windows.signCommand`. Merged by CI, never by local builds.
- `scripts/check-nsis-template.mjs` — fails CI when the vendored template drifts from the bundler's own copy.

**Modify:**
- `src-tauri/tauri.conf.json` — add `bundle.windows.nsis.template`.
- `.github/workflows/build.yml` — signing step, secrets, drift check, overlay wiring.

---

### Task 1: Vendor the template unchanged and prove it is a no-op

Vendoring and patching are split deliberately: this task proves the fork path works before any behaviour changes, so if the next task misbehaves the cause is unambiguous.

**Files:**
- Create: `src-tauri/vendor/nsis/installer.nsi`
- Modify: `src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `bundle.windows.nsis.template` path that Task 2 edits.

- [ ] **Step 1: Fetch the template matching our bundler**

```bash
mkdir -p src-tauri/vendor/nsis
gh api "repos/tauri-apps/tauri/contents/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi?ref=tauri-bundler-v2.9.4" \
  -q '.content' | base64 -d > src-tauri/vendor/nsis/installer.nsi
wc -l src-tauri/vendor/nsis/installer.nsi
```

Expected: 977 lines.

- [ ] **Step 2: Confirm the placeholders survived the fetch**

```bash
grep -c "{{" src-tauri/vendor/nsis/installer.nsi
```

Expected: `81`. A different number means the fetch mangled the file — stop and re-fetch rather than continuing, because a missing placeholder fails late and confusingly.

- [ ] **Step 3: Point the bundler at it**

In `src-tauri/tauri.conf.json`, change:

```json
      "nsis": {
        "installMode": "currentUser"
      }
```

to:

```json
      "nsis": {
        "installMode": "currentUser",
        "template": "vendor/nsis/installer.nsi"
      }
```

The path is relative to `src-tauri/`.

- [ ] **Step 4: Build and confirm the vendored template is byte-identical in effect**

```bash
bun run tauri build --bundles nsis
```

Expected: succeeds, producing `src-tauri/target/release/bundle/nsis/Venta_<version>_x64-setup.exe`.

Then confirm the generated script still contains the guards we depend on:

```bash
grep -c "MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive" src-tauri/target/release/nsis/x64/installer.nsi
```

Expected: `6`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/vendor/nsis/installer.nsi src-tauri/tauri.conf.json
git commit -m "build(nsis): vendor the installer template unchanged

Vendored from tauri-bundler-v2.9.4 with no edits, so the next commit's
behaviour change has a clean diff to sit on."
```

---

### Task 2: Make passive the default

**Files:**
- Modify: `src-tauri/vendor/nsis/installer.nsi`

**Interfaces:**
- Consumes: the vendored template from Task 1.
- Produces: an installer that shows one progress window on double-click, and still honours `/S` (updater) and a new `/WIZARD` opt-out.

- [ ] **Step 1: Patch `.onInit`**

In `src-tauri/vendor/nsis/installer.nsi`, find:

```nsis
  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
```

and insert immediately after it:

```nsis
  ; ALPINE PATCH: passive is the default, so a double-click gets one progress
  ; window instead of a five-page wizard. Every page except MUI_PAGE_INSTFILES
  ; carries `MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive`, and SkipIfPassive aborts
  ; the page when $PassiveMode = 1 - so this one default is the whole feature.
  ;
  ; It must sit *after* the `/P` block above, not before: `${GetOptions}` writes
  ; its result into $PassiveMode and clears it when the switch is absent, so
  ; setting the default earlier would be overwritten by the very next line.
  ;
  ; `/WIZARD` restores the old pages for anyone who needs to choose an install
  ; directory interactively. Silent installs (`/S`, which is what the updater
  ; sends as `/S /R`) are unaffected: NSIS suppresses pages itself in silent
  ; mode, and the install section keys shortcut creation and auto-close off
  ; `$PassiveMode = 1 ${OrIf} ${Silent}`, which both paths satisfy.
  ${GetOptions} $CMDLINE "/WIZARD" $R9
  ${If} ${Errors}
    StrCpy $PassiveMode 1
  ${Else}
    StrCpy $PassiveMode 0
  ${EndIf}
```

- [ ] **Step 2: Rebuild**

```bash
bun run tauri build --bundles nsis
```

Expected: succeeds.

- [ ] **Step 3: Verify the wizard-less install by hand**

Uninstall any existing copy first so this is a genuine first install:

```powershell
if (Test-Path "$env:LOCALAPPDATA\Venta\uninstall.exe") {
  Start-Process "$env:LOCALAPPDATA\Venta\uninstall.exe" -ArgumentList '/S' -Wait
}
```

Then **double-click** `src-tauri/target/release/bundle/nsis/Venta_<version>_x64-setup.exe` in Explorer — do not launch it from a shell, and specifically not from Git Bash, which rewrites leading-`/` arguments into paths.

Expected: no Welcome page, no licence, no directory picker, no Finish page. One progress window that closes itself. A desktop shortcut and a Start-Menu entry exist afterwards, and the app is in `%LOCALAPPDATA%\Venta`. No UAC prompt at any point.

- [ ] **Step 4: Verify the escape hatch and the updater path still work**

```powershell
# Wizard still reachable on demand
Start-Process ".\src-tauri\target\release\bundle\nsis\Venta_<version>_x64-setup.exe" -ArgumentList '/WIZARD'
# Expected: the full page sequence appears.

# Silent install, which is what the updater runs
Start-Process ".\src-tauri\target\release\bundle\nsis\Venta_<version>_x64-setup.exe" -ArgumentList '/S' -Wait -PassThru
# Expected: exit code 0, no window at all.
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/vendor/nsis/installer.nsi
git commit -m "feat(nsis): default to a passive install, no wizard

Every page but MUI_PAGE_INSTFILES already aborts when \$PassiveMode = 1,
so defaulting it turns a five-page wizard into one self-closing progress
window. /WIZARD restores the pages; /S is unaffected."
```

---

### Task 3: Fail CI when the vendored template drifts

A fork that silently diverges from the bundler it feeds is the main long-term cost of Task 1. This makes divergence loud at the next CLI bump instead of at the next broken installer.

**Files:**
- Create: `scripts/check-nsis-template.mjs`
- Modify: `.github/workflows/build.yml`

**Interfaces:**
- Consumes: `src-tauri/vendor/nsis/installer.nsi`.
- Produces: a `bun run nsis:check` script that exits non-zero on drift.

- [ ] **Step 1: Write the checker**

Create `scripts/check-nsis-template.mjs`:

```js
/**
 * Fails when our vendored NSIS template has drifted from the upstream revision
 * it was forked from.
 *
 * The template is a handlebars source consumed by tauri-bundler, so a bundler
 * upgrade can change the placeholders or the macros it expects while our copy
 * keeps compiling against the old ones - producing an installer that is subtly
 * wrong rather than one that fails to build. This turns that into a CI failure.
 *
 * On drift: re-fetch upstream, re-apply the `ALPINE PATCH` block (see
 * docs/superpowers/plans/2026-08-06-wizardless-install-and-signing.md), and bump
 * PINNED_REF.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const PINNED_REF = 'tauri-bundler-v2.9.4';
const UPSTREAM =
  `https://raw.githubusercontent.com/tauri-apps/tauri/${PINNED_REF}` +
  `/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi`;

// The one block we deliberately add. Everything else must match upstream.
const PATCH_MARKER = 'ALPINE PATCH';

const local = readFileSync('src-tauri/vendor/nsis/installer.nsi', 'utf8');

const res = await fetch(UPSTREAM);
if (!res.ok) {
  console.error(`::error::could not fetch ${UPSTREAM} (HTTP ${res.status})`);
  process.exit(1);
}
const upstream = await res.text();

const placeholders = (s) => (s.match(/\{\{/g) ?? []).length;
if (placeholders(local) !== placeholders(upstream)) {
  console.error(
    `::error::vendored NSIS template has ${placeholders(local)} handlebars ` +
      `placeholders, upstream ${PINNED_REF} has ${placeholders(upstream)}. ` +
      `A dropped placeholder breaks bundling in a way that is hard to read.`,
  );
  process.exit(1);
}

if (!local.includes(PATCH_MARKER)) {
  console.error(
    `::error::vendored NSIS template no longer contains an "${PATCH_MARKER}" ` +
      `block - the passive-by-default change was lost, and installs would go ` +
      `back to showing the wizard.`,
  );
  process.exit(1);
}

// Strip our patch block, then compare. The block is delimited by the marker
// comment and the ${EndIf} that closes it.
const stripped = local.replace(
  /\n\s*; ALPINE PATCH:[\s\S]*?\$\{EndIf\}\n/,
  '\n',
);

const norm = (s) => s.replace(/\r\n/g, '\n').trimEnd();
const hash = (s) => createHash('sha256').update(norm(s)).digest('hex');

if (hash(stripped) !== hash(upstream)) {
  console.error(
    `::error::vendored NSIS template differs from upstream ${PINNED_REF} by ` +
      `more than the ALPINE PATCH block. Re-fetch upstream, re-apply the patch, ` +
      `and bump PINNED_REF.`,
  );
  process.exit(1);
}

console.log(`NSIS template matches ${PINNED_REF} plus the ALPINE PATCH block.`);
```

- [ ] **Step 2: Add the script entry**

In `package.json` `scripts`, beside the existing `licenses` entries:

```json
    "nsis:check": "node scripts/check-nsis-template.mjs",
```

- [ ] **Step 3: Run it and confirm it passes**

```bash
bun run nsis:check
```

Expected: `NSIS template matches tauri-bundler-v2.9.4 plus the ALPINE PATCH block.`

- [ ] **Step 4: Confirm it actually catches drift**

```bash
printf '\n; deliberate drift\n' >> src-tauri/vendor/nsis/installer.nsi
bun run nsis:check; echo "exit=$?"
```

Expected: exit `1` with the "differs from upstream" error. Then revert:

```bash
git checkout -- src-tauri/vendor/nsis/installer.nsi
bun run nsis:check
```

Expected: passes again. A checker that has never been seen to fail is not a checker.

- [ ] **Step 5: Wire it into CI**

In `.github/workflows/build.yml`, in the `release-windows` job, immediately after the `Check third-party notices are up to date` step:

```yaml
      # The NSIS template is vendored (src-tauri/vendor/nsis/installer.nsi) so the
      # installer can default to a passive, wizard-less install. A vendored
      # handlebars template can drift from the bundler that consumes it on any CLI
      # bump, producing a subtly wrong installer rather than a build failure - this
      # makes that loud.
      - name: Check the vendored NSIS template is in sync
        run: bun run nsis:check
```

- [ ] **Step 6: Commit**

```bash
git add scripts/check-nsis-template.mjs package.json .github/workflows/build.yml
git commit -m "ci(nsis): fail when the vendored installer template drifts"
```

---

### Task 4: Signing, inert until the certificate exists

**Files:**
- Create: `src-tauri/tauri.signing.conf.json`
- Modify: `.github/workflows/build.yml`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: signed `Venta.exe` and `Venta_<version>_x64-setup.exe` once the secrets are populated.

> **Prerequisite.** Azure Artifact Signing identity validation must have completed
> for AlpineBits KLG and a **Public Trust** certificate profile must exist. Until
> then this task can be committed but the secrets stay empty and the step no-ops.
> Do not tick Steps 4–6 before that.

- [ ] **Step 1: Create the signing overlay**

Create `src-tauri/tauri.signing.conf.json`:

```json
{
  "bundle": {
    "windows": {
      "signCommand": {
        "cmd": "trusted-signing-cli",
        "args": [
          "-e",
          "$AZURE_ENDPOINT",
          "-a",
          "$AZURE_CODE_SIGNING_NAME",
          "-c",
          "$AZURE_CERT_PROFILE_NAME",
          "%1"
        ]
      }
    }
  }
}
```

`%1` is Tauri's placeholder for the file being signed; the bundler substitutes it
per binary and again for the finished installer. This file is deliberately **not**
merged into `tauri.conf.json`: a developer without Azure credentials must still be
able to run `bun run tauri build`, and a `signCommand` pointing at a missing tool
fails the build for everyone.

- [ ] **Step 2: Commit the overlay on its own**

```bash
git add src-tauri/tauri.signing.conf.json
git commit -m "build(signing): add the Artifact Signing config overlay

Kept out of tauri.conf.json so local builds work without Azure
credentials; CI merges it with --config only when the secrets exist."
```

- [ ] **Step 3: Add the CI steps**

In `.github/workflows/build.yml`, in `release-windows`, immediately **before** the
`Build Tauri (Windows)` step:

```yaml
      # Signing is opt-in on the presence of secrets so the workflow keeps working
      # before the certificate exists. `signing.outputs.enabled` gates every step
      # below, and the build falls back to an unsigned bundle when it is false.
      - name: Detect signing credentials
        id: signing
        shell: bash
        run: |
          if [ -n "${{ secrets.AZURE_CLIENT_ID }}" ]; then
            echo "enabled=true" >> $GITHUB_OUTPUT
          else
            echo "enabled=false" >> $GITHUB_OUTPUT
            echo "::warning::No Azure signing credentials - producing an UNSIGNED build. Users will see SmartScreen warnings."
          fi

      - name: Install trusted-signing-cli
        if: steps.signing.outputs.enabled == 'true'
        run: cargo install trusted-signing-cli@0.11.0
```

Then replace the `Build Tauri (Windows)` step with:

```yaml
      - name: Build Tauri (Windows)
        env:
          RUSTC_WRAPPER: sccache
          SCCACHE_GHA_ENABLED: "true"
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
          SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
          # Consumed by trusted-signing-cli via the Azure SDK's environment
          # credential chain. Unset when signing is disabled, which is fine
          # because the overlay is not merged in that case either.
          AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
          AZURE_CLIENT_SECRET: ${{ secrets.AZURE_CLIENT_SECRET }}
          AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
          AZURE_ENDPOINT: ${{ secrets.AZURE_ENDPOINT }}
          AZURE_CODE_SIGNING_NAME: ${{ secrets.AZURE_CODE_SIGNING_NAME }}
          AZURE_CERT_PROFILE_NAME: ${{ secrets.AZURE_CERT_PROFILE_NAME }}
        shell: bash
        run: |
          if [ "${{ steps.signing.outputs.enabled }}" = "true" ]; then
            bun run tauri build --bundles nsis --config src-tauri/tauri.signing.conf.json
          else
            bun run tauri build --bundles nsis
          fi
```

Note the `TAURI_SIGNING_PRIVATE_KEY` pair is unrelated to Authenticode — it is the
minisign key that signs the updater manifest. Both are needed; neither replaces
the other.

- [ ] **Step 4: Populate the repository secrets**

In the `build` environment, add: `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
`AZURE_TENANT_ID` (from an Entra app registration granted the **Trusted Signing
Certificate Profile Signer** role on the signing account), `AZURE_ENDPOINT` (the
region URI for the account — `https://swn.codesigning.azure.net` for Switzerland
North, `https://weu.codesigning.azure.net` for West Europe), `AZURE_CODE_SIGNING_NAME`
(the Artifact Signing account name) and `AZURE_CERT_PROFILE_NAME` (the Public Trust
profile name).

- [ ] **Step 5: Verify against the Public Trust Test profile first**

Set `AZURE_CERT_PROFILE_NAME` to the **Public Trust Test** profile and push to
`release`. Expected: the build succeeds and the artifacts carry a signature that
chains to a test root — proving the whole pipeline works without spending real
signing operations or attaching the production identity to a broken build.

Then switch the secret to the real Public Trust profile.

- [ ] **Step 6: Verify the shipped artifact is actually signed**

Download the release artifact and check:

```powershell
$s = Get-AuthenticodeSignature ".\Venta_<version>_x64-setup.exe"
$s.Status                      # Expected: Valid
$s.SignerCertificate.Subject   # Expected: contains "AlpineBits KLG"
```

Also verify the **inner** binary, because an installer can be signed while the
executable it drops is not:

```powershell
(Get-AuthenticodeSignature "$env:LOCALAPPDATA\Venta\Venta.exe").Status
```

Expected: `Valid`.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/build.yml
git commit -m "ci(signing): sign Windows artifacts when Azure credentials exist"
```

---

## Self-Review

**Spec coverage.** The "no manual installer you have to run" half of requirement
(a) is delivered by Task 2 and guarded by Task 3. The SmartScreen half is Task 4.
Requirement (b) was delivered by
[the update-gate plan](2026-08-06-pre-launch-update-gate.md) and is untouched here.

**Type consistency.** `PINNED_REF` in `scripts/check-nsis-template.mjs` matches the
`?ref=` in Task 1 Step 1 (`tauri-bundler-v2.9.4`). `PATCH_MARKER` matches the
`; ALPINE PATCH:` comment written in Task 2 Step 1, and the strip regex terminates
on the `${EndIf}` that block actually ends with. The `81` placeholder count in
Task 1 Step 2 is the measured value for that ref. `nsis:check` is spelled the same
in `package.json`, the local runs, and the CI step. The overlay's `$AZURE_*` names
match the `env:` block in Task 4 Step 3 and the secrets in Step 4.

**Known gaps, stated rather than hidden:**

1. **SmartScreen does not clear on day one.** Reputation accrues per certificate
   from download volume over time, and Microsoft removed EV's instant bypass in
   2024. Expect warnings to persist for a while after Task 4 lands; that is the
   process working, not a misconfiguration.
2. **`trusted-signing-cli` is pinned to `0.11.0`** (verified as the current release
   on crates.io, 2026-08-06). It is a third-party crate sitting directly in the
   signing path, so bumping it deserves the same scrutiny as any other
   supply-chain change — pin it, never float it.
3. **The template fork is a standing maintenance cost.** Task 3 makes drift loud,
   but someone still has to re-fetch and re-apply on each CLI bump.
4. **Losing the directory picker is the point, and it is a real trade-off.**
   Anyone who wants a custom location needs `/WIZARD` or `/D=`, which is not
   discoverable. This matches Discord and is a deliberate choice, not an oversight.
5. **Task 4 cannot be completed yet.** Identity validation was submitted
   2026-08-06 and takes 1–20 business days. Tasks 1–3 are independent of it and
   should land first.
