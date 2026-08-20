import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    input,
    signal,
    untracked,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PrimeTemplate} from 'primeng/api';
import {PersonaAvatarComponent} from '../persona-avatar/persona-avatar.component';
import {PersonaEditorComponent, PersonaEditorTarget} from '../persona-editor/persona-editor.component';
import {PersonaService} from '../../../../services/persona.service';
import {GuildService} from '../../../../services/guild.service';
import {ProfileService} from '../../../../services/profile.service';
import {ToastService} from '../../../../services/toast.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {GuildPersonaDto, PersonaCastMemberDto, PersonaDto} from '../../../../dtos/response/persona.dto';
import {guildAbilities} from '../../guild-permissions';
import {ModulePermissions} from '../../../../enums/module-permissions.enum';
import {SelfGuildMemberDto} from '../../../../dtos/response/member.dto';
import {
    identityFromCastMember,
    matchesCastMemberQuery,
    matchesPersonaQuery,
    personaIdentity,
    PersonaIdentity,
} from '../persona-identity';
import {readableAccent} from '../../../../models/profile-font.model';
import {approvalMeta, canSubmit} from '../persona-approval';
import {hasProxyTags, ProxyTags, proxyTagsOf} from '../persona-proxy';

type DirectoryTab = 'cast' | 'mine' | 'review';

/** A guild-wide cast row. `entry` is only set for a character the caller may itself speak as. */
interface CastRow {
    member: PersonaCastMemberDto;
    who: PersonaIdentity;
    entry: GuildPersonaDto | null;
}

/** One of the account's characters, paired with whether it has been adopted into this guild. */
interface MineRow {
    persona: PersonaDto;
    entry: GuildPersonaDto | null;
}

/** The guild's cast: who is played here, what the account owns, and what is waiting on a reviewer. */
@Component({
    selector: 'app-persona-directory',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        PersonaAvatarComponent,
        PersonaEditorComponent,
        TranslateModule,
        FormsModule,
        Dialog,
        Button,
        PrimeTemplate,
    ],
    templateUrl: './persona-directory.component.html',
    host: {class: 'flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden'},
})
export class PersonaDirectoryComponent {
    readonly guildId = input.required<string>();

    protected readonly personas = inject(PersonaService);
    private readonly guilds = inject(GuildService);
    private readonly profiles = inject(ProfileService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);
    protected readonly nav = inject(NavigationService);

    protected readonly tab = signal<DirectoryTab>('cast');
    protected readonly query = signal('');
    protected readonly editing = signal<PersonaEditorTarget | null>(null);
    protected readonly reviewing = signal<GuildPersonaDto | null>(null);
    protected readonly withdrawing = signal<PersonaDto | null>(null);
    protected readonly reviewReason = signal('');
    protected readonly busyId = signal<string | null>(null);

    private readonly ownMember = signal<SelfGuildMemberDto | null>(null);

    protected readonly guild = computed(() => this.guilds.guilds().find(g => g.id === this.guildId()));

    protected readonly guildName = computed(() => this.guild()?.name ?? '');

    private readonly abilities = computed(() =>
        guildAbilities(this.ownMember(), this.guild(), this.profiles.ownProfile()?.userId),
    );

    protected readonly canManage = computed(() =>
        this.abilities().canModule(ModulePermissions.ManageAnyPersona),
    );
    protected readonly canApprove = computed(() =>
        this.abilities().canModule(ModulePermissions.ApprovePersonas),
    );

    protected readonly cast = computed((): CastRow[] =>
        this.personas
            .guildCast(this.guildId())
            .filter(member => matchesCastMemberQuery(member, this.query()))
            .map(member => ({
                member,
                who: identityFromCastMember(member),
                entry: this.personas.entry(this.guildId(), member.personaId),
            })),
    );

    protected readonly mine = computed((): MineRow[] =>
        this.personas
            .ownPersonas()
            .map(persona => ({
                persona,
                entry: this.personas.entry(this.guildId(), persona.id),
            }))
            .filter(row => this.matchesMine(row)),
    );

    /** The queue as the service holds it: the review events patch it there, not here. */
    protected readonly pending = computed(() => this.personas.pending(this.guildId()));

    protected readonly reviewQueue = computed(() =>
        this.pending().filter(entry => matchesPersonaQuery(entry, this.query())),
    );

    protected readonly loadingPending = computed(() => this.personas.isPendingLoading(this.guildId()));

    protected readonly loadingCast = computed(() => this.personas.isGuildCastLoading(this.guildId()));

    constructor() {
        effect(() => {
            const guildId = this.guildId();
            untracked(() => {
                this.personas.ensureCast(guildId);
                this.personas.ensureGuildCast(guildId);
                this.personas.ensureOwn();
                this.guilds.getOwnMember(guildId).subscribe({
                    next: member => this.ownMember.set(member),
                    error: () => this.ownMember.set(null),
                });
            });
        });

        effect(() => {
            const guildId = this.guildId();
            const allowed = this.canApprove();
            untracked(() => {
                if (!allowed) {
                    this.personas.forgetPending(guildId);
                    return;
                }
                this.personas.ensurePending(guildId);
            });
        });

        // A reviewer who loses the permission mid-session must not be left on an empty tab.
        effect(() => {
            if (this.tab() === 'review' && !this.canApprove()) untracked(() => this.tab.set('cast'));
        });
    }

