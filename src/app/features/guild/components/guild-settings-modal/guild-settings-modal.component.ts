import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    ElementRef,
    HostListener,
    inject,
    input,
    model,
    output,
    signal,
    untracked,
    viewChild,
} from '@angular/core';
import {NgClass} from '@angular/common';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {ZIndexUtils} from 'primeng/utils';
import {GuildDto, RoleDto} from '../../../../dtos/response/guild.dto';
import {environment} from '../../../../../environments/environment';
import {WikiSettingsComponent} from './pages/wiki-settings/wiki-settings.component';
import {OverviewSettingsComponent} from './pages/overview-settings/overview-settings.component';
import {MembersSettingsComponent} from './pages/members-settings/members-settings.component';
import {RolesSettingsComponent} from './pages/roles-settings/roles-settings.component';
import {InvitesSettingsComponent} from './pages/invites-settings/invites-settings.component';
import {BansSettingsComponent} from './pages/bans-settings/bans-settings.component';
import {AuditLogSettingsComponent} from './pages/audit-log-settings/audit-log-settings.component';
import {DiscordSyncSettingsComponent} from './pages/discord-sync-settings/discord-sync-settings.component';
import {EmojiSettingsComponent} from './pages/emoji-settings/emoji-settings.component';
import {ModerationSettingsComponent} from './pages/moderation-settings/moderation-settings.component';
import {OnboardingSettingsComponent} from './pages/onboarding-settings/onboarding-settings.component';
import {TemplatesSettingsComponent} from './pages/templates-settings/templates-settings.component';
import {ModulesSettingsComponent} from './pages/modules-settings/modules-settings.component';
import {QuietHoursSettingsComponent} from './pages/quiet-hours-settings/quiet-hours-settings.component';
import {GuestAccessSettingsComponent} from './pages/guest-access-settings/guest-access-settings.component';
import {GuildFeature, guildFeatures} from '../../guild-features';
import {PlanPanelComponent} from '../../../settings/plan-panel/plan-panel.component';
import {EntitlementStore, EntitlementSubjectRef, MY_ENTITLEMENTS} from '../../../../stores/entitlement.store';
import {WindowChrome} from '../../../../platform/ports/window-chrome.port';
import {TranslateModule} from '@ngx-translate/core';
import {PrimeTemplate} from 'primeng/api';
import {GuildService} from '../../../../services/guild.service';
import {ProfileService} from '../../../../services/profile.service';
import {SelfGuildMemberDto} from '../../../../dtos/response/member.dto';
import {memberCanManageGuild} from '../../guild-permissions';

/** `checking` exists so the modal never renders settings before permission is proven; guessing while the member row loads would flash admin controls at people who lack them. */
type Access = 'checking' | 'granted' | 'denied';

/** One page in the guild settings nav. */
interface NavItem {
    id: string;
    labelKey: string;
    icon: string;
}

interface NavGroup {
    titleKey: string;
    items: NavItem[];
}

/** Reading-and-form pages get a capped measure; anything data-dense (a table, a list, the role permission matrix) is left at the default full width. */
const FORM_PAGE_IDS = new Set([
    'overview',
    'modules',
    'moderation',
    'onboarding',
    'wiki',
    'templates',
    'discord-sync',
    'plan',
    'quiet-hours',
    'guest-access',
]);

