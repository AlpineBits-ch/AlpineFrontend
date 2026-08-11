import {OsInfo} from '../ports/os-info.port';
import {sniffIsMobile} from '../os-kind';
import {version as packageVersion} from '../../../../package.json';

/**
 * What the product calls itself in a browser.
 *
 * <p>The value of `productName` in `src-tauri/tauri.conf.json`, which is where the desktop adapter
 * gets it from. Hardcoded because there is no app bundle to ask - a browser tab has a document title
 * and nothing else - and duplicated rather than derived because the alternative is shipping the Tauri
 * config to the browser to read one string out of it.</p>
 */
const PRODUCT_NAME = 'Venta';

/**
 * What the browser build knows about itself.
 *
 * <p>`kind` is `'web'` and stays `'web'` on a phone: it names the <i>shell</i>, and callers reading it
 * are asking which desktop OS they are on, for which the honest answer in a browser is none of them.
 * The form factor question is {@link isMobile}, which does answer truthfully on a phone browser.</p>
 */
export class WebOsInfo extends OsInfo {
    override readonly kind = 'web' as const;

    /**
     * Whether this is a phone or tablet browser.
     *
     * <p>Read once at construction to match the desktop adapter, where the value is compiled in and
     * cannot change. A browser window resized past a breakpoint does not turn into a phone.</p>
     */
    override readonly isMobile: boolean = sniffIsMobile();

    override async appName(): Promise<string> {
        return PRODUCT_NAME;
    }

    /**
     * The version this bundle was built from.
     *
     * <p><b>Read out of `package.json` rather than written here as a literal.</b>
     * `scripts/version-bump.js` moves `package.json`, `tauri.conf.json` and `Cargo.toml` together, so
     * this stays in step with the desktop build for free, whereas a constant in this file would be
     * missed by that script and quietly drift.</p>
     *
     * <p>Drift would matter more than a wrong number in the About page: `logout-dialog.component.ts`
     * passes this into `MlsService.exportBackup`, so it is stamped into the key-backup envelope and
     * becomes the record of which client wrote a backup someone is trying to restore.</p>
     *
     * <p>`resolveJsonModule` is already on, and the named import lets the bundler keep the one string
     * instead of inlining the whole manifest - which also matters because `package.json` lists every
     * dependency and version this client is built from, and that is not something to publish to a web
     * origin wholesale.</p>
     */
    override async appVersion(): Promise<string> {
        return packageVersion;
    }
}
