/**
 * `PlatformService` reads the OS off a global the Tauri runtime injects - so with no runtime, the
 * plugin call it used to make did not answer "unknown", it threw. It was also a *field initialiser*,
 * which meant the throw landed while the injector was constructing the service and took whatever was
 * being built down with it. Outside Tauri that was `MainPageComponent`: `/overview` failed to activate,
 * the router restored the URL it came from, and the app sat on `/authentication` with an empty outlet
 * and a valid session.
 *
 * <p><b>Globals rather than `vi.mock`.</b> This used to mock `@tauri-apps/api/core` and
 * `@tauri-apps/plugin-os`, which meant the test asserted on a mock of the thing it was worried about
 * rather than on the thing itself. The service now reads the two globals directly - it is the only
 * place outside `src/app/platform/` that touches the OS one, see its own note - so defining and
 * deleting them is both closer to reality and the reason the last case below can be written at all.</p>
 */
import {TestBed} from '@angular/core/testing';
import {PlatformService} from './platform.service';

type Mutable = Record<string, unknown>;

const TAURI = '__TAURI_INTERNALS__';
const OS = '__TAURI_OS_PLUGIN_INTERNALS__';

function build(): PlatformService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    return TestBed.inject(PlatformService);
}

function setHost(present: boolean): void {
    if (present) (globalThis.window as unknown as Mutable)[TAURI] = {};
    else delete (globalThis.window as unknown as Mutable)[TAURI];
}

function setOs(osType: string | null): void {
    if (osType === null) delete (globalThis.window as unknown as Mutable)[OS];
    else (globalThis.window as unknown as Mutable)[OS] = {os_type: osType};
}

beforeEach(() => {
    setHost(true);
    setOs('windows');
});

afterEach(() => {
    setHost(false);
    setOs(null);
});

describe('inside Tauri', () => {
    it('is mobile on ios', () => {
        setOs('ios');
        expect(build().isMobile).toBe(true);
    });

    it('is mobile on android', () => {
        setOs('android');
        expect(build().isMobile).toBe(true);
    });

    it('is not mobile on a desktop OS', () => {
        setOs('macos');
        expect(build().isMobile).toBe(false);
    });

    /**
     * The case the old implementation could not survive: a Tauri runtime whose OS plugin was not
     * registered. `type()` dereferenced the missing global and threw a `TypeError`; the inlined read is
     * `?.`-chained, so the answer is "not mobile" - which is right for every desktop build and is in any
     * case better than taking the injector down.
     */
    it('answers "not mobile" when the OS plugin global is missing but the runtime is there', () => {
        setOs(null);
        expect(() => build()).not.toThrow();
        expect(build().isMobile).toBe(false);
    });
});

describe('outside Tauri', () => {
    it('answers "not mobile" instead of throwing when the globals are absent', () => {
        setHost(false);
        setOs(null);

        expect(() => build()).not.toThrow();
        expect(build().isMobile).toBe(false);
    });

    it('does not read the OS global at all', () => {
        setHost(false);

        // An accessor rather than a value, so "was it read" is observable. The old spec asserted the
        // same thing against a mocked `type()`; this asserts it against the dereference itself.
        let reads = 0;
        Object.defineProperty(globalThis.window, OS, {
            configurable: true,
            get: () => {
                reads++;
                return {os_type: 'windows'};
            },
        });

        expect(build().isMobile).toBe(false);
        expect(reads).toBe(0);

        delete (globalThis.window as unknown as Mutable)[OS];
    });
});

/**
 * The read is memoised, and that matters: `isMobile` is touched from field initialisers all over the
 * app, so it is read far more often than it changes - which is never within a session.
 */
describe('memoisation', () => {
    it('reads the global once per instance', () => {
        let reads = 0;
        Object.defineProperty(globalThis.window, OS, {
            configurable: true,
            get: () => {
                reads++;
                return {os_type: 'ios'};
            },
        });

        const service = build();
        expect(service.isMobile).toBe(true);
        expect(service.isMobile).toBe(true);
        expect(service.isMobile).toBe(true);
        expect(reads).toBe(1);

        delete (globalThis.window as unknown as Mutable)[OS];
    });
});
