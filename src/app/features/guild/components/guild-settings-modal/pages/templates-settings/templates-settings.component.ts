import {ChangeDetectionStrategy, Component, computed, inject, input, OnInit, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Textarea} from 'primeng/textarea';
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
    imports: [FormsModule, Button, InputText, Textarea, Tooltip, TranslateModule],
    templateUrl: './templates-settings.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TemplatesSettingsComponent implements OnInit {
    guild = input.required<GuildDto>();

    name = signal('');
    description = signal('');
    saving = signal(false);
    copiedId = signal<string | null>(null);

    /** Every template made since this page was opened. The API has no way to list templates back
     * (create, get-by-id and use are the only routes), and an id that isn't copied is an id that
     * is gone, so holding them here is the only recall there is until a listing route exists. */
    created = signal<CreatedTemplateDto[]>([]);

    /** Mirrors the template `maxlength` values so the counters cannot drift from the real cap. */
    readonly nameLimit = 100;
    readonly descriptionLimit = 300;

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
                this.created.update(ts => [template, ...ts]);
                this.name.set('');
                this.description.set('');
                this.toastService.success(this.translate.instant('GUILD_SETTINGS.TEMPLATES.SUCCESS_TITLE'));
            },
            error: err => {
                this.saving.set(false);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.TEMPLATES.SAVE_ERROR_TOAST'), err);
            },
        });
    }

    copyId(template: CreatedTemplateDto): void {
        navigator.clipboard.writeText(template.id).then(
            () => {
                this.copiedId.set(template.id);
                setTimeout(() => this.copiedId.set(null), 2000);
            },
            // Clipboard writes are refused in insecure contexts and when permission is
            // denied; without this the button just sat there looking broken.
            () => this.toastService.error(this.translate.instant('GUILD_SETTINGS.TEMPLATES.COPY_ERROR')),
        );
    }
}
