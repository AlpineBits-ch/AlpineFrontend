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
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {HttpErrorResponse} from '@angular/common/http';
import {Subject} from 'rxjs';
import {debounceTime} from 'rxjs/operators';
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
import {topicRefWire} from '../../../dtos/request/discovery.dto';
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

/** A listing carries 1 to 8 topics. Spec section 3.3. */
const TOPIC_CAP = 8;
const HEADLINE_LIMIT = 80;
const PITCH_LIMIT = 600;
const LINKS_CAP = 3;

/** Matches `draft.service.ts`'s server-autosave cadence. */
const AUTOSAVE_DEBOUNCE_MS = 1_200;

type SuspendedReason = 'PlanLapsed' | 'StaffAction';

/** Keyed off the enum, not interpolated: a reason this build has never heard of is a missing property here, caught at compile time, rather than a blank line. */
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

/** Every literal key the two lookup tables above can produce, for `i18n-keys.spec.ts`. */
export const LISTING_EDITOR_TRANSLATION_KEYS: readonly string[] = [
    ...Object.values(SUSPENDED_REASON_KEYS),
    ...Object.values(STATE_KEYS),
];

type PublishErrorKind = 'notEntitled' | 'forbidden' | 'failed';

const PUBLISH_ERROR_KEYS: Record<PublishErrorKind, string> = {
    notEntitled: 'DISCOVERY.LISTING.PUBLISH_ERROR.NOT_ENTITLED',
    forbidden: 'DISCOVERY.LISTING.PUBLISH_ERROR.FORBIDDEN',
    failed: 'DISCOVERY.LISTING.PUBLISH_ERROR.FAILED',
};

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
    protected readonly listing = computed(
        (): ListingDto | null => this.store.listingFor(this.guildId())()[0] ?? null,
    );
    protected readonly stateKey = computed(() => STATE_KEYS[this.listing()?.state ?? 'Draft']);

    protected readonly suspendedReasonKey = computed(() => {
        const listing = this.listing();
        if (!listing || listing.state !== 'Suspended' || !listing.suspendedReason) return null;
        return SUSPENDED_REASON_KEYS[listing.suspendedReason as SuspendedReason] ?? null;
    });

    private readonly apiConfig = inject(ApiConfigService);
    private readonly guild = computed(() => this.guilds.guilds().find(g => g.id === this.guildId()) ?? null);
    private readonly guildIconUrl = computed(
        () => `${this.apiConfig.baseUrl()}/api/v1/guild/guilds/${this.guildId()}/icon`,
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
    }

    private seedForm(guildId: string, listing: ListingDto | null): void {
        this.seededGuildId = guildId;
        this.headline.set(listing?.headline ?? '');
        this.pitch.set(listing?.pitch ?? '');
        this.topics.set(listing?.topics ?? []);
        this.language.set(listing?.language ?? 'en');
        this.joinPolicy.set(listing?.joinPolicy ?? 'Open');
        this.links.set(listing?.links ?? []);
        this.bumpOverrideAt.set(null);
        this.publishErrorKey.set(null);
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
        this.links.set([...this.links(), value]);
        this.newLink.set('');
        this.queueAutosave();
    }

    protected removeLink(index: number): void {
        this.links.set(this.links().filter((_, i) => i !== index));
        this.queueAutosave();
    }

    private queueAutosave(): void {
        this.autosave$.next();
    }

    /** A draft needs at least one topic server-side; skip rather than retry a guaranteed 400. */
    private flushDraft(): void {
        const guildId = this.seededGuildId;
        if (guildId === null || this.topics().length === 0) return;

        this.store
            .saveDraft(guildId, {
                headline: this.headline(),
                pitch: this.pitch(),
                topics: this.topics().map(topicRefWire),
                language: this.language(),
                joinPolicy: this.joinPolicy(),
                links: this.links(),
            })
            .subscribe({error: () => undefined});
    }

    protected publish(): void {
        if (this.publishing()) return;
        this.publishing.set(true);
        this.publishErrorKey.set(null);
        this.store.publish(this.guildId()).subscribe({
            next: () => this.publishing.set(false),
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
                if (availableAt) this.bumpOverrideAt.set(availableAt);
            },
        });
    }
}

function classifyPublishError(err: unknown): PublishErrorKind {
    if (err instanceof HttpErrorResponse && err.status === 403) {
        const body = err.error as {error?: string} | null;
        return body?.error === 'public_listing_not_entitled' ? 'notEntitled' : 'forbidden';
    }
    return 'failed';
}

function bumpCooldownAvailableAt(err: unknown): string | null {
    if (!(err instanceof HttpErrorResponse) || err.status !== 409) return null;
    const body = err.error as {error?: string; bumpAvailableAt?: string} | null;
    return body?.error === 'bump_cooldown' && body.bumpAvailableAt ? body.bumpAvailableAt : null;
}
