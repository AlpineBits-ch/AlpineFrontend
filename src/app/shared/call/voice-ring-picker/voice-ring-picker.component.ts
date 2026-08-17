import {
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    effect,
    inject,
    input,
    model,
    signal,
    untracked,
} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {HttpErrorResponse} from '@angular/common/http';
import {FormsModule} from '@angular/forms';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule} from '@ngx-translate/core';
import {forkJoin, of} from 'rxjs';
import {catchError} from 'rxjs/operators';
import {AppAvatarComponent} from '../../../components/avatar/avatar.component';
import {GuildMemberDto} from '../../../dtos/response/member.dto';
import {GuildService} from '../../../services/guild.service';
import {ProfileService} from '../../../services/profile.service';
import {VoiceRingService} from '../../../services/voice-ring.service';
import {VoiceRingStateService} from '../../../services/voice-ring-state.service';
import {VoiceRingRefusalDto} from '../../../dtos/response/voice-ring.dto';

/** One row in the picker. */
interface Candidate {
    userId: string;
    name: string;
    member: GuildMemberDto;
}

/**
 * Who to ask into this voice channel.
 *
 * <p><b>The list is the channel's viewers, not the guild's members.</b> A ring at somebody who
 * cannot see the channel is refused, and a permission refusal is deliberately not refunded against
 * the rate limit - walking the member list to find out who can see a private channel is meant to
 * cost a token per name. Filtering here is what stops this UI doing exactly that by accident.</p>
 *
 * <p>Anyone already in the channel is dropped too: the server answers `409 TargetAlreadyInChannel`
 * for them, which is a no-op rather than an error, and offering the button anyway would be offering
 * a button that does nothing.</p>
 */
@Component({
    selector: 'app-voice-ring-picker',
    standalone: true,
    imports: [Dialog, Button, InputText, PrimeTemplate, FormsModule, TranslateModule, AppAvatarComponent],
    templateUrl: './voice-ring-picker.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VoiceRingPickerComponent {
    readonly visible = model.required<boolean>();
    readonly guildId = input.required<string>();
    readonly channelId = input.required<string>();
    /** Who is already in the room, so they are not offered. */
    readonly alreadyIn = input<readonly string[]>([]);

    protected readonly loading = signal(false);
    protected readonly query = signal('');
    protected readonly candidates = signal<Candidate[]>([]);

    /** Who has been sent a message invitation this time the dialog was open. */
    protected readonly invited = signal<ReadonlySet<string>>(new Set());
    /** The one request in flight, so a double click does not send twice. */
    protected readonly inviting = signal<string | null>(null);
    protected readonly inviteRefusal = signal<{userId: string; messageKey: string} | null>(null);

    protected readonly ringState = inject(VoiceRingStateService);

    /** Ringing yourself is a `400`, and is nobody's intent anyway. */
    private readonly selfUserId = computed(() => this.profileService.ownProfile()?.userId ?? '');

    protected readonly filtered = computed(() => {
        const excluded = new Set([...this.alreadyIn(), this.selfUserId()]);
        const q = this.query().trim().toLowerCase();
        return this.candidates()
            .filter(c => !excluded.has(c.userId))
            .filter(c => !q || c.name.toLowerCase().includes(q));
    });

    /** The invitation currently out from this channel, if any - so the button shows its countdown. */
    protected readonly pending = computed(() => this.ringState.outgoingFor(this.guildId(), this.channelId()));

    protected readonly refusal = computed(() => this.ringState.refusalFor(this.guildId(), this.channelId()));

    private readonly guildService = inject(GuildService);
    private readonly profileService = inject(ProfileService);
    private readonly rings = inject(VoiceRingService);
    private readonly destroyRef = inject(DestroyRef);

    constructor() {
        // Loaded when the dialog opens rather than on construction: this is two requests, and the
        // component sits mounted beside a voice channel nobody may ever invite anyone into.
        effect(() => {
            if (!this.visible()) return;
            untracked(() => this.load());
        });
    }

    /**
     * The quiet invitation, and the primary action.
     *
     * <p>Held locally rather than in {@link VoiceRingStateService} because there is nothing global
     * to hold: a message invitation creates no ring, so nothing counts down, nothing can be taken
     * back, and no other part of the interface has a state to reflect. It is one request and it is
     * finished.</p>
     *
     * <p>Unlike a ring it can be refused for a reason that is about the two people rather than the
     * channel - the recipient may not accept direct messages from this sender - so the refusal is
     * reported per person rather than in the channel-wide banner the ring refusals use.</p>
     */
    protected invite(candidate: Candidate): void {
        if (this.inviting() || this.invited().has(candidate.userId)) return;

        this.inviting.set(candidate.userId);
        this.inviteRefusal.set(null);

        this.rings
            .invite(this.guildId(), this.channelId(), candidate.userId)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
                next: () => {
                    this.inviting.set(null);
                    this.invited.update(sent => new Set(sent).add(candidate.userId));
                },
                error: (err: HttpErrorResponse) => {
                    this.inviting.set(null);
                    // A 403 carrying RecipientPolicy is the recipient's own setting, which is worth
                    // saying plainly. Anything else is ours to be vague about.
                    this.inviteRefusal.set({
                        userId: candidate.userId,
                        messageKey:
                            (err?.error as VoiceRingRefusalDto | null)?.reason === 'RecipientPolicy'
                                ? 'VOICE_RING.INVITE_REFUSED'
                                : 'VOICE_RING.INVITE_FAILED',
                    });
                },
            });
    }

    /** The loud one. Still here, still the same call, just no longer what a row does. */
    protected send(candidate: Candidate): void {
        this.ringState.send(this.guildId(), this.channelId(), candidate.userId);
    }

    protected cancel(): void {
        this.ringState.cancel(this.guildId(), this.channelId());
    }

    protected close(): void {
        this.visible.set(false);
    }

    private load(): void {
        this.loading.set(true);
        this.query.set('');
        // Reset per opening. "Invited" is a note about this sitting, not a durable fact - the
        // durable one is the card in their conversation.
        this.invited.set(new Set());
        this.inviting.set(null);
        this.inviteRefusal.set(null);

        forkJoin({
            // A failed viewer read is not a reason to offer everybody: it collapses to an empty
            // list, which shows the empty state rather than a roster the server would refuse.
            viewers: this.guildService
                .getChannelViewers(this.channelId())
                .pipe(catchError(() => of([] as string[]))),
            members: this.guildService
                .getMembers(this.guildId(), 0, 200)
                .pipe(catchError(() => of([] as GuildMemberDto[]))),
        })
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(({viewers, members}) => {
                const canSee = new Set(viewers);
                this.candidates.set(
                    members
                        .filter(m => canSee.has(m.userId))
                        .map(m => ({
                            userId: m.userId,
                            name: m.nickname || m.profile?.userName || m.userId,
                            member: m,
                        }))
                        .sort((a, b) => a.name.localeCompare(b.name)),
                );
                this.loading.set(false);
            });
    }
}
