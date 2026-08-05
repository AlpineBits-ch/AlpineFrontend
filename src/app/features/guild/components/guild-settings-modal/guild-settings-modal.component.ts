import {Component, computed, effect, inject, input, model, output, signal, untracked} from '@angular/core';
import {NgClass} from '@angular/common';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {GuildDto, RoleDto} from '../../../../dtos/response/guild.dto';
import {environment} from '../../../../../environments/environment';
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
import {TranslateModule} from '@ngx-translate/core';
import {PrimeTemplate} from 'primeng/api';
import {GuildService} from '../../../../services/guild.service';
import {ProfileService} from '../../../../services/profile.service';
import {SelfGuildMemberDto} from '../../../../dtos/response/member.dto';
import {memberCanManageGuild} from '../../guild-permissions';

/**
 * `checking` exists so the modal never renders settings on an unproven permission.
 * Every page below assumes the viewer may act on the guild, so guessing while the
 * member row is in flight would flash admin controls at people who lack them.
 */
type Access = 'checking' | 'granted' | 'denied';

/**
 * One page in the guild settings nav.
 *
 * <p>Renamed from `label`/`title`, which is all that changed here - unlike the settings and admin
 * navs, this one always held `GUILD_SETTINGS.NAV.*` keys and the template always translated them.
 * The names were the only thing lying, and they were the reason the other two navs looked correct
 * at a glance while rendering English. Naming a key a key is what stops that reading.</p>
 */
interface NavItem {
    id: string;
    labelKey: string;
    icon: string;
}

interface NavGroup {
    titleKey: string;
    items: NavItem[];
}

/**
 * The guild settings nav for one guild.
 *
 * <p>Modules a guild has switched off are *absent* here, not disabled - a household should never
 * see a Bans tab it can't press. `modules` itself is never gated: it is how a module gets switched
 * back on, so hiding it would be a one-way door.</p>
 *
 * <p>A free function rather than the body of the `computed` it used to be, because it depends on
 * nothing but the guild's feature set - so the feature-gated branches, which are the ones most
 * likely to reference a key nobody added, can be exercised without standing up a component that
 * wants `GuildService`, `ProfileService` and a `Dialog`. The `computed` is now one line.</p>
 */
export function buildGuildNavGroups(guild: Pick<GuildDto, 'features'> | null | undefined): NavGroup[] {
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
                {id: 'templates', labelKey: 'GUILD_SETTINGS.NAV.TEMPLATES', icon: 'pi pi-clone'},
                {id: 'discord-sync', labelKey: 'GUILD_SETTINGS.NAV.DISCORD_SYNC', icon: 'pi pi-discord'},
                ...(features.has(GuildFeature.Onboarding)
                    ? [{id: 'onboarding', labelKey: 'GUILD_SETTINGS.NAV.ONBOARDING', icon: 'pi pi-book'}]
                    : []),
            ],
        },
        // Guild-scoped household settings. Their own group rather than folded into Server:
        // a community guild has neither flag, so the whole group disappears and nobody has to
        // wonder why a chat server is asking about bedtimes.
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
        TranslateModule,
        PrimeTemplate,
    ],
    templateUrl: './guild-settings-modal.component.html',
})
export class GuildSettingsModalComponent {
    isVisible = model.required<boolean>();
    guild = input.required<GuildDto>();
    guildUpdated = output<GuildDto>();
    guildDeleted = output<string>();

    activePage = signal('overview');
    headerIconFailed = signal(false);

    /**
     * Set by whichever page is showing when it has edits the user hasn't saved.
     * Nav clicks and the close button route through the confirm dialog while it's
     * true -the `@switch` below destroys the page component, so leaving without
     * asking silently throws the edits away.
     */
    protected pageDirty = signal(false);
    protected pendingPage = signal<string | null>(null);
    protected pendingClose = signal(false);
    protected showUnsavedDialog = computed(() => this.pendingPage() !== null || this.pendingClose());

    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);
    private ownMember = signal<SelfGuildMemberDto | null>(null);
    private memberLoaded = signal(false);
    /** Guild the cached member row belongs to, so reopening on another guild re-checks. */
    private loadedGuildId: string | null = null;

    /**
     * The last line of defence. Entry points hide their "Server Settings" item, but this
     * modal is the single place every one of them funnels through, so the check lives here
     * too and covers any future caller that forgets.
     *
     * The server enforces this independently -each page's requests would 403. This only
     * stops the app offering controls that were never going to work.
     */
    protected access = computed<Access>(() => {
        const ownUserId = this.profileService.ownProfile()?.userId;
        if (ownUserId && ownUserId === this.guild().ownerId) return 'granted';
        if (!this.memberLoaded()) return 'checking';
        return memberCanManageGuild(this.ownMember(), this.guild().ownerId, ownUserId) ? 'granted' : 'denied';
    });

    guildIconUrl = computed(() =>
        `${environment.apiUrl}/api/v1/guild/guilds/${this.guild().id}/icon`
    );
    navGroups = computed<NavGroup[]>(() => buildGuildNavGroups(this.guild()));

    constructor() {
        // Esc bypasses `requestClose`, so a page can be left dirty. Clearing on close
        // stops that stale flag from guarding the next visit for no reason.
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
            // untracked: the load writes the very signals `access` is built from, and a
            // tracked read of them here would re-run this effect on every write.
            untracked(() => this.loadOwnMember(guildId));
        });

        // Switching a module off from the modules page can pull the page the user is
        // standing on out from under them - most obviously turning Moderation off while
        // looking at Bans. Fall back rather than render a page that no longer has a tab.
        effect(() => {
            const visible = this.navGroups().some(g => g.items.some(i => i.id === this.activePage()));
            if (visible) return;
            untracked(() => {
                this.pendingPage.set(null);
                this.pageDirty.set(false);
                this.activePage.set('overview');
            });
        });

        // A failed icon load is about one guild only. Without this reset the fallback
        // initial sticks when the modal is reopened on a guild that does have an icon.
        effect(() => {
            this.guildIconUrl();
            untracked(() => this.headerIconFailed.set(false));
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

    navItemClasses(id: string): Record<string, boolean> {
        const active = this.activePage() === id;
        return {
            'bg-[color-mix(in_srgb,var(--color-brand)_15%,transparent)]': active,
            'text-[var(--color-brand-dim)]': active,
            'text-white/50': !active,
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
            // A lookup that failed proves nothing about access, so it settles on denied
            // rather than leaving the modal spinning with no way out.
            error: () => {
                if (this.loadedGuildId !== guildId) return;
                this.memberLoaded.set(true);
            },
        });
    }
}
