import {PlatformHost} from './host';
import {ScreenPublisher} from './ports/screen-publisher.port';
import {TauriScreenPublisher} from './tauri/screen-publisher.tauri';
import {WebScreenPublisher} from './web/screen-publisher.web';

/**
 * The screen publisher for a host.
 *
 * Both adapter classes are imported statically; what stays lazy is the Tauri IPC module, reached
 * only through an `import()` inside `TauriScreenPublisher`'s methods.
 */
export function screenPublisherFor(host: PlatformHost): ScreenPublisher {
    return host === 'tauri' ? new TauriScreenPublisher() : new WebScreenPublisher();
}
