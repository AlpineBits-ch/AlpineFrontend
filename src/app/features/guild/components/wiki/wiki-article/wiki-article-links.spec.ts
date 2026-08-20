import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {OAuthService} from 'angular-oauth2-oidc';
import {of} from 'rxjs';
import {KeybindsService} from '../../../../../services/keybinds.service';
import {provideFakePlatform} from '../../../../../platform/testing/provide-fake-platform';
import {LinkOpener} from '../../../../../platform/ports/link-opener.port';
import {ApiConfigService} from '../../../../../services/api-config.service';
import {NotificationService} from '../../../../../services/notification.service';
import {WikiService} from '../../../../../services/wiki.service';
import {WikiAiService} from '../wiki-ai.service';
import {WikiDto, WikiPageDto, WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {WikiArticleComponent} from './wiki-article.component';

/**
 * Clicking an anchor in read mode. The defect this covers: a relative markdown link fell through
 * with no preventDefault, reached the WebView and opened the system browser.
 */
describe('WikiArticleComponent anchor clicks', () => {
    let fixture: ComponentFixture<WikiArticleComponent>;
    let opened: string[];

    function summary(id: string, title: string, slug: string): WikiPageSummaryDto {
        return {
            id,
            guildId: 'g1',
            title,
            slug,
            authorId: 'u1',
            createdAt: new Date(0),
            updatedAt: new Date(0),
            visibility: 'public',
            tags: [],
            isPinned: false,
            revisionCount: 1,
        };
    }

    function body(content: string): WikiPageDto {
        return {...summary('p9', 'Home', 'home'), content} as WikiPageDto;
    }

    function anchors(): HTMLAnchorElement[] {
        return Array.from(fixture.nativeElement.querySelectorAll('.wiki-article-body a'));
    }

    /** Returns whether the click was prevented, which is what stops the WebView acting on it. */
    function click(anchor: HTMLAnchorElement): boolean {
        const event = new MouseEvent('click', {bubbles: true, cancelable: true});
        anchor.dispatchEvent(event);
        return event.defaultPrevented;
    }

    beforeEach(async () => {
        opened = [];
        Element.prototype.scrollIntoView = () => undefined;

        await TestBed.configureTestingModule({
            imports: [WikiArticleComponent],
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                provideTranslateService({defaultLanguage: 'en'}),
                provideFakePlatform(),
                {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
                {provide: OAuthService, useValue: {getAccessToken: () => 'tok'}},
                {provide: NotificationService, useValue: {createNotification: async () => undefined}},
                {provide: KeybindsService, useValue: {getBinding: () => null}},
                MessageService,
                {
                    provide: LinkOpener,
                    useValue: {
                        open: async (url: string) => {
                            opened.push(url);
                        },
                    },
                },
                {
                    provide: WikiAiService,
                    useValue: {
                        available: () => false,
                        activeProvider: () => null,
                        ghostTextEnabled: () => false,
                        refresh: async () => undefined,
                    },
                },
                {
                    provide: WikiService,
                    useValue: {getWiki: () => of({id: 'w1', guildId: 'g1', pages: [], categories: []})},
                },
            ],
        }).compileComponents();

        fixture = TestBed.createComponent(WikiArticleComponent);
        fixture.componentRef.setInput('guildId', 'g1');
        fixture.componentRef.setInput('editing', false);
        fixture.componentRef.setInput('wiki', {
            id: 'w1',
            guildId: 'g1',
            pages: [summary('p1', 'Getting Started', 'getting-started')],
            categories: [],
        } as unknown as WikiDto);
        fixture.detectChanges();
    });

    it('navigates internally for a relative link instead of leaving the app', () => {
        const navigated: string[] = [];
        fixture.componentInstance.wikiLinkClicked.subscribe(id => navigated.push(id));
        fixture.componentRef.setInput('page', body('See [Getting Started](Getting-Started) first.'));
        fixture.detectChanges();

        expect(click(anchors()[0])).toBe(true);
        expect(navigated).toEqual(['p1']);
        expect(opened).toEqual([]);
    });

    it('opens an external link through the platform port, never as a plain anchor', () => {
        fixture.componentRef.setInput('page', body('See [the docs](https://example.com/a).'));
        fixture.detectChanges();

        expect(click(anchors()[0])).toBe(true);
        expect(opened).toEqual(['https://example.com/a']);
    });

    it('swallows a relative link that names no page, and marks it broken', () => {
        const navigated: string[] = [];
        fixture.componentInstance.wikiLinkClicked.subscribe(id => navigated.push(id));
        fixture.componentRef.setInput('page', body('See [Nowhere](Nowhere-At-All).'));
        fixture.detectChanges();

        const anchor = anchors()[0];
        expect(anchor.getAttribute('data-wiki-broken')).toBe('true');
        expect(click(anchor)).toBe(true);
        expect(navigated).toEqual([]);
        expect(opened).toEqual([]);
    });

    it('still follows a wiki: link', () => {
        const navigated: string[] = [];
        fixture.componentInstance.wikiLinkClicked.subscribe(id => navigated.push(id));
        fixture.componentRef.setInput('page', body('See [Started](wiki:p1).'));
        fixture.detectChanges();

        expect(click(anchors()[0])).toBe(true);
        expect(navigated).toEqual(['p1']);
    });

    it('swallows a mention', () => {
        const navigated: string[] = [];
        fixture.componentInstance.wikiLinkClicked.subscribe(id => navigated.push(id));
        fixture.componentRef.setInput('page', body('Ask [@Dom](user:u1).'));
        fixture.detectChanges();

        expect(click(anchors()[0])).toBe(true);
        expect(navigated).toEqual([]);
        expect(opened).toEqual([]);
    });
});
