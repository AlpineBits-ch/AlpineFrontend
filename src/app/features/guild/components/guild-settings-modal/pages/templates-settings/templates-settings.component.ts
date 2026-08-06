import {ChangeDetectionStrategy, Component, computed, inject, input, OnInit, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Tooltip} from 'primeng/tooltip';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {SelfGuildMemberDto} from '../../../../../../dtos/response/member.dto';
import {CreatedTemplateDto, GuildTemplateService} from '../../../../../../services/guild-template.service';
import {GuildService} from '../../../../../../services/guild.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {ToastService} from '../../../../../../services/toast.service';
import {hasPermission, Permissions} from '../../../../../../enums/permissions.enum';
import {unionMemberPermissions} from '../../../../guild-permissions';

@Component({
    selector: 'app-templates-settings',
    imports: [FormsModule, Button, InputText, Tooltip, TranslateModule],
    templateUrl: './templates-settings.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TemplatesSettingsComponent implements OnInit {
    guild = input.required<GuildDto>();

    name = signal('');
    description = signal('');
    saving = signal(false);
    created = signal<CreatedTemplateDto | null>(null);
    copied = signal(false);

    private guildTemplateService = inject(GuildTemplateService);
    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);
    private ownMember = signal<SelfGuildMemberDto | null>(null);

    // Snapshotting a whole guild is a Manage Server-level action server-side; without this
    // gate any member who can open guild settings gets to click Save and collect a 403.
    // Mirrors EmojiSettingsComponent.canManageEmojis, plus the owner short-circuit used by
    // ChannelListComponent (SelfGuildMemberDto.permissions doesn't reliably carry
    // Superadmin for the guild owner).
    canCreateTemplate = computed(() => {
        const ownUserId = this.profileService.ownProfile()?.userId;
        if (ownUserId && ownUserId === this.guild().ownerId) return true;
        const member = this.ownMember();
        if (!member) return false;
        const perms = unionMemberPermissions(member);
        return hasPermission(perms, Permissions.Superadmin) || hasPermission(perms, Permissions.ManageGuild);
    });

    ngOnInit(): void {
        this.guildService.getOwnMember(this.guild().id).subscribe(m => this.ownMember.set(m));
    }

    save(): void {
        const trimmedName = this.name().trim();
        if (!trimmedName || this.saving() || !this.canCreateTemplate()) return;
        this.saving.set(true);
        this.guildTemplateService.createFromGuild(this.guild().id, {
            name: trimmedName,
            description: this.description().trim() || undefined,
        }).subscribe({
            next: template => {
                this.saving.set(false);
                this.created.set(template);
            },
            error: err => {
                this.saving.set(false);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.TEMPLATES.SAVE_ERROR_TOAST'), err);
            },
        });
    }

    copyId(): void {
        const template = this.created();
        if (!template) return;
        navigator.clipboard.writeText(template.id).then(() => {
            this.copied.set(true);
            setTimeout(() => this.copied.set(false), 2000);
        });
    }

    createAnother(): void {
        this.created.set(null);
        this.name.set('');
        this.description.set('');
    }
}
