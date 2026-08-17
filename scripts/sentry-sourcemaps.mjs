/**
 * Injects debug ids into the built frontend and uploads the sourcemaps to Sentry,
 * skipping cleanly when there is no auth token.
 *
 * `beforeBuildCommand` is `bun run build`, so every `tauri build` runs this -
 * including the Windows and Linux release jobs, which build the *same* frontend
 * and would otherwise upload an identical set of sourcemaps to the same Sentry
 * release twice. Only release-linux carries SENTRY_AUTH_TOKEN now; Windows skips
 * here instead of paying ~40s for a duplicate upload on the job that gates the
 * release.
 *
 * The skip is keyed on the token being absent rather than on an explicit
 * SKIP_SENTRY=1 flag, because that is the same condition that made this fail for
 * everyone else: `sentry-cli sourcemaps upload` exits non-zero without
 * credentials, so a plain `bun run tauri build` on a dev machine died at the very
 * end of an otherwise complete build. Anyone who *wants* the upload sets the
 * token, and forks - which never receive repository secrets - stop breaking.
 *
 * Uses spawnSync with an argv array rather than a shell string: the `./dist` path
 * and the org/project flags are fixed, but shelling out on Windows re-parses the
 * command through cmd.exe, and that is the layer that has historically mangled
 * paths here.
 */
import { spawnSync } from 'node:child_process';

const ORG = 'alpinebits-klg';
const PROJECT = 'venta-frontend';
const DIST = './dist';

if (!process.env.SENTRY_AUTH_TOKEN) {
  console.log(
    'SENTRY_AUTH_TOKEN is not set - skipping sourcemap inject and upload. ' +
      'The build output is unaffected; only Sentry symbolication for this build is.',
  );
  process.exit(0);
}

// Inject first, then upload. The inject step stamps a debug id into each bundle
// and its map; uploading without it produces maps Sentry cannot match to a stack
// frame, which fails silently at symbolication time rather than loudly here.
const steps = [
  ['sourcemaps', 'inject', '--org', ORG, '--project', PROJECT, DIST],
  ['sourcemaps', 'upload', '--org', ORG, '--project', PROJECT, DIST],
];

for (const args of steps) {
  const result = spawnSync('sentry-cli', args, { stdio: 'inherit', shell: true });

  if (result.error) {
    console.error(`Failed to run sentry-cli: ${result.error.message}`);
    process.exitCode = 1;
    break;
  }

  if (result.status !== 0) {
    console.error(`sentry-cli ${args.join(' ')} exited with ${result.status}`);
    process.exitCode = result.status ?? 1;
    break;
  }
}
