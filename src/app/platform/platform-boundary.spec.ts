import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';

/**
 * The boundary invariant: **no file outside `src/app/platform/` may import a native host module.**
 *
 * <p>There is no ESLint config in this repo, so this is enforced as an assertion rather than as a
 * convention. It starts red, and going green *is* the definition of the port work being finished -
 * the failure message lists every offender with the specifier it matched, so it doubles as the
 * migration checklist. See `docs/superpowers/specs/2026-08-11-browser-only-build-design.md`.</p>
 *
 * <p>This is a plain-function spec: no TestBed, no Angular, nothing to bootstrap. It reads the source
 * tree off disk, which is why it can be trusted at all - a spec that imported the modules to inspect
 * them would be asserting on the bundler's output rather than on what anyone will read in a
 * review.</p>
 */

/** Package prefixes that only exist inside a Tauri host. */
const NATIVE_PREFIXES = ['@tauri-apps/', 'tauri-plugin-', '@choochmeque/'] as const;

/**
 * The one directory allowed to know a native host exists.
 *
 * <p>Relative to `src/app`, with a trailing separator so a sibling named `platform-status` - and
 * there is one, `platform-status.service.ts` - is not accidentally exempted along with it.</p>
 */
const PLATFORM_DIR = 'platform';

/**
 * Suffixes exempt for now.
 *
 * <p><b>`*.spec.ts` is temporary.</b> Ten specs currently do `vi.mock('@tauri-apps/api/core', ...)`
 * to force `isTauri() === true`, which is a legitimate thing to have needed and is not what this
 * assertion is about. The design spec's plan is fake adapters provided in TestBed, and <b>the
 * exemption is removed per-file as each spec moves to one</b> - so this list shrinks to nothing
 * rather than staying as a permanent hole. Nothing else belongs here.</p>
 */
const EXEMPT_SUFFIXES = ['.spec.ts'] as const;

/**
 * Matches the specifier of a static import, a re-export, or a dynamic `import()`.
 *
 * <p>Specifier position only, deliberately: `native-ptt.service.ts` mentions plugin names in prose,
 * and a bare substring search would report a comment as a boundary violation. `require()` is
 * included for completeness even though nothing in this tree uses it.</p>
 */
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"])([^'"]+)\1/g;

/**
 * Locates `src/app` from this spec's own position, walking up to the directory holding
 * `angular.json`.
 *
 * <p>Not `process.cwd()`: a runner is free to change it, and a boundary check that silently found no
 * files would pass. Not a fixed number of `..` either - the test builder bundles specs, so
 * `import.meta.url` need not sit at the source path - so the repo root is *identified* rather than
 * counted to.</p>
 */
function findAppRoot(): string {
    let dir = specDir();

    for (let i = 0; i < 12; i++) {
        const appRoot = path.join(dir, 'src', 'app');
        if (fs.existsSync(path.join(dir, 'angular.json')) && fs.existsSync(appRoot)) return appRoot;

        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }

    throw new Error(`Could not locate src/app by walking up from ${specDir()}`);
}

/** This file's directory, from `import.meta.url` rather than from the cwd. */
function specDir(): string {
    // `new URL(...).pathname` is `/C:/Users/...` on Windows; the drive letter has to come first for
    // `path` to treat it as absolute, or every `existsSync` below quietly answers false.
    const pathname = decodeURIComponent(new URL(import.meta.url).pathname);
    const native = pathname.replace(/^\/([A-Za-z]:)/, '$1');
    return path.dirname(native);
}

/** Every `.ts` file under `root`, as paths relative to it, posix-separated. */
function collectTsFiles(root: string): string[] {
    const found: string[] = [];

    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile() && entry.name.endsWith('.ts')) {
                found.push(path.relative(root, full).split(path.sep).join('/'));
            }
        }
    };

    walk(root);
    return found.sort();
}

function isExempt(relative: string): boolean {
    if (relative === PLATFORM_DIR || relative.startsWith(`${PLATFORM_DIR}/`)) return true;
    return EXEMPT_SUFFIXES.some(suffix => relative.endsWith(suffix));
}

/**
 * Globals the Tauri runtime injects onto `window`.
 *
 * <p>Reading one of these is exactly as much of a boundary breach as importing a plugin, and the
 * import check above cannot see it - which is not hypothetical: `platform.service.ts` inlines
 * `window.__TAURI_OS_PLUGIN_INTERNALS__.os_type` (all that the plugin's `type()` does) and passed the
 * import check while doing it. An invariant whose value is that it cannot decay has to cover both
 * spellings, or the next migration just moves from one to the other.</p>
 */
const NATIVE_GLOBAL_RE = /__TAURI[A-Z_]*__/g;

/**
 * Files allowed to read a native global from outside `src/app/platform/`.
 *
 * <p><b>Exactly one, and it is documented rather than tolerated.</b> `PlatformService.isMobile` is
 * injected from *field initialisers* across the app - the hazard that file explains at length - so it
 * cannot take an `OsInfo` dependency yet. `isMobile` is now a memoised getter rather than a field, so
 * nothing runs during construction and the collapse onto `OsInfo` is a mechanical change whenever its
 * callers stop being field initialisers.</p>
 *
 * <p>The exit condition is that collapse. Nothing else goes on this list: a new entry means someone
 * reached around the ports, which is the thing this file exists to make impossible to do quietly.</p>
 */
