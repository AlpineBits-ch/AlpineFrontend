/**
 * Task 12 fix round 1, Important 1: the thing requirement 6 ("a call ending while full-view is on
 * must not leave the message column stuck collapsed") is actually about is
 * `ConversationComponent.isCallFullView = computed(() => this.callPanelRef()?.isFullView() ?? false)`
 * - it has to fall back to `false` the instant `@if (activeCall())` tears `CallPanelComponent` down,
 * because nothing ever resets `isFullView` explicitly.
 */
import {Component, computed, signal, viewChild} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {describe, expect, it, vi} from 'vitest';
import {CallPanelComponent} from './call-panel/call-panel.component';
import {CallSessionService} from '../../../../services/call-session.service';
import {CallWebRtcService} from '../../../../services/call-webrtc.service';
import {RustMediaService} from '../../../../services/rust-media.service';
import {ApiConfigService} from '../../../../services/api-config.service';
import {ShareWatchService} from '../../../../services/share-watch.service';
import {provideFakePlatform} from '../../../../platform/testing/provide-fake-platform';

@Component({
    imports: [CallPanelComponent],
    template: `
        @if (active()) {
            <app-call-panel />
        }
        <!-- The exact binding conversation.component.html uses on the row that holds the message
             column, composer, and MLS banners. -->
        <div [class.hidden]="isCallFullView()" class="row"></div>
    `,
})
class FullViewHostComponent {
    /** Stands in for `ConversationComponent.activeCall()`'s truthiness - toggling this is what
     *  destroys/recreates `app-call-panel` the same way a call ending/starting does there. */
    readonly active = signal(true);
    /** The exact pair from `conversation.component.ts`: `callPanelRef` + `isCallFullView`. Public
     *  here (unlike the `private`/`protected` original) purely so the test can drive them. */
    readonly callPanelRef = viewChild(CallPanelComponent);
    readonly isCallFullView = computed(() => this.callPanelRef()?.isFullView() ?? false);
}

function render(): ComponentFixture<FullViewHostComponent> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideTranslateService(),
            // See call-panel-full-view.spec.ts for why a rendered (non-null-session) call panel
            // needs these: app-avatar reaches OsInfo and, through ProfileService, ApiConfigService.
            provideFakePlatform(),
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test'}},
            // app-call-panel now always routes through app-call-screen-layout, sharing or not - see
            // call-panel.component.html - which injects the real ShareWatchService unless overridden.
            // That service's own dependency chain runs to GuildWebsocketService/VoiceWebsocketService
            // -> RealtimeConnectionService -> AuthService -> OAuthService, none of which this test's
            // module provides, and none of which this behaviour (a viewChild + `?? false` fallback)
            // has anything to do with.
            {
                provide: ShareWatchService,
                useValue: {
                    setWatching: vi.fn(),
                    refresh: vi.fn(),
                    clear: vi.fn(),
                    viewerCount: () => 0,
                    viewersOf: () => [],
                },
            },
            {
                provide: CallSessionService,
                useValue: {
                    session: signal({
                        callId: 'call-1',
                        conversationId: 'conv-1',
                        startedAt: new Date(),
                        local: {isMuted: false, isDeafened: false, isCameraOn: false, isSharing: false},
                        participants: [
                            {
                                userId: 'me',
                                displayName: 'Me',
                                avatarLabel: 'M',
                                isLocal: true,
                                isMuted: false,
                                isSpeaking: false,
                                isCameraOn: false,
                                videoStream: undefined,
                            },
                        ],
                        screenShares: [],
                    }),
                    screenPreset: signal(null),
                    aloneDeadline: signal(null),
                    localScreenHasAudio: signal(false),
                    localScreenAudioMuted: signal(false),
                },
            },
            {
                provide: CallWebRtcService,
                useValue: {
                    stats: signal(null),
                    rtcState: signal('new'),
                    participantsWithAudio: signal(new Set<string>()),
                    inboundVideoFpsByShare: signal({}),
                },
            },
            {
                provide: RustMediaService,
                useValue: {
                    publishPreview: () => null,
                    previewPaused: () => false,
                    claimPreviewRender: () => void 0,
                    releasePreviewRender: () => void 0,
                    resumePreview: () => void 0,
                },
            },
        ],
    });

    const fixture = TestBed.createComponent(FullViewHostComponent);
    fixture.detectChanges();
    return fixture;
}

describe('ConversationComponent full-view collapse fallback (viewChild + computed)', () => {
    it('starts a freshly-active call already un-collapsed', () => {
        const fixture = render();
        expect(fixture.componentInstance.isCallFullView()).toBe(false);
        expect(fixture.nativeElement.querySelector('.row').classList.contains('hidden')).toBe(false);
    });

    it('un-hides the row the instant the panel is torn down, even though isFullView was left true', () => {
        const fixture = render();
        const panel = fixture.componentInstance.callPanelRef();
        if (!panel) throw new Error('app-call-panel did not render');

        panel.isFullView.set(true);
        fixture.detectChanges();

        expect(fixture.componentInstance.isCallFullView()).toBe(true);
        expect(fixture.nativeElement.querySelector('.row').classList.contains('hidden')).toBe(true);

        // The call ends: in the real component, activeCall() goes null and the `@if` around
        // app-call-panel tears it down. Nothing anywhere sets isFullView back to false - this
        // fallback is the only thing standing between that and a permanently-collapsed row.
        fixture.componentInstance.active.set(false);
        fixture.detectChanges();

        expect(fixture.componentInstance.callPanelRef()).toBeUndefined();
        expect(fixture.componentInstance.isCallFullView()).toBe(false);
        expect(fixture.nativeElement.querySelector('.row').classList.contains('hidden')).toBe(false);
    });
});
