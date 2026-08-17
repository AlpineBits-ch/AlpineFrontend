import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal, WritableSignal} from '@angular/core';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {CallShareTileComponent} from './call-share-tile/call-share-tile.component';
import {CallScreenShare} from './call.types';
import {RustMediaService} from '../../services/rust-media.service';

/**
 * Task 10 at the share tile: the full-size tile local sharing falls back to when nobody else is
 * sharing (see `CallScreenLayoutComponent.displayedShares` - the self-card only exists once
 * somebody else is also sharing, and this tile is what shows the local preview the rest of the
 * time).
 */
function share(overrides: Partial<CallScreenShare> = {}): CallScreenShare {
    return {
        shareId: 'a',
        userId: 'user-a',
        displayName: 'A',
        isLocal: true,
        previewSrc: 'data:image/jpeg;base64,AAAA',
        // The local publish render, in its fallback representation: a host that cannot decode the
        // stream shows the thumbnail. `localRender` is what the pause keys off in either form -
        // see `CallScreenShare.localRender` - so it travels with the fixture, not with previewSrc.
        localRender: true,
        ...overrides,
    };
}

interface Fakes {
    previewPaused: WritableSignal<boolean>;
    claimPreviewRender: ReturnType<typeof vi.fn>;
    releasePreviewRender: ReturnType<typeof vi.fn>;
    resumePreview: ReturnType<typeof vi.fn>;
}

function setup(s: CallScreenShare): {fixture: ComponentFixture<CallShareTileComponent>; fakes: Fakes} {
    const fakes: Fakes = {
        previewPaused: signal(false),
        claimPreviewRender: vi.fn(),
        releasePreviewRender: vi.fn(),
        resumePreview: vi.fn(),
    };

    TestBed.configureTestingModule({
        imports: [CallShareTileComponent, TranslateModule.forRoot()],
        providers: [{provide: RustMediaService, useValue: fakes}],
    });

    const fixture = TestBed.createComponent(CallShareTileComponent);
    fixture.componentRef.setInput('share', s);
    fixture.detectChanges();
    return {fixture, fakes};
}

describe('CallShareTileComponent preview claim', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        HTMLMediaElement.prototype.pause = vi.fn();
    });

    it('claims the preview render for a local share showing the thumbnail fallback', () => {
        const {fakes} = setup(share());

        expect(fakes.claimPreviewRender).toHaveBeenCalledTimes(1);
    });

    /**
     * The case the claim used to miss. Once the local tile started decoding the publish, its
     * picture arrives as a `MediaStream` - and a claim gated on `previewSrc` would have gone quiet
     * exactly where the render became the most expensive thing on the stage, letting the idle pause
     * fire on a decoder the user is watching.
     */
    it('claims the preview render for a local share showing the decoded publish', () => {
        const {fakes} = setup(share({stream: {} as MediaStream, previewSrc: null}));

        expect(fakes.claimPreviewRender).toHaveBeenCalledTimes(1);
    });

    it('claims nothing for a remote share', () => {
        const {fakes} = setup(
            share({
                isLocal: false,
                userId: 'user-b',
                previewSrc: null,
                localRender: false,
                stream: {} as MediaStream,
            }),
        );

        expect(fakes.claimPreviewRender).not.toHaveBeenCalled();
    });

    it("claims nothing for a local share with a real MediaStream - the browser path, not RustMediaService's preview", () => {
        // A browser publish keeps its own `getDisplayMedia` track in the webview. Nothing there is
        // rendered on the service's behalf, so the projection marks `localRender` false and there
        // is nothing for the pause to apply to - which is what separates it from the decoded
        // publish above, where the stream is equally real and the claim is equally required.
        const {fakes} = setup(share({stream: {} as MediaStream, previewSrc: null, localRender: false}));

        expect(fakes.claimPreviewRender).not.toHaveBeenCalled();
    });

    it('releases the claim on destroy', () => {
        const {fixture, fakes} = setup(share());
        expect(fakes.claimPreviewRender).toHaveBeenCalledTimes(1);

        fixture.destroy();

        expect(fakes.releasePreviewRender).toHaveBeenCalledTimes(1);
    });
});

describe('CallShareTileComponent paused preview card', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        HTMLMediaElement.prototype.pause = vi.fn();
    });

    it('renders the live thumbnail as normal while not paused', () => {
        const {fixture} = setup(share());

        expect(fixture.nativeElement.querySelector('img')).not.toBeNull();
        expect(fixture.nativeElement.textContent).not.toContain('CALL.PREVIEW_PAUSED');
    });

    it('swaps to a paused card that says the stream is still running, with a resume button', () => {
        const {fixture, fakes} = setup(share());

        fakes.previewPaused.set(true);
        fixture.detectChanges();

        const text = fixture.nativeElement.textContent as string;
        expect(text).toContain('CALL.PREVIEW_PAUSED');
        expect(text).toContain('CALL.PREVIEW_PAUSED_HINT');
        expect(text).toContain('CALL.RESUME_PREVIEW');
        expect(fixture.nativeElement.querySelector('img')).toBeNull();
    });

    it('resumes on clicking the resume button', () => {
        const {fixture, fakes} = setup(share());
        fakes.previewPaused.set(true);
        fixture.detectChanges();

        const resumeButton = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find(b =>
            b.textContent?.includes('CALL.RESUME_PREVIEW'),
        ) as HTMLButtonElement;
        resumeButton.click();

        expect(fakes.resumePreview).toHaveBeenCalledTimes(1);
    });

    /**
     * The ordering the template states explicitly. Once the local tile decodes the publish, its
     * picture is a `MediaStream` - and a stream-first branch order would leave a frozen canvas on
     * screen with nothing to say why, which is the state the paused card exists to explain.
     */
    it('shows the paused card in place of the decoded publish, not behind it', () => {
        const {fixture, fakes} = setup(share({stream: {} as MediaStream, previewSrc: null}));

        fakes.previewPaused.set(true);
        fixture.detectChanges();

        expect(fixture.nativeElement.textContent).toContain('CALL.PREVIEW_PAUSED');
        expect(fixture.nativeElement.querySelector('video')).toBeNull();
    });

    it('never shows the paused card for a remote share, even if the flag is somehow true', () => {
        const {fixture, fakes} = setup(
            share({
                isLocal: false,
                userId: 'user-b',
                previewSrc: null,
                localRender: false,
                stream: {} as MediaStream,
            }),
        );

        fakes.previewPaused.set(true);
        fixture.detectChanges();

        expect(fixture.nativeElement.textContent).not.toContain('CALL.PREVIEW_PAUSED');
    });

    it('stays on the no-share placeholder rather than a paused card when there is no previewSrc at all', () => {
        const {fixture, fakes} = setup(share({previewSrc: null, localRender: false}));

        fakes.previewPaused.set(true);
        fixture.detectChanges();

        expect(fixture.nativeElement.textContent).not.toContain('CALL.PREVIEW_PAUSED');
        expect(fixture.nativeElement.querySelector('.pi-desktop')).not.toBeNull();
    });
});
