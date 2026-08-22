import {
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    effect,
    inject,
    input,
    signal,
    untracked,
} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {HttpErrorResponse} from '@angular/common/http';
import {catchError, debounceTime, Observable, Subject, switchMap, tap, EMPTY} from 'rxjs';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Textarea} from 'primeng/textarea';
import {Select} from 'primeng/select';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {TopicPickerComponent} from '../topic-picker/topic-picker.component';
import {CommunityCardComponent} from '../discover-page/community-card.component';
import {
    DiscoveryCardDto,
    JoinPolicy,
    ListingDto,
    ListingState,
    TopicDto,
} from '../../../dtos/response/discovery.dto';
import {ListingWriteDto, topicRefWire} from '../../../dtos/request/discovery.dto';
import {ENTITLEMENT_KEYS, isGranted} from '../../../dtos/response/entitlement.dto';
import {DiscoveryStore} from '../../../stores/discovery.store';
import {EntitlementStore} from '../../../stores/entitlement.store';
import {entitlementRemedyCopy} from '../../../core/entitlement-message';
import {GuildService} from '../../../services/guild.service';
import {ToastService} from '../../../services/toast.service';
import {MinuteClockService} from '../../../services/minute-clock.service';
import {ApiConfigService} from '../../../services/api-config.service';
import {RelativeTimePipe} from '../../../pipes/relative-time.pipe';
import {injectGuildRoster} from '../../guild/shared/guild-roster';
import {CONTENT_LANGUAGES} from '../../../models/language.model';

/** A listing carries 1 to 8 topics. Spec section 3.3. */
const TOPIC_CAP = 8;
const HEADLINE_LIMIT = 80;
const PITCH_LIMIT = 600;
const LINKS_CAP = 3;

/** Matches `draft.service.ts`'s server-autosave cadence. Reused by `profile-page.component.ts`. */
export const AUTOSAVE_DEBOUNCE_MS = 1_200;

/** Under a minute left, `relativeTime` would render "this minute", which reads as broken on a 72h cooldown. */
const BUMP_SOON_MS = 60_000;

/** Mirrors `ListingWriteService.AllowedLinkHosts` server-side, so an unlisted host is refused before a request rather than after. */
const ALLOWED_LINK_HOSTS = new Set([
    'discord.gg',
    'discord.com',
    'twitter.com',
    'x.com',
    'youtube.com',
    'youtu.be',
    'twitch.tv',
    'instagram.com',
    'tiktok.com',
    'reddit.com',
    'steamcommunity.com',
    'patreon.com',
    'roll20.net',
    'dndbeyond.com',
    'startplaying.games',
    'worldanvil.com',
    'bsky.app',
]);

function isAllowedLink(raw: string): boolean {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return ALLOWED_LINK_HOSTS.has(host.startsWith('www.') ? host.slice(4) : host);
}

type SuspendedReason = 'PlanLapsed' | 'StaffAction';

/** Compile error if `SuspendedReason` grows without a matching entry here. */
const SUSPENDED_REASON_KEYS: Record<SuspendedReason, string> = {
    PlanLapsed: 'DISCOVERY.LISTING.SUSPENDED.PLAN_LAPSED',
    StaffAction: 'DISCOVERY.LISTING.SUSPENDED.STAFF_ACTION',
};

const STATE_KEYS: Record<ListingState, string> = {
    Draft: 'DISCOVERY.LISTING.STATE.DRAFT',
    Published: 'DISCOVERY.LISTING.STATE.PUBLISHED',
    Suspended: 'DISCOVERY.LISTING.STATE.SUSPENDED',
    Unlisted: 'DISCOVERY.LISTING.STATE.UNLISTED',
};

type PublishErrorKind = 'notEntitled' | 'forbidden' | 'nothingSaved' | 'failed';

const PUBLISH_ERROR_KEYS: Record<PublishErrorKind, string> = {
    notEntitled: 'DISCOVERY.LISTING.PUBLISH_ERROR.NOT_ENTITLED',
    forbidden: 'DISCOVERY.LISTING.PUBLISH_ERROR.FORBIDDEN',
    nothingSaved: 'DISCOVERY.LISTING.PUBLISH_ERROR.NOTHING_SAVED',
    failed: 'DISCOVERY.LISTING.PUBLISH_ERROR.FAILED',
};

