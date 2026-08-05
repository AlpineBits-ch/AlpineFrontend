import {Component, computed, effect, inject, signal, ViewChild} from '@angular/core';
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
import {AccountSwitchService} from "../../../../services/account-switch.service";
import {statusLabelKey as labelKeyForStatus} from "../../../../models/online-status.model";
import {UserStatusDotComponent} from "../../../../components/user-status-dot/user-status-dot.component";
import {SelfActivityCardComponent} from "../self-activity-card/self-activity-card.component";

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
        UserStatusDotComponent,
        SelfActivityCardComponent,
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
    protected readonly UserType = UserType;

    /**
     * What to call the status the user has put themselves in.
     *
     * <p>Null while the profile is loading, which is the skeleton's cue - see the template. It is
     * deliberately not defaulted to "Online": a panel that has not heard from the server yet does
     * not know, and guessing is how the old connection-state binding came to claim a user was
     * online while they were sitting there Invisible.</p>
     */
    protected readonly statusLabelKey = computed(() =>
        labelKeyForStatus(this.profileService.ownProfile()?.onlineStatus)
    );

    /**
     * Whether the socket, rather than the status, owns the line under the name.
     *
     * <p>A dead socket is the more urgent thing to say, and saying it costs nothing: the avatar dot
     * carries presence on its own, so the status is still on screen while the subtitle is busy.</p>
     */
    protected readonly showConnectionTrouble = computed(() =>
        this.websocketService.connectionState() !== ConnectionState.Connected
    );

    private settingsUi = inject(SettingsUiService);
    private switcher = inject(AccountSwitchService);
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

    /** Sign in as somebody else without signing out of this account. */
    public startAddAccount(): void {
        this.switcher.beginAddAccount();
    }
}
