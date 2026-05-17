import {Component, inject, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {ProfileService} from "../../../../services/profile.service";
import {AppAvatarComponent} from "../../../../components/avatar/avatar.component";
import {Button} from "primeng/button";
import {ConnectionState, MessagingWebsocketService} from "../../../../services/messaging-websocket.service";
import {ConnectionStatusComponent} from "../connection-status/connection-status.component";
import {SettingsModalComponent} from "../../../../features/settings/settings-modal/settings-modal.component";
import {VoiceChannelService} from "../../../../services/voice-channel.service";
import {ProfileDialogService} from "../../../../services/profile-dialog.service";
import {TranslateModule} from '@ngx-translate/core';

@Component({
    selector: 'app-quick-settings',
    imports: [
        AppAvatarComponent,
        Button,
        ConnectionStatusComponent,
        SettingsModalComponent,
        NgClass,
        TranslateModule,
    ],
    templateUrl: './quick-settings.component.html',
    styleUrl: './quick-settings.component.css',
})
export class QuickSettingsComponent {
    public isSettingsOpen = signal(false);
    protected profileService = inject(ProfileService);
    protected websocketService = inject(MessagingWebsocketService);
    protected voiceSvc = inject(VoiceChannelService);
    protected profileDialogSvc = inject(ProfileDialogService);
    protected readonly ConnectionState = ConnectionState;

    constructor() {
        if (!this.profileService.ownProfile()) {
            this.profileService.getSelf().subscribe();
        }
    }
}
