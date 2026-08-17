import {defineConfig} from 'vitest/config';

/** Keep `isolate: true`: without it `vi.mock` leaks across spec files in a worker batch and CI fails on low-core machines. */
export default defineConfig({
    test: {
        isolate: true,
    },
});
