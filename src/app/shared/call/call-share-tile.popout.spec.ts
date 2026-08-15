import {ComponentFixture, TestBed} from '@angular/core/testing';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {CallShareTileComponent} from './call-share-tile/call-share-tile.component';
import {CallScreenShare} from './call.types';
import {RustMediaService} from '../../services/rust-media.service';

const MARKER = '.pop-out-marker{color:rgb(1,2,3)}';

function share(overrides: Partial<CallScreenShare> = {}): CallScreenShare {
    return {
        shareId: 'a',
        userId: 'user-a',
        displayName: 'A',
        isLocal: true,
        ...overrides,
    };
}

/**
 * A stand-in for the window `documentPictureInPicture.requestWindow()` hands back.
 *
 * <p>Its `document` is a real one, from `createHTMLDocument`, so the element move under test is a
 * genuine cross-document adoption rather than a spy recording that a method was called: after the
 * move the element is really a child of another document's body, and after the restore it is really
 * back in this one. Closing fires `pagehide` because that is what a browser does when a pop-out goes
 * away, and it is the only path the component has back.</p>
 */
function fakePipWindow() {
    const pipDocument = document.implementation.createHTMLDocument('pop-out');
    const onPagehide: Array<() => void> = [];
    let closed = false;

    return {
        document: pipDocument,
        addEventListener(type: string, listener: () => void): void {
            if (type === 'pagehide') onPagehide.push(listener);
        },
        close: vi.fn(() => {
            if (closed) return;
            closed = true;
            onPagehide.splice(0).forEach(listener => listener());
        }),
        /** Closing from the OS chrome rather than from the app: same event, no `close()` call. */
        dismiss(): void {
            closed = true;
            onPagehide.splice(0).forEach(listener => listener());
        },
    };
}

type FakePipWindow = ReturnType<typeof fakePipWindow>;

/** Installs a document-PiP capability that hands out `pip`, and no video PiP at all. */
function installDocumentPip(pip: FakePipWindow): {requestWindow: ReturnType<typeof vi.fn>} {
    const requestWindow = vi.fn(() => Promise.resolve(pip as unknown as Window));
    Object.defineProperty(window, 'documentPictureInPicture', {value: {requestWindow}, configurable: true});
    Object.defineProperty(document, 'pictureInPictureEnabled', {value: false, configurable: true});
    return {requestWindow};
}

