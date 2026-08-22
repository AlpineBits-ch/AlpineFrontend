import {ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked} from '@angular/core';
import {DatePipe} from '@angular/common';
import {TranslateModule} from '@ngx-translate/core';
import {ProfileDto} from '../../dtos/response/profile.dto';
import {ProfileService} from '../../services/profile.service';
import {ProfileModalTab, ProfilePopoutService} from '../../services/profile-popout.service';
import {DirectMessageService} from '../../services/direct-message.service';
import {UserActivityService} from '../../services/user-activity.service';
import {
    MutualFriendRow,
    MutualsNotVisibleError,
    MutualServerRow,
    MutualsService,
} from '../../services/mutuals.service';
import {NavigationService} from '../../features/main-page/navigation.service';
import {GuildService} from '../../services/guild.service';
import {ProfileHeaderComponent} from '../profile-header/profile-header.component';
import {ProfileActionsComponent} from '../profile-actions/profile-actions.component';
import {ActivityCardComponent} from '../activity-card/activity-card.component';
import {AppAvatarComponent} from '../avatar/avatar.component';
import {UserStatusDotComponent} from '../user-status-dot/user-status-dot.component';
import {ProfileCanvasComponent} from '../profile-canvas/profile-canvas.component';
import {ProfileCanvasStore} from '../../stores/profile-canvas.store';

/** One tab's list, loaded once per subject. */
interface TabState<T> {
    items: T[];
    loading: boolean;
    /** Set when the fetch failed for a reason a retry could fix. */
    failed: boolean;
    /** Set when the subject does not show this list to us, which removes the tab. */
    hidden: boolean;
}

function emptyTab<T>(): TabState<T> {
    return {items: [], loading: false, failed: false, hidden: false};
}