/** Modules a guild has switched off are absent from this nav, not disabled, and `modules` itself is never gated. `billingAvailable` (default false) hides the Plan page when this instance sells nothing. */
export function buildGuildNavGroups(
    guild: Pick<GuildDto, 'features'> | null | undefined,
    billingAvailable = false,
): NavGroup[] {
    const features = guildFeatures(guild);
    const groups: NavGroup[] = [
        {
            titleKey: 'GUILD_SETTINGS.NAV.GROUP_SERVER',
            items: [
                {id: 'overview', labelKey: 'GUILD_SETTINGS.NAV.OVERVIEW', icon: 'pi pi-home'},
                {id: 'modules', labelKey: 'GUILD_SETTINGS.NAV.MODULES', icon: 'pi pi-th-large'},
                {id: 'members', labelKey: 'GUILD_SETTINGS.NAV.MEMBERS', icon: 'pi pi-users'},
                {id: 'roles', labelKey: 'GUILD_SETTINGS.NAV.ROLES', icon: 'pi pi-shield'},
                ...(features.has(GuildFeature.Moderation)
                    ? [{id: 'bans', labelKey: 'GUILD_SETTINGS.NAV.BANS', icon: 'pi pi-ban'}]
                    : []),
                ...(features.has(GuildFeature.AutoMod)
                    ? [{id: 'moderation', labelKey: 'GUILD_SETTINGS.NAV.MODERATION', icon: 'pi pi-filter'}]
                    : []),
                ...(features.has(GuildFeature.Moderation)
                    ? [{id: 'audit-log', labelKey: 'GUILD_SETTINGS.NAV.AUDIT_LOG', icon: 'pi pi-history'}]
                    : []),
            ],
        },
        {
            titleKey: 'GUILD_SETTINGS.NAV.GROUP_COMMUNITY',
            items: [
                {id: 'invites', labelKey: 'GUILD_SETTINGS.NAV.INVITES', icon: 'pi pi-link'},
                ...(features.has(GuildFeature.Emojis)
                    ? [{id: 'emojis', labelKey: 'GUILD_SETTINGS.NAV.EMOJIS', icon: 'pi pi-face-smile'}]
                    : []),
                ...(features.has(GuildFeature.Wiki)
                    ? [{id: 'wiki', labelKey: 'GUILD_SETTINGS.NAV.WIKI', icon: 'pi pi-globe'}]
                    : []),
                {id: 'templates', labelKey: 'GUILD_SETTINGS.NAV.TEMPLATES', icon: 'pi pi-clone'},
                {id: 'discord-sync', labelKey: 'GUILD_SETTINGS.NAV.DISCORD_SYNC', icon: 'pi pi-discord'},
                ...(features.has(GuildFeature.Onboarding)
                    ? [{id: 'onboarding', labelKey: 'GUILD_SETTINGS.NAV.ONBOARDING', icon: 'pi pi-book'}]
                    : []),
            ],
        },
        {
            titleKey: 'GUILD_SETTINGS.NAV.GROUP_HOUSEHOLD',
            items: [
                ...(features.has(GuildFeature.QuietHours)
                    ? [{id: 'quiet-hours', labelKey: 'GUILD_SETTINGS.NAV.QUIET_HOURS', icon: 'pi pi-moon'}]
                    : []),
                ...(features.has(GuildFeature.GuestAccess)
                    ? [{id: 'guest-access', labelKey: 'GUILD_SETTINGS.NAV.GUEST_ACCESS', icon: 'pi pi-key'}]
                    : []),
            ],
        },
        {
            titleKey: 'GUILD_SETTINGS.NAV.GROUP_PLAN',
            items: [
                ...(billingAvailable
                    ? [{id: 'plan', labelKey: 'GUILD_SETTINGS.NAV.PLAN', icon: 'pi pi-credit-card'}]
                    : []),
            ],
        },
    ];
    return groups.filter(group => group.items.length > 0);
}

