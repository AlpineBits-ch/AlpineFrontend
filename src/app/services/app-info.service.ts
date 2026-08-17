import {inject, Injectable, signal} from '@angular/core';
import {OsInfo} from '../platform/ports/os-info.port';

/**
 * Product name baked into `src-tauri/tauri.conf.json`. Used as the label while the host is still
 * being asked, and if it somehow fails to answer.
 */
const FALLBACK_PRODUCT_NAME = 'Venta';

/**
 * Reads the running app's identity from the host once, at startup, and hands it to every consumer as
 * a signal.
 *
 * <p>A thin delegate over {@link OsInfo}. On desktop both values come from `tauri.conf.json`, so a
 * release bump is reflected everywhere without touching the frontend; in a browser they come from the
 * bundle's own `package.json`, which the same version-bump script writes.</p>
 */
@Injectable({
    providedIn: 'root',
})
export class AppInfoService {
    /** Empty until the host answers. */
    public readonly version = signal('');
    public readonly productName = signal(FALLBACK_PRODUCT_NAME);

    private readonly os = inject(OsInfo);

    constructor() {
        // Both stay async even on web, where the answers are already in hand - the port keeps one
        // shape so this has one code path. The catch arms are what used to cover "there is no Tauri
        // app to ask"; they now cover only a genuine IPC failure, and the version is then omitted
        // rather than shown as a stale hardcoded string.
        this.os.appVersion()
            .then(version => this.version.set(version))
            .catch(() => this.version.set(''));

        this.os.appName()
            .then(name => this.productName.set(name))
            .catch(() => this.productName.set(FALLBACK_PRODUCT_NAME));
    }
}
