import {ChangeDetectionStrategy, Component, computed, DestroyRef, inject, input, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {HttpErrorResponse} from '@angular/common/http';
import {TranslateModule} from '@ngx-translate/core';
import {GuildService} from '../../../../../../services/guild.service';
import {MessageEmbed} from '../../../../../../dtos/response/message.dto';
import {isInviteUsable} from '../../../../../../dtos/response/invite.dto';
import {environment} from '../../../../../../../environments/environment';

/** What the join button is doing, not what the invite is. */
type JoinState = 'idle' | 'joining' | 'joined' | 'failed';

/**
 * What a lazy re-resolve found out about an invite the card was frozen with.
 *
 * <p>`unknown` is both the starting state and where a refusal we cannot read anything into - a
 * `429` above all - puts it back, so the check can be tried again later.</p>
 */
type Freshness = 'unknown' | 'checking' | 'usable' | 'gone';

/**
 * A guild invite linked from a message, rendered from the server's `venta.invite` embed.
 *
 * <p><b>Presentational.</b> It no longer parses a URL and no longer fetches on mount. The server
 * recognises its own invite links, resolves them in-process and freezes the guild's name and
 * description onto the embed, so the card renders the moment the message does - where it used to
 * open a request per message and show a skeleton until it answered.</p>
 *
 * <p>The embed is frozen at post time and deliberately does not carry whether the invite is still
 * good. {@link refresh} fills that in lazily, once, when something asks - and a failure keeps the
 * frozen card rather than blanking it, including the `429` these preview routes now answer with.</p>
 *
 * <p><b>The `venta` block carries identifiers, never a URL to call.</b> Every request below is
 * composed from this client's own route table through {@link GuildService}: an endpoint supplied by
 * an embed, hit with the user's token, would be a credential harvester any bot author could
 * author.</p>
 */
@Component({
    selector: 'app-invite-card',
    standalone: true,
    imports: [TranslateModule],
    templateUrl: './invite-card.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InviteCardComponent {
    embed = input.required<MessageEmbed>();

    protected readonly joinState = signal<JoinState>('idle');
    protected readonly freshness = signal<Freshness>('unknown');
    protected readonly iconFailed = signal(false);

    /** Everything the card renders comes from here. Absent means there is no card to draw. */
    protected readonly venta = computed(() => this.embed().venta);

    protected readonly guildId = computed(() => this.venta()?.guild_id);
    protected readonly inviteCode = computed(() => this.venta()?.invite_code);

    /**
     * The guild's name, as its owner typed it. Rendered as text and never through markdown: the
     * server relays it, it does not author it.
     */
    protected readonly title = computed(() => this.embed().title ?? '');
    protected readonly description = computed(() => this.embed().description ?? '');

    /**
     * Expiry as of render time.
     *
     * <p>The one volatile-looking field that is safe to freeze: an absolute instant does not go
     * stale the way the word "expired" does, so this needs no request at all. It is compared to the
     * clock here rather than trusted as a state.</p>
     */
    protected readonly hasLapsed = computed(() => {
        const at = this.venta()?.expires_at;
        return !!at && new Date(at).getTime() <= Date.now();
    });

    /** Revoked, exhausted or lapsed - anything that means "do not offer Join". */
    protected readonly unusable = computed(() =>
        this.hasLapsed() || this.freshness() === 'gone');

    protected readonly maxUses = computed(() => this.venta()?.max_uses);

    protected readonly guildIconUrl = computed(() => {
        const id = this.guildId();
        return id ? `${environment.apiUrl}/api/v1/guild/guilds/${id}/icon` : '';
    });

    protected readonly guildInitials = computed(() =>
        this.title().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join(''));

    private readonly guildService = inject(GuildService);
    private readonly destroyRef = inject(DestroyRef);

    /**
     * Re-resolves the invite to find out whether it still works.
     *
     * <p>Lazy and once: the preview routes are rate limited to 30 a minute per caller and a miss
     * costs a token too, so this runs on an explicit gesture rather than on render. `429` is a
     * "could not tell", not a verdict - the card keeps whatever it was showing.</p>
     */
    protected refresh(): void {
        const code = this.inviteCode();
        if (!code || this.freshness() !== 'unknown') return;

        this.freshness.set('checking');
        this.guildService.getInviteByCode(code)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
                next: invite => this.freshness.set(isInviteUsable(invite) ? 'usable' : 'gone'),
                error: (err: HttpErrorResponse) => {
                    // A 404 is the one answer that is a verdict: a revoked or never-real code is
                    // deliberately indistinguishable from a typo. Everything else - rate limiting
                    // above all - leaves the frozen card exactly as it was.
                    this.freshness.set(err?.status === 404 ? 'gone' : 'unknown');
                },
            });
    }

    protected join(): void {
        const code = this.inviteCode();
        if (!code || this.joinState() === 'joining' || this.joinState() === 'joined') return;

        this.joinState.set('joining');
        this.guildService.redeemInvite(code)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
                next: () => {
                    this.joinState.set('joined');
                    this.guildService.guildJoined$.next();
                },
                error: (err: HttpErrorResponse) => {
                    // 409 is "you are already in there", which is a success from the reader's point
                    // of view and must not be drawn as a failure.
                    this.joinState.set(err?.status === 409 ? 'joined' : 'failed');
                    if (err?.status === 404) this.freshness.set('gone');
                },
            });
    }
}
