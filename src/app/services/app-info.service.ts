import {Injectable, signal} from '@angular/core';
import {getName, getVersion} from '@tauri-apps/api/app';

/**
 * Product name baked into `src-tauri/tauri.conf.json`. Used as the label outside a Tauri window,
 * where there is no app to ask.
 */
const FALLBACK_PRODUCT_NAME = 'Venta';

/**
 * Reads the running app's identity from Tauri once, at startup, and hands it to every consumer as
 * a signal. Both values come from `tauri.conf.json`, so a release bump is reflected everywhere
 * without touching the frontend.
 */
@Injectable({
    providedIn: 'root',
})
export class AppInfoService {
    /** Empty until Tauri answers, and permanently empty outside a Tauri window. */
    public readonly version = signal('');
    public readonly productName = signal(FALLBACK_PRODUCT_NAME);

    constructor() {
        // Both reject outside a Tauri window - under `ng serve` there is no app to ask. The version
        // is then omitted rather than shown as a stale hardcoded string.
        getVersion()
            .then(version => this.version.set(version))
            .catch(() => this.version.set(''));

        getName()
            .then(name => this.productName.set(name))
            .catch(() => this.productName.set(FALLBACK_PRODUCT_NAME));
    }
}