function setup(s: CallScreenShare): ComponentFixture<CallShareTileComponent> {
    TestBed.configureTestingModule({
        imports: [CallShareTileComponent, TranslateModule.forRoot()],
        // The tile injects RustMediaService to claim "somebody is rendering the preview" for the
        // idle pause. Stubbed rather than provided for real: the real one reaches for ScreenPublisher,
        // and none of the pop-out behaviour under test here depends on preview frames.
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

/** The host is `display: contents`, so its first rendered child is the tile root. */
function tileRoot(fixture: ComponentFixture<CallShareTileComponent>): HTMLElement {
    return (fixture.nativeElement as HTMLElement).firstElementChild as HTMLElement;
}

/**
 * The pan/zoom surface, which the template renders as the tile root's first child - ahead of every
 * overlay, which is exactly the placement the restore has to reproduce.
 */
function surface(fixture: ComponentFixture<CallShareTileComponent>): HTMLElement {
    return tileRoot(fixture).firstElementChild as HTMLElement;
}

/** Presses the PiP control the way a user does, through the real DOM button. */
async function pressPip(fixture: ComponentFixture<CallShareTileComponent>): Promise<void> {
    const button = (fixture.nativeElement as HTMLElement)
        .querySelector<HTMLButtonElement>('app-call-tile-action[icon="pi-external-link"] button');
    expect(button, 'the pop-out control should be rendered').not.toBeNull();
    button!.click();
    await fixture.whenStable();
    fixture.detectChanges();
}

describe('CallShareTileComponent pop-out', () => {
    let markerStyle: HTMLStyleElement;

    beforeEach(() => {
        TestBed.resetTestingModule();
        // index.html puts the theme class on <body> and the harness does not, so without this the
        // "the class was carried over" assertion would compare '' to '' and survive deleting the
        // line it exists to guard.
        document.body.className = 'dark';
        // jsdom implements neither play() nor pause(); an unhandled "not implemented" would fail the
        // run before the assertion it is standing in the way of.
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        HTMLMediaElement.prototype.pause = vi.fn();

        // A stylesheet with a rule nothing else could have written, so "styles were copied" is an
        // assertion about this page's actual CSS reaching the pop-out and not about a count.
        markerStyle = document.createElement('style');
        markerStyle.textContent = MARKER;
        document.head.append(markerStyle);
    });

    afterEach(() => {
        markerStyle.remove();
        document.body.className = '';
        delete (document as {pictureInPictureEnabled?: unknown}).pictureInPictureEnabled;
        delete (window as {documentPictureInPicture?: unknown}).documentPictureInPicture;
    });

    it('moves the picture into the pop-out window and brings it back on pagehide', async () => {
        const pip = fakePipWindow();
        installDocumentPip(pip);
        const fixture = setup(share({stream: {} as MediaStream}));
        const picture = surface(fixture);
        const root = tileRoot(fixture);

        await pressPip(fixture);

        // The one assertion this whole capability combination exists for: video PiP is off, so the
        // press had to take the document route, and the press did something.
        expect(picture.parentElement).toBe(pip.document.body);
        expect(root.contains(picture)).toBe(false);

        pip.dismiss();
        fixture.detectChanges();

        expect(picture.parentElement).toBe(root);
    });

    it('returns the picture to its original position, not merely to its original parent', async () => {
        const pip = fakePipWindow();
        installDocumentPip(pip);
        const fixture = setup(share({stream: {} as MediaStream}));
        const picture = surface(fixture);
        const root = tileRoot(fixture);
        const overlaysBefore = Array.from(root.children).slice(1);

        await pressPip(fixture);
        pip.dismiss();
        fixture.detectChanges();

        // Appending would also satisfy "back in the right parent" while putting the picture on top
        // of the LIVE badge, the name pill and every hover control.
        expect(root.firstElementChild).toBe(picture);
        expect(Array.from(root.children).slice(1)).toEqual(overlaysBefore);
    });

    it('leaves the tile chrome behind, including the control that brings the picture back', async () => {
        const pip = fakePipWindow();
        installDocumentPip(pip);
        const fixture = setup(share({stream: {} as MediaStream}));
        const root = tileRoot(fixture);

        await pressPip(fixture);

        expect(root.querySelector('app-call-live-badge')).not.toBeNull();
        expect(root.querySelector('app-call-tile-action[icon="pi-external-link"]')).not.toBeNull();
        expect(pip.document.body.querySelector('app-call-tile-action')).toBeNull();
    });

    it('gives the pop-out document the page styles and the call background', async () => {
        const pip = fakePipWindow();
        installDocumentPip(pip);
        const fixture = setup(share({stream: {} as MediaStream}));

        await pressPip(fixture);

        const copied = Array.from(pip.document.head.querySelectorAll('style'))
            .map(style => style.textContent ?? '')
            .join('\n');
        expect(copied).toContain('.pop-out-marker');
        expect(pip.document.body.style.background).toBe('var(--color-stage)');
        expect(pip.document.body.style.margin).toBe('0px');
        // The dark tokens hang off a class on <body>; without it the pop-out renders light-theme.
        expect(pip.document.body.className).toBe('dark');
    });

    it('asks for a window the size of the tile', async () => {
        const pip = fakePipWindow();
        const {requestWindow} = installDocumentPip(pip);
        const fixture = setup(share({stream: {} as MediaStream}));
        // jsdom lays nothing out, so every box is 0x0 until one is stated.
        surface(fixture).getBoundingClientRect = () => ({width: 800, height: 450}) as DOMRect;

        await pressPip(fixture);

        expect(requestWindow).toHaveBeenCalledWith({width: 800, height: 450});
    });

    it('falls back to a 16:9 default when the tile has no measurable box', async () => {
        const pip = fakePipWindow();
        const {requestWindow} = installDocumentPip(pip);
        const fixture = setup(share({stream: {} as MediaStream}));

        await pressPip(fixture);

        expect(requestWindow).toHaveBeenCalledWith({width: 960, height: 540});
    });

    it('closes the pop-out on a second press, which is what restores the picture', async () => {
        const pip = fakePipWindow();
        const {requestWindow} = installDocumentPip(pip);
        const fixture = setup(share({stream: {} as MediaStream}));
        const picture = surface(fixture);
        const root = tileRoot(fixture);

        await pressPip(fixture);
        await pressPip(fixture);

        expect(pip.close).toHaveBeenCalledTimes(1);
        expect(requestWindow).toHaveBeenCalledTimes(1);
        expect(picture.parentElement).toBe(root);
    });

    it('takes the picture back and closes the window when the tile is destroyed', async () => {
        const pip = fakePipWindow();
        installDocumentPip(pip);
        const fixture = setup(share({stream: {} as MediaStream}));
        const picture = surface(fixture);
        const root = tileRoot(fixture);

        await pressPip(fixture);
        fixture.destroy();

        // Hanging up mid-pop-out must not strand the element in a window nothing owns any more.
        expect(picture.parentElement).toBe(root);
        expect(pip.close).toHaveBeenCalledTimes(1);
    });

    it('pops out a preview-only local share, which has no stream to give a video element', async () => {
        const pip = fakePipWindow();
        installDocumentPip(pip);
        const fixture = setup(share({previewSrc: 'data:image/png;base64,xx'}));
        const picture = surface(fixture);

        await pressPip(fixture);

        expect(picture.parentElement).toBe(pip.document.body);
        expect(pip.document.body.querySelector('img')).not.toBeNull();
    });

    it('keeps the control while the pop-out is open, even after the share loses its picture', async () => {
        // A share can go contentless mid-call - the publisher stops, the preview stops arriving -
        // and the gate would otherwise withdraw the route from under an open window, leaving the
        // picture in an OS window the app offers no way to close and an empty tile behind it.
        const pip = fakePipWindow();
        installDocumentPip(pip);
        const fixture = setup(share({stream: {} as MediaStream}));
        const picture = surface(fixture);
        const root = tileRoot(fixture);

        await pressPip(fixture);
        fixture.componentRef.setInput('share', share({stream: undefined, previewSrc: null}));
        fixture.detectChanges();

        expect((fixture.nativeElement as HTMLElement)
            .querySelector('app-call-tile-action[icon="pi-external-link"]')).not.toBeNull();

        // The half that matters: still rendered is worth nothing if pressing it no longer works.
        await pressPip(fixture);

        expect(pip.close).toHaveBeenCalledTimes(1);
        expect(picture.parentElement).toBe(root);
    });

    it('leaves the picture alone when the request is refused', async () => {
        const requestWindow = vi.fn(() => Promise.reject(new Error('denied')));
        Object.defineProperty(window, 'documentPictureInPicture', {value: {requestWindow}, configurable: true});
        Object.defineProperty(document, 'pictureInPictureEnabled', {value: false, configurable: true});
        const fixture = setup(share({stream: {} as MediaStream}));
        const picture = surface(fixture);
        const root = tileRoot(fixture);

        await pressPip(fixture);

        expect(picture.parentElement).toBe(root);
    });
});

describe('CallShareTileComponent PiP route selection', () => {
    let requestPictureInPicture: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        TestBed.resetTestingModule();
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        HTMLMediaElement.prototype.pause = vi.fn();
        // jsdom has no video PiP at all, so this is the whole implementation for the fallback route.
        requestPictureInPicture = vi.fn(() => Promise.resolve({} as PictureInPictureWindow));
        Object.defineProperty(HTMLVideoElement.prototype, 'requestPictureInPicture', {
            value: requestPictureInPicture,
            configurable: true,
        });
    });

    afterEach(() => {
        delete (document as {pictureInPictureEnabled?: unknown}).pictureInPictureEnabled;
        delete (window as {documentPictureInPicture?: unknown}).documentPictureInPicture;
        delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestPictureInPicture;
    });

    it('uses video PiP when document PiP is unavailable', async () => {
        Object.defineProperty(document, 'pictureInPictureEnabled', {value: true, configurable: true});
        const fixture = setup(share({stream: {} as MediaStream}));
        const picture = surface(fixture);
        const root = tileRoot(fixture);

        await pressPip(fixture);

        expect(requestPictureInPicture).toHaveBeenCalledTimes(1);
        // Video PiP hands the element to the browser's overlay; it stays in the document.
        expect(picture.parentElement).toBe(root);
    });

    it('prefers document PiP when both are available', async () => {
        const pip = fakePipWindow();
        const requestWindow = vi.fn(() => Promise.resolve(pip as unknown as Window));
        Object.defineProperty(window, 'documentPictureInPicture', {value: {requestWindow}, configurable: true});
        Object.defineProperty(document, 'pictureInPictureEnabled', {value: true, configurable: true});
        const fixture = setup(share({stream: {} as MediaStream}));

        await pressPip(fixture);

        // Document PiP is a real OS window; video PiP is a small always-on-top overlay. Given the
        // choice, the pop-out is the one this task set out to add.
        expect(requestWindow).toHaveBeenCalledTimes(1);
        expect(requestPictureInPicture).not.toHaveBeenCalled();
    });

    it('does not maximise the tile behind it when the popped-out picture is clicked', async () => {
        // The picture carries its click handler into the pop-out window with it (see
        // call-share-tile.click.spec.ts). Left ungated, clicking the window you deliberately moved
        // the stream out of would rearrange the stage behind it - and maximise a tile that is empty,
        // because its picture is over here.
        const pip = fakePipWindow();
        installDocumentPip(pip);
        const fixture = setup(share({stream: {} as MediaStream}));
        const picture = surface(fixture);
        const maximize = vi.fn();
        fixture.componentInstance.maximizeToggle.subscribe(maximize);

        await pressPip(fixture);
        picture.dispatchEvent(new MouseEvent('click', {bubbles: true}));

        expect(maximize).not.toHaveBeenCalled();
    });

    it('takes the click back once the picture is back in the tile', async () => {
        const pip = fakePipWindow();
        installDocumentPip(pip);
        const fixture = setup(share({stream: {} as MediaStream}));
        const picture = surface(fixture);
        const maximize = vi.fn();
        fixture.componentInstance.maximizeToggle.subscribe(maximize);

        await pressPip(fixture);
        pip.dismiss();
        fixture.detectChanges();
        picture.dispatchEvent(new MouseEvent('click', {bubbles: true}));

        expect(maximize).toHaveBeenCalledTimes(1);
    });

    it('does not treat a documentPictureInPicture without requestWindow as a capability', async () => {
        // A property that looks present and throws on the only call anybody makes of it is the dead
        // button one level down from the one the gate already prevents.
        Object.defineProperty(window, 'documentPictureInPicture', {value: {}, configurable: true});
        Object.defineProperty(document, 'pictureInPictureEnabled', {value: true, configurable: true});
        const fixture = setup(share({stream: {} as MediaStream}));

        await pressPip(fixture);

        expect(requestPictureInPicture).toHaveBeenCalledTimes(1);
    });
});
