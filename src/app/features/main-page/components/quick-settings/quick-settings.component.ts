import {Component, effect, inject, signal, ViewChild} from '@angular/core';
import {NgClass} from '@angular/common';
import {ProfileService} from "../../../../services/profile.service";
import {AppAvatarComponent} from "../../../../components/avatar/avatar.component";
import {Button} from "primeng/button";
import {ConnectionState, MessagingWebsocketService} from "../../../../services/messaging-websocket.service";
import {ConnectionStatusComponent} from "../connection-status/connection-status.component";
import {SettingsModalComponent} from "../../../../features/settings/settings-modal/settings-modal.component";
import {VoiceChannelService} from "../../../../services/voice-channel.service";
import {TranslateModule} from '@ngx-translate/core';
import {UserService} from "../../../../services/user.service";
import {UserType} from "../../../../dtos/response/UserDto";
import {AdminModalComponent} from "../../../../features/admin/admin-modal/admin-modal.component";
import {StatusPickerComponent} from "../status-picker/status-picker.component";
import {SelfProfilePopoverComponent} from "../self-profile-popover/self-profile-popover.component";
import {SettingsUiService} from "../../../../services/settings-ui.service";

@Component({
    selector: 'app-quick-settings',
    imports: [
        AppAvatarComponent,
        Button,
        ConnectionStatusComponent,
        SettingsModalComponent,
        AdminModalComponent,
        StatusPickerComponent,
        SelfProfilePopoverComponent,
        NgClass,
        TranslateModule,
    ],
    templateUrl: './quick-settings.component.html',
    styleUrl: './quick-settings.component.css',
})
export class QuickSettingsComponent {
    public isSettingsOpen = signal(false);
    public isAdminOpen = signal(false);
    protected profileService = inject(ProfileService);
    protected userService = inject(UserService);
    protected websocketService = inject(MessagingWebsocketService);
    protected voiceSvc = inject(VoiceChannelService);
    protected readonly ConnectionState = ConnectionState;
    protected readonly UserType = UserType;
    private settingsUi = inject(SettingsUiService);
    @ViewChild(SettingsModalComponent) private settingsModal!: SettingsModalComponent;
    @ViewChild(SelfProfilePopoverComponent) private selfProfilePopover!: SelfProfilePopoverComponent;

    constructor() {
        if (!this.profileService.ownProfile()) {
            this.profileService.getSelf().subscribe();
        }
        if (!this.userService.self()) {
            this.userService.getSelf().subscribe();
        }

        // The dialog is a child of this component, so requests raised elsewhere - the titlebar's
        // help menu - can only be honoured from here.
        effect(() => {
            const page = this.settingsUi.requestedPage();
            if (!page) return;
            this.settingsUi.consume();
            this.settingsModal?.selectPage(page);
            this.isSettingsOpen.set(true);
        });
    }

    protected openSelfProfilePopover(event: Event): void {
        this.selfProfilePopover.toggle(event);
    }

    public openProfileSettings(): void {
        this.settingsModal.selectPage('profile');
        this.isSettingsOpen.set(true);
    }
}
