import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';

import {OAuthService} from 'angular-oauth2-oidc';

import {MessageService} from 'primeng/api';
import {provideTranslateService} from '@ngx-translate/core';
import {of, Subject} from 'rxjs';

import {provideFakePlatform} from '../../../../../platform/testing/provide-fake-platform';
import {ComposerComponent} from './composer.component';
import {ApiConfigService} from '../../../../../services/api-config.service';
import {NotificationService} from '../../../../../services/notification.service';
import {SocialKeyGateService} from '../../../../../services/social-key-gate.service';
import {AttachmentDto, FileService} from '../../../../../services/file.service';
import {PersonaService} from '../../../../../services/persona.service';
import {DraftApi} from '../../../../../services/draft-api.service';
import {PersonaApi} from '../../../../../services/persona-api.service';

/** The composer only ever asks the gate two things, so the double only answers two. */
function gateStub(satisfied: boolean) {
    let release: ((allowed: boolean) => void) | null = null;
    return {
        isSatisfied: vi.fn(() => satisfied),
        require: vi.fn(
            () =>
                new Promise<boolean>(resolve => {
                    release = resolve;
                }),
        ),
        /** Completes the pending require(), as the key-setup dialog would. */
        settle(allowed: boolean) {
            satisfied = allowed;
            release?.(allowed);
        },
    };
}

/** Hands out one subject per upload, so a test decides when - and whether - each one lands. */
function fileServiceStub() {
    const uploads: Subject<AttachmentDto>[] = [];
    return {
        uploads,
        uploadFile: vi.fn(() => {
            const subject = new Subject<AttachmentDto>();
            uploads.push(subject);
            return subject;
        }),
    };
}