/** Every literal key the three lookup tables above can produce, for `i18n-keys.spec.ts`. */
export const LISTING_EDITOR_TRANSLATION_KEYS: readonly string[] = [
    ...Object.values(SUSPENDED_REASON_KEYS),
    ...Object.values(STATE_KEYS),
    ...Object.values(PUBLISH_ERROR_KEYS),
];

/** The server's 400 body for a draft save is the plain refusal string itself - show it, not a generic one. */
function draftSaveErrorMessage(err: unknown, translate: TranslateService): string {
    if (
        err instanceof HttpErrorResponse &&
        err.status === 400 &&
        typeof err.error === 'string' &&
        err.error.trim()
    ) {
        return err.error;
    }
    return translate.instant('DISCOVERY.LISTING.SAVE_ERROR');
}

function classifyPublishError(err: unknown): PublishErrorKind {
    if (err instanceof HttpErrorResponse && err.status === 403) {
        const body = err.error as {error?: string} | null;
        return body?.error === 'public_listing_not_entitled' ? 'notEntitled' : 'forbidden';
    }
    // The publish route answers 404 for a guild with no listing row, not for a bad URL.
    if (err instanceof HttpErrorResponse && err.status === 404) return 'nothingSaved';
    return 'failed';
}

function bumpCooldownAvailableAt(err: unknown): string | null {
    if (!(err instanceof HttpErrorResponse) || err.status !== 409) return null;
    const body = err.error as {error?: string; bumpAvailableAt?: string} | null;
    return body?.error === 'bump_cooldown' && body.bumpAvailableAt ? body.bumpAvailableAt : null;
}

