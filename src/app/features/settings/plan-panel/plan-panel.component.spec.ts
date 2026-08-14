/**
 * What a settings screen is allowed to say about a plan.
 *
 * <p>Three things are asserted here that are easy to get wrong in a way nothing else would catch:
 * the copy is `displayName` and never the lookup key, a pinned version is on screen rather than
 * quietly dropped, and a subject with no plan gets no plan row rather than an invented "Free".</p>
 */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {signal} from '@angular/core';
import {provideTranslateService} from '@ngx-translate/core';
import {describe, expect, it} from 'vitest';
import {PlanPanelComponent} from './plan-panel.component';
import {ApiConfigService} from '../../../services/api-config.service';
import {EntitlementStore, EntitlementSubjectRef, MY_ENTITLEMENTS} from '../../../stores/entitlement.store';
import {EntitlementPlanDto, EntitlementSnapshotDto, GuildFeatureResolutionDto} from '../../../dtos/response/entitlement.dto';

function snapshot(over: Partial<EntitlementSnapshotDto> = {}): EntitlementSnapshotDto {
    return {
        licenseMode: 'hosted',
        upgradesAvailable: true,
        vocabularyVersion: 1,
        subject: {kind: 'user', id: 'user-1'},
        resolvedAt: '2026-08-14T10:00:00Z',
        version: 0,
        ttlSeconds: 60,
        entitlements: {},
        ladders: {},
        remedy: 'upgrade_user',
        actorCanRemedy: true,
        ...over,
    };
}

function setup(opts: {
    subject?: EntitlementSubjectRef;
    plan?: EntitlementPlanDto;
    snapshot?: EntitlementSnapshotDto | null;
    features?: GuildFeatureResolutionDto;
} = {}) {
    const held = opts.snapshot === null
        ? null
        : opts.snapshot ?? snapshot(opts.plan ? {plan: opts.plan} : {});

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        imports: [PlanPanelComponent],
        providers: [
            provideTranslateService({defaultLanguage: 'en'}),
            // The panel now hosts the plan picker and the payment methods list, both of which talk
            // to Billing. Neither is asserted here - these tests are about what the panel says
            // about the plan a subject is *on* - so the requests are left in flight and no
            // `verify()` is called. `stripePublishableKey` answers blank, which is what makes the
            // picker draw a comparison with nothing to press.
            provideHttpClient(),
            provideHttpClientTesting(),
            // Stubbed rather than real: the real one reaches for OAuthService, and none of this
            // file is about which instance the requests would have gone to.
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            {
                provide: EntitlementStore,
                useValue: {
                    snapshot: () => held,
                    plan: () => held?.plan ?? null,
                    features: () => opts.features ?? null,
                    ensureLoaded: () => undefined,
                    ensureFeaturesLoaded: () => undefined,
                    stripePublishableKey: signal(''),
                },
            },
        ],
    });

    const fixture: ComponentFixture<PlanPanelComponent> = TestBed.createComponent(PlanPanelComponent);
    fixture.componentRef.setInput('subject', opts.subject ?? MY_ENTITLEMENTS);
    fixture.detectChanges();
    return fixture;
}

/** Untranslated keys render as themselves, so assertions read against the key. */
function text(fixture: ComponentFixture<PlanPanelComponent>): string {
    return fixture.nativeElement.textContent as string;
}

