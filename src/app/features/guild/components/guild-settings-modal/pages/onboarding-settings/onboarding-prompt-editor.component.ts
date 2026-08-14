import {ChangeDetectionStrategy, Component, computed, effect, inject, input, model, output, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Select} from 'primeng/select';
import {MultiSelect} from 'primeng/multiselect';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {Dialog} from 'primeng/dialog';
import {PrimeTemplate} from 'primeng/api';
import {ChannelType, GuildDto, RoleDto, RoleType} from '../../../../../../dtos/response/guild.dto';
import {
    ONBOARDING_LIMITS,
    OnboardingPrompt,
    OnboardingPromptOption,
    OnboardingPromptType,
} from '../../../../../../dtos/response/guild-safety.dto';
import {hasPermission, parsePermissions, PermissionValue, Permissions} from '../../../../../../enums/permissions.enum';
import {ModulePermissions, ModulePermissionValue, parseModulePermissions} from '../../../../../../enums/module-permissions.enum';

/**
 * Roles the server refuses in a prompt option, because picking one is unmoderated
 * self-service: anything carrying admin, management, moderation, audit-log, emoji,
 * message/thread-moderation or wiki-editing power (guide §2.4).
 *
 * This is a client-side mirror so the picker can explain the refusal up front; the
 * server re-checks at save *and* at grant time and stays authoritative.
 */
const PRIVILEGED_MASK: PermissionValue =
    Permissions.Superadmin
    | Permissions.ManageGuild | Permissions.ManageChannel | Permissions.ManagePermissions
    | Permissions.ManageRoles | Permissions.ManageWebhooks
    | Permissions.KickMembers | Permissions.BanMembers | Permissions.ModerateMembers
    | Permissions.ViewAuditLog | Permissions.ManageEmojis | Permissions.ManageExpressions
    | Permissions.EditAnyMessage | Permissions.DeleteAnyMessage | Permissions.PinMessages
    | Permissions.ManageAnyThread;

/** The wiki half, now that those bits live in their own space. */
const PRIVILEGED_MODULE_MASK: ModulePermissionValue =
    ModulePermissions.EditAnyWikiPage | ModulePermissions.DeleteWikiPages
    | ModulePermissions.ManageWikiRevisions | ModulePermissions.ManageWikiStructure
    | ModulePermissions.ModerateWikiComments | ModulePermissions.PublishWikiPublicly;

export function isPrivilegedRole(role: Pick<RoleDto, 'permissions' | 'modulePermissions'>): boolean {
    return (parsePermissions(role.permissions) & PRIVILEGED_MASK) !== 0n
        || (parseModulePermissions(role.modulePermissions) & PRIVILEGED_MODULE_MASK) !== 0n;
}

/**
 * Edits one prompt and its options in isolation, handing the finished object back to
 * the settings page - the whole config is only ever written as a single PUT, so nothing
 * here talks to the network.
 */
@Component({
    selector: 'app-onboarding-prompt-editor',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [FormsModule, TranslateModule, Button, InputText, Select, MultiSelect, ToggleSwitch, Dialog, PrimeTemplate],
    templateUrl: './onboarding-prompt-editor.component.html',
})
export class OnboardingPromptEditorComponent {
    visible = model.required<boolean>();
    guild = input.required<GuildDto>();
    /** The prompt being edited, or null to start a new one. */
    prompt = input<OnboardingPrompt | null>(null);

    save = output<OnboardingPrompt>();

    protected readonly OnboardingPromptType = OnboardingPromptType;
    protected readonly limits = ONBOARDING_LIMITS;

    protected draft = signal<OnboardingPrompt>(this.emptyPrompt());
    protected showValidation = signal(false);

    private translate = inject(TranslateService);

    protected typeOptions = computed(() => [
        {label: this.translate.instant('ONBOARDING_EDIT.TYPE_CHOICE'), value: OnboardingPromptType.MultipleChoice},
        {label: this.translate.instant('ONBOARDING_EDIT.TYPE_DROPDOWN'), value: OnboardingPromptType.Dropdown},
    ]);