/** A guild's own listing: composed here, autosaved as a draft, published against the entitlement. */
@Component({
    selector: 'app-listing-editor',
    imports: [
        FormsModule,
        Button,
        InputText,
        Textarea,
        Select,
        TranslateModule,
        TopicPickerComponent,
        CommunityCardComponent,
        RelativeTimePipe,
    ],
    templateUrl: './listing-editor.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ListingEditorComponent {
    readonly guildId = input.required<string>();

    protected readonly headlineLimit = HEADLINE_LIMIT;
    protected readonly pitchLimit = PITCH_LIMIT;
    protected readonly linksCap = LINKS_CAP;
    protected readonly topicCap = TOPIC_CAP;

    protected readonly headline = signal('');
    protected readonly pitch = signal('');
    protected readonly topics = signal<TopicDto[]>([]);
    protected readonly language = signal('en');
    protected readonly joinPolicy = signal<JoinPolicy>('Open');
    protected readonly links = signal<string[]>([]);
    protected readonly newLink = signal('');
    protected readonly linkInvalid = signal(false);

    /** Reflects the autosave lifecycle, not just "is there a pending debounce". */
    protected readonly saveStatus = signal<'saved' | 'unsaved' | 'saving' | 'error'>('saved');

    protected readonly publishing = signal(false);
    protected readonly unlisting = signal(false);
    protected readonly bumping = signal(false);
    protected readonly publishErrorKey = signal<string | null>(null);
    /** From a `bump_cooldown` 409's body, when fresher than the last-loaded row. */
    private readonly bumpOverrideAt = signal<string | null>(null);

    private readonly store = inject(DiscoveryStore);
    private readonly entitlements = inject(EntitlementStore);
    private readonly guilds = inject(GuildService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);
    protected readonly clock = inject(MinuteClockService);
    private readonly roster = injectGuildRoster(
        () => this.guildId(),
        'GUILD_SETTINGS.MEMBERS.UNKNOWN_MEMBER',
    );

    protected readonly listingLoaded = computed(() => this.store.listingLoaded(this.guildId()));
    protected readonly listingError = computed(() => this.store.listingError(this.guildId()));
    protected readonly listing = computed(
        (): ListingDto | null => this.store.listingFor(this.guildId())()[0] ?? null,
    );
    protected readonly stateKey = computed(() => STATE_KEYS[this.listing()?.state ?? 'Draft']);

    /** The one precondition the server enforces that the client can fully catch ahead of a request. */
    protected readonly blockedReason = computed((): 'topics' | null =>
        this.topics().length === 0 ? 'topics' : null,
    );

    protected readonly languageOptions = CONTENT_LANGUAGES.map(l => ({
        value: l.code,
        label: l.label,
        english: l.english,
    }));

    protected readonly suspendedReasonKey = computed(() => {
        const listing = this.listing();
        if (!listing || listing.state !== 'Suspended' || !listing.suspendedReason) return null;
        return SUSPENDED_REASON_KEYS[listing.suspendedReason as SuspendedReason] ?? null;
    });

    private readonly apiConfig = inject(ApiConfigService);
    private readonly guild = computed(() => this.guilds.guilds().find(g => g.id === this.guildId()) ?? null);
    private readonly guildIconUrl = computed(
        () => `${this.apiConfig.baseUrl()}/api/v1/guild/guilds/${this.guildId()}/icon/thumbnail`,
    );

    protected readonly previewCard = computed((): DiscoveryCardDto => {
        const listing = this.listing();
        return {
            listingId: listing?.id ?? this.guildId(),
            guildId: this.guildId(),
            guildName: this.guild()?.name ?? '',
            guildIconUrl: this.guildIconUrl(),
            guildBannerUrl: null,
            memberCount: this.roster.members().length,
            headline: this.headline(),
            pitch: this.pitch(),
            topics: this.topics(),
            matchedTopics: [],
            language: this.language(),
            joinPolicy: this.joinPolicy(),
            lastBumpedAt: listing?.lastBumpedAt ?? null,
        };
    });

    private readonly entitled = computed(() =>
        isGranted(
            this.entitlements.value({kind: 'guild', id: this.guildId()}, ENTITLEMENT_KEYS.guildPublicListing),
        ),
    );
    private readonly entitlementLoaded = computed(
        () => this.entitlements.snapshot({kind: 'guild', id: this.guildId()}) !== null,
    );
    protected readonly showUpgradeBar = computed(() => this.entitlementLoaded() && !this.entitled());
    protected readonly upgradeRemedy = computed(() => {
        const snapshot = this.entitlements.snapshot({kind: 'guild', id: this.guildId()});
        return entitlementRemedyCopy(snapshot?.remedy, snapshot?.actorCanRemedy === true);
    });

    protected readonly joinPolicyOptions = computed(() => [
        {value: 'Open' as JoinPolicy, label: this.translate.instant('DISCOVERY.LISTING.JOIN_POLICY.OPEN')},
        {
            value: 'Application' as JoinPolicy,
            label: this.translate.instant('DISCOVERY.LISTING.JOIN_POLICY.APPLICATION'),
        },
    ]);

    protected readonly bumpAvailableAt = computed(
        () => this.bumpOverrideAt() ?? this.listing()?.bumpAvailableAt ?? null,
    );
    protected readonly bumpReady = computed(() => {
        const at = this.bumpAvailableAt();
        return !at || new Date(at).getTime() <= this.clock.now();
    });
    protected readonly bumpCountingDown = computed(() => {
        const at = this.bumpAvailableAt();
        if (!at) return false;
        const remaining = new Date(at).getTime() - this.clock.now();
        return remaining > 0 && remaining < BUMP_SOON_MS;
    });

    private seededGuildId: string | null = null;
    private readonly autosave$ = new Subject<void>();

    constructor() {
        this.clock.retain();

        effect(() => {
            const id = this.guildId();
            untracked(() => {
                this.store.loadListing(id);
                this.entitlements.ensureLoaded({kind: 'guild', id});
            });
        });

        effect(() => {
            const id = this.guildId();
            if (!this.store.listingLoaded(id) || this.seededGuildId === id) return;
            const row = this.store.listingFor(id)()[0] ?? null;
            untracked(() => this.seedForm(id, row));
        });

        this.autosave$
            .pipe(debounceTime(AUTOSAVE_DEBOUNCE_MS), takeUntilDestroyed())
            .subscribe(() => this.flushDraft());

        // The debounce above never fires for the last edit before navigating away.
        inject(DestroyRef).onDestroy(() => {
            if (this.saveStatus() === 'unsaved') this.flushDraft();
        });
    }

    private seedForm(guildId: string, listing: ListingDto | null): void {
        this.seededGuildId = guildId;
        this.headline.set(listing?.headline ?? '');
        this.pitch.set(listing?.pitch ?? '');
        this.topics.set(listing?.topics ?? []);
        this.language.set(listing?.language ?? 'en');
        this.joinPolicy.set(listing?.joinPolicy ?? 'Open');
        this.links.set(listing?.links ?? []);
        this.linkInvalid.set(false);
        this.bumpOverrideAt.set(null);
        this.publishErrorKey.set(null);
        this.saveStatus.set('saved');
    }

    protected setHeadline(value: string): void {
        this.headline.set(value);
        this.queueAutosave();
    }

    protected setPitch(value: string): void {
        this.pitch.set(value);
        this.queueAutosave();
    }

    protected setTopics(value: TopicDto[]): void {
        this.topics.set(value);
        this.queueAutosave();
    }

    protected setLanguage(value: string): void {
        this.language.set(value);
        this.queueAutosave();
    }

    protected setJoinPolicy(value: JoinPolicy): void {
        this.joinPolicy.set(value);
        this.queueAutosave();
    }

    protected addLink(): void {
        const value = this.newLink().trim();
        if (!value || this.links().length >= LINKS_CAP) return;
        if (!isAllowedLink(value)) {
            this.linkInvalid.set(true);
            return;
        }
        this.linkInvalid.set(false);
        this.links.set([...this.links(), value]);
        this.newLink.set('');
        this.queueAutosave();
    }

    protected removeLink(index: number): void {
        this.links.set(this.links().filter((_, i) => i !== index));
        this.queueAutosave();
    }

    protected retry(): void {
        this.store.loadListing(this.guildId(), {force: true});
    }

    private queueAutosave(): void {
        this.saveStatus.set('unsaved');
        this.autosave$.next();
    }

    /** Null when there is nothing to send yet, or the draft would fail a rule the client already enforces. */
    private saveDraftNow(): Observable<ListingDto> | null {
        const guildId = this.seededGuildId;
        if (guildId === null || this.blockedReason() !== null) return null;

        const dto: ListingWriteDto = {
            headline: this.headline(),
            pitch: this.pitch(),
            topics: this.topics().map(topicRefWire),
            language: this.language().trim(),
            joinPolicy: this.joinPolicy(),
            links: this.links(),
        };

        this.saveStatus.set('saving');
        return this.store.saveDraft(guildId, dto).pipe(
            tap({
                next: () => this.saveStatus.set('saved'),
                error: (err: unknown) => {
                    this.saveStatus.set('error');
                    this.toast.error(draftSaveErrorMessage(err, this.translate));
                },
            }),
        );
    }

    private flushDraft(): void {
        this.saveDraftNow()?.subscribe({error: () => undefined});
    }

    protected publish(): void {
        // saveDraftNow() refuses while blockedReason() is set, so publishing here would hit a guild
        // with no listing row and answer 404.
        if (this.publishing() || this.blockedReason() !== null) return;
        this.publishing.set(true);
        this.publishErrorKey.set(null);

        // Publishes whatever the server currently holds, so a keystroke inside the debounce window
        // must land before the request, not after.
        const pendingSave = this.saveStatus() === 'unsaved' ? this.saveDraftNow() : null;
        const publish$ = this.store.publish(this.guildId());
        const request$ = pendingSave
            ? pendingSave.pipe(
                  switchMap(() => publish$),
                  // Falling through to publish is only right when the server already holds a
                  // listing; with none, the 404 replaces the save error that explains it. The
                  // failed save has already raised its own toast, so this stops rather than adds.
                  catchError(() => (this.listing() ? publish$ : EMPTY)),
              )
            : publish$;

        request$.subscribe({
            next: () => this.publishing.set(false),
            complete: () => this.publishing.set(false),
            error: (err: unknown) => {
                this.publishing.set(false);
                const key = PUBLISH_ERROR_KEYS[classifyPublishError(err)];
                this.publishErrorKey.set(key);
                this.toast.error(this.translate.instant(key));
            },
        });
    }

    protected unlist(): void {
        if (this.unlisting()) return;
        this.unlisting.set(true);
        this.store.unlist(this.guildId()).subscribe({
            next: () => this.unlisting.set(false),
            error: () => {
                this.unlisting.set(false);
                this.toast.error(this.translate.instant('DISCOVERY.LISTING.UNLIST_ERROR'));
            },
        });
    }

    protected bump(): void {
        if (this.bumping() || !this.bumpReady()) return;
        this.bumping.set(true);
        this.store.bump(this.guildId()).subscribe({
            next: () => {
                this.bumping.set(false);
                this.bumpOverrideAt.set(null);
            },
            error: (err: unknown) => {
                this.bumping.set(false);
                const availableAt = bumpCooldownAvailableAt(err);
                if (availableAt) {
                    this.bumpOverrideAt.set(availableAt);
                    return;
                }
                this.toast.error(this.translate.instant('DISCOVERY.LISTING.BUMP_ERROR'));
            },
        });
    }
}