const GLOBAL_READ_ALLOWLIST = ['services/platform.service.ts'] as const;

function nativeGlobalsIn(source: string): string[] {
    const code = stripComments(source);
    return [...new Set([...code.matchAll(NATIVE_GLOBAL_RE)].map(match => match[0]))];
}

/**
 * Blanks out comments, leaving code and string literals intact.
 *
 * <p>Needed for the same reason the import check matches specifier position only, and learned the same
 * way: the first version of the global check reported `device-description.ts`, whose comment explains
 * that it uses `detectHost()` *rather than* a second read of `__TAURI_INTERNALS__`. Naming the thing
 * you are avoiding is good prose and must not read as a violation.</p>
 *
 * <p><b>String literals deliberately survive</b> - `'__TAURI_INTERNALS__' in window` is the real idiom
 * for this read, so stripping strings would blind the check to the very spelling it exists to catch.
 * String state is still tracked while scanning, so a `//` inside a URL does not swallow the rest of
 * its line.</p>
 */
function stripComments(source: string): string {
    let out = '';
    let i = 0;
    let quote: string | null = null;

    while (i < source.length) {
        const ch = source[i]!;
        const next = source[i + 1];

        if (quote) {
            if (ch === '\\') {
                out += source.slice(i, i + 2);
                i += 2;
                continue;
            }
            if (ch === quote) quote = null;
            out += ch;
            i++;
            continue;
        }

        if (ch === '"' || ch === "'" || ch === '`') {
            quote = ch;
            out += ch;
            i++;
            continue;
        }

        if (ch === '/' && next === '/') {
            while (i < source.length && source[i] !== '\n') i++;
            continue;
        }

        if (ch === '/' && next === '*') {
            i += 2;
            while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
            i += 2;
            continue;
        }

        out += ch;
        i++;
    }

    return out;
}

function nativeImportsIn(source: string): string[] {
    const hits: string[] = [];

    for (const match of source.matchAll(SPECIFIER_RE)) {
        const specifier = match[2];
        if (specifier && NATIVE_PREFIXES.some(prefix => specifier.startsWith(prefix))) {
            hits.push(specifier);
        }
    }

    return [...new Set(hits)];
}

describe('platform boundary', () => {
    const appRoot = findAppRoot();
    const files = collectTsFiles(appRoot);

    it('finds the source tree it is meant to be checking', () => {
        // Guards the check itself. Every assertion below is vacuously true against an empty file
        // list, so a path resolved wrongly would present as a green boundary rather than as an error.
        expect(files.length).toBeGreaterThan(100);
        expect(files).toContain('platform/platform-boundary.spec.ts');
    });

    it('keeps native host imports inside src/app/platform', () => {
        // One readable line per offence rather than a list of objects: this array *is* the diff the
        // runner prints, so it has to be legible on its own and not only inside the message below.
        const offences: string[] = [];
        const offendingFiles = new Set<string>();

        for (const file of files) {
            if (isExempt(file)) continue;
            const source = fs.readFileSync(path.join(appRoot, file), 'utf8');
            for (const specifier of nativeImportsIn(source)) {
                offences.push(`src/app/${file} -> ${specifier}`);
                offendingFiles.add(file);
            }
        }

        expect(
            offences,
            `${offendingFiles.size} file(s) outside src/app/platform/ still import a native host ` +
            'module.\nEach one is a port migration that has not happened yet; the fix is to depend ' +
            'on a port\nin src/app/platform/ports/ instead. See\n' +
            'docs/superpowers/specs/2026-08-11-browser-only-build-design.md.\n\n' +
            `${offences.map(line => `  ${line}`).join('\n')}\n`,
        ).toEqual([]);
    });

    it('keeps native global reads inside src/app/platform', () => {
        const offences: string[] = [];

        for (const file of files) {
            if (isExempt(file)) continue;
            if ((GLOBAL_READ_ALLOWLIST as readonly string[]).includes(file)) continue;

            const source = fs.readFileSync(path.join(appRoot, file), 'utf8');
            for (const global of nativeGlobalsIn(source)) {
                offences.push(`src/app/${file} -> window.${global}`);
            }
        }

        expect(
            offences,
            'A file outside src/app/platform/ reads a global the Tauri runtime injects.\n' +
            'This is the same breach as importing a plugin, only invisible to the import check -\n' +
            'ask a port instead. `detectHost()` answers "which host is this"; PlatformCapabilities\n' +
            'answers "can this host do X", which is almost always the real question.\n\n' +
            `${offences.map(line => `  ${line}`).join('\n')}\n`,
        ).toEqual([]);
    });

    it('does not carry a stale allowlist entry', () => {
        // An allowlist outlives what it excused. Each entry must still exist AND still contain the
        // thing it was excused for - otherwise the list quietly grants a permanent exemption to a file
        // that no longer needs one, and the next reader treats it as precedent.
        for (const allowed of GLOBAL_READ_ALLOWLIST) {
            const full = path.join(appRoot, allowed);
            expect(fs.existsSync(full), `${allowed} is allowlisted but does not exist`).toBe(true);
            expect(
                nativeGlobalsIn(fs.readFileSync(full, 'utf8')),
                `${allowed} no longer reads a native global - remove it from GLOBAL_READ_ALLOWLIST`,
            ).not.toEqual([]);
        }
    });
});
