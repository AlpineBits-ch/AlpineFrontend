import {defineConfig} from 'vitest/config';

/**
 * Test-runner configuration, picked up because `angular.json` sets `runnerConfig: true`.
 *
 * <p>Exists for exactly one setting. `@angular/build:unit-test` defaults Vitest to
 * `isolate: false` - its own comment says "to align with the Karma/Jasmine experience" - which
 * makes every spec file in a worker share one module registry. `vi.mock` is then not per-file in
 * practice: whichever file in the batch registers a mock for a module last decides what every
 * other file in that batch sees.</p>
 *
 * <p><b>That is what was breaking CI, and only CI.</b> Vitest distributes spec files across
 * workers by CPU count, so which files land in a batch together depends on how many cores the
 * machine has. On a 32-core dev box the 92 files spread thin and collided rarely; on a 4-core
 * GitHub runner they batched, and six suites failed with mocks that had silently been replaced by
 * another file's - `vi.mocked(LazyStore).mockImplementation is not a function` (the automock never
 * applied), `Cannot read properties of undefined (reading 'invoke')` (the `@tauri-apps/api/core`
 * namespace came back undefined), and an `@ionic/core` directory import resolving through Node
 * instead of the bundler. None of them were assertion failures, and none reproduced on the
 * developer machine that had just run the same command.</p>
 *
 * <p>Reproduced by running the suite in a Linux container capped to 4 CPUs, which is the shape of
 * a GitHub runner; the failure set moved with the core count and with the number of spec files,
 * which is why adding two files appeared to break four unrelated suites.</p>
 *
 * <p>The cost is a fresh environment per file rather than a shared one. That is the price of
 * `vi.mock` meaning what it says, and it is not negotiable while any spec mocks a module another
 * spec also imports - which, with `@tauri-apps/*` mocked in a dozen places, is most of them.</p>
 */
export default defineConfig({
    test: {
        isolate: true,
    },
});
