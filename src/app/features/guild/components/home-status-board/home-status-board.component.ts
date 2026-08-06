import {Component, computed, effect, inject, input, signal, untracked} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Select} from 'primeng/select';
import {Tooltip} from 'primeng/tooltip';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {GuildDto} from '../../../../dtos/response/guild.dto';
import {
    HOME_STATUS_DEFAULT_MINUTES,
    HOME_STATUS_NOTE_MAX,
    HomeStatusDto,
    HomeStatusKind,
} from '../../../../dtos/response/home-status.dto';
import {HomeStatusService} from '../../../../services/home-status.service';
import {ProfileService} from '../../../../services/profile.service';
import {ProfileDialogService} from '../../../../services/profile-dialog.service';
import {ToastService} from '../../../../services/toast.service';
import {GuildFeature, guildHasFeature} from '../../guild-features';
import {HOME_STATUS_META, HomeStatusMeta, homeStatusMeta} from '../../home-status-meta';

/** Offered durations, in minutes. The server caps anything longer at 7 days. */
const DURATIONS: readonly number[] = [60, 4 * 60, HOME_STATUS_DEFAULT_MINUTES, 24 * 60, 3 * 24 * 60, 7 * 24 * 60];

interface BoardRow {
    status: HomeStatusDto;
    meta: HomeStatusMeta;
    displayName: string;
    avatarUrl: string | undefined;
    isSelf: boolean;
}

/**
 * "Who's home", above the member list.
 *
 * <p>Its own panel rather than a decoration on the member rows, because it answers a different
 * question from the one the member list answers and only some members have an answer at all - a
 * status is asserted, not derived, so most of the roster is legitimately absent from here.</p>
 */
@Component({
    selector: 'app-home-status-board',
    imports: [FormsModule, Button, InputText, Select, Tooltip, TranslateModule],
    templateUrl: './home-status-board.component.html',
})
export class HomeStatusBoardComponent {
    guild = input.required<GuildDto>();

    protected readonly KIND_META = HOME_STATUS_META;
    protected readonly NOTE_MAX = HOME_STATUS_NOTE_MAX;

    protected editing = signal(false);
    protected saving = signal(false);
    protected draftKind = signal<HomeStatusKind>(HomeStatusKind.Home);
    protected draftNote = signal('');
    protected draftMinutes = signal<number>(HOME_STATUS_DEFAULT_MINUTES);

    private store = inject(HomeStatusService);
    private profiles = inject(ProfileService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);
    protected profileDialog = inject(ProfileDialogService);

    /** Off means the household does not do this at all - render nothing, not a denial. */
    protected enabled = computed(() =>
        guildHasFeature(this.guild(), GuildFeature.Presence) && !this.store.isUnavailable(this.guild().id));

    /** Holds the empty state back until the first fetch lands - "nobody" is a claim, not a spinner. */
    protected loadingBoard = computed(() => this.store.isLoading(this.guild().id));

    protected durationOptions = computed(() =>
        DURATIONS.map(minutes => ({minutes, label: this.durationLabel(minutes)})));

    protected ownStatus = computed(() =>
        this.store.own(this.guild().id, this.profiles.ownProfile()?.userId));

    /**
     * Live statuses, self first and then by how soon they lapse.
     *
     * <p>Reads straight off the store's filtered view, so an entry that has just decayed is gone
     * from here on the next sweep without this component tracking anything.</p>
     */
    protected rows = computed<BoardRow[]>(() => {
        const ownUserId = this.profiles.ownProfile()?.userId;
        return this.store.statuses(this.guild().id)
            .map(status => ({
                status,
                meta: homeStatusMeta(status.kind),
                displayName: this.profiles.getCachedByUserId(status.userId)?.userName
                    ?? status.userId.slice(0, 8) + '…',
                avatarUrl: this.profiles.getCachedByUserId(status.userId)?.avatarUrl,
                isSelf: status.userId === ownUserId,
            }))
            .sort((a, b) =>
                Number(b.isSelf) - Number(a.isSelf)
                || Date.parse(a.status.expiresAt) - Date.parse(b.status.expiresAt));
    });

    constructor() {
        effect(() => {
            const guild = this.guild();
            if (!this.enabled()) return;
            untracked(() => void this.store.ensureLoaded(guild.id));
        });

        // Names and avatars come from the profile cache, which the member list fills for members it
        // has paged in - not necessarily for everyone with a status. Resolving here is what stops a
        // board of truncated user ids on a household with more members than one page.
        effect(() => {
            const missing = this.store.statuses(this.guild().id)
                .map(s => s.userId)
                .filter(id => !this.profiles.getCachedByUserId(id));
            untracked(() => missing.forEach(id => this.profiles.resolveByUserId(id)));
        });
    }

    protected startEdit(): void {
        const own = this.ownStatus();
        this.draftKind.set(own?.kind ?? HomeStatusKind.Home);
        this.draftNote.set(own?.note ?? '');
        this.draftMinutes.set(HOME_STATUS_DEFAULT_MINUTES);
        this.editing.set(true);
    }

    protected cancelEdit(): void {
        this.editing.set(false);
    }

    protected async save(): Promise<void> {
        if (this.saving()) return;
        this.saving.set(true);
        try {
            await this.store.set(this.guild().id, {
                kind: this.draftKind(),
                note: this.draftNote().slice(0, HOME_STATUS_NOTE_MAX),
                expiresInMinutes: this.draftMinutes(),
            });
            this.editing.set(false);
        } catch (err) {
            this.toast.httpError(this.translate.instant('HOME_STATUS.SAVE_ERROR'), err);
        } finally {
            this.saving.set(false);
        }
    }

    protected async clear(): Promise<void> {
        const ownUserId = this.profiles.ownProfile()?.userId;
        if (!ownUserId || this.saving()) return;
        this.saving.set(true);
        try {
            await this.store.clear(this.guild().id, ownUserId);
            this.editing.set(false);
        } catch (err) {
            this.toast.httpError(this.translate.instant('HOME_STATUS.CLEAR_ERROR'), err);
        } finally {
            this.saving.set(false);
        }
    }

    /**
     * "until 18:30", or the weekday for anything past today.
     *
     * <p>The expiry is shown rather than hidden because it is the whole contract: this row stops
     * being asserted then, and a reader who knows that treats a stale-looking status correctly.</p>
     */
    protected untilLabel(status: HomeStatusDto): string {
        const at = new Date(status.expiresAt);
        const sameDay = at.toDateString() === new Date().toDateString();
        const time = at.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
        return sameDay ? time : `${at.toLocaleDateString([], {weekday: 'short'})} ${time}`;
    }

    private durationLabel(minutes: number): string {
        if (minutes < 60) return this.translate.instant('HOME_STATUS.DURATION.MINUTES', {count: minutes});
        if (minutes < 24 * 60) return this.translate.instant('HOME_STATUS.DURATION.HOURS', {count: minutes / 60});
        return this.translate.instant('HOME_STATUS.DURATION.DAYS', {count: minutes / (24 * 60)});
    }
}
