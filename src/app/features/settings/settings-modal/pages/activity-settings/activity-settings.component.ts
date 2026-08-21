import {ChangeDetectionStrategy, Component, computed, inject, OnInit} from '@angular/core';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {HttpErrorResponse} from '@angular/common/http';
import {PrivacySettingsService} from '../../../../../services/privacy-settings.service';
import {UserSettingsService} from '../../../../../services/user-settings.service';
import {RichPresenceService} from '../../../../../services/rich-presence.service';
import {ToastService} from '../../../../../services/toast.service';
import {PlatformCapabilities} from '../../../../../platform/capabilities';
import {OsInfo} from '../../../../../platform/ports/os-info.port';

/** One row in the per-game list. */
interface GameRow {
    name: string;
    /** True when the game is being shared, i.e. *not* on the opt-out list. */
    shared: boolean;
    /** Whether this is what the machine is running right now, rather than only remembered. */
    live: boolean;
}

/** Activity Privacy, who sees what this machine is doing. */
@Component({
    selector: 'app-activity-settings',
    imports: [ToggleSwitch, FormsModule, TranslateModule],
    templateUrl: './activity-settings.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ActivitySettingsComponent implements OnInit {
    protected readonly privacy = inject(PrivacySettingsService);
    private readonly userSettings = inject(UserSettingsService);
    private readonly richPresence = inject(RichPresenceService);
    private readonly os = inject(OsInfo);
    private readonly capabilities = inject(PlatformCapabilities);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    protected readonly settings = this.privacy.settings;

    /** Everything is dead until the real privacy record is known, see the privacy page. */
    protected readonly disabled = computed(() => !this.privacy.isReady());
    protected readonly unavailable = computed(() => this.privacy.status() === 'unavailable');

    /** Whether this build can detect anything at all. */
    protected readonly canDetect = computed(() => this.capabilities.gameDetection && !this.os.isMobile);

    protected readonly discordIntegration = computed(
        () => this.userSettings.activitySettings().discordIntegration,
    );

    /** Whether the integration is on but lost the race for `discord-ipc-0`. */
    protected readonly rpcLostRace = computed(() => {
        const status = this.richPresence.rpcStatus();
        return !!status?.running && status.index != null && status.index !== 0;
    });

    /** The games we know about: whatever is running now, plus everything previously hidden. */
    protected readonly games = computed((): GameRow[] => {
        const hidden = new Set(this.userSettings.activitySettings().hiddenGames);
        const live = new Set(this.richPresence.detected().map(a => a.name));

        return [...new Set([...live, ...hidden])]
            .map(name => ({name, shared: !hidden.has(name), live: live.has(name)}))
            .sort((a, b) => Number(b.live) - Number(a.live) || a.name.localeCompare(b.name));
    });

    ngOnInit(): void {
        this.privacy.ensureLoaded();
    }

    /**
     * The account-wide switch. This one is a real privacy control: it is stored on
     * `UserPrivacySettings` and enforced in the server's projection, so turning it off removes
     * activity for every viewer on every device, not just this one.
     */
    protected onShareActivity(share: boolean): void {
        if (this.settings().shareActivity === share) return;
        this.privacy.patch({shareActivity: share}).subscribe({
            error: (err: HttpErrorResponse) => {
                console.warn('[ActivitySettings] could not save shareActivity', err);
                this.toast.error(this.translate.instant('SETTINGS.ACTIVITY.ERROR_SAVE'));
            },
        });
    }

    protected onGameShared(name: string, shared: boolean): void {
        this.userSettings.setGameHidden(name, !shared);
    }

    protected onDiscordIntegration(enabled: boolean): void {
        this.userSettings.updateActivity({discordIntegration: enabled});
    }
}
