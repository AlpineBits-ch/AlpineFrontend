/**
 * Paging on the mobile conversation list, after `<ion-infinite-scroll>` was replaced by an
 * `IntersectionObserver` on a sentinel element.
 *
 * <p>Ionic's version handed the callback an event whose `target.complete()` re-armed it, so the
 * component could not ask for the same page twice by accident. An observer has no such handshake:
 * it fires on <b>every</b> intersection change, and the sentinel here deliberately stays in the
 * DOM while a page is in flight because it is also what renders "Loading…". Without a guard the
 * list requests page after page as it grows under the viewport - which is the easy bug in a
 * hand-rolled observer and the reason this file exists.</p>
 */
import {TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {of, Subject} from 'rxjs';
import {ConversationListComponent} from './conversation-list.component';
import {ConversationStore} from '../../../../stores/conversation.store';
import {MessageStore} from '../../../../stores/message.store';
import {ProfileService} from '../../../../services/profile.service';
import {MessagingService} from '../../../../services/messaging.service';
import {ConversationService} from '../../../../services/conversation.service';
import {MessagingWebsocketService} from '../../../../services/messaging-websocket.service';
import {ConversationUtilsService} from '../../../../services/conversation-utils.service';
import {MlsService} from '../../../../services/mls.service';
import {MlsSyncService} from '../../../../services/mls-sync.service';
import {ToastService} from '../../../../services/toast.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {PlatformService} from '../../../../services/platform.service';

beforeEach(() => {
    // jsdom implements no `matchMedia`, and PrimeNG's ContextMenu binds a listener to it in
    // `ngOnInit`. Only the two tests that actually render the template need this; stubbing it here
    // rather than in each keeps the failure from looking like something the list did.
    if (!window.matchMedia) {
        window.matchMedia = ((query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            addListener: () => undefined,
            removeListener: () => undefined,
            dispatchEvent: () => false,
        })) as unknown as typeof window.matchMedia;
    }
});

function setup(options: {hasMore?: boolean; loading?: boolean} = {}) {
    const hasMore = signal(options.hasMore ?? true);
    const loading = signal(options.loading ?? false);
    const loadMore = vi.fn();

    const conversationStore = {
        entities: signal([]),
        loaded: signal(true),
        hasMore,
        loading,
        loadMore,
        loadInitial: vi.fn(),
        removeConversation: vi.fn(),
    };

    TestBed.configureTestingModule({
        providers: [
            {provide: ConversationStore, useValue: conversationStore},
            {provide: MessageStore, useValue: {removeMessagesForConversation: vi.fn()}},
            {provide: ProfileService, useValue: {
                ownProfile: () => ({userId: 'me'}), getCachedByUserId: () => undefined,
                resolveByUserId: vi.fn(),
            }},
            {provide: MessagingService, useValue: {
                getMessagesForConversation: () => of([]),
                messageSentObservable: new Subject(),
            }},
            {provide: ConversationService, useValue: {deleteConversation: () => of(undefined)}},
            {provide: MessagingWebsocketService, useValue: {messageObservable: new Subject()}},
            {provide: ConversationUtilsService, useValue: {
                getChatTitle: () => 'Chat', getPartnerMember: () => undefined,
                getPartnerStatus: () => undefined, getTypingLabel: () => null,
            }},
            {provide: MlsService, useValue: {getCachedMessage: vi.fn(async () => null)}},
            {provide: MlsSyncService, useValue: {leaveContext: vi.fn(async () => undefined)}},
            {provide: ToastService, useValue: {success: vi.fn(), httpError: vi.fn()}},
            {provide: NavigationService, useValue: {
                mainView: signal({type: 'home'}), tryRestoreConversationNav: vi.fn(),
                showHome: vi.fn(),
            }},
            {provide: PlatformService, useValue: {isMobile: true}},
        ],
    });

    const fixture = TestBed.createComponent(ConversationListComponent);
    const component = fixture.componentInstance as unknown as { requestNextPage(): void };
    return {fixture, component, hasMore, loading, loadMore};
}

describe('ConversationListComponent paging', () => {
    it('requests the next page when the sentinel comes into view', () => {
        const {component, loadMore} = setup();

        component.requestNextPage();

        expect(loadMore).toHaveBeenCalledTimes(1);
    });

    it('does not request again while a page is already in flight', () => {
        const {component, loading, loadMore} = setup();

        component.requestNextPage();
        // The sentinel stays on screen while "Loading…" is showing, so the observer keeps firing
        // as the list grows under it. Ionic's `complete()` handshake used to make this impossible;
        // here the store's own `loading` flag is what stands in for it.
        loading.set(true);
        component.requestNextPage();
        component.requestNextPage();

        expect(loadMore).toHaveBeenCalledTimes(1);
    });

    it('resumes once the page has landed', () => {
        const {component, loading, loadMore} = setup();

        component.requestNextPage();
        loading.set(true);
        component.requestNextPage();
        loading.set(false);
        component.requestNextPage();

        // Guarding must not latch: a list that stops paging after the first page is as broken as
        // one that never stops.
        expect(loadMore).toHaveBeenCalledTimes(2);
    });

    it('does not request past the end of the list', () => {
        const {component, hasMore, loadMore} = setup({hasMore: false});

        component.requestNextPage();
        hasMore.set(true);
        component.requestNextPage();

        // `loading` alone would not cover this: at the end of the list nothing is in flight, so a
        // guard on that flag by itself would still fire one request past the last page.
        expect(loadMore).toHaveBeenCalledTimes(1);
    });

    it('renders no sentinel once there is nothing more to load', () => {
        const {fixture, hasMore} = setup();
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('.py-3')).toBeTruthy();

        hasMore.set(false);
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('.py-3')).toBeNull();
    });

    it('renders the list without any Ionic custom element', () => {
        const {fixture} = setup();
        fixture.detectChanges();

        // The removal, asserted rather than assumed. An unknown `<ion-*>` element does not fail a
        // template compile on its own, so a leftover tag would render as an inert empty box and
        // take a piece of the list's layout with it.
        const html: string = fixture.nativeElement.innerHTML;
        expect(html).not.toMatch(/<ion-/);
    });
});
