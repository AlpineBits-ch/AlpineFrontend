/**
 * The conversation input is bound to the store entity now (`navService.activeConversation()`), so
 * the read-receipt write in `ConversationComponent.setupReadTracking` closes a loop the `untracked`
 * there cannot see: write -> new entity object -> new input -> effect re-runs -> write. Every turn
 * re-filters and re-sorts the whole message list, so it bites hardest with a long scrollback loaded.
 *
 * Reproduced with the pair alone rather than the real component, whose DI chain reaches the
 * realtime connection - the same approach as conversation-call-full-view.spec.ts. The run counter
 * is bounded so a regression fails on the count instead of hanging the runner.
 */
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
import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {Subject} from 'rxjs';
import {describe, expect, it} from 'vitest';
import {ConversationCacheService} from '../../../../services/cache/conversation-cache.service';
import {ConversationStore} from '../../../../stores/conversation.store';
import {ConversationDto} from '../../../../dtos/response/conversation.dto';
import {ConversationEncryption} from '../../../../enums/conversation-encryption.enum';
import {MessagingWebsocketService} from '../../../../services/messaging-websocket.service';
import {ApiConfigService} from '../../../../services/api-config.service';

const MAX_RUNS = 6;

function conversation(): ConversationDto {
    return {
        id: 'conv_1',
        createdAt: new Date(),
        updatedAt: new Date(),
        name: 'Group',
        iconUpdatedAt: null,
        members: [
            {
                id: 'cmem_1',
                createdAt: new Date(),
                updatedAt: new Date(),
                userId: 'user_1',
                cachedUserName: 'Me',
                lastReadMessageId: undefined,
                mentionCount: 0,
            },
        ],
        encryptionState: ConversationEncryption.Plain,
    };
}

/** Only the streams ConversationStore subscribes to on init. */
function fakeWebsocket() {
    return {
        conversationCreatedObservable: new Subject<string>(),
        messageObservable: new Subject<unknown>(),
        conversationRemovedObservable: new Subject<unknown>(),
        conversationUpdatedObservable: new Subject<unknown>(),
        conversationMemberRemovedObservable: new Subject<unknown>(),
    };
}

@Component({
    selector: 'app-read-tracking',
    template: '',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
class ReadTrackingComponent {
    readonly conversation = input.required<ConversationDto>();
    readonly runs = signal(0);
    private readonly store = inject(ConversationStore);

    constructor() {
        effect(() => {
            const convId = this.conversation().id;
            untracked(() => {
                this.runs.update(n => n + 1);
                if (this.runs() > MAX_RUNS) return;
                this.store.updateMemberLastRead(convId, 'user_1', 'mesg_1');
            });
        });
    }
}

/** The binding main-page.component.html uses: the live store entity, falling back to the opened copy. */
@Component({
    imports: [ReadTrackingComponent],
    template: `<app-read-tracking [conversation]="live()" />`,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
class HostComponent {
    readonly opened = conversation();
    private readonly store = inject(ConversationStore);
    readonly live = computed(() => this.store.entityMap()[this.opened.id] ?? this.opened);
}

function setup() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        imports: [HostComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            {provide: MessagingWebsocketService, useValue: fakeWebsocket()},
            // Stubbed rather than provided for real: the store's write-behind would otherwise pull
            // CacheStoreFactory -> CacheSealService -> SecureStore into a spec about signal cycles.
            {
                provide: ConversationCacheService,
                useValue: {
                    recall: async () => [],
                    remember: async () => undefined,
                    forget: async () => undefined,
                },
            },
        ],
    });

    const store = TestBed.inject(ConversationStore);
    store.addConversation(conversation());
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return {fixture, store};
}

describe('conversation read tracking against a live store entity', () => {
    it('settles instead of re-triggering itself through the input', () => {
        const {fixture} = setup();
        const tracker = fixture.debugElement.children[0].componentInstance as ReadTrackingComponent;

        fixture.detectChanges();
        fixture.detectChanges();

        // One run for the first paint, one more for the write that actually changed something.
        expect(tracker.runs()).toBeLessThanOrEqual(2);
    });

    it('still reacts when the conversation is genuinely replaced', () => {
        const {fixture, store} = setup();
        const tracker = fixture.debugElement.children[0].componentInstance as ReadTrackingComponent;
        const before = tracker.runs();

        store.applyEdit('conv_1', 'Renamed', null);
        fixture.detectChanges();

        expect(tracker.runs()).toBeGreaterThan(before);
    });
});
