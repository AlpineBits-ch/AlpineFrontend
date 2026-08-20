import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {OAuthService} from 'angular-oauth2-oidc';
import {of, throwError} from 'rxjs';
import {KeybindsService} from '../../../../../services/keybinds.service';
import {provideFakePlatform} from '../../../../../platform/testing/provide-fake-platform';
import {ApiConfigService} from '../../../../../services/api-config.service';
import {NotificationService} from '../../../../../services/notification.service';
import {WikiService} from '../../../../../services/wiki.service';
import {WikiAiService} from '../wiki-ai.service';
import {WikiStateService} from '../wiki-state.service';
import {CreateWikiPageDto} from '../../../../../dtos/request/wiki.dto';
import {WikiArticleComponent} from './wiki-article.component';

/** What a save actually sends, and what it says when it cannot send anything. */
describe('WikiArticleComponent save', () => {
    let fixture: ComponentFixture<WikiArticleComponent>;
    let created: CreateWikiPageDto[];
    let messages: {severity?: string; summary?: string}[];
    let failCreate: boolean;

    function setTitle(value: string): void {
        const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
        input.value = value;
        input.dispatchEvent(new Event('input'));
        fixture.detectChanges();
    }

    beforeEach(async () => {
        created = [];
        messages = [];
        failCreate = false;
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
                {
                    provide: MessageService,
                    useValue: {add: (message: {severity?: string}) => messages.push(message)},
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
                    useValue: {
                        getWiki: () => of({id: 'w1', guildId: 'g1', pages: [], categories: []}),
                        createPage: (_guildId: string, body: CreateWikiPageDto) => {
                            created.push(body);
                            return failCreate
                                ? throwError(() => new Error('nope'))
                                : of({id: 'p9', title: body.title});
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

    /** The nav's "Add sub-page here" wrote this and nothing ever read it, so every page landed at the root. */
    it('sends the category and parent the nav asked for', () => {
        TestBed.inject(WikiStateService).editorDefaults.set({categoryId: 'c1', parentPageId: 'p1'});
        setTitle('Rollback');

        fixture.componentInstance.save();

        expect(created).toHaveLength(1);
        expect(created[0].categoryId).toBe('c1');
        expect(created[0].parentPageId).toBe('p1');
    });

    it('leaves both out when the editor was opened without them', () => {
        TestBed.inject(WikiStateService).editorDefaults.set(null);
        setTitle('Rollback');

        fixture.componentInstance.save();

        expect(created).toHaveLength(1);
        expect(created[0].categoryId).toBeUndefined();
        expect(created[0].parentPageId).toBeUndefined();
    });

    it('says why an untitled page cannot be saved instead of returning silently', () => {
        setTitle('   ');

        fixture.componentInstance.save();

        expect(created).toHaveLength(0);
        expect(messages.some(m => m.severity === 'warn')).toBe(true);
    });

    it('reports a failed save as an error rather than as a quiet draft', () => {
        failCreate = true;
        const statuses: string[] = [];
        fixture.componentInstance.saveStatusChanged.subscribe(status => statuses.push(status));
        setTitle('Rollback');

        fixture.componentInstance.save();

        expect(statuses).toContain('error');
        expect(messages.some(m => m.severity === 'error')).toBe(true);
    });
});
