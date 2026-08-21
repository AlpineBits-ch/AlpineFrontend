import {isDevMode} from '@angular/core';
import {bootstrapApplication} from '@angular/platform-browser';
import {AppComponent} from './app/app.component';
import {appConfig} from './app/app.config';
import * as Sentry from '@sentry/angular';
import {detectHost} from './app/platform/host';
import {installId, scrubBreadcrumb, scrubEvent} from './app/core/telemetry-privacy';

// Which shell we are in, on the root element. Must be set before the first paint, and must not
// reuse `data-window-flush`, which answers a different question and is recomputed on every resize.
document.documentElement.setAttribute('data-host', detectHost());

// Starts unidentified: a per-install pseudonym, no user info, no request bodies.
// TelemetryConsentService swaps in the real user id if the account has consented.
Sentry.init({
    dsn: 'https://fd38719fd718686505847669170b7da4@o4511596550946816.ingest.de.sentry.io/4511596570673232',
    dataCollection: {
        // https://docs.sentry.io/platforms/javascript/guides/angular/configuration/options/#dataCollection
        userInfo: false,
        httpBodies: [],
    },
    beforeSend: event => scrubEvent(event),
    beforeBreadcrumb: breadcrumb => scrubBreadcrumb(breadcrumb),
});
Sentry.setUser({id: installId()});

// Nothing native may run at module scope: a rejection here happens before Angular exists to report
// it and the app never starts. Anything needed this early belongs behind a platform port.

bootstrapApplication(AppComponent, appConfig)
    .then(async appRef => {
        // Reveal the window now that Angular has bootstrapped. It starts hidden
        // (tauri.conf.json `visible: false`) to avoid a flash of unstyled content.
        try {
            const {getCurrentWebviewWindow} = await import('@tauri-apps/api/webviewWindow');
            const win = getCurrentWebviewWindow();
            const {invoke} = await import('@tauri-apps/api/core');
            try {
                await invoke('apply_maximize_fix', {label: 'echo'});
                const isMax = await win.isMaximized();
                if (isMax) {
                    await win.unmaximize();
                    await win.maximize();
                }
            } catch {
                // The maximize fix is a Windows-only command; without it the window still shows.
            }
            await win.show();
        } catch {
            // Running in a browser (non-Tauri): no-op
        }

        if (isDevMode()) {
            import('./debug').then(m => m.registerDebugHelpers(appRef));
        }
    })
    .catch(err => console.error(err));
