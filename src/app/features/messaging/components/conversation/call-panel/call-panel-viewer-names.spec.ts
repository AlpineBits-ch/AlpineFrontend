/**
 * `resolveParticipantName` is what `CallScreenLayoutComponent`'s viewer-count popover uses to turn
 * a watching user id into a display name (see `CallScreenLayoutComponent.nameOf`). A viewer whose
 * join has not reached this client yet has no roster entry to resolve against - the question this
 * covers is what that miss shows, since a raw internal user id has no business in a user-facing
 * popover.
 */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {provideTranslateService} from '@ngx-translate/core';
import {describe, expect, it} from 'vitest';
import {CallPanelComponent} from './call-panel.component';
import {CallSessionService} from '../../../../../services/call-session.service';
import {CallWebRtcService} from '../../../../../services/call-webrtc.service';
import {RustMediaService} from '../../../../../services/rust-media.service';

function render(): ComponentFixture<CallPanelComponent> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            // No translations loaded - `.instant()` on a missing key returns the key itself, which
            // is exactly what this suite needs to tell "translated placeholder" apart from "raw id".
            provideTranslateService(),
            {
                provide: CallSessionService,
                useValue: {
                    // Null session: the panel's whole template sits behind `@if (session())`, so
                    // nothing here needs to render for a method call on the component instance.
                    session: signal(null),
                    screenPreset: signal(null),
                    aloneDeadline: signal(null),
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

describe('CallPanelComponent viewer name resolution', () => {
    it('resolves a known participant to their display name', () => {
        const fixture = render();
        (TestBed.inject(CallSessionService) as unknown as {session: ReturnType<typeof signal>}).session.set({
            callId: 'call-1',
            startedAt: new Date().toISOString(),
            local: {isMuted: false, isDeafened: false, isCameraOn: false, isSharing: false},
            participants: [{userId: 'user-a', displayName: 'Alice', isLocal: false}],
            screenShares: [],
        });

        const resolve = (
            fixture.componentInstance as unknown as {resolveParticipantName: (id: string) => string}
        ).resolveParticipantName;

        expect(resolve('user-a')).toBe('Alice');
    });

    it('falls back to a translated placeholder, never the raw user id, for an unresolved viewer', () => {
        const fixture = render();

        const resolve = (
            fixture.componentInstance as unknown as {resolveParticipantName: (id: string) => string}
        ).resolveParticipantName;

        // No translations are loaded, so `.instant()` echoes the key back - proof this is the
        // translated placeholder path, not the raw id, without depending on locale content.
        expect(resolve('someone-not-in-the-call')).toBe('CALL.UNKNOWN_VIEWER');
        expect(resolve('someone-not-in-the-call')).not.toBe('someone-not-in-the-call');
    });
});
