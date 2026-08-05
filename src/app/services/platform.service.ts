import {Injectable} from '@angular/core';
import {isTauri} from '@tauri-apps/api/core';
import {type} from "@tauri-apps/plugin-os";

@Injectable({
    providedIn: 'root',
})
export class PlatformService {
    /**
     * Whether this is a phone build.
     *
     * <p>Gated on `isTauri()` because `type()` is not a call that can fail gracefully - it reads
     * `window.__TAURI_OS_PLUGIN_INTERNALS__.os_type` off a global the Tauri runtime injects, so with
     * no runtime it throws a `TypeError` instead of returning anything. This is a field initialiser,
     * so the throw lands while the injector is constructing the service, and takes down whatever was
     * being constructed at the time. Outside Tauri that is `MainPageComponent`: route activation for
     * `/overview` throws, the router restores the URL it came from, and the app sits on
     * `/authentication` with an empty router outlet and a perfectly good session it never got to
     * use. Same gating pattern, and the same reason, as {@link openSettingsStore}.</p>
     *
     * <p>Inside Tauri `isTauri()` is true and the rest of the expression is exactly what was here
     * before, so no desktop or mobile build can observe this. Outside it the answer is "not mobile",
     * which is the only honest one available: there is no Tauri build that runs outside Tauri, so
     * this branch is the browser/E2E bundle and nothing that ships to a user.</p>
     */
    public isMobile = isTauri() && (type() == 'ios' || type() == 'android');
}
