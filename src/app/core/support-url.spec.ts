import {appealUrl, siteHost, supportUrl} from './support-url';

describe('siteHost', () => {
    it('replaces the first label rather than prefixing it', () => {
        // The bug this function exists to prevent: support.api.venta.gg has no DNS behind it.
        expect(siteHost('https://api.venta.gg', 'support')).toBe('https://support.venta.gg');
    });

    it('prefixes a bare domain, which has no subdomain to replace', () => {
        expect(siteHost('https://venta.gg', 'support')).toBe('https://support.venta.gg');
    });

    it('replaces the first label of a deeper host without touching the rest', () => {
        expect(siteHost('https://api.eu.venta.gg', 'support')).toBe('https://support.eu.venta.gg');
    });

    it('prefixes a single label', () => {
        expect(siteHost('http://localhost', 'support')).toBe('http://support.localhost');
    });

    it('prefixes a bare IP rather than eating an octet', () => {
        expect(siteHost('http://127.0.0.1', 'support')).toBe('http://support.127.0.0.1');
    });

    it('keeps a non-default port, so a dev instance stays reachable', () => {
        expect(siteHost('http://localhost:5000', 'support')).toBe('http://support.localhost:5000');
    });

    it('keeps the scheme of the API it was derived from', () => {
        expect(siteHost('http://api.example.com', 'support')).toBe('http://support.example.com');
    });

    it('builds the other labels off the same rule', () => {
        expect(siteHost('https://api.venta.gg', 'docs')).toBe('https://docs.venta.gg');
        expect(siteHost('https://api.venta.gg', 'admin')).toBe('https://admin.venta.gg');
    });

    it('returns the input unchanged when it is not a URL, rather than throwing in a template', () => {
        expect(siteHost('not a url', 'support')).toBe('not a url');
    });

    it('drops a path on the API base - the site is an origin', () => {
        expect(siteHost('https://api.venta.gg/api/v1', 'support')).toBe('https://support.venta.gg');
    });
});

describe('supportUrl / appealUrl', () => {
    it('points at the support site itself', () => {
        expect(supportUrl('https://api.venta.gg')).toBe('https://support.venta.gg');
    });

    it('points the appeal at the one page that files it', () => {
        expect(appealUrl('https://api.venta.gg')).toBe('https://support.venta.gg/appeal');
    });
});
