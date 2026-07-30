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
import {TranslateModule} from '@ngx-translate/core';
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

interface NavItem {
    id: string;
    label: string;
    icon: string;
}

interface NavGroup {
    title: string;
    items: NavItem[];
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
        TranslateModule,
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
    navGroups: NavGroup[] = [
        {
            title: 'Server Settings',
            items: [
                {id: 'overview', label: 'Overview', icon: 'pi pi-home'},
                {id: 'members', label: 'Members', icon: 'pi pi-users'},
                {id: 'roles', label: 'Roles', icon: 'pi pi-shield'},
                {id: 'bans', label: 'Bans', icon: 'pi pi-ban'},
                {id: 'moderation', label: 'Moderation', icon: 'pi pi-filter'},
                {id: 'audit-log', label: 'Audit Log', icon: 'pi pi-history'},
            ],
        },
        {
            title: 'Community',
            items: [
                {id: 'invites', label: 'Invites', icon: 'pi pi-link'},
                {id: 'emojis', label: 'Emojis', icon: 'pi pi-face-smile'},
                {id: 'templates', label: 'Templates', icon: 'pi pi-clone'},
                {id: 'discord-sync', label: 'Discord Sync', icon: 'pi pi-discord'},
                {id: 'onboarding', label: 'Onboarding', icon: 'pi pi-book'},
            ],
        },
    ];

    constructor() {
        effect(() => {
            const guildId = this.guild().id;
            if (!this.isVisible()) return;
            // untracked: the load writes the very signals `access` is built from, and a
            // tracked read of them here would re-run this effect on every write.
            untracked(() => this.loadOwnMember(guildId));
        });
    }

    onHeaderIconError(): void {
        this.headerIconFailed.set(true);
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
        for (const g of this.navGroups) {
            const found = g.items.find(i => i.id === this.activePage());
            if (found) return found.label;
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
