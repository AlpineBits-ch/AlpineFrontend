import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal, WritableSignal} from '@angular/core';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {CallScreenLayoutComponent} from './call-screen-layout.component';
import {CallScreenShare} from '../call.types';
import {ShareWatchService, WatchScope} from '../../../services/share-watch.service';
import {RustMediaService} from '../../../services/rust-media.service';

/**
 * Task 10 at the self-card: the small monitor shown when somebody else is also sharing.
 *
 * <p>Two things worth guarding: the self-card has to <b>claim</b> the preview render while - and
 * only while - it is the thing actually showing it, and it has to <b>render the paused card</b>
 * with a resume affordance rather than silently freezing on the last frame.</p>
 */
function share(shareId: string, overrides: Partial<CallScreenShare> = {}): CallScreenShare {
    return {
        shareId,
        userId: shareId === 'mine' ? 'me' : `user-${shareId}`,
        displayName: shareId === 'mine' ? 'You' : shareId,
        isLocal: shareId === 'mine',
        ...overrides,
    };
}

interface Fakes {
    previewPaused: WritableSignal<boolean>;
    claimPreviewRender: ReturnType<typeof vi.fn>;
    releasePreviewRender: ReturnType<typeof vi.fn>;
    resumePreview: ReturnType<typeof vi.fn>;
}

function setup(shares: CallScreenShare[]): {fixture: ComponentFixture<CallScreenLayoutComponent>; fakes: Fakes} {
    const fakes: Fakes = {
        previewPaused: signal(false),
        claimPreviewRender: vi.fn(),
        releasePreviewRender: vi.fn(),
        resumePreview: vi.fn(),
    };

    TestBed.configureTestingModule({
        imports: [CallScreenLayoutComponent, TranslateModule.forRoot()],
        providers: [
            {
                provide: ShareWatchService,
                useValue: {setWatching: vi.fn(), refresh: vi.fn(), clear: vi.fn(), viewerCount: () => 0, viewersOf: () => []},
            },
            {provide: RustMediaService, useValue: fakes},
        ],
    });

    const fixture: ComponentFixture<CallScreenLayoutComponent> = TestBed.createComponent(CallScreenLayoutComponent);
    fixture.componentRef.setInput('screenShares', shares);
    fixture.componentRef.setInput('participants', []);
    fixture.componentRef.setInput('participantsWithAudio', new Set<string>());
    fixture.detectChanges();

    return {fixture, fakes};
}

function selfCardButton(fixture: ComponentFixture<CallScreenLayoutComponent>): HTMLButtonElement {
    return fixture.nativeElement.querySelector('[title="CALL.SHOW_MY_STREAM"], [title="CALL.RESUME_PREVIEW"]') as HTMLButtonElement;
}

