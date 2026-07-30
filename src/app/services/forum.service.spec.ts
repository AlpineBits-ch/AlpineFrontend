import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';

import {ForumService} from './forum.service';
import {ApiConfigService} from './api-config.service';

describe('ForumService', () => {
    let service: ForumService;
    let http: HttpTestingController;
    const base = 'https://api.test.example/api/v1/guild';

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            ],
        });
        service = TestBed.inject(ForumService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    describe('tags', () => {
        it('lists tags under the forum channel', () => {
            service.getTags('f1').subscribe();
            const req = http.expectOne(`${base}/channels/f1/tags`);
            expect(req.request.method).toBe('GET');
            req.flush([]);
        });

        it('creates a tag under the forum channel', () => {
            service.createTag('f1', {name: 'bug', emojiName: '🐛'}).subscribe();
            const req = http.expectOne(`${base}/channels/f1/tags`);
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({name: 'bug', emojiName: '🐛'});
            req.flush({});
        });

        /** Update and delete are keyed by tag id alone - the forum isn't in the path. */
        it('updates a tag by id', () => {
            service.updateTag('ftag_1', {name: 'confirmed bug'}).subscribe();
            const req = http.expectOne(`${base}/forum-tags/ftag_1`);
            expect(req.request.method).toBe('PATCH');
            expect(req.request.body).toEqual({name: 'confirmed bug'});
            req.flush({});
        });

        it('deletes a tag by id', () => {
            service.deleteTag('ftag_1').subscribe();
            const req = http.expectOne(`${base}/forum-tags/ftag_1`);
            expect(req.request.method).toBe('DELETE');
            req.flush(null);
        });

        it('sends the complete ordered id list when reordering', () => {
            service.reorderTags('f1', {tagIds: ['ftag_c', 'ftag_a']}).subscribe();
            const req = http.expectOne(`${base}/channels/f1/tags/reorder`);
            expect(req.request.method).toBe('PATCH');
            expect(req.request.body).toEqual({tagIds: ['ftag_c', 'ftag_a']});
            req.flush(null);
        });
    });

    describe('config', () => {
        it('reads the forum config', () => {
            service.getConfig('f1').subscribe();
            const req = http.expectOne(`${base}/channels/f1/forum-config`);
            expect(req.request.method).toBe('GET');
            req.flush({});
        });

        it('PATCHes only the fields given', () => {
            service.updateConfig('f1', {requireTag: true}).subscribe();
            const req = http.expectOne(`${base}/channels/f1/forum-config`);
            expect(req.request.method).toBe('PATCH');
            expect(req.request.body).toEqual({requireTag: true});
            req.flush({});
        });
    });

    describe('posts', () => {
        it('omits every query param when no filters are set', () => {
            service.getPosts('f1').subscribe();
            const req = http.expectOne(r => r.url === `${base}/channels/f1/posts`);
            expect(req.request.params.keys()).toEqual([]);
            req.flush({posts: [], nextCursor: null});
        });

        it('joins tag ids with commas and passes the rest through', () => {
            service.getPosts('f1', {
                tagIds: ['ftag_a', 'ftag_b'],
                match: 'all',
                sort: 'activity',
                archived: 'all',
                limit: 25,
                cursor: 'opaque',
            }).subscribe();

            const req = http.expectOne(r => r.url === `${base}/channels/f1/posts`);
            expect(req.request.params.get('tagIds')).toBe('ftag_a,ftag_b');
            expect(req.request.params.get('match')).toBe('all');
            expect(req.request.params.get('sort')).toBe('activity');
            expect(req.request.params.get('archived')).toBe('all');
            expect(req.request.params.get('limit')).toBe('25');
            expect(req.request.params.get('cursor')).toBe('opaque');
            req.flush({posts: [], nextCursor: null});
        });

        it('PUTs the whole tag set on a post', () => {
            service.setPostTags('t1', {tagIds: ['ftag_a']}).subscribe();
            const req = http.expectOne(`${base}/threads/t1/tags`);
            expect(req.request.method).toBe('PUT');
            expect(req.request.body).toEqual({tagIds: ['ftag_a']});
            req.flush({});
        });

        it('PATCHes pin and lock separately', () => {
            service.setPostPinned('t1', {pinned: true}).subscribe();
            const pin = http.expectOne(`${base}/threads/t1/pin`);
            expect(pin.request.method).toBe('PATCH');
            expect(pin.request.body).toEqual({pinned: true});
            pin.flush(null);

            service.setPostLocked('t1', {locked: false}).subscribe();
            const lock = http.expectOne(`${base}/threads/t1/lock`);
            expect(lock.request.method).toBe('PATCH');
            expect(lock.request.body).toEqual({locked: false});
            lock.flush(null);
        });
    });
});