describe('ComposerComponent', () => {
    let component: ComposerComponent;
    let fixture: ComponentFixture<ComposerComponent>;
    let gate: ReturnType<typeof gateStub>;
    let files: ReturnType<typeof fileServiceStub>;

    async function setup(satisfied = true) {
        gate = gateStub(satisfied);
        files = fileServiceStub();
        await TestBed.configureTestingModule({
            imports: [ComposerComponent],
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                // BotCommandService -> GuildWebsocketService -> MlsService -> MlsEngine. The composer
                // never encrypts anything here, so inert fakes for every port are all this needs.
                provideFakePlatform(),
                {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
                // Reached transitively: the composer injects BotCommandService and
                // GuildWebsocketService, whose chain ends at AuthService -> OAuthService.
                // The composer never calls it, so a bare stub is enough.
                {
                    provide: OAuthService,
                    useValue: {getAccessToken: () => null, refreshToken: vi.fn(), logOut: vi.fn()},
                },
                // Real NotificationService calls Tauri APIs (platform(), focus sync via
                // UserSettingsService) from its constructor, which reject under jsdom.
                {provide: NotificationService, useValue: {createNotification: vi.fn()}},
                {provide: SocialKeyGateService, useValue: gate},
                {provide: FileService, useValue: files},
                // Reached the moment a channelId is set: the composer asks what the server holds.
                {
                    provide: DraftApi,
                    useValue: {
                        list: () => of([]),
                        get: () => of(null),
                        save: () => of(null),
                        discard: () => of(undefined),
                    },
                },
                // The switcher loads the cast as soon as personas are switched on. Empty is fine:
                // these tests drive the selection directly rather than through the menu.
                {
                    provide: PersonaApi,
                    useValue: {listOwn: () => of([]), listGuild: () => of([]), getAutoproxy: () => of(null)},
                },
                // ToastService -> MessageService; the composer reports a failed upload through it.
                MessageService,
                provideTranslateService({defaultLanguage: 'en'}),
            ],
        }).compileComponents();

        fixture = TestBed.createComponent(ComposerComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();
    }

    /** Writes into the contenteditable the way a user would, then sends. */
    function type(text: string): HTMLElement {
        const editor = fixture.nativeElement.querySelector('[contenteditable]') as HTMLElement;
        editor.textContent = text;
        return editor;
    }

    beforeEach(() => setup());

    it('should create', () => {
        expect(component).toBeTruthy();
    });

    it('sends without consulting the dialog when a master key exists', () => {
        const sent = vi.fn();
        component.message.subscribe(sent);
        type('hello');

        component.send();

        expect(sent).toHaveBeenCalledOnce();
        expect(gate.require).not.toHaveBeenCalled();
    });

    /**
     * The bug these cover: attachments go out as ids, an upload still in flight has no id, and the
     * send path quietly took only the ones that did - so hitting Enter a second too early posted
     * the message with some of its files missing and no sign anything had been dropped.
     */
    describe('with an attachment still uploading', () => {
        /** Queues a file for upload without going through the hidden file input. */
        function attach(name = 'clip.wav'): void {
            component['attachments'].attach(new File(['bytes'], name));
        }

        function completeUpload(index: number, id: string): void {
            files.uploads[index].next({id} as AttachmentDto);
            files.uploads[index].complete();
        }

        it('holds the send until the upload lands, then sends with the attachment', async () => {
            const sent = vi.fn();
            component.message.subscribe(sent);
            type('look at this');
            attach();

            component.send();
            expect(sent).not.toHaveBeenCalled();

            completeUpload(0, 'atac_1');
            await Promise.resolve();

            expect(sent).toHaveBeenCalledOnce();
            expect(sent.mock.calls[0][0].attachments).toEqual(['atac_1']);
        });

        /** Two Enters must not become two messages once the wait is over. */
        it('sends once however many times Enter is pressed while waiting', async () => {
            const sent = vi.fn();
            component.message.subscribe(sent);
            type('look at this');
            attach();

            component.send();
            component.send();
            component.send();
            completeUpload(0, 'atac_1');
            await Promise.resolve();

            expect(sent).toHaveBeenCalledOnce();
        });

        /** A second file attached during the wait is part of the message too. */
        it('waits for an upload started after Enter was pressed', async () => {
            const sent = vi.fn();
            component.message.subscribe(sent);
            type('look at these');
            attach('one.wav');

            component.send();
            attach('two.wav');
            completeUpload(0, 'atac_1');
            await Promise.resolve();

            expect(sent).not.toHaveBeenCalled();

            completeUpload(1, 'atac_2');
            await Promise.resolve();

            expect(sent).toHaveBeenCalledOnce();
            expect(sent.mock.calls[0][0].attachments).toEqual(['atac_1', 'atac_2']);
        });

        /**
         * A failed upload settles the wait but has no id, so sending would drop it silently - the
         * same bug in slower motion. The message is kept so the failed chip can be removed first.
         */
        it('refuses to send when an upload failed, and keeps what was typed', async () => {
            const sent = vi.fn();
            component.message.subscribe(sent);
            const editor = type('look at this');
            attach();

            component.send();
            files.uploads[0].error(new Error('nope'));
            await Promise.resolve();

            expect(sent).not.toHaveBeenCalled();
            expect(editor.textContent).toBe('look at this');
        });
    });

    describe('with no master key', () => {
        beforeEach(async () => {
            TestBed.resetTestingModule();
            await setup(false);
        });

        /**
         * The reason the gate sits at the very top of send(): everything below it clears the
         * editor. Losing what you typed as the price of saying "not now" would make declining
         * expensive, and the whole premise of deferring key setup is that it is free.
         */
        it('emits nothing and keeps the typed message when the prompt is declined', async () => {
            const sent = vi.fn();
            component.message.subscribe(sent);
            const editor = type('a message worth keeping');

            component.send();
            gate.settle(false);
            await Promise.resolve();

            expect(sent).not.toHaveBeenCalled();
            expect(editor.textContent).toBe('a message worth keeping');
        });

        it('sends the still-typed message once setup completes', async () => {
            const sent = vi.fn();
            component.message.subscribe(sent);
            type('a message worth keeping');

            component.send();
            gate.settle(true);
            await Promise.resolve();

            expect(sent).toHaveBeenCalledOnce();
            expect(sent.mock.calls[0][0].content).toBe('a message worth keeping');
        });
    });

    /** Picking a character applies to everything the composer posts, not only to typed prose. */
    describe('speaking as a character', () => {
        beforeEach(async () => {
            fixture.componentRef.setInput('guildId', 'guil_1');
            fixture.componentRef.setInput('channelId', 'chan_1');
            fixture.componentRef.setInput('canUsePersonas', true);
            TestBed.inject(PersonaService).select('chan_1', 'pers_1');
            fixture.detectChanges();
        });

        it('posts a gif as the chosen character', () => {
            const sent = vi.fn();
            component.message.subscribe(sent);

            component.onGifSelected('https://gif.test.example/wave.gif');

            expect(sent).toHaveBeenCalledOnce();
            expect(sent.mock.calls[0][0].content).toBe('https://gif.test.example/wave.gif');
            expect(sent.mock.calls[0][0].personaId).toBe('pers_1');
        });

        it('posts a gif as itself once the character is cleared', () => {
            const sent = vi.fn();
            component.message.subscribe(sent);
            TestBed.inject(PersonaService).select('chan_1', null);

            component.onGifSelected('https://gif.test.example/wave.gif');

            expect(sent.mock.calls[0][0].personaId).toBeUndefined();
        });
    });

    /**
     * Chrome leaves a filler <br> behind when the last character of a block is deleted. Read as a
     * newline it gives the empty composer a second line, which is what put the placeholder above
     * the attach button.
     */
    describe('deleting back to empty', () => {
        function editorEl(): HTMLElement {
            return fixture.nativeElement.querySelector('[contenteditable]') as HTMLElement;
        }

        function caretIn(node: Node): void {
            const range = document.createRange();
            range.setStart(node, 0);
            range.collapse(true);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);
        }

        it('keeps no line behind after the last character goes', () => {
            const editor = editorEl();
            editor.innerHTML = '<span data-block=""><br></span>';
            caretIn(editor.firstElementChild!);

            component.onInput();

            expect(editor.querySelectorAll('br')).toHaveLength(0);
            expect(editor.innerHTML).toBe('');
        });

        it('keeps no empty block behind after select-all delete', () => {
            const editor = editorEl();
            editor.innerHTML = '';
            caretIn(editor);

            component.onInput();

            expect(editor.innerHTML).toBe('');
        });

        it('still marks the empty line after a trailing newline', () => {
            const editor = editorEl();
            editor.innerHTML = '<span data-block="">a<br></span>';
            caretIn(editor.firstElementChild!);

            component.onInput();

            expect(editor.querySelectorAll('br[data-sentinel]')).toHaveLength(1);
        });
    });
});
