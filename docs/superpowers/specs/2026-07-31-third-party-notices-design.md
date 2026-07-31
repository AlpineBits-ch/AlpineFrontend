# Third-party notices — design

**Date:** 2026-07-31
**Status:** approved, implementing

## Problem

The app ships 904 Rust crates and ~330 production npm packages, and reproduces a copyright notice
for none of them. Every direct dependency but one (`tslib`, 0BSD) carries an attribution
obligation, and several obligations are stronger than a bare MIT line:

- Google's WebRTC C++ (BSD-3-Clause) is **compiled into the binary** whenever the default `aec`
  feature is on. Its binary-form clause explicitly requires reproducing the notice "in the
  documentation and/or other materials provided with the distribution".
- The SADIE II HRIR sphere (Apache-2.0, University of York) is `include_bytes!`'d into the binary
  at `src-tauri/src/media/voice/mixer.rs:53` — 18 MB of third-party data.
- `emoji-datasource-twitter` declares MIT, but `angular.json` copies its sprite sheet into the
  build output, and those sprites are Twemoji graphics under **CC-BY-4.0**.
- `jpeg-encoder` is `(MIT OR Apache-2.0) AND IJG` — the `AND` makes the IJG credit mandatory
  regardless of which permissive licence is chosen.

None of these are visible to a naive dependency scanner. Three of the four are invisible to any
scanner at all.

## Approach

A committed, script-regenerated notices file, delivered as an Angular asset and shown on a new
About page in the settings modal.

Committed rather than build-time-generated: diffs are reviewable in git, builds stay offline and
fast, and CI can fail on staleness. The build already needs meson/ninja/python for `aec`; it does
not need a fourth tool.

Angular asset rather than Tauri resource: the notices are UI text and the About page is UI. An
asset needs no `bundle.resources` entry, no fs capability scope, and works identically under
`ng serve` — a Tauri resource does not exist during web dev, which would break the page there.

`cargo-about` was considered and rejected. It is not installed, and requiring `cargo install
cargo-about` for regeneration buys little: all 904 crate sources are already extracted under
`~/.cargo/registry/src`, and 775 of them ship a real licence file. The remaining 129 are covered by
an SPDX fallback table.

## Components

### `scripts/generate-notices.js`

One dependency-free Node script. Two collectors and a renderer.

**Rust collector.** Shells `cargo metadata --format-version 1` in `src-tauri` and walks the resolve
graph from the root package, excluding only `dev` edges. Build edges are kept deliberately: `-sys`
crates link real code into the shipped binary, so dropping them would under-attribute. This
over-includes a few build-only crates such as `tauri-build`. Over-attribution is harmless;
under-attribution is not.

**npm collector.** Breadth-first over the production closure, seeded from `dependencies` only.
`devDependencies` are excluded — they do not ship. Each name resolves through nested-then-ancestor
`node_modules`, matching Node's own resolution.

**Licence text resolution**, identical for both ecosystems:

1. Read `LICENSE*` / `LICENCE*` / `COPYING*` / `NOTICE*` / `UNLICENSE*` from the package directory.
   This is the verbatim upstream text and carries the real copyright holder.
2. If the package ships none, fall back to canonical SPDX text from `scripts/spdx-texts.js`,
   prefixed with an attribution line built from the manifest's `authors` and `repository` so the
   copyright holder survives.
3. If neither applies, **fail**.

### Failure over silent gaps

A package that resolves to no licence file and no known SPDX id exits the script non-zero and names
the package. A new dependency under an unrecognised licence cannot slip in unnoticed. A notices
file that silently omits things is worse than no notices file, because it looks like diligence.

### `scripts/spdx-texts.js`

Canonical text for the licence ids present in the tree: MIT, Apache-2.0, BSD-2-Clause,
BSD-3-Clause, ISC, Zlib, MPL-2.0, Unicode-3.0, BSL-1.0, CC0-1.0, Unlicense, 0BSD, OFL-1.1,
CC-BY-4.0.

### `scripts/extra-notices.md`

Hand-written appendix, appended verbatim. Covers the five obligations no scanner can see: bundled
WebRTC C++, the SADIE II sphere, Twemoji graphics, the IJG credit, and OpenH264 — including the
statement that Cisco's binary is fetched at runtime and never redistributed, which is what keeps
the AVC royalty burden off this project.

### Output

`src/assets/THIRD-PARTY-NOTICES.md`, committed. Regenerated with `bun run licenses`.

### UI

`pages/about-settings/`, following the existing nine-page pattern, plus an `about` nav entry in
`settings-modal.component.ts`. Fetches the asset over `HttpClient` and renders it through `marked`
+ `dompurify` — both already runtime dependencies, so no new packages.

The page absorbs the existing "About" section from `other-settings` (app version and the
update-check button) and that section is deleted there. Two About blocks in one settings modal
would be incoherent, and the move fixes a hardcoded `Version 0.1.0-alpha` string that has been
stale since the app reached 3.0.148. Version now comes from `getVersion()` in
`@tauri-apps/api/app`.

Strings are hardcoded English, matching `other-settings` and five of the nine existing pages. No
`venta-i18n` submodule commit is required.

### CI

A step in `.github/workflows/build.yml` runs `bun run licenses` then `git diff --exit-code`, so
adding a dependency without regenerating the notices fails the build.

## Testing

`scripts/generate-notices.test.js` under vitest, covering the pure logic: the resolve-graph walk
excludes dev edges, the npm closure excludes devDependencies, licence-file discovery prefers a
shipped file over SPDX fallback, and an unknown licence id throws rather than emitting an empty
section.

The generated file itself is verified by assertion on known-hard cases: the WebRTC BSD-3-Clause
notice is present, the OFL fonts appear, and the Twemoji CC-BY-4.0 entry exists.

## Out of scope

Licence *compatibility* review. This produces the attributions the licences require; it does not
opine on whether any licence conflicts with how the app is distributed. One flag worth recording:
`@sentry/cli` is `FSL-1.1-MIT`, not an open-source licence, and is listed under runtime
`dependencies` though it is a build tool used only by the `sentry:sourcemaps` script. It does not
ship, so it owes no notice, but it is misfiled.
