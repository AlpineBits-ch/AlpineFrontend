import * as fs from 'node:fs';
import * as path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {cspNonce} from './csp-nonce';

function findRepoRoot(): string {
    // Must use `import.meta.url`, not `process.cwd()`: the test builder bundles specs.
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
        // Reading `nonce` passes in jsdom but returns an empty string in every real browser.
        mount({nonce: 'd6ac98bab0ee525c8f66677b15ac1ee9'});

        expect(cspNonce()).toBeUndefined();
    });
});

describe('the nonce pipeline', () => {
    it('substitutes on markup that index.html actually contains', () => {
        // A sub_filter matching nothing does not error, it just silently stops substituting.
        const conf = read('docker', 'web', 'nginx.conf');
        // Compare on the normalised form: the builder re-serialises `<base href="/" />` as `<base href="/">`.
        const html = read('src', 'index.html').replace(/\s*\/>/g, '>');

        const targets = [...conf.matchAll(/^\s*sub_filter\s+'([^']*)'/gm)].map(match => match[1]);

        expect(targets.length).toBeGreaterThan(0);
        for (const target of targets) {
            expect(
                html,
                `nginx.conf substitutes on ${target}, which index.html no longer contains`,
            ).toContain(target);
        }
    });

    it('hands the nonce to PrimeNG', () => {
        // Dropping this option is silent everywhere but a browser with a real CSP.
        const config = read('src', 'app', 'app.config.ts');

        expect(config).toMatch(/csp:\s*\{\s*nonce:\s*cspNonce\(\)\s*}/);
    });
});
