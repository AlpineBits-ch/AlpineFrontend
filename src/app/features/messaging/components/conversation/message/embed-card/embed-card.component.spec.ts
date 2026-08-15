import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {vi} from 'vitest';
import {EmbedCardComponent} from './embed-card.component';
import {EmbedFlags, MessageEmbed} from '../../../../../../dtos/response/message.dto';
import {LinkOpener} from '../../../../../../platform/ports/link-opener.port';
import {ApiConfigService} from '../../../../../../services/api-config.service';
import {
    WikiDeepLinkService,
} from '../../../../../guild/components/wiki/wiki-share/wiki-deep-link.service';

/** The one bit that says the server wrote this, not the message's author. */
const GENERATED = EmbedFlags.Generated;

interface ProtectedSurface {
    mode: () => string;
    venta: () => MessageEmbed['venta'];
    allowMarkdown: () => boolean;
}

function setup(embed: MessageEmbed) {
    TestBed.configureTestingModule({
        imports: [EmbedCardComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService({defaultLanguage: 'en'}),
            {provide: LinkOpener, useValue: {open: vi.fn(() => Promise.resolve())}},
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            // The wiki card's "can this click land anywhere" check, whose real graph reaches the
            // navigation stack and the account registry. Nothing here navigates.
            {provide: WikiDeepLinkService, useValue: {canOpen: () => false, open: vi.fn()}},
        ],
    });

    const fixture: ComponentFixture<EmbedCardComponent> = TestBed.createComponent(EmbedCardComponent);
    fixture.componentRef.setInput('embed', embed);
    fixture.detectChanges();

    return {fixture, card: fixture.componentInstance as unknown as ProtectedSurface};
}

function inviteEmbed(overrides: Partial<MessageEmbed> = {}): MessageEmbed {
    return {
        type: 'venta.invite',
        url: 'https://venta.gg/invite/ABC23456',
        title: 'Sunday Raid Group',
        description: 'Casual mythic+',
        flags: GENERATED,
        fields: [],
        venta: {kind: 'invite', resolved: true, invite_code: 'ABC23456', guild_id: 'gild_1'},
        ...overrides,
    };
}

describe('EmbedCardComponent venta trust', () => {
    afterEach(() => TestBed.resetTestingModule());

    it('renders a venta card the server vouched for', () => {
        const {fixture, card} = setup(inviteEmbed());

        expect(card.mode()).toBe('venta-invite');
        expect(fixture.nativeElement.querySelectorAll('app-invite-card').length).toBe(1);
    });

    it('draws nothing for a venta.* embed without the generated flag', () => {
        // Without the flag the whole embed - `venta` block included - was written by whoever posted
        // the message, which may be a bot. It buys an attacker nothing (every action runs through a
        // permission-checked endpoint) but a card that looks server-vouched when it is not is a
        // phishing surface.
        const {fixture, card} = setup(inviteEmbed({flags: 0}));

        expect(card.venta()).toBeUndefined();
        expect(card.mode()).toBe('none');
        expect(fixture.nativeElement.querySelectorAll('app-invite-card').length).toBe(0);
        expect(fixture.nativeElement.textContent).not.toContain('Sunday Raid Group');
    });

    it('draws nothing when flags are absent entirely', () => {
        const {card} = setup(inviteEmbed({flags: undefined}));

        expect(card.mode()).toBe('none');
    });

    it('ignores a venta kind it has never heard of rather than half-rendering it', () => {
        // A future kind will arrive before the next release. Falling back to the link layout would
        // draw a card describing something this build cannot act on.
        const {fixture, card} = setup({
            type: 'venta.event' as MessageEmbed['type'],
            url: 'https://venta.gg/event/evnt_1',
            flags: GENERATED,
            fields: [],
            venta: {kind: 'event', resolved: false, guild_id: 'gild_1'},
        });

        expect(card.mode()).toBe('none');
        expect(fixture.nativeElement.querySelectorAll('app-invite-card, app-wiki-card').length).toBe(0);
    });

    it('keeps the ordinary link-card fallback for an unknown NON-venta type', () => {
        // Only `venta.*` draws nothing. An unrecognised third-party type still has a title, a
        // description and a URL worth rendering, and that fallback predates this feature.
        const {fixture, card} = setup({
            type: 'poll' as MessageEmbed['type'],
            url: 'https://example.com/p',
            title: 'A poll',
            flags: GENERATED,
            fields: [],
        });

        expect(card.mode()).toBe('card');
        expect(fixture.nativeElement.textContent).toContain('A poll');
    });

    it('never runs a generated embed through markdown', () => {
        const {card} = setup(inviteEmbed());
        expect(card.allowMarkdown()).toBe(false);
    });
});

describe('EmbedCardComponent wiki stub', () => {
    afterEach(() => TestBed.resetTestingModule());

    it('renders a wiki embed that carries no title at all', () => {
        // The missing title is deliberate and permanent, not a gap: reading a wiki is gated per
        // user and per role, and a generated embed is stored once for everyone who can read the
        // channel. The card fills the name in per viewer, or leaves the placeholder standing.
        const {fixture, card} = setup({
            type: 'venta.wiki_page',
            url: 'https://venta.gg/wiki/gild_1/wkpg_7',
            flags: GENERATED,
            fields: [],
            venta: {kind: 'wiki_page', resolved: false, guild_id: 'gild_1', page_id: 'wkpg_7'},
        });

        expect(card.mode()).toBe('venta-wiki');
        expect(fixture.nativeElement.querySelectorAll('app-wiki-card').length).toBe(1);
        expect(fixture.nativeElement.textContent).toContain('WIKI.CARD.PLACEHOLDER_TITLE');
    });
});

describe('EmbedCardComponent media source', () => {
    afterEach(() => TestBed.resetTestingModule());

    it('renders our proxy copy, not the origin', () => {
        // Read as `proxyUrl` this was always undefined, so every card silently hot-linked the
        // origin - handing it the IP and read time of everyone who scrolled past a link one other
        // person posted, which is the exact leak proxy_url exists to prevent.
        const {fixture} = setup({
            type: 'image',
            url: 'https://origin.example/pic.png',
            flags: GENERATED,
            fields: [],
            image: {
                url: 'https://origin.example/pic.png',
                proxy_url: 'https://api.test.example/api/v1/previews/media/abc',
                width: 100,
                height: 50,
            },
        });

        const img: HTMLImageElement = fixture.nativeElement.querySelector('img');
        expect(img.getAttribute('src')).toBe('https://api.test.example/api/v1/previews/media/abc');
    });

    it('falls back to the origin only when there is no proxy copy', () => {
        const {fixture} = setup({
            type: 'image',
            url: 'https://origin.example/pic.png',
            flags: GENERATED,
            fields: [],
            image: {url: 'https://origin.example/pic.png', width: 100, height: 50},
        });

        const img: HTMLImageElement = fixture.nativeElement.querySelector('img');
        expect(img.getAttribute('src')).toBe('https://origin.example/pic.png');
    });
});
