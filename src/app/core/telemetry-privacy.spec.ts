import {describe, expect, it} from 'vitest';
import {installId, scrubBreadcrumb, scrubEvent, scrubUrl, scrubValue} from './telemetry-privacy';

describe('scrubValue', () => {
    it('replaces sensitive keys at the top level', () => {
        expect(scrubValue({email: 'a@b.c', keep: 1})).toEqual({email: '[redacted]', keep: 1});
    });

    it('matches keys regardless of case and separators', () => {
        const scrubbed = scrubValue({
            UserName: 'x',
            phone_number: 'y',
            'access-token': 'z',
        }) as Record<string, unknown>;

        expect(scrubbed['UserName']).toBe('[redacted]');
        expect(scrubbed['phone_number']).toBe('[redacted]');
        expect(scrubbed['access-token']).toBe('[redacted]');
    });

    it('reaches sensitive keys nested inside objects and arrays', () => {
        const scrubbed = scrubValue({
            users: [{email: 'a@b.c', id: '1'}],
            nested: {deep: {password: 'hunter2'}},
        }) as any;

        expect(scrubbed.users[0].email).toBe('[redacted]');
        expect(scrubbed.users[0].id).toBe('1');
        expect(scrubbed.nested.deep.password).toBe('[redacted]');
    });

    it('does not mutate the value it was given', () => {
        const original = {email: 'a@b.c'};
        scrubValue(original);
        expect(original.email).toBe('a@b.c');
    });

    it('leaves primitives alone', () => {
        expect(scrubValue('plain')).toBe('plain');
        expect(scrubValue(7)).toBe(7);
        expect(scrubValue(null)).toBeNull();
    });

    it('terminates on a cyclic object rather than recursing forever', () => {
        const cyclic: Record<string, unknown> = {name: 'x'};
        cyclic['self'] = cyclic;
        expect(() => scrubValue(cyclic)).not.toThrow();
    });
});

describe('scrubUrl', () => {
    it('drops the query string, which is where reset tokens live', () => {
        expect(scrubUrl('https://x.test/reset?token=secret')).toBe('https://x.test/reset');
    });

    it('drops the fragment', () => {
        expect(scrubUrl('https://x.test/page#access_token=secret')).toBe('https://x.test/page');
    });

    it('leaves a clean url untouched', () => {
        expect(scrubUrl('https://x.test/page')).toBe('https://x.test/page');
    });
});

describe('scrubEvent', () => {
    it('removes the request body outright', () => {
        const event = scrubEvent({request: {data: {password: 'hunter2'}}});
        expect(event.request!.data).toBe('[redacted]');
    });

    it('strips the query string off the request url', () => {
        const event = scrubEvent({request: {url: 'https://x.test/verify?code=123'}});
        expect(event.request!.url).toBe('https://x.test/verify');
    });

    it('scrubs sensitive headers but keeps the rest', () => {
        const event = scrubEvent({request: {headers: {Authorization: 'Bearer x', 'X-Trace': 't'}}});
        const headers = event.request!.headers as Record<string, unknown>;
        expect(headers['Authorization']).toBe('[redacted]');
        expect(headers['X-Trace']).toBe('t');
    });

    it('scrubs extra and contexts', () => {
        const event = scrubEvent({extra: {email: 'a@b.c'}, contexts: {user: {phone: '123'}}});
        expect((event.extra as any).email).toBe('[redacted]');
        expect((event.contexts as any).user.phone).toBe('[redacted]');
    });

    it('passes through an event with nothing sensitive in it', () => {
        const event = scrubEvent({request: {url: 'https://x.test/'}});
        expect(event.request!.url).toBe('https://x.test/');
    });
});

describe('scrubBreadcrumb', () => {
    it('strips query strings out of breadcrumb urls', () => {
        const crumb = scrubBreadcrumb({data: {url: 'https://x.test/a?token=t'}});
        expect((crumb.data as any).url).toBe('https://x.test/a');
    });

    it('redacts sensitive fields in breadcrumb data', () => {
        const crumb = scrubBreadcrumb({data: {email: 'a@b.c'}});
        expect((crumb.data as any).email).toBe('[redacted]');
    });

    it('leaves a breadcrumb with no data alone', () => {
        expect(scrubBreadcrumb({message: 'clicked'})).toEqual({message: 'clicked'});
    });
});

describe('installId', () => {
    function fakeStorage(initial: Record<string, string> = {}) {
        const store = {...initial};
        return {
            getItem: (k: string) => store[k] ?? null,
            setItem: (k: string, v: string) => void (store[k] = v),
        };
    }

    it('generates and persists an id on first use', () => {
        const storage = fakeStorage();
        const id = installId(storage);
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
        expect(storage.getItem('telemetry_install_id')).toBe(id);
    });

    it('returns the same id on later calls', () => {
        const storage = fakeStorage();
        expect(installId(storage)).toBe(installId(storage));
    });

    it('is not the user id - two installs differ', () => {
        expect(installId(fakeStorage())).not.toBe(installId(fakeStorage()));
    });
});