@Component({
    selector: 'app-guild-settings-modal',
    imports: [
        NgClass,
        Dialog,
        Button,
        OverviewSettingsComponent,
        WikiSettingsComponent,
        MembersSettingsComponent,
        RolesSettingsComponent,
        InvitesSettingsComponent,
        BansSettingsComponent,
        AuditLogSettingsComponent,
        DiscordSyncSettingsComponent,
        EmojiSettingsComponent,
        ModerationSettingsComponent,
        OnboardingSettingsComponent,
        TemplatesSettingsComponent,
        ModulesSettingsComponent,
        QuietHoursSettingsComponent,
        GuestAccessSettingsComponent,
        PlanPanelComponent,
        TranslateModule,
        PrimeTemplate,
    ],
    templateUrl: './guild-settings-modal.component.html',
    styleUrl: './guild-settings-modal.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GuildSettingsModalComponent {
    readonly isVisible = model.required<boolean>();
    readonly guild = input.required<GuildDto>();
    guildUpdated = output<GuildDto>();
    guildDeleted = output<string>();

    readonly activePage = signal('overview');
    readonly headerIconFailed = signal(false);

    /** Set by the active page when it has unsaved edits; nav/close must route through the confirm dialog first, since `@switch` destroys the page component on navigation and would silently discard them. */
    protected readonly pageDirty = signal(false);
    protected readonly pendingPage = signal<string | null>(null);
    protected readonly pendingClose = signal(false);
    protected readonly showUnsavedDialog = computed(() => this.pendingPage() !== null || this.pendingClose());

    /** Only for the Escape handler's topmost-overlay test; see `isTopmostOverlay`. */
    private readonly mainDialog = viewChild<Dialog>('mainDialog');
    /** The strip the nav scrolls in: horizontally on mobile, vertically once it's a sidebar. */
    private readonly navScroller = viewChild<ElementRef<HTMLElement>>('navScroller');

    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);
    private entitlements = inject(EntitlementStore);
    private readonly chrome = inject(WindowChrome);
    private readonly ownMember = signal<SelfGuildMemberDto | null>(null);
    private readonly memberLoaded = signal(false);
    /** Guild the cached member row belongs to, so reopening on another guild re-checks. */
    private loadedGuildId: string | null = null;

    /** True on desktop, where the app draws its own titlebar above this dialog; false on web, where there is none to clear. Constant for the component's life, so a plain field, not a signal. */
    protected readonly hasTitlebar = this.chrome.supported;
    /** `--inset` clears the titlebar so its window controls stay clickable while settings are open; skipped on web, which has no titlebar. */
    protected readonly dialogStyleClass = `guild-settings-dialog${this.hasTitlebar ? ' guild-settings-dialog--inset' : ''}`;
    protected readonly dialogMaskStyleClass = `guild-settings-mask${this.hasTitlebar ? ' guild-settings-mask--inset' : ''}`;

    /** Last line of defence: every entry point hides its "Server Settings" item, but this modal is the single place they all funnel through, so the check lives here too. The server enforces this independently; this only stops the app offering controls that were never going to work. */
    protected readonly access = computed<Access>(() => {
        const ownUserId = this.profileService.ownProfile()?.userId;
        if (ownUserId && ownUserId === this.guild().ownerId) return 'granted';
        if (!this.memberLoaded()) return 'checking';
        return memberCanManageGuild(this.ownMember(), this.guild().ownerId, ownUserId) ? 'granted' : 'denied';
    });

    readonly guildIconUrl = computed(
        () => `${environment.apiUrl}/api/v1/guild/guilds/${this.guild().id}/icon`,
    );
    readonly navGroups = computed<NavGroup[]>(() =>
        buildGuildNavGroups(this.guild(), this.entitlements.upgradesAvailable()),
    );

    /**
     * Caps the reading-and-form pages to a comfortable measure; data-dense pages (Members, Roles, Bans, Invites,
     * Emojis, Audit Log) keep the full width the shell already gives them. `h-full` is on both branches: several
     * pages (members, roles, bans, audit-log) size their own internal scroll region off a full-height parent, and
     * this wrapper sits between them and that parent now.
     */
    readonly pageContentClasses = computed(() =>
        FORM_PAGE_IDS.has(this.activePage()) ? 'max-w-[720px] h-full' : 'h-full',
    );

    /** What the Plan page reads. Rebuilt only when the guild changes, so the input holds still. */
    protected readonly planSubject = computed<EntitlementSubjectRef>(() => ({
        kind: 'guild',
        id: this.guild().id,
    }));

    constructor() {
        // Resets the dirty/pending flags on close so a stale flag doesn't guard the next open.
        effect(() => {
            if (this.isVisible()) return;
            untracked(() => {
                this.pageDirty.set(false);
                this.pendingPage.set(null);
                this.pendingClose.set(false);
            });
        });

        effect(() => {
            const guildId = this.guild().id;
            if (!this.isVisible()) return;
            // untracked: loadOwnMember writes the signals `access` is built from; a tracked read here would re-run this effect on every write.
            untracked(() => this.loadOwnMember(guildId));
        });

        // upgradesAvailable is false until the caller's own set is read, so that read must happen on open, not when the Plan tab is pressed.
        effect(() => {
            if (this.isVisible()) untracked(() => this.entitlements.ensureLoaded(MY_ENTITLEMENTS));
        });

        // Passes along module resolution already known from a single-guild read so the Plan page doesn't re-fetch it; absent is fine and files nothing.
        effect(() => {
            const guild = this.guild();
            untracked(() => this.entitlements.putFeatures(guild.id, guild.featureResolution));
        });

        // Falls back to overview if the active page's tab disappears (e.g. its module got switched off) rather than rendering a page with no tab.
        effect(() => {
            const visible = this.navGroups().some(g => g.items.some(i => i.id === this.activePage()));
            if (visible) return;
            untracked(() => {
                this.pendingPage.set(null);
                this.pageDirty.set(false);
                this.activePage.set('overview');
            });
        });

        // Resets on guild change so a failed icon load doesn't stick as the fallback when reopened on a guild that has an icon.
        effect(() => {
            this.guildIconUrl();
            untracked(() => this.headerIconFailed.set(false));
        });

        // Keeps the active mobile nav pill in view; switching a module off can also snap us back to Overview at the far left.
        effect(() => {
            const page = this.activePage();
            const scroller = this.navScroller()?.nativeElement;
            if (scroller) this.revealNavItem(scroller, page);
        });
    }

    onHeaderIconError(): void {
        this.headerIconFailed.set(true);
    }

    onPageDirtyChange(dirty: boolean): void {
        this.pageDirty.set(dirty);
    }

    /** Nav clicks go through here so unsaved edits get a chance to survive. */
    requestPage(id: string): void {
        if (id === this.activePage()) return;
        if (this.pageDirty()) {
            this.pendingPage.set(id);
            return;
        }
        this.activePage.set(id);
    }

    requestClose(): void {
        if (this.pageDirty()) {
            this.pendingClose.set(true);
            return;
        }
        this.isVisible.set(false);
    }

    discardAndContinue(): void {
        const target = this.pendingPage();
        const closing = this.pendingClose();
        this.pendingPage.set(null);
        this.pendingClose.set(false);
        this.pageDirty.set(false);
        if (closing) {
            this.isVisible.set(false);
        } else if (target) {
            this.activePage.set(target);
        }
    }

    keepEditing(): void {
        this.pendingPage.set(null);
        this.pendingClose.set(false);
    }

    /** Escape is a close request like any other, not a way past the guard; closeOnEscape is off because it would destroy the page and drop unsaved edits, so the key is handled here instead. */
    // Typed `Event` (what $event actually is); narrowing to KeyboardEvent fails under strict template/host checks, and nothing here reads a key field anyway.
    @HostListener('document:keydown.escape', ['$event'])
    protected onEscape(event: Event): void {
        if (!this.isVisible()) return;

        // On the guard itself, Escape takes the safe path; discarding stays a button press so a keystroke never throws edits away.
        if (this.showUnsavedDialog()) {
            event.preventDefault();
            this.keepEditing();
            return;
        }

        if (!this.isTopmostOverlay()) return;
        event.preventDefault();
        this.requestClose();
    }

    navItemClasses(id: string): Record<string, boolean> {
        const active = this.activePage() === id;
        return {
            'bg-[color-mix(in_srgb,var(--color-brand)_15%,transparent)]': active,
            'text-[var(--color-brand-dim)]': active,
            'text-text-secondary': !active,
        };
    }

    currentLabel(): string {
        for (const g of this.navGroups()) {
            const found = g.items.find(i => i.id === this.activePage());
            if (found) return found.labelKey;
        }
        return '';
    }

    onGuildUpdated(g: GuildDto): void {
        this.guildUpdated.emit(g);
    }

    onRolesChanged(_roles: RoleDto[]): void {
        // roles are managed locally in the page; emit updated guild if needed
    }

    /** Whether something a page opened (a select panel, its own confirm dialog) sits above us and should own Escape instead; same z-index test PrimeNG's closeOnEscape uses. */
    private isTopmostOverlay(): boolean {
        const container = this.mainDialog()?.container();
        const topZIndex = ZIndexUtils.getCurrent();
        if (!container || !topZIndex) return true;
        return ZIndexUtils.get(container) >= topZIndex;
    }

    /** Centres the active mobile nav pill in the strip, as far as the ends allow. */
    private revealNavItem(scroller: HTMLElement, pageId: string): void {
        const item = scroller.querySelector<HTMLElement>(`[data-page-id="${pageId}"]`);
        // offsetParent is null while the strip is display:none, i.e. every viewport wide enough for the sidebar nav.
        if (!item?.offsetParent) return;

        const itemBox = item.getBoundingClientRect();
        const stripBox = scroller.getBoundingClientRect();
        scroller.scrollBy({
            left: itemBox.left - stripBox.left - (stripBox.width - itemBox.width) / 2,
            behavior: 'smooth',
        });
    }

    private loadOwnMember(guildId: string): void {
        if (this.loadedGuildId === guildId) return;
        this.loadedGuildId = guildId;
        this.ownMember.set(null);
        this.memberLoaded.set(false);

        this.guildService.getOwnMember(guildId).subscribe({
            next: member => {
                if (this.loadedGuildId !== guildId) return;
                this.ownMember.set(member);
                this.memberLoaded.set(true);
            },
            // A failed lookup proves nothing about access, so it settles rather than leaving the modal spinning with no way out.
            error: () => {
                if (this.loadedGuildId !== guildId) return;
                this.memberLoaded.set(true);
            },
        });
    }
}
