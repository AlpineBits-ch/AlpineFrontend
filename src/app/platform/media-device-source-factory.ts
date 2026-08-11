import {detectHost, PlatformHost} from './host';
import {MediaDeviceSource} from './ports/media-devices.port';
import {TauriMediaDeviceSource} from './tauri/media-devices.tauri';
import {WebMediaDeviceSource} from './web/media-devices.web';

/**
 * The {@link MediaDeviceSource} adapter for a host.
 *
 * <p>Both adapters are imported statically and both are trivial - the desktop one reaches
 * `@tauri-apps/api/core` through an `import()` on first call, and the web one needs nothing but
 * `navigator`. So the unused adapter costs a few lines in the bundle and nothing at runtime, and in
 * exchange the choice is made in one place that `providePlatform()` and a test can both call.</p>
 */
export function createMediaDeviceSource(host: PlatformHost = detectHost()): MediaDeviceSource {
    return host === 'tauri' ? new TauriMediaDeviceSource() : new WebMediaDeviceSource();
}
