/**
 * Task 12: "let a DM call fill the window" - what full view does to the panel, and what it does not
 * do to the height the user dragged to.
 */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {CallPanelComponent} from './call-panel.component';
import {CallSessionService} from '../../../../../services/call-session.service';
import {CallWebRtcService} from '../../../../../services/call-webrtc.service';
import {RustMediaService} from '../../../../../services/rust-media.service';
import {ApiConfigService} from '../../../../../services/api-config.service';
import {ShareWatchService} from '../../../../../services/share-watch.service';
import {provideFakePlatform} from '../../../../../platform/testing/provide-fake-platform';

/** The handful of `protected` members these tests need to drive directly, the same
 *  cast-through-`unknown` pattern `call-panel-viewer-names.spec.ts` uses for the same reason. */
interface PanelInternals {
    panelHeight: () => number;
    isResizing: () => boolean;
    toggleMaximize(): void;

    onResizeStart(event: MouseEvent): void;

    onMouseMove(event: MouseEvent): void;

    onMouseUp(): void;
}

function internals(component: CallPanelComponent): PanelInternals {
    return component as unknown as PanelInternals;
}

function render(): ComponentFixture<CallPanelComponent> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideTranslateService(),
            // A non-empty roster renders app-avatar for the local participant, which reaches
            // OsInfo - a platform port with no default provider outside app.config.ts - and, through
            // ProfileService, ApiConfigService, whose real constructor reads localStorage directly.
            // See provideFakePlatform's own doc for the class of failure this exists to end.
            provideFakePlatform(),
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test'}},
            // The panel now always routes through app-call-screen-layout, sharing or not - see
            // call-panel.component.html - which injects the real ShareWatchService unless overridden.
            // Its dependency chain runs to GuildWebsocketService/VoiceWebsocketService ->
            // RealtimeConnectionService -> AuthService -> OAuthService, none of which this test's
            // module provides and none of which the resize/full-view behaviour under test touches.
            {
                provide: ShareWatchService,
                useValue: {setWatching: vi.fn(), refresh: vi.fn(), clear: vi.fn(), viewerCount: () => 0, viewersOf: () => []},
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
                                userId: 'me', displayName: 'Me', avatarLabel: 'M', isLocal: true,
                                isMuted: false, isSpeaking: false, isCameraOn: false, videoStream: undefined,
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
                    localPublishStream: () => null,
                    previewPaused: () => false,
                    claimPreviewRender: () => void 0,
                    releasePreviewRender: () => void 0,
                    resumePreview: () => void 0,
                },
            },
        ],
    });

    const fixture = TestBed.createComponent(CallPanelComponent);
    fixture.detectChanges();
    return fixture;
}

/** Drags the handle from the current `panelHeight()` by `deltaY` pixels, exactly as a real
 *  mousedown/mousemove pair would, so the MIN/MAX clamp inside `onMouseMove` is exercised rather
 *  than bypassed. */
function drag(component: CallPanelComponent, deltaY: number): void {
    const c = internals(component);
    c.onResizeStart({clientY: 0, preventDefault: () => {}} as MouseEvent);
    c.onMouseMove({clientY: deltaY} as MouseEvent);
    c.onMouseUp();
}

describe('CallPanelComponent full view', () => {
    let fixture: ComponentFixture<CallPanelComponent>;
    let component: CallPanelComponent;

    beforeEach(() => {
        fixture = render();
        component = fixture.componentInstance;
    });

    it('fills the container and stops applying panelHeight, without changing the dragged height', () => {
        drag(component, 650 - 420); // panelHeight defaults to 420 (DEFAULT_HEIGHT)
        expect(internals(component).panelHeight()).toBe(650);

        internals(component).toggleMaximize();
        fixture.detectChanges();

        expect(component.isFullView()).toBe(true);
        // panelHeight is untouched by entering full view - this is what makes restoring later give
        // back 650 rather than DEFAULT_HEIGHT.
        expect(internals(component).panelHeight()).toBe(650);

        const panel: HTMLElement = fixture.nativeElement.querySelector('.panel');
        expect(panel.classList.contains('panel--full')).toBe(true);
        // Angular removes the style attribute entirely when a [style.height.px] binding is set to
        // null, rather than leaving a stale `height: 650px` fighting the flex-1 rule.
        expect(panel.style.height).toBe('');
    });

    it('restores to the previously dragged height, not DEFAULT_HEIGHT', () => {
        drag(component, 650 - 420);
        internals(component).toggleMaximize(); // enter full view
        fixture.detectChanges();

        internals(component).toggleMaximize(); // restore
        fixture.detectChanges();

        expect(component.isFullView()).toBe(false);
        expect(internals(component).panelHeight()).toBe(650);
        const panel: HTMLElement = fixture.nativeElement.querySelector('.panel');
        expect(panel.classList.contains('panel--full')).toBe(false);
        expect(panel.style.height).toBe('650px');
    });

    it('clamps drags to the 200-900px range in the normal (non-full) state', () => {
        drag(component, 10_000); // way past MAX_HEIGHT
        expect(internals(component).panelHeight()).toBe(900);

        drag(component, -10_000); // way below MIN_HEIGHT
        expect(internals(component).panelHeight()).toBe(200);
    });

    it('does not let a drag start while full view is on, and removes the handle from the DOM', () => {
        internals(component).toggleMaximize(); // enter full view
        fixture.detectChanges();

        internals(component).onResizeStart({clientY: 0, preventDefault: () => {}} as MouseEvent);
        expect(internals(component).isResizing()).toBe(false);

        // The handle is not in the DOM at all while full view is on - there is nothing left to drag
        // against once the panel fills its container, so a live-but-inert handle would be a dead
        // control.
        expect(fixture.nativeElement.querySelector('.resize-handle')).toBeNull();
    });

    it('keeps the maximize/restore button and swaps its label with full view', () => {
        // aria-pressed is unique to the maximize/restore button - the stats toggle next to it and
        // the controls-bar buttons further down don't set it.
        const button: HTMLButtonElement = fixture.nativeElement.querySelector('button[aria-pressed]');
        expect(button.getAttribute('aria-pressed')).toBe('false');
        // No translations are loaded (see render()), so `.instant()` echoes the key back - proof
        // this is CALL.MAXIMIZE specifically, not just any truthy string, without depending on
        // locale content. Requirement 5 was "the button and its two labels stay", not just "the
        // button stays", so both the label and the aria-pressed state need covering.
        expect(button.getAttribute('aria-label')).toBe('CALL.MAXIMIZE');
        expect(button.getAttribute('title')).toBe('CALL.MAXIMIZE');

        internals(component).toggleMaximize();
        fixture.detectChanges();

        expect(button.getAttribute('aria-pressed')).toBe('true');
        expect(button.getAttribute('aria-label')).toBe('CALL.RESTORE');
        expect(button.getAttribute('title')).toBe('CALL.RESTORE');
    });

    it('never carries full view over into a fresh call - a new panel instance always starts collapsed', () => {
        internals(component).toggleMaximize();
        expect(component.isFullView()).toBe(true);

        // The panel only ever exists behind `@if (activeCall())` in ConversationComponent, so a
        // call ending and a new one starting means this component is destroyed and a brand new
        // instance takes its place - never the same instance surviving with stale state. That, plus
        // ConversationComponent deriving its collapse flag from `viewChild(CallPanelComponent)`
        // (which reads `undefined`, not a stale `true`, once this component is gone) is what keeps a
        // finished call from leaving the message list stuck collapsed.
        fixture.destroy();

        const next = render();
        expect(next.componentInstance.isFullView()).toBe(false);
        next.destroy();
    });
});
