import { isDevMode } from '@angular/core';
import { bootstrapApplication } from "@angular/platform-browser";
import { AppComponent } from "./app/app.component";
import { appConfig } from "./app/app.config";
import { getSecureKey } from "./app/platform/crypto";
import * as Sentry from "@sentry/angular";
Sentry.init({
    dsn: "https://fd38719fd718686505847669170b7da4@o4511596550946816.ingest.de.sentry.io/4511596570673232",
    dataCollection: {
        // To disable sending user data and HTTP bodies, uncomment the lines below. For more info visit:
        // https://docs.sentry.io/platforms/javascript/guides/angular/configuration/options/#dataCollection
        // userInfo: false,
        // httpBodies: []
    }
});
getSecureKey().then(res => {
    console.log('generated key: ', res, '')
});





bootstrapApplication(AppComponent, appConfig)
  .then(async (appRef) => {
    // Reveal the window now that Angular has bootstrapped.
    // The window starts hidden (tauri.conf.json `visible: false`) to avoid a
    // flash of unstyled content; the #app-loading overlay handles the wait.
    try {
      const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const win = getCurrentWebviewWindow();
      const { invoke } = await import('@tauri-apps/api/core');
      try {
        await invoke('apply_maximize_fix', { label: 'echo' });
        const isMax = await win.isMaximized();
        if (isMax) {
          await win.unmaximize();
          await win.maximize();
        }
      } catch {}
      await win.show();
    } catch {
      // Running in a browser (non-Tauri) — no-op
    }

    if (isDevMode()) {
      import('./debug').then(m => m.registerDebugHelpers(appRef));
    }
  })
  .catch((err) => console.error(err));
