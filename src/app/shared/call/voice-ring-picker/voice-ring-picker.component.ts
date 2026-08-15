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
import {VoiceRingStateService} from '../../../services/voice-ring-state.service';

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
    visible = model.required<boolean>();
    guildId = input.required<string>();
    channelId = input.required<string>();
    /** Who is already in the room, so they are not offered. */
    alreadyIn = input<readonly string[]>([]);

    protected readonly loading = signal(false);
    protected readonly query = signal('');
    protected readonly candidates = signal<Candidate[]>([]);

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
    protected readonly pending = computed(() =>
        this.ringState.outgoingFor(this.guildId(), this.channelId()));

    protected readonly refusal = computed(() =>
        this.ringState.refusalFor(this.guildId(), this.channelId()));

    private readonly guildService = inject(GuildService);
    private readonly profileService = inject(ProfileService);
    private readonly destroyRef = inject(DestroyRef);

    constructor() {
        // Loaded when the dialog opens rather than on construction: this is two requests, and the
        // component sits mounted beside a voice channel nobody may ever invite anyone into.
        effect(() => {
            if (!this.visible()) return;
            untracked(() => this.load());
        });
    }

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

        forkJoin({
            // A failed viewer read is not a reason to offer everybody: it collapses to an empty
            // list, which shows the empty state rather than a roster the server would refuse.
            viewers: this.guildService.getChannelViewers(this.channelId())
                .pipe(catchError(() => of([] as string[]))),
            members: this.guildService.getMembers(this.guildId(), 0, 200)
                .pipe(catchError(() => of([] as GuildMemberDto[]))),
        }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({viewers, members}) => {
            const canSee = new Set(viewers);
            this.candidates.set(members
                .filter(m => canSee.has(m.userId))
                .map(m => ({
                    userId: m.userId,
                    name: m.nickname || m.profile?.userName || m.userId,
                    member: m,
                }))
                .sort((a, b) => a.name.localeCompare(b.name)));
            this.loading.set(false);
        });
    }
}
