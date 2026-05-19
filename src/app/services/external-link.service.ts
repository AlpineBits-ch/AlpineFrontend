import { Injectable } from '@angular/core';
import {openUrl} from "@tauri-apps/plugin-opener";

@Injectable({
  providedIn: 'root',
})
export class ExternalLinkService {
   public async openExternalLink( url: string) {

    try {
      await openUrl(url);
      console.log("Link opened:", url);
    } catch (error) {
      console.error("Failed to open link:", error);
    }
  }
}
