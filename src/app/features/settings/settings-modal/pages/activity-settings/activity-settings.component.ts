import {Component, computed, inject, OnInit} from '@angular/core';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {HttpErrorResponse} from '@angular/common/http';
import {PrivacySettingsService} from '../../../../../services/privacy-settings.service';
import {UserSettingsService} from '../../../../../services/user-settings.service';
import {RichPresenceService} from '../../../../../services/rich-presence.service';
import {ToastService} from '../../../../../services/toast.service';
import {isTauri} from '@tauri-apps/api/core';
import {PlatformService} from '../../../../../services/platform.service';

/** One row in the per-game list. */
interface GameRow {
    name: string;
    /** True when the game is being shared, i.e. *not* on the opt-out list. */
    shared: boolean;
    /** Whether this is what the machine is running right now, rather than only remembered. */
    live: boolean;
}

/**
 * Activity Privacy — who sees what this machine is doing.
 *
 * <p>Three controls at three different levels, and the page is arranged so that is obvious: the
 * account-wide share switch (server-enforced), the per-game exceptions under it, and finally the
 * Discord RPC integration, which is a different kind of decision entirely — it is about what this
 * computer does to other software on it, not about who can see anything.</p>
 *
 * <p>Writes go through on change with no Save button, matching
 * {@link PrivacySettingsComponent}: a page of independent switches has no coherent moment at which
 * "save everything" means something.</p>
 */
@Component({
    selector: 'app-activity-settings',
    imports: [ToggleSwitch, FormsModule, TranslateModule],
    templateUrl: './activity-settings.component.html',
})
export class ActivitySettingsComponent implements OnInit {
    protected readonly privacy = inject(PrivacySettingsService);
    private readonly userSettings = inject(UserSettingsService);
    private readonly richPresence = inject(RichPresenceService);
    private readonly platform = inject(PlatformService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    protected readonly settings = this.privacy.settings;

    /** Everything is dead until the real privacy record is known — see the privacy page. */
    protected readonly disabled = computed(() => !this.privacy.isReady());
    protected readonly unavailable = computed(() => this.privacy.status() === 'unavailable');

    /**
     * Whether this build can detect anything at all.
     *
     * <p>Mobile and web cannot enumerate processes or bind the sockets, so they are receive-only by
     * platform. Saying so is better than showing a per-game list that will never fill up.</p>
     *
     * <p>The `isTauri()` half was missing and the omission was invisible: on web the toggles stayed
     * enabled, and `RichPresenceService` guards every one of its Tauri calls on `isTauri()` too - so
     * flipping them did nothing at all, silently. Same condition as the service's, deliberately.</p>
     */
    protected readonly canDetect = computed(() => isTauri() && !this.platform.isMobile);

    protected readonly discordIntegration = computed(() =>
        this.userSettings.activitySettings().discordIntegration
    );

    /**
     * Whether the integration is on but lost the race for `discord-ipc-0`.
     *
     * <p>The one failure worth its own message. Everything is configured correctly and the server is
     * running, but client libraries stop at the first socket that answers a handshake, so holding
     * index 3 means nothing will ever reach us this session. Without saying so, the honest user
     * report is "I turned it on and nothing happened".</p>
     */
    protected readonly rpcLostRace = computed(() => {
        const status = this.richPresence.rpcStatus();
        return !!status?.running && status.index != null && status.index !== 0;
    });

    /**
     * The games we know about: whatever is running now, plus everything previously hidden.
     *
     * <p>The hidden entries have to be listed even when the game is not running — otherwise the only
     * way to un-hide something is to launch it, and a list you can put things into but not take
     * them out of is a trap. Live entries sort first; the rest are alphabetical so the list does not
     * reorder itself under the cursor as processes come and go.</p>
     */
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