/** The full profile: who somebody is on the left, what you have in common on the right. */
@Component({
    selector: 'app-profile-modal',
    imports: [
        DatePipe,
        TranslateModule,
        ProfileHeaderComponent,
        ProfileActionsComponent,
        ActivityCardComponent,
        AppAvatarComponent,
        UserStatusDotComponent,
        ProfileCanvasComponent,
    ],
    templateUrl: './profile-modal.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileModalComponent {
    protected readonly popoutSvc = inject(ProfilePopoutService);
    protected readonly profile = signal<ProfileDto | undefined>(undefined);
    protected readonly tab = signal<ProfileModalTab>('activity');
    protected readonly friends = signal<TabState<MutualFriendRow>>(emptyTab());
    protected readonly servers = signal<TabState<MutualServerRow>>(emptyTab());
    protected readonly brokenIcons = signal<ReadonlySet<string>>(new Set());

    private profileService = inject(ProfileService);
    private mutuals = inject(MutualsService);
    private directMessages = inject(DirectMessageService);
    private userActivity = inject(UserActivityService);
    private navService = inject(NavigationService);
    private guildService = inject(GuildService);
    private canvasStore = inject(ProfileCanvasStore);

    /**
     * Counts come from the profile embed, so the strip renders before either list loads. A count of
     * zero and an absent key both mean there is no tab to offer.
     */
    protected readonly friendCount = computed(() => this.profile()?.mutualFriends?.length ?? 0);
    protected readonly serverCount = computed(() => this.profile()?.mutualServers?.length ?? 0);

    protected readonly showFriendsTab = computed(() => this.friendCount() > 0 && !this.friends().hidden);
    protected readonly showServersTab = computed(() => this.serverCount() > 0 && !this.servers().hidden);

    protected readonly canvas = computed(() => {
        const profile = this.profile();
        return profile ? this.canvasStore.canvasFor(profile.id) : undefined;
    });

    protected readonly showCanvasTab = computed(() => (this.canvas()?.widgets.length ?? 0) > 0);

    /** Set on open when the default tab was asked for, cleared once acted on or overridden by hand. */
    private promoteDefaultToCanvas = false;

    protected readonly activities = computed(() =>
        this.userActivity.activitiesFor(this.popoutSvc.modal()?.userId),
    );

    /**
     * The tab that was asked for can turn out not to exist: the count that offered it came from a
     * profile read taken before the subject tightened the setting.
     */
    protected readonly effectiveTab = computed((): ProfileModalTab => {
        const tab = this.tab();
        if (tab === 'canvas' && !this.showCanvasTab()) return 'activity';
        if (tab === 'friends' && !this.showFriendsTab()) return 'activity';
        if (tab === 'servers' && !this.showServersTab()) return 'activity';
        return tab;
    });

    constructor() {
        // Only the target is tracked. Everything else is a write, and `loadTab` reads the very tab
        // state it writes, which would make this effect retrigger itself forever.
        effect(() => {
            const target = this.popoutSvc.modal();

            untracked(() => {
                this.friends.set(emptyTab());
                this.servers.set(emptyTab());
                this.brokenIcons.set(new Set());

                if (!target) {
                    this.profile.set(undefined);
                    this.promoteDefaultToCanvas = false;
                    return;
                }

                this.tab.set(target.tab);
                this.promoteDefaultToCanvas = target.tab === 'activity';

                const cached = this.profileService.getCachedByUserId(target.userId);
                this.profile.set(cached);
                if (cached) {
                    this.loadTab(target.tab, cached);
                    this.canvasStore.ensureLoaded(cached.id);
                    return;
                }

                this.profileService.getByUserId(target.userId).subscribe(p => {
                    if (this.popoutSvc.modal()?.userId !== target.userId) return;
                    this.profile.set(p);
                    this.loadTab(target.tab, p);
                    this.canvasStore.ensureLoaded(p.id);
                });
            });
        });

        // The store is cold on first open, so the canvas can still be loading when the modal
        // appears. The default tab is decided once it lands, not up front.
        effect(() => {
            const hasCanvas = this.showCanvasTab();

            untracked(() => {
                if (!this.promoteDefaultToCanvas || !hasCanvas) return;
                this.promoteDefaultToCanvas = false;
                this.tab.set('canvas');
            });
        });
    }

    protected close(): void {
        this.popoutSvc.closeModal();
    }

    protected onKeydown(event: KeyboardEvent): void {
        if (event.key === 'Escape') this.close();
    }

    protected selectTab(tab: ProfileModalTab): void {
        this.promoteDefaultToCanvas = false;
        this.tab.set(tab);
        const profile = this.profile();
        if (profile) this.loadTab(tab, profile);
    }

    protected retry(): void {
        const profile = this.profile();
        if (!profile) return;

        if (this.tab() === 'friends') this.friends.set(emptyTab());
        if (this.tab() === 'servers') this.servers.set(emptyTab());
        this.loadTab(this.tab(), profile);
    }

    protected message(): void {
        const userId = this.popoutSvc.modal()?.userId;
        if (!userId) return;

        this.directMessages.openOrCreateAndNavigate(userId);
        this.close();
    }

    /** A mutual friend replaces the subject rather than stacking a second modal. */
    protected openFriend(row: MutualFriendRow): void {
        this.popoutSvc.openModal(row.userId);
    }

    /** The row carries an id, and selecting a server takes the guild itself. */
    protected openServer(row: MutualServerRow): void {
        this.guildService.getGuild(row.guildId).subscribe({
            next: guild => {
                this.navService.selectServer(guild);
                this.close();
            },
            error: () => this.close(),
        });
    }

    protected guildIconUrl(guildId: string): string {
        return this.mutuals.guildIconUrl(guildId);
    }

    protected guildInitial(row: MutualServerRow): string {
        return (row.name ?? row.guildId)[0]?.toUpperCase() ?? '?';
    }

    protected iconFailed(guildId: string): boolean {
        return this.brokenIcons().has(guildId);
    }

    /** A guild with no icon 404s, and only the failed request says so. */
    protected onIconError(guildId: string): void {
        this.brokenIcons.update(ids => new Set(ids).add(guildId));
    }

    /** Fetches once per subject. A tab already loaded, loading, failed or hidden is left alone. */
    private loadTab(tab: ProfileModalTab, profile: ProfileDto): void {
        if (tab === 'friends') this.loadFriends(profile);
        if (tab === 'servers') this.loadServers(profile);
    }

    private loadFriends(profile: ProfileDto): void {
        const state = this.friends();
        if (state.loading || state.hidden || state.items.length > 0) return;

        this.friends.set({...emptyTab<MutualFriendRow>(), loading: true});
        this.mutuals.friends(profile.id).subscribe({
            next: page => this.friends.set({...emptyTab<MutualFriendRow>(), items: page.items}),
            error: (err: unknown) =>
                this.friends.set({
                    ...emptyTab<MutualFriendRow>(),
                    hidden: err instanceof MutualsNotVisibleError,
                    failed: !(err instanceof MutualsNotVisibleError),
                }),
        });
    }

    private loadServers(profile: ProfileDto): void {
        const state = this.servers();
        if (state.loading || state.hidden || state.items.length > 0) return;

        this.servers.set({...emptyTab<MutualServerRow>(), loading: true});
        this.mutuals.servers(profile.id).subscribe({
            next: page => this.servers.set({...emptyTab<MutualServerRow>(), items: page.items}),
            error: (err: unknown) =>
                this.servers.set({
                    ...emptyTab<MutualServerRow>(),
                    hidden: err instanceof MutualsNotVisibleError,
                    failed: !(err instanceof MutualsNotVisibleError),
                }),
        });
    }
}
