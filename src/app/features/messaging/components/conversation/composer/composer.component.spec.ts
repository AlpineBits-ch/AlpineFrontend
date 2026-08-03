import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';

import {OAuthService} from 'angular-oauth2-oidc';

import {ComposerComponent} from './composer.component';
import {ApiConfigService} from '../../../../../services/api-config.service';
import {NotificationService} from '../../../../../services/notification.service';
import {SocialKeyGateService} from '../../../../../services/social-key-gate.service';

/** The composer only ever asks the gate two things, so the double only answers two. */
function gateStub(satisfied: boolean) {
    let release: ((allowed: boolean) => void) | null = null;
    return {
        isSatisfied: vi.fn(() => satisfied),
        require: vi.fn(() => new Promise<boolean>(resolve => {
            release = resolve;
        })),
        /** Completes the pending require(), as the key-setup dialog would. */
        settle(allowed: boolean) {
            satisfied = allowed;
            release?.(allowed);
        },
    };
}

describe('ComposerComponent', () => {
    let component: ComposerComponent;
    let fixture: ComponentFixture<ComposerComponent>;
    let gate: ReturnType<typeof gateStub>;

    async function setup(satisfied = true) {
        gate = gateStub(satisfied);
        await TestBed.configureTestingModule({
            imports: [ComposerComponent],
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
                // Reached transitively: the composer injects BotCommandService and
                // GuildWebsocketService, whose chain ends at AuthService -> OAuthService.
                // The composer never calls it, so a bare stub is enough.
                {provide: OAuthService, useValue: {getAccessToken: () => null, refreshToken: vi.fn(), logOut: vi.fn()}},
                // Real NotificationService calls Tauri APIs (platform(), focus sync via
                // UserSettingsService) from its constructor, which reject under jsdom.
                {provide: NotificationService, useValue: {createNotification: vi.fn()}},
                {provide: SocialKeyGateService, useValue: gate},
            ],
        })
            .compileComponents();

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
});
