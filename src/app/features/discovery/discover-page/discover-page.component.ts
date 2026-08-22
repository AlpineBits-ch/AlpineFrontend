import {ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked} from '@angular/core';
import {toObservable, toSignal} from '@angular/core/rxjs-interop';
import {debounceTime, distinctUntilChanged, map} from 'rxjs';
import {FormsModule} from '@angular/forms';
import {Dialog} from 'primeng/dialog';
import {TranslateModule} from '@ngx-translate/core';
import {CommunityCardComponent} from './community-card.component';
import {InterestOnboardingComponent} from '../interest-onboarding/interest-onboarding.component';
import {discoveryFeedKey, DiscoveryStore} from '../../../stores/discovery.store';
import {DiscoveryFeedQuery} from '../../../dtos/request/discovery.dto';
import {TopicDto} from '../../../dtos/response/discovery.dto';

type DiscoverTab = 'communities' | 'postings';

const SEARCH_DEBOUNCE_MS = 300;

/** Builds the feed's cache key and its fetch argument from the same query, so the two can never drift apart. */
function loadFeed(store: InstanceType<typeof DiscoveryStore>, query: DiscoveryFeedQuery): void {
    store.loadFeed(discoveryFeedKey(query), {arg: query});
}

@Component({
    selector: 'app-discover-page',
    imports: [FormsModule, Dialog, TranslateModule, CommunityCardComponent, InterestOnboardingComponent],
    templateUrl: './discover-page.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DiscoverPageComponent {
    protected readonly searchTerm = signal('');
    protected readonly activeTab = signal<DiscoverTab>('communities');
    /** A later phase gates this on the age floor in spec 8.3, by flipping this one boolean. */
    protected readonly showPostingsTab = computed(() => false);
    /** Session-local: leaving Discover and coming back re-asks, since interests are still unset. */
    private readonly onboardingSkipped = signal(false);

    protected readonly editingInterests = signal(false);
    protected readonly editTopics = signal<TopicDto[]>([]);
    protected readonly editVisible = signal(true);

    private readonly store = inject(DiscoveryStore);
    protected readonly interests = this.store.interests;

    /** Debounced so a query key is not minted, and a request not issued, per keystroke. */
    private readonly settledSearch = toSignal(
        toObservable(this.searchTerm).pipe(
            debounceTime(SEARCH_DEBOUNCE_MS),
            map(term => term.trim()),
            distinctUntilChanged(),
        ),
        {initialValue: ''},
    );

    private readonly query = computed((): DiscoveryFeedQuery => {
        const q = this.settledSearch();
        return q ? {q} : {};
    });
    private readonly feedKey = computed(() => discoveryFeedKey(this.query()));

    protected readonly cards = computed(() => this.store.feedFor(this.feedKey())());
    protected readonly feedLoading = computed(() => this.store.feedLoading(this.feedKey()));
    protected readonly feedError = computed(() => this.store.feedError(this.feedKey()));
    protected readonly feedCursor = computed(() => this.store.feedCursor(this.feedKey()));
    protected readonly feedLoadingMore = computed(() => this.store.feedLoadingMore(this.feedKey()));

    /** The acquisition path for interest data, not a consolation message: see spec 13.3. */
    protected readonly showOnboarding = computed(() => {
        const interests = this.interests();
        return (
            !this.onboardingSkipped() &&
            this.searchTerm().trim() === '' &&
            interests !== null &&
            interests.topics.length === 0
        );
    });

    /** Whether it is still too early to know if onboarding applies: holds the feed off starting its own skeleton so the two never race and swap on screen. */
    protected readonly interestsPending = computed(
        () => this.interests() === null && this.searchTerm().trim() === '',
    );

    constructor() {
        this.store.loadInterests();

        effect(() => {
            const query = this.query();
            untracked(() => loadFeed(this.store, query));
        });
    }

    protected loadMore(): void {
        this.store.loadMoreFeed(this.feedKey());
    }

    protected onOnboardingSkipped(): void {
        this.onboardingSkipped.set(true);
    }

    protected openInterestEditor(): void {
        const current = this.interests();
        this.editTopics.set(current?.topics ?? []);
        this.editVisible.set(current?.visible ?? true);
        this.editingInterests.set(true);
    }
}