    protected identityOf(entry: GuildPersonaDto) {
        return personaIdentity(entry);
    }

    /** A character with no profile here still has to be drawn readably. */
    protected accentOf(persona: PersonaDto): string | null {
        return readableAccent(persona.color);
    }

    protected approvalOf(entry: GuildPersonaDto) {
        return approvalMeta(entry.approvalState);
    }

    /** The two halves separately, so the card can float the body between them. */
    protected tagsOf(entry: GuildPersonaDto): ProxyTags | null {
        const tags = proxyTagsOf(entry);
        return hasProxyTags(tags) ? tags : null;
    }

    protected open(personaId: string): void {
        this.nav.openCharacter(this.guildId(), personaId);
    }

    /** A rename lands in the guild cast, an override lands in the speakable entry. Read both back. */
    protected refreshAfterSave(): void {
        this.personas.ensureCast(this.guildId(), true);
        this.personas.ensureGuildCast(this.guildId(), true);
    }

    protected createPersonal(): void {
        this.editing.set({persona: null, entry: null, guildId: this.guildId()});
    }

    protected createShared(): void {
        this.editing.set({persona: null, entry: null, guildId: this.guildId(), guildOwned: true});
    }

    protected edit(entry: GuildPersonaDto): void {
        this.editing.set({
            persona: entry.persona,
            entry,
            guildId: this.guildId(),
            guildOwned: !!entry.persona.ownerGuildId,
        });
    }

    /** Adopting is the same write as saving overrides, with everything left inherited. */
    protected adopt(persona: PersonaDto): void {
        this.busyId.set(persona.id);
        this.personas.saveProfile(this.guildId(), persona.id, {}).subscribe({
            next: () => {
                this.busyId.set(null);
                this.personas.ensureGuildCast(this.guildId(), true);
                this.toast.success(this.translate.instant('PERSONA.DIRECTORY.ADOPTED', {name: persona.name}));
            },
            error: err => {
                this.busyId.set(null);
                this.toast.httpError(this.translate.instant('PERSONA.DIRECTORY.ADOPT_FAILED'), err);
            },
        });
    }

    protected confirmWithdraw(persona: PersonaDto): void {
        this.withdrawing.set(persona);
    }

    protected withdraw(): void {
        const persona = this.withdrawing();
        if (!persona) return;

        this.busyId.set(persona.id);
        this.personas.removeProfile(this.guildId(), persona.id).subscribe({
            next: () => {
                this.busyId.set(null);
                this.withdrawing.set(null);
                this.personas.ensureGuildCast(this.guildId(), true);
                this.toast.success(
                    this.translate.instant('PERSONA.DIRECTORY.WITHDRAWN', {
                        name: persona.name,
                        guild: this.guildName(),
                    }),
                );
            },
            error: err => {
                this.busyId.set(null);
                this.toast.httpError(this.translate.instant('PERSONA.DIRECTORY.WITHDRAW_FAILED'), err);
            },
        });
    }

    protected canSubmitEntry(entry: GuildPersonaDto): boolean {
        return canSubmit(entry);
    }

    protected submit(entry: GuildPersonaDto): void {
        this.busyId.set(entry.persona.id);
        this.personas.submit(this.guildId(), entry.persona.id).subscribe({
            next: () => {
                this.busyId.set(null);
                this.toast.success(this.translate.instant('PERSONA.DIRECTORY.SUBMITTED'));
            },
            error: err => {
                this.busyId.set(null);
                this.toast.httpError(this.translate.instant('PERSONA.DIRECTORY.SUBMIT_FAILED'), err);
            },
        });
    }

    protected approve(entry: GuildPersonaDto): void {
        this.busyId.set(entry.persona.id);
        this.personas.approve(this.guildId(), entry.persona.id).subscribe({
            next: () => {
                this.busyId.set(null);
                this.personas.ensurePending(this.guildId(), true);
            },
            error: err => {
                this.busyId.set(null);
                this.toast.httpError(this.translate.instant('PERSONA.REVIEW.APPROVE_FAILED'), err);
            },
        });
    }

    protected openReview(entry: GuildPersonaDto): void {
        this.reviewReason.set('');
        this.reviewing.set(entry);
    }

    protected sendChanges(): void {
        const entry = this.reviewing();
        const reason = this.reviewReason().trim();
        if (!entry || !reason) return;

        this.busyId.set(entry.persona.id);
        this.personas.requestChanges(this.guildId(), entry.persona.id, {reason}).subscribe({
            next: () => {
                this.busyId.set(null);
                this.reviewing.set(null);
                this.personas.ensurePending(this.guildId(), true);
            },
            error: err => {
                this.busyId.set(null);
                this.toast.httpError(this.translate.instant('PERSONA.REVIEW.REQUEST_FAILED'), err);
            },
        });
    }

    /** Same search as the Cast tab, falling back to the global row for a character not adopted here. */
    private matchesMine(row: MineRow): boolean {
        if (row.entry) return matchesPersonaQuery(row.entry, this.query());

        const needle = this.query().trim().toLowerCase();
        if (!needle) return true;
        return [row.persona.name, row.persona.pronouns].some(value => value?.toLowerCase().includes(needle));
    }
}
