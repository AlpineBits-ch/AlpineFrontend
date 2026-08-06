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
 *
 * Sets `process.exitCode` rather than calling `process.exit()`. Exiting hard
 * while the fetch's handle is still open trips a libuv assertion on Windows
 * ("!(handle->flags & UV_HANDLE_CLOSING)"), which replaces the exit code with a
 * crash and buries the actual error message under a stack dump.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const PINNED_REF = 'tauri-bundler-v2.9.4';
const UPSTREAM =
  `https://raw.githubusercontent.com/tauri-apps/tauri/${PINNED_REF}` +
  `/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi`;

// Our deliberate additions. Each is delimited explicitly rather than inferred
// from NSIS structure: an earlier version stripped from the marker comment to
// the next `${EndIf}`, which silently mismatched the moment a patch contained a
// nested ${If} - it ate the inner EndIf and left the outer one behind, and the
// checker then reported drift on a correct file.
const PATCH_BEGIN = '; ALPINE PATCH BEGIN';
const PATCH_END = '; ALPINE PATCH END';
// `\n\s*` at the start deliberately swallows the blank line that separates the
// patch from the code above it, so replacing the match with a single "\n"
// restores exactly the spacing upstream has. Anchoring on `[ \t]*` instead
// leaves that blank line behind and the comparison fails by one newline.
const PATCH_BLOCK = /\n\s*; ALPINE PATCH BEGIN\n[\s\S]*?\n[ \t]*; ALPINE PATCH END\n/g;
const LOCAL_PATH = 'src-tauri/vendor/nsis/installer.nsi';

const fail = (message) => {
  console.error(`::error::${message}`);
  process.exitCode = 1;
};

const placeholders = (s) => (s.match(/\{\{/g) ?? []).length;
const norm = (s) => s.replace(/\r\n/g, '\n').trimEnd();
// Inputs are already normalised by main(); this just hashes them.
const hash = (s) => createHash('sha256').update(s).digest('hex');

async function main() {
  // Normalised up front, before anything pattern-matches against them. The
  // working copy has CRLF endings on Windows (core.autocrlf), so a regex
  // anchored on `\n` silently fails to match `\r\n` - which showed up as the
  // checker reporting drift on a pristine file.
  const local = norm(readFileSync(LOCAL_PATH, 'utf8'));

  const res = await fetch(UPSTREAM);
  if (!res.ok) {
    return fail(`could not fetch ${UPSTREAM} (HTTP ${res.status})`);
  }
  const upstream = norm(await res.text());

  if (placeholders(local) !== placeholders(upstream)) {
    return fail(
      `vendored NSIS template has ${placeholders(local)} handlebars ` +
        `placeholders, upstream ${PINNED_REF} has ${placeholders(upstream)}. ` +
        `A dropped placeholder breaks bundling in a way that is hard to read.`,
    );
  }

  const begins = local.split(PATCH_BEGIN).length - 1;
  const ends = local.split(PATCH_END).length - 1;

  if (begins === 0) {
    return fail(
      `vendored NSIS template no longer contains an "${PATCH_BEGIN}" block - ` +
        `the passive-by-default change was lost, and installs would go back to ` +
        `showing the wizard.`,
    );
  }

  if (begins !== ends) {
    return fail(
      `vendored NSIS template has ${begins} "${PATCH_BEGIN}" markers but ${ends} ` +
        `"${PATCH_END}" markers. Every patch must be delimited at both ends or ` +
        `the comparison below silently stops matching.`,
    );
  }

  // Strip every delimited patch block, then compare the remainder to upstream.
  const stripped = local.replace(PATCH_BLOCK, '\n');

  if (hash(stripped) !== hash(upstream)) {
    return fail(
      `vendored NSIS template differs from upstream ${PINNED_REF} by more than ` +
        `the ALPINE PATCH block. Re-fetch upstream, re-apply the patch, and ` +
        `bump PINNED_REF.`,
    );
  }

  console.log(`NSIS template matches ${PINNED_REF} plus the ALPINE PATCH block.`);
}

await main();