    /**
     * @everyone is excluded (everyone already has it) and privileged roles are shown but
     * disabled, so an admin who expected a role to be here learns why instead of hunting
     * for a missing entry.
     */
    protected roleOptions = computed(() =>
        this.guild().roles
            .filter(r => r.type !== RoleType.Everyone)
            .sort((a, b) => b.position - a.position)
            .map(r => {
                const privileged = isPrivilegedRole(r);
                return {
                    label: privileged
                        ? `${r.name} - ${this.translate.instant('ONBOARDING_EDIT.ROLE_PRIVILEGED')}`
                        : r.name,
                    value: r.id,
                    disabled: privileged,
                };
            }));

    protected channelOptions = computed(() =>
        this.guild().channels
            .filter(c => !c.parentChannelId && c.type !== ChannelType.Thread)
            .sort((a, b) => a.position - b.position)
            .map(c => ({label: c.name, value: c.id})));

    protected atOptionCap = computed(() => this.draft().options.length >= this.limits.optionsPerPrompt);

    /** Mirrors the server's rules so the settings page never round-trips for a known 400. */
    protected errors = computed(() => {
        const d = this.draft();
        const out: string[] = [];
        if (!d.title.trim()) out.push('ONBOARDING_EDIT.ERR_TITLE');
        if (d.options.length === 0) out.push('ONBOARDING_EDIT.ERR_NO_OPTIONS');
        if (d.options.some(o => !o.title.trim())) out.push('ONBOARDING_EDIT.ERR_OPTION_TITLE');
        // An option that grants nothing does nothing - the server rejects it outright.
        if (d.options.some(o => o.roleIds.length === 0 && o.channelIds.length === 0)) {
            out.push('ONBOARDING_EDIT.ERR_OPTION_EMPTY');
        }
        return out;
    });

    constructor() {
        effect(() => {
            // Re-seed each time the dialog opens so a cancelled edit leaves nothing behind.
            if (!this.visible()) return;
            const source = this.prompt();
            this.draft.set(source ? structuredClone(source) : this.emptyPrompt());
            this.showValidation.set(false);
        });
    }

    protected patch(patch: Partial<OnboardingPrompt>): void {
        this.draft.update(d => ({...d, ...patch}));
    }

    protected patchOption(index: number, patch: Partial<OnboardingPromptOption>): void {
        this.draft.update(d => ({
            ...d,
            options: d.options.map((o, i) => i === index ? {...o, ...patch} : o),
        }));
    }

    protected addOption(): void {
        if (this.atOptionCap()) return;
        this.draft.update(d => ({
            ...d,
            options: [...d.options, {title: '', description: null, emoji: null, roleIds: [], channelIds: [], position: d.options.length}],
        }));
    }

    protected removeOption(index: number): void {
        this.draft.update(d => ({
            ...d,
            // Positions are renumbered here even though the server normalizes them anyway,
            // so the local object stays a faithful picture of what was sent.
            options: d.options.filter((_, i) => i !== index).map((o, position) => ({...o, position})),
        }));
    }

    protected moveOption(index: number, delta: number): void {
        const target = index + delta;
        const options = this.draft().options;
        if (target < 0 || target >= options.length) return;

        const next = [...options];
        const [moved] = next.splice(index, 1);
        next.splice(target, 0, moved);
        this.draft.update(d => ({...d, options: next.map((o, position) => ({...o, position}))}));
    }

    protected commit(): void {
        if (this.errors().length > 0) {
            this.showValidation.set(true);
            return;
        }
        this.save.emit(this.draft());
        this.visible.set(false);
    }

    private emptyPrompt(): OnboardingPrompt {
        return {
            title: '',
            type: OnboardingPromptType.MultipleChoice,
            singleSelect: true,
            required: false,
            inOnboarding: true,
            position: 0,
            options: [],
        };
    }
}
