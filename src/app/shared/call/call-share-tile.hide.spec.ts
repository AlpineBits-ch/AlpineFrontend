import {ComponentFixture, TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {CallShareTileComponent} from './call-share-tile/call-share-tile.component';
import {CallScreenShare} from './call.types';
import {RustMediaService} from '../../services/rust-media.service';

function share(overrides: Partial<CallScreenShare> = {}): CallScreenShare {
    return {
        shareId: 'a',
        userId: 'user-a',
        displayName: 'A',
        isLocal: false,
        ...overrides,
    };
}

function setup(s: CallScreenShare): ComponentFixture<CallShareTileComponent> {
    TestBed.configureTestingModule({
        imports: [CallShareTileComponent, TranslateModule.forRoot()],
        providers: [
            {
                provide: RustMediaService,
                useValue: {
                    previewPaused: () => false,
                    claimPreviewRender: vi.fn(),
                    releasePreviewRender: vi.fn(),
                    resumePreview: vi.fn(),
                },
            },
        ],
    });

    const fixture = TestBed.createComponent(CallShareTileComponent);
    fixture.componentRef.setInput('share', s);
    fixture.detectChanges();
    return fixture;
}

function hideButton(fixture: ComponentFixture<CallShareTileComponent>): Element | null {
    return (fixture.nativeElement as HTMLElement).querySelector('[aria-label="CALL.STOP_WATCHING"]');
}

describe('CallShareTileComponent hide control', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        HTMLMediaElement.prototype.pause = vi.fn();
    });

    it('offers the hide control for a remote share', () => {
        const fixture = setup(share());

        expect(hideButton(fixture)).not.toBeNull();
    });

    it('never offers the hide control for the local share', () => {
        // The watch claim never counted the local share to begin with (the layout's effect filters
        // !isLocal before calling setWatching), so "stop watching" would only mean hiding your own
        // output - not a stream anyone was asked to drop.
        const fixture = setup(share({isLocal: true}));

        expect(hideButton(fixture)).toBeNull();
    });

    it('emits hide on click, and does not also toggle maximise', () => {
        const fixture = setup(share());
        const hideEmitted = vi.fn();
        const maximizeEmitted = vi.fn();
        fixture.componentInstance.hide.subscribe(hideEmitted);
        fixture.componentInstance.maximizeToggle.subscribe(maximizeEmitted);

        (hideButton(fixture) as HTMLElement).click();

        expect(hideEmitted).toHaveBeenCalledTimes(1);
        expect(maximizeEmitted).not.toHaveBeenCalled();
    });
});
