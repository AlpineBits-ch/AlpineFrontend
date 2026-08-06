import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {WikiArticleComponent} from './wiki-article.component';
import {WikiAiService} from '../wiki-ai.service';
import {ApiConfigService} from '../../../../../services/api-config.service';
import {OAuthService} from 'angular-oauth2-oidc';
import {NotificationService} from '../../../../../services/notification.service';
import {WikiPageDto} from '../../../../../dtos/response/wiki.dto';

/**
 * The article as the AI dialog reaches it: `draftWithAi` is a public method the wiki view calls
 * on a `?.`, so anything unresolved on the way to the inline bar fails by doing nothing at all.
 */
describe('WikiArticleComponent AI entry points', () => {
    let fixture: ComponentFixture<WikiArticleComponent>;
    let asked: unknown[];

    async function* pending(): AsyncIterable<string> {
        yield 'ok';
        await new Promise(() => undefined);
    }

    function page(): WikiPageDto {
        return {
            id: 'p1', guildId: 'g1', title: 'On-call', slug: 'on-call', authorId: 'u1',
            createdAt: new Date(0), updatedAt: new Date(0), visibility: 'public', tags: [],
            isPinned: false, revisionCount: 1, content: 'The rota rotates weekly.',
        };
    }

    /** The inline AI bar is the only fixed overlay this component renders. */
    function barVisible(): boolean {
        return !!fixture.nativeElement.querySelector('app-wiki-ai-inline div.fixed');
    }

    beforeEach(async () => {
        asked = [];
        Element.prototype.scrollIntoView = () => undefined;

        await TestBed.configureTestingModule({
            imports: [WikiArticleComponent],
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                provideTranslateService({defaultLanguage: 'en'}),
                // The article reaches WikiService -> ApiConfigService -> OAuthService. Nothing
                // on the AI path makes a request, so the base URL is all that is needed.
                {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
                {provide: OAuthService, useValue: {getAccessToken: () => 'tok'}},
                // Reached through the websocket service and initialises against the Tauri OS
                // plugin, which is not there under jsdom.
                {provide: NotificationService, useValue: {createNotification: async () => undefined}},
                {
                    provide: WikiAiService,
                    useValue: {
                        available: () => true,
                        activeProvider: () => 'anthropic',
                        ghostTextEnabled: () => false,
                        refresh: async () => undefined,
                        draft: (req: unknown) => {
                            asked.push(req);
                            return pending();
                        },
                        transform: (req: unknown) => {
                            asked.push(req);
                            return pending();
                        },
                    },
                },
            ],
        }).compileComponents();

        fixture = TestBed.createComponent(WikiArticleComponent);
        fixture.componentRef.setInput('guildId', 'g1');
        fixture.componentRef.setInput('editing', true);
        fixture.componentRef.setInput('page', null);
        fixture.detectChanges();
    });

    it('opens the inline bar when the dialog hands over a prompt', () => {
        fixture.componentInstance.draftWithAi('write the on-call page');
        fixture.detectChanges();
        expect(asked.length).toBe(1);
    });

    /**
     * The wiki hands the article a fresh page object on every summary refresh - anyone's edit to
     * any page, a pin, a tag. Cancelling the AI bar on that discarded a generation that was
     * streaming into a page nobody had navigated away from.
     */
    it('keeps a running generation when the same page is handed over again', () => {
        fixture.componentRef.setInput('page', page());
        fixture.detectChanges();

        fixture.componentInstance.draftWithAi('write the on-call page');
        fixture.detectChanges();
        expect(barVisible()).toBe(true);

        // A refresh: same page, new object, one field moved.
        fixture.componentRef.setInput('page', {...page(), isPinned: true});
        fixture.detectChanges();
        expect(barVisible()).toBe(true);
    });

    it('still cancels when a different page is opened', () => {
        fixture.componentRef.setInput('page', page());
        fixture.detectChanges();

        fixture.componentInstance.draftWithAi('write the on-call page');
        fixture.detectChanges();
        expect(barVisible()).toBe(true);

        fixture.componentRef.setInput('page', {...page(), id: 'p2', title: 'Something else'});
        fixture.detectChanges();
        expect(barVisible()).toBe(false);
    });
});
