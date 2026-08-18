import {HttpErrorResponse} from '@angular/common/http';
import {describe, expect, it} from 'vitest';
import {coverHost, publishRefusal} from './wiki-publish-refusal';

function refusal(body: unknown, status = 400): HttpErrorResponse {
    return new HttpErrorResponse({status, statusText: 'Bad Request', error: body});
}

describe('publishRefusal', () => {
    it('reads the code the server sends', () => {
        expect(publishRefusal(refusal({error: 'wiki_page_private', message: 'anything'}))).toBe('private');
        expect(publishRefusal(refusal({error: 'wiki_page_cover_not_hosted'}))).toBe('cover');
    });

    it('ignores the message, which is prose and may change', () => {
        const worded = refusal({error: 'wiki_page_private', message: 'A page marked private...'});
        const reworded = refusal({error: 'wiki_page_private', message: 'Something else entirely'});

        expect(publishRefusal(worded)).toBe(publishRefusal(reworded));
        expect(publishRefusal(refusal({message: 'A page marked private cannot be published.'}))).toBeNull();
    });

    it('is null for anything that is not one of the two answers', () => {
        expect(publishRefusal(refusal({error: 'wiki_page_private'}, 500))).toBeNull();
        expect(publishRefusal(refusal({error: 'something_new'}))).toBeNull();
        expect(publishRefusal(refusal(null))).toBeNull();
        expect(publishRefusal(refusal('Cover url must be at most 2048 characters.'))).toBeNull();
        expect(publishRefusal(new Error('offline'))).toBeNull();
        expect(publishRefusal(undefined)).toBeNull();
    });
});

describe('coverHost', () => {
    it('names the host of an off-instance cover', () => {
        expect(coverHost('https://images.example.com/a.png')).toBe('images.example.com');
        expect(coverHost('  http://tracker.test/x.jpg  ')).toBe('tracker.test');
    });

    it('has nothing to name for an app-relative path or a non-URL', () => {
        expect(coverHost('/uploads/a.png')).toBeNull();
        expect(coverHost('not a url')).toBeNull();
        expect(coverHost('')).toBeNull();
        expect(coverHost(null)).toBeNull();
    });

    it('names the host of a protocol-relative cover, which only looks app-relative', () => {
        expect(coverHost('//images.example.com/x.png')).toBe('images.example.com');
    });
});
