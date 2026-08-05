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
import {UserActivityService} from "../../../../services/user-activity.service";
import {ACTIVITY_STATUS_KEYS, ACTIVITY_TYPE_ICONS, primaryActivity} from "../../../../models/activity.model";
import {statusLabelKey as labelKeyForStatus} from "../../../../models/online-status.model";
import {UserStatusDotComponent} from "../../../../components/user-status-dot/user-status-dot.component";

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
    private userActivity = inject(UserActivityService);

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

    /**
     * Our own game line, which takes the second row of the panel from the connection status when
     * there is one to show.
     *
     * <p>Only while connected. The connection status is the more urgent thing to say when it is not
     * "Connected", and a "Playing X" line sitting over a dead socket is telling the user about
     * their machine when the thing they need to know is about the app.</p>
     */
    protected readonly ownActivity = computed(() =>
        this.websocketService.connectionState() === ConnectionState.Connected
            ? primaryActivity(this.userActivity.own())
            : null
    );

    /**
     * The strip's second line: what the game itself is reporting.
     *
     * <p>Discord puts the game's own words here — `details`, then `state`. Null when it reports
     * neither, in which case the template falls back to the activity verb so the row never renders
     * as one orphaned line. The name is already the first line and is deliberately not repeated.</p>
     */
    protected readonly activitySubtitle = computed(() => {
        const activity = this.ownActivity();
        return activity?.details ?? activity?.state ?? null;
    });

    /**
     * The verb, used only when the game gave us nothing of its own to show.
     *
     * <p>`ACTIVITY_STATUS_KEYS`, not `ACTIVITY_TYPE_KEYS`: the latter are transitive fragments
     * ("Listening to", "Competing in") written to be followed by a name, and the name is already
     * the line above.</p>
     */
    protected readonly activityTypeKey = computed(() => {
        const type = this.ownActivity()?.type;
        return type ? ACTIVITY_STATUS_KEYS[type] : null;
    });

    /**
     * Stands in for cover art, which we do not have yet.
     *
     * <p>The tile is the right size and shape for real artwork so that dropping it in later is a
     * swap rather than a re-layout — and a glyph reads as deliberate where an empty square would
     * read as a failed image.</p>
     */
    protected readonly activityIcon = computed(() => {
        const type = this.ownActivity()?.type;
        return ACTIVITY_TYPE_ICONS[type ?? 'Playing'];
    });

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
