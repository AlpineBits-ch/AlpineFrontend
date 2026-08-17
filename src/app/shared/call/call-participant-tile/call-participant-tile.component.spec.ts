/**
 * Task 18: the name pill used to be two different treatments - a bottom-left pill with the camera
 * on, `mt-3` centred text sharing the flex column with the avatar when it was off. That made a
 * one-person tile with no camera read as an off-centre stack rather than a centred face, which is
 * the exact thing the reference screenshot called out. The pill is now unconditional; these specs
 * pin the bottom-left placement in both camera states and the structural change (the pill leaving
 * the flex column) that is what actually re-centres the avatar - see the class doc on the template
 * for why taking the name out of the column is sufficient rather than needing an override on the
 * avatar itself.
 */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {CallParticipantTileComponent} from './call-participant-tile.component';
import {CallParticipant} from '../call.types';
import {ProfileService} from '../../../services/profile.service';
import {OsInfo} from '../../../platform/ports/os-info.port';
import {FakeOsInfo} from '../../../platform/testing/fake-os-info';

function participant(overrides: Partial<CallParticipant> = {}): CallParticipant {
    return {
        userId: 'user-a',
        displayName: 'Alice',
        avatarLabel: 'A',
        isLocal: false,
        isMuted: false,
        isSpeaking: false,
        isCameraOn: false,
        ...overrides,
    };
}

function render(overrides: Partial<CallParticipant> = {}): ComponentFixture<CallParticipantTileComponent> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        imports: [CallParticipantTileComponent, TranslateModule.forRoot()],
        providers: [
            {provide: OsInfo, useValue: new FakeOsInfo('web', false)},
            {
                provide: ProfileService,
                useValue: {getCachedByUserId: () => undefined, resolveByUserId: () => undefined},
            },
        ],
    });

    const fixture = TestBed.createComponent(CallParticipantTileComponent);
    fixture.componentRef.setInput('participant', participant(overrides));
    fixture.componentRef.setInput('audioState', 'ok');
    fixture.detectChanges();
    return fixture;
}

/**
 * The name pill: the direct parent of the `<span>` carrying `displayName` verbatim.
 *
 * <p>Matching on the SPAN specifically, not on any ancestor div's aggregate textContent - with the
 * camera on and no stream yet, nothing else in the tile renders text (the avatar is not drawn at
 * all in that branch), so the root tile div's own textContent also collapses to exactly "Alice" and
 * a text-equality search over every div would return the root instead of the pill.</p>
 */
function pill(fixture: ComponentFixture<CallParticipantTileComponent>): HTMLElement {
    const span = Array.from(fixture.nativeElement.querySelectorAll('span') as NodeListOf<HTMLElement>).find(
        el => el.textContent?.trim() === 'Alice' && el.children.length === 0,
    );
    const el = span?.parentElement;
    if (!el) throw new Error('name pill not found');
    return el;
}

describe('CallParticipantTileComponent name pill', () => {
    it('renders a bottom-left pill with the camera off', () => {
        const fixture = render({isCameraOn: false});

        const el = pill(fixture);
        expect(el.className).toContain('absolute');
        expect(el.className).toContain('bottom-2');
        expect(el.className).toContain('left-2');
        expect(el.className).toContain('bg-black/50');
        // The old camera-off treatment - proof this is not just the camera-on branch happening to
        // also render bottom-left classes, but the centred-text branch actually gone.
        expect(el.className).not.toContain('mt-3');
    });

    it('renders the identical bottom-left pill with the camera on', () => {
        // The reference wants ONE treatment, not "camera off now matches camera on" by coincidence -
        // this pins that both states produce the same pill.
        const off = pill(render({isCameraOn: false}));
        const on = pill(render({isCameraOn: true, videoStream: undefined}));

        expect(on.className).toBe(off.className);
    });

    it('takes the name out of the tile column so the avatar centres on its own', () => {
        // The root tile keeps its own `items-center justify-center` unchanged (see the brief: only
        // the name's placement may change) - what has to change is the name no longer being a
        // participant in that same flex column. `absolute` is exactly that: it removes the pill from
        // flow, leaving app-avatar as the column's only child, which is what lets `justify-center`
        // centre it instead of centring an avatar+name stack half a name-height off-centre.
        const fixture = render({isCameraOn: false});

        const root: HTMLElement = fixture.nativeElement.querySelector('.group');
        expect(root.className).toContain('items-center');
        expect(root.className).toContain('justify-center');

        const avatar = fixture.nativeElement.querySelector('app-avatar');
        expect(avatar).not.toBeNull();
        // Only the pill (out of flow) and the avatar (still in flow) sit in the tile - no leftover
        // wrapper still carrying the old stack's spacing.
        expect(fixture.nativeElement.querySelector('.mt-3')).toBeNull();
    });

    it('keeps the muted glyph inside the pill, camera off', () => {
        const fixture = render({isCameraOn: false, isMuted: true});

        const el = pill(fixture);
        expect(el.querySelector('.icon-slashed')).not.toBeNull();
    });
});
