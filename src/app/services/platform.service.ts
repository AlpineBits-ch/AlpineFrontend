import {Injectable} from '@angular/core';
import {type} from "@tauri-apps/plugin-os";

@Injectable({
    providedIn: 'root',
})
export class PlatformService {
    public isMobile = type() == 'ios' || type() == 'android';
}
