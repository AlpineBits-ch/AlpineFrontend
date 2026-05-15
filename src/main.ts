import { isDevMode } from '@angular/core';
import { bootstrapApplication } from "@angular/platform-browser";
import { AppComponent } from "./app/app.component";
import { appConfig } from "./app/app.config";
import { getSecureKey } from "./app/platform/crypto";

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
      await win.show();
      // When the main app window finishes bootstrapping, signal the login window to close
      if (win.label === 'echo') {
        const { emit } = await import('@tauri-apps/api/event');
        await emit('main-window-ready');
      }
    } catch {
      // Running in a browser (non-Tauri) — no-op
    }

    if (isDevMode()) {
      import('./debug').then(m => m.registerDebugHelpers(appRef));
    }
  })
  .catch((err) => console.error(err));