describe('the plan row', () => {
    /** `name` is the lookup key. "plus" is not a sentence, and it is not what an operator named. */
    it('renders the display name and never the key', () => {
        const fixture = setup({plan: {name: 'plus', displayName: 'Venta Plus', version: 2}});

        expect(text(fixture)).toContain('Venta Plus');
        expect(text(fixture)).not.toContain('plus"');
    });

    /**
     * Grandfathering is the reason this is on screen: a guild can be resolving version 2 while
     * version 4 is what is on sale, and showing only "Plus" hides from exactly that population
     * that their limits come from older terms.
     */
    it('shows the version the subject is actually on', () => {
        const fixture = setup({plan: {name: 'plus', displayName: 'Venta Plus', version: 2}});

        expect(text(fixture)).toContain('PLAN.VERSION');
        expect(text(fixture)).toContain('PLAN.VERSION_NOTE');
    });

    /** Absent is not version zero, and a version nobody stated is not a fact to render. */
    it('says nothing about a version the server did not send', () => {
        const fixture = setup({plan: {name: 'plus', displayName: 'Venta Plus'}});

        expect(text(fixture)).toContain('Venta Plus');
        expect(text(fixture)).not.toContain('PLAN.VERSION_NOTE');
    });

    /**
     * No plan is a real state. An instance with none configured resolves every key to its
     * catalogue default, and naming a tier the server never claimed is the one sentence a
     * self-hoster would read as a paywall.
     */
    it('invents no plan where the server named none', () => {
        const fixture = setup();

        expect(text(fixture)).toContain('PLAN.NONE_TITLE');
        expect(text(fixture)).not.toContain('Free');
    });

    it('claims nothing at all before anything has been read', () => {
        const fixture = setup({snapshot: null});

        expect(text(fixture)).toContain('PLAN.NONE_TITLE');
        expect(text(fixture)).not.toContain('ENTITLEMENT.CTA.');
    });
});

describe('the remedy on a plan screen', () => {
    it('offers the upgrade the server said this reader can buy', () => {
        const fixture = setup({
            snapshot: snapshot({remedy: 'upgrade_user', actorCanRemedy: true}),
        });

        expect(text(fixture)).toContain('ENTITLEMENT.CTA.UPGRADE_ACCOUNT');
    });

    /** Never computed here. Re-implementing ManageGuild is how a buy button that 403s gets drawn. */
    it('names who can act instead, for a reader who cannot', () => {
        const fixture = setup({
            subject: {kind: 'guild', id: 'guild-1'},
            snapshot: snapshot({remedy: 'upgrade_guild', actorCanRemedy: false}),
        });

        expect(text(fixture)).toContain('ENTITLEMENT.CTA.ASK_OWNER');
    });

    it('offers nothing where there is nothing to buy', () => {
        const fixture = setup({snapshot: snapshot({remedy: 'none', actorCanRemedy: false})});

        expect(text(fixture)).not.toContain('ENTITLEMENT.CTA.');
    });
});

describe('what a guild plan is withholding', () => {
    /** `withheldByPlan` as sent. Deriving it from what is effective is impossible, hence the list. */
    it('names the modules the owner asked for and is not getting', () => {
        const fixture = setup({
            subject: {kind: 'guild', id: 'guild-1'},
            features: {
                chosen: ['Forums', 'Events'],
                includedByPlan: ['Events'],
                withheldByPlan: ['Forums'],
                effective: ['Events'],
            },
        });

        expect(text(fixture)).toContain('PLAN.WITHHELD_SECTION');
        expect(text(fixture)).toContain('GUILD_MODULE.FORUMS.LABEL');
    });

    /** Empty is the normal case, and an empty heading is a scold about nothing. */
    it('draws no section for a plan that covers what the guild uses', () => {
        const fixture = setup({
            subject: {kind: 'guild', id: 'guild-1'},
            features: {
                chosen: ['Events'], includedByPlan: ['Events'], withheldByPlan: [], effective: ['Events'],
            },
        });

        expect(text(fixture)).not.toContain('PLAN.WITHHELD_SECTION');
    });

    /** The account screen has no modules to withhold, whatever a guild elsewhere is missing. */
    it('draws nothing of the sort on the account screen', () => {
        const fixture = setup({
            features: {
                chosen: ['Forums'], includedByPlan: [], withheldByPlan: ['Forums'], effective: [],
            },
        });

        expect(text(fixture)).not.toContain('PLAN.WITHHELD_SECTION');
    });
});
