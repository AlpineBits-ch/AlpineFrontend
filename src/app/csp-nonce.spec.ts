import * as fs from 'node:fs';
import * as path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {cspNonce} from './csp-nonce';

/**
 * The CSP nonce reaches PrimeNG through a chain with a link in three different files, and every
 * link fails silently.
 *
 * <p>nginx `sub_filter`s the nonce into the markup, Angular reads `ngCspNonce`, and `app.config.ts`
 * hands the same value to PrimeNG so its runtime-injected `<style>` elements are accepted. Break
 * any one and the app still builds, still boots, still passes every component spec - and renders
 * with no PrimeNG styling at all, because a blocked stylesheet is not an error the app can see.
 * That is what shipped on 2026-08-12. These assertions are the tripwire.</p>
 */

function findRepoRoot(): string {
    // From `import.meta.url`, not `process.cwd()`: the test builder bundles specs, so this file's
    // reported location need not be its source location, and a root that resolved to nothing would
    // make every assertion below vacuously pass.
    const pathname = decodeURIComponent(new URL(import.meta.url).pathname);
    let dir = path.dirname(pathname.replace(/^\/([A-Za-z]:)/, '$1'));

    for (let i = 0; i < 12; i++) {
        if (fs.existsSync(path.join(dir, 'angular.json'))) return dir;

        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }

    throw new Error(`Could not locate the repo root by walking up from ${pathname}`);
}

const REPO_ROOT = findRepoRoot();

function read(...segments: string[]): string {
    return fs.readFileSync(path.join(REPO_ROOT, ...segments), 'utf8');
}

describe('cspNonce', () => {
    afterEach(() => {
        document.querySelectorAll('app-root').forEach(element => element.remove());
    });

    function mount(attributes: Record<string, string>): void {
        const root = document.createElement('app-root');
        for (const [name, value] of Object.entries(attributes)) root.setAttribute(name, value);
        document.body.appendChild(root);
    }

    it('reads the nonce nginx stamped onto app-root', () => {
        mount({ngCspNonce: 'd6ac98bab0ee525c8f66677b15ac1ee9'});

        expect(cspNonce()).toBe('d6ac98bab0ee525c8f66677b15ac1ee9');
    });

    it('is undefined on a host that stamps nothing, which is desktop and `ng serve`', () => {
        mount({});

        expect(cspNonce()).toBeUndefined();
    });

    it('is undefined when there is no app-root at all', () => {
        expect(cspNonce()).toBeUndefined();
    });

    it('does not read the real `nonce` attribute, which browsers blank after parsing', () => {
        // Reading `nonce` instead of `ngCspNonce` passes in jsdom and returns an empty string in
        // every real browser, so the mistake would survive a green suite and ship.
        mount({nonce: 'd6ac98bab0ee525c8f66677b15ac1ee9'});

        expect(cspNonce()).toBeUndefined();
    });
});

describe('the nonce pipeline', () => {
    it('substitutes on markup that index.html actually contains', () => {
        // nginx.conf's own comment notes that a sub_filter matching nothing does not error - it
        // just silently stops substituting. Adding an attribute to `<app-root>` in index.html is
        // enough to do it, and nothing downstream would complain.
        const conf = read('docker', 'web', 'nginx.conf');
        // The builder re-serialises index.html, so `<base href="/" />` in source reaches nginx as
        // `<base href="/">`. Compare on that normalised form: matching the source verbatim reports
        // a substitution as broken when it works, which is how this assertion first failed.
        const html = read('src', 'index.html').replace(/\s*\/>/g, '>');

        const targets = [...conf.matchAll(/^\s*sub_filter\s+'([^']*)'/gm)].map(match => match[1]);

        expect(targets.length).toBeGreaterThan(0);
        for (const target of targets) {
            expect(html, `nginx.conf substitutes on ${target}, which index.html no longer contains`)
                .toContain(target);
        }
    });

    it('hands the nonce to PrimeNG', () => {
        // PrimeNG defaults `csp` to `{nonce: undefined}` and injects its compiled preset as
        // `<style>` elements regardless, so dropping this option is silent everywhere but a
        // browser with a real CSP.
        const config = read('src', 'app', 'app.config.ts');

        expect(config).toMatch(/csp:\s*\{\s*nonce:\s*cspNonce\(\)\s*}/);
    });
});
