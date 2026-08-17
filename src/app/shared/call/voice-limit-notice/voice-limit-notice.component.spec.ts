/**
 * The persistent notice, and the rule the whole entitlement contract turns on: never draw a button
 * that will 403, and never omit one that belonged.
 *
 * <p>`remedy` and `actorCanRemedy` are server-computed - it resolves ManageGuild per request and
 * knows whether the instance sells anything at all - so every case below is about rendering what
 * arrived rather than about deciding anything.</p>
 */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {VoiceLimitNoticeComponent} from './voice-limit-notice.component';
import {VoiceLimitNotice} from '../../../services/voice-limits.service';
import {EntitlementSubjectDto} from '../../../dtos/response/entitlement.dto';

function notice(over: Partial<VoiceLimitNotice> = {}): VoiceLimitNotice {
    return {
        key: 'voice.video_ceiling',
        surfaceKey: 'VOICE.DEGRADED.QUALITY_CAPPED',
        rung: '720p30',
        granted: {kind: 'ladder', rung: '720p30', rank: 2},
        refused: false,
        messageKey: 'ENTITLEMENT.REASON.GUILD_PLAN_LIMIT',
        ctaKey: null,
        hintKey: null,
        subject: {kind: 'guild', id: 'guild-1'},
        feature: null,
        retryable: false,
        ...over,
    };
}

function render(notices: VoiceLimitNotice[]): ComponentFixture<VoiceLimitNoticeComponent> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        imports: [VoiceLimitNoticeComponent, TranslateModule.forRoot()],
    });
    const fixture = TestBed.createComponent(VoiceLimitNoticeComponent);
    fixture.componentRef.setInput('notices', notices);
    fixture.detectChanges();
    return fixture;
}

function text(fixture: ComponentFixture<VoiceLimitNoticeComponent>): string {
    return (fixture.nativeElement.textContent as string).replace(/\s+/g, ' ').trim();
}

function cta(fixture: ComponentFixture<VoiceLimitNoticeComponent>): HTMLButtonElement | null {
    return fixture.nativeElement.querySelector('[data-testid="voice-limit-cta"]');
}

describe('a limit notice', () => {
    it('draws nothing at all when nothing is limited', () => {
        const fixture = render([]);

        expect(fixture.nativeElement.querySelector('[data-testid="voice-limit-notices"]')).toBeNull();
    });

    it('names what was reduced and why, and stays on screen', () => {
        const fixture = render([notice()]);

        expect(text(fixture)).toContain('VOICE.DEGRADED.QUALITY_CAPPED');
        expect(text(fixture)).toContain('ENTITLEMENT.REASON.GUILD_PLAN_LIMIT');
    });

    it('gives the button to a caller the server said can act', () => {
        const fixture = render([notice({ctaKey: 'ENTITLEMENT.CTA.UPGRADE_SERVER'})]);

        expect(cta(fixture)?.textContent?.trim()).toBe('ENTITLEMENT.CTA.UPGRADE_SERVER');
    });

    it('aims the button at the party the remedy applies to', () => {
        const fixture = render([notice({
            ctaKey: 'ENTITLEMENT.CTA.UPGRADE_ACCOUNT',
            subject: {kind: 'user', id: 'user-1'},
        })]);
        const seen: (EntitlementSubjectDto | null)[] = [];
        fixture.componentInstance.upgrade.subscribe(s => seen.push(s));

        cta(fixture)!.click();

        // Not "whichever guild is on screen": for a paired ceiling those are routinely different.
        expect(seen).toEqual([{kind: 'user', id: 'user-1'}]);
    });

    /** A member who cannot manage the guild gets the explanation and no upgrade button. */
    it('gives a sentence instead of a button to a caller who cannot act', () => {
        const fixture = render([notice({ctaKey: null, hintKey: 'ENTITLEMENT.CTA.ASK_OWNER'})]);

        expect(cta(fixture)).toBeNull();
        expect(text(fixture)).toContain('ENTITLEMENT.CTA.ASK_OWNER');
    });

    /**
     * An operator ceiling carries no remedy at all, because no amount of money moves one - and the
     * same pair arrives for every limit on an instance that sells nothing.
     */
    it('gives neither for an operator ceiling', () => {
        const fixture = render([notice({
            messageKey: 'ENTITLEMENT.REASON.OPERATOR_CEILING',
            ctaKey: null,
            hintKey: null,
        })]);

        expect(cta(fixture)).toBeNull();
        expect(text(fixture)).toContain('ENTITLEMENT.REASON.OPERATOR_CEILING');
        expect(text(fixture)).not.toContain('ENTITLEMENT.CTA');
    });

    /**
     * Edge: a catalogue key this build has no sentence for. The reason line carries the card on its
     * own rather than the card rendering blank or showing a raw key.
     */
    it('falls back to the reason alone for a key it cannot name', () => {
        const fixture = render([notice({surfaceKey: null, rung: null})]);

        expect(text(fixture)).toBe('ENTITLEMENT.REASON.GUILD_PLAN_LIMIT');
    });

    it('draws one card per limit, keyed so nothing appears twice', () => {
        const fixture = render([
            notice(),
            notice({key: 'voice.max_publishers', surfaceKey: 'VOICE.DEGRADED.PUBLISHERS_FULL'}),
        ]);

        expect(fixture.nativeElement.querySelectorAll('[data-limit-key]')).toHaveLength(2);
    });
});
