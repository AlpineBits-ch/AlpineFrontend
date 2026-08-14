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

    it('claims the preview render for a local share with only a previewSrc', () => {
        const {fakes} = setup(share());

        expect(fakes.claimPreviewRender).toHaveBeenCalledTimes(1);
    });

    it('claims nothing for a remote share', () => {
        const {fakes} = setup(share({isLocal: false, userId: 'user-b', previewSrc: null, stream: {} as MediaStream}));

        expect(fakes.claimPreviewRender).not.toHaveBeenCalled();
    });

    it('claims nothing for a local share with a real MediaStream - the browser path, not RustMediaService\'s preview', () => {
        const {fakes} = setup(share({stream: {} as MediaStream}));

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

        const resumeButton = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')]
            .find(b => b.textContent?.includes('CALL.RESUME_PREVIEW')) as HTMLButtonElement;
        resumeButton.click();

        expect(fakes.resumePreview).toHaveBeenCalledTimes(1);
    });

    it('never shows the paused card for a remote share, even if the flag is somehow true', () => {
        const {fixture, fakes} = setup(share({isLocal: false, userId: 'user-b', previewSrc: null, stream: {} as MediaStream}));

        fakes.previewPaused.set(true);
        fixture.detectChanges();

        expect(fixture.nativeElement.textContent).not.toContain('CALL.PREVIEW_PAUSED');
    });

    it('stays on the no-share placeholder rather than a paused card when there is no previewSrc at all', () => {
        const {fixture, fakes} = setup(share({previewSrc: null}));

        fakes.previewPaused.set(true);
        fixture.detectChanges();

        expect(fixture.nativeElement.textContent).not.toContain('CALL.PREVIEW_PAUSED');
        expect(fixture.nativeElement.querySelector('.pi-desktop')).not.toBeNull();
    });
});
