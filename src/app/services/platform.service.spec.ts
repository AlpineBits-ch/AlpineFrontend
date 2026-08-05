/**
 * `PlatformService` reads the OS off a global the Tauri runtime injects, from a *field
 * initialiser* - so with no runtime it does not answer "unknown", it throws while the injector is
 * constructing the service, and takes whatever was being built down with it. Outside Tauri that
 * was `MainPageComponent`: `/overview` failed to activate, the router restored the URL it came
 * from, and the app sat on `/authentication` with an empty outlet and a valid session.
 */
vi.mock('@tauri-apps/api/core', () => ({isTauri: vi.fn(() => true)}));
vi.mock('@tauri-apps/plugin-os', () => ({type: vi.fn(() => 'windows')}));

import {TestBed} from '@angular/core/testing';
import {isTauri} from '@tauri-apps/api/core';
import {type as osType} from '@tauri-apps/plugin-os';
import {PlatformService} from './platform.service';

const mockIsTauri = vi.mocked(isTauri);
const mockOsType = vi.mocked(osType);

function build(): PlatformService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    return TestBed.inject(PlatformService);
}

beforeEach(() => {
    // clearAllMocks clears calls but not implementations, so both are restored explicitly - the
    // "outside Tauri" case below would otherwise leak into everything after it.
    vi.clearAllMocks();
    mockIsTauri.mockReturnValue(true);
    mockOsType.mockReturnValue('windows');
});

describe('inside Tauri', () => {
    it('is mobile on ios', () => {
        mockOsType.mockReturnValue('ios');
        expect(build().isMobile).toBe(true);
    });

    it('is mobile on android', () => {
        mockOsType.mockReturnValue('android');
        expect(build().isMobile).toBe(true);
    });

    it('is not mobile on a desktop OS', () => {
        mockOsType.mockReturnValue('macos');
        expect(build().isMobile).toBe(false);
    });
});

describe('outside Tauri', () => {
    it('answers "not mobile" instead of throwing when the OS plugin global is absent', () => {
        mockIsTauri.mockReturnValue(false);
        mockOsType.mockImplementation(() => {
            // Exactly what @tauri-apps/plugin-os does with no runtime: it dereferences
            // window.__TAURI_OS_PLUGIN_INTERNALS__, which is undefined.
            throw new TypeError("Cannot read properties of undefined (reading 'os_type')");
        });

        expect(() => build()).not.toThrow();
        expect(build().isMobile).toBe(false);
    });

    it('does not call into the OS plugin at all', () => {
        mockIsTauri.mockReturnValue(false);

        build();

        expect(mockOsType).not.toHaveBeenCalled();
    });
});
