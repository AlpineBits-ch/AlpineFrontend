import {OsInfo} from '../ports/os-info.port';

/**
 * An {@link OsInfo} for specs, provided in TestBed in place of an adapter.
 *
 * <p>Replaces the `vi.mock('@tauri-apps/api/core', () => ({isTauri: () => true}))` blocks. Those could
 * only ever describe a Tauri host, which is why the browser branch of anything gating on the host went
 * untested; here every branch - including `kind: 'web'` and a phone - is one constructor argument.</p>
 *
 * <p>Defaults to a Windows desktop, because that is the host the existing behaviour was written for and it
 * keeps a spec that does not care about the host from having to say so.</p>
 */
export class FakeOsInfo extends OsInfo {
    /** Set to make {@link appName} reject - a failed IPC round trip. */
    nameError: Error | null = null;

    /** Set to make {@link appVersion} reject. Callers must then show no version, not a stale one. */
    versionError: Error | null = null;

    constructor(
        override readonly kind: OsInfo['kind'] = 'windows',
        override readonly isMobile = false,
        private readonly name = 'Venta',
        private readonly version = '3.0.195',
    ) {
        super();
    }

    override async appName(): Promise<string> {
        if (this.nameError) throw this.nameError;
        return this.name;
    }

    override async appVersion(): Promise<string> {
        if (this.versionError) throw this.versionError;
        return this.version;
    }
}
