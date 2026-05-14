import { isDevMode } from '@angular/core';
import { bootstrapApplication } from "@angular/platform-browser";
import { AppComponent } from "./app/app.component";
import { appConfig } from "./app/app.config";
import {getSecureKey} from "./app/platform/crypto";

getSecureKey().then(res => {
    console.log('generated key: ', res, '')
});
bootstrapApplication(AppComponent, appConfig)
  .then(appRef => {
    if (isDevMode()) {
      import('./debug').then(m => m.registerDebugHelpers(appRef));
    }
  })
  .catch((err) => console.error(err));