describe('CallScreenLayoutComponent preview claim', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        // jsdom implements neither play() nor pause(); a browser-path self-card (a real
        // MediaStream) renders a <video>, and an unhandled "not implemented" would fail the run
        // before the assertion it is standing in the way of.
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        HTMLMediaElement.prototype.pause = vi.fn();
    });

    it('claims the preview render while the self-card is showing it', () => {
        const {fakes} = setup([share('mine', {previewSrc: 'data:image/jpeg;base64,AAAA'}), share('theirs')]);

        expect(fakes.claimPreviewRender).toHaveBeenCalledTimes(1);
    });

    it('does not claim directly while alone - the local share is in the grid tile, not the self-card', () => {
        // Alone, the local share renders through the grid tile instead (see
        // call-share-tile.preview-pause.spec.ts, which owns *that* claim) - selfCard() is null, so
        // the layout's own effect must never fire, whatever the tile does with the same service.
        const {fixture, fakes} = setup([share('mine', {previewSrc: 'data:image/jpeg;base64,AAAA'})]);

        const claimedByLayout = fakes.claimPreviewRender.mock.calls.some(([token]) => token === fixture.componentInstance);
        expect(claimedByLayout).toBe(false);
    });

    it('claims nothing for a browser share - a real MediaStream, not RustMediaService\'s preview', () => {
        const {fakes} = setup([share('mine', {stream: {} as MediaStream}), share('theirs')]);

        expect(fakes.claimPreviewRender).not.toHaveBeenCalled();
    });

    it('releases the claim once the self-card stops showing it', () => {
        const {fixture, fakes} = setup([share('mine', {previewSrc: 'data:image/jpeg;base64,AAAA'}), share('theirs')]);
        expect(fakes.claimPreviewRender).toHaveBeenCalledTimes(1);

        // Nobody else is sharing any more - the local share moves back into the grid and the
        // self-card goes null.
        fixture.componentRef.setInput('screenShares', [share('mine', {previewSrc: 'data:image/jpeg;base64,AAAA'})]);
        fixture.detectChanges();

        expect(fakes.releasePreviewRender).toHaveBeenCalledTimes(1);
    });

    it('releases the claim on destroy', () => {
        const {fixture, fakes} = setup([share('mine', {previewSrc: 'data:image/jpeg;base64,AAAA'}), share('theirs')]);
        expect(fakes.claimPreviewRender).toHaveBeenCalledTimes(1);

        fixture.destroy();

        expect(fakes.releasePreviewRender).toHaveBeenCalledTimes(1);
    });
});

describe('CallScreenLayoutComponent paused preview card', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        HTMLMediaElement.prototype.pause = vi.fn();
    });

    it('shows the live thumbnail as normal while not paused', () => {
        const {fixture} = setup([share('mine', {previewSrc: 'data:image/jpeg;base64,AAAA'}), share('theirs')]);

        expect(fixture.nativeElement.textContent).toContain('CALL.YOU_ARE_LIVE');
        expect(fixture.nativeElement.querySelector('img')).not.toBeNull();
    });

    it('swaps to the paused card once RustMediaService reports paused, without dropping the still-running-stream wording', () => {
        const {fixture, fakes} = setup([share('mine', {previewSrc: 'data:image/jpeg;base64,AAAA'}), share('theirs')]);

        fakes.previewPaused.set(true);
        fixture.detectChanges();

        const text = fixture.nativeElement.textContent as string;
        expect(text).toContain('CALL.PREVIEW_PAUSED');
        expect(text).toContain('CALL.PREVIEW_PAUSED_HINT');
        expect(text).not.toContain('CALL.YOU_ARE_LIVE');
        expect(fixture.nativeElement.querySelector('img')).toBeNull();
    });

    it('never shows the paused card when nothing is being shared, even if the flag is somehow true', () => {
        // The self-card itself does not render at all without a local share - this pins that a
        // stray previewPaused=true cannot conjure one up.
        const {fixture, fakes} = setup([]);

        fakes.previewPaused.set(true);
        fixture.detectChanges();

        expect(fixture.nativeElement.textContent).not.toContain('CALL.PREVIEW_PAUSED');
    });

    it('resumes on click, rather than maximising, while paused', () => {
        const {fixture, fakes} = setup([share('mine', {previewSrc: 'data:image/jpeg;base64,AAAA'}), share('theirs')]);
        fakes.previewPaused.set(true);
        fixture.detectChanges();

        selfCardButton(fixture).click();

        expect(fakes.resumePreview).toHaveBeenCalledTimes(1);
        // maximizedId is a protected signal - reaching into it the same way the sibling specs in
        // this directory do, to prove the click did not also promote the self-card into the grid.
        expect((fixture.componentInstance as unknown as {maximizedId: () => string | null}).maximizedId()).toBeNull();
    });

    it('maximises on click as before while not paused', () => {
        const {fixture} = setup([share('mine', {previewSrc: 'data:image/jpeg;base64,AAAA'}), share('theirs')]);

        selfCardButton(fixture).click();

        expect((fixture.componentInstance as unknown as {maximizedId: () => string | null}).maximizedId()).toBe('mine');
    });
});
