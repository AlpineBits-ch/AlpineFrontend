import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {of} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';

import {SceneHeaderComponent} from './scene-header.component';
import {SceneService} from '../../../../services/scene.service';
import {PersonaService} from '../../../../services/persona.service';
import {ToastService} from '../../../../services/toast.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {
    SceneDto,
    SceneJoinPolicy,
    SceneJoinRequestDto,
    SceneJoinRequestStatus,
    SceneStatus,
    SceneVisibility,
} from '../../../../dtos/response/scene.dto';
import {ChannelDto, ChannelType} from '../../../../dtos/response/guild.dto';

function scene(overrides: Partial<SceneDto> = {}): SceneDto {
    return {
        channelId: 'ch_scene',
        guildId: 'g1',
        name: 'The Siege of Blackwater',
        status: SceneStatus.Active,
        joinPolicy: SceneJoinPolicy.Open,
        visibility: SceneVisibility.Everyone,
        turnOrder: ['p1'],
        participants: [{personaId: 'p1', name: 'Kaelen'}],
        currentTurnPersonaId: 'p1',
        oocThreadId: 'ch_ooc',
        ...overrides,
    };
}

function channels(): ChannelDto[] {
    return [
        {id: 'ch_scene', name: 'the-siege', type: ChannelType.Scene, guildId: 'g1'} as ChannelDto,
        {id: 'ch_ooc', name: 'the-siege-ooc', type: ChannelType.Thread, guildId: 'g1'} as ChannelDto,
    ];
}

function request(overrides: Partial<SceneJoinRequestDto> = {}): SceneJoinRequestDto {
    return {
        id: 'scjr_1',
        guildId: 'g1',
        sceneChannelId: 'ch_scene',
        personaId: 'p2',
        personaName: 'Thessaly Quen',
        requestedByUserId: 'u2',
        note: 'She has history with Veyra.',
        status: SceneJoinRequestStatus.Pending,
        createdAt: '2026-08-20T09:00:00Z',
        updatedAt: '2026-08-20T09:00:00Z',
        ...overrides,
    };
}

function setup(
    overrides: Partial<SceneDto> = {},
    canManage = true,
    requests: SceneJoinRequestDto[] = [],
) {
    // Reset here rather than in beforeEach: the pairs below stand two headers up in one test.
    TestBed.resetTestingModule();

    const scenes = {
        now: () => Date.now(),
        speakableIds: () => new Set<string>(),
        update: vi.fn(() => of(scene())),
        skipTurn: vi.fn(() => of(scene())),
        nudgeTurn: vi.fn(() => of(undefined)),
        pendingRequests: vi.fn(() => requests),
        approveRequest: vi.fn(() => of(request({status: SceneJoinRequestStatus.Approved}))),
        denyRequest: vi.fn(() => of(request({status: SceneJoinRequestStatus.Denied}))),
        ensureRequests: vi.fn(),
    };

    TestBed.configureTestingModule({
        imports: [SceneHeaderComponent],
        providers: [
            provideTranslateService(),
            {provide: SceneService, useValue: scenes},
            {
                provide: PersonaService,
                useValue: {
                    identity: () => null,
                    ensureCast: () => undefined,
                    ensureGuildCast: () => undefined,
                    speakable: () => [],
                },
            },
            {provide: ToastService, useValue: {success: vi.fn(), httpError: vi.fn()}},
            {provide: NavigationService, useValue: {openSceneSide: vi.fn()}},
        ],
    });

    const fixture: ComponentFixture<SceneHeaderComponent> = TestBed.createComponent(SceneHeaderComponent);
    fixture.componentRef.setInput('guildId', 'g1');
    fixture.componentRef.setInput('scene', scene(overrides));
    fixture.componentRef.setInput('canManage', canManage);
    fixture.componentRef.setInput('guildChannels', channels());
    fixture.detectChanges();

    return {fixture, scenes, html: () => fixture.nativeElement.textContent as string};
}

describe('SceneHeaderComponent', () => {
    it('offers the in-character and out-of-character pair when both halves exist', () => {
        const {fixture} = setup();
        expect(fixture.nativeElement.querySelectorAll('.scene-pair-tab').length).toBe(2);
    });

    it('draws no pair when the scene has no companion thread', () => {
        const {fixture} = setup({oocThreadId: null});
        expect(fixture.nativeElement.querySelector('.scene-pair')).toBeNull();
    });

    it('hides the status chip while the scene is running', () => {
        const {fixture} = setup({status: SceneStatus.Active});
        expect(fixture.nativeElement.querySelector('.scene-status-chip')).toBeNull();
    });

    it('shows the status chip on a scene that is not running', () => {
        const {fixture} = setup({status: SceneStatus.Paused});
        expect(fixture.nativeElement.querySelector('.scene-status-chip')).not.toBeNull();
    });

    it('gives the menu only to a game master', () => {
        expect(setup({}, false).fixture.nativeElement.querySelector('.scene-icon-button')).toBeNull();
        expect(setup({}, true).fixture.nativeElement.querySelector('.scene-icon-button')).not.toBeNull();
    });

    it('raises the stalled banner once the turn has been chased twice', () => {
        expect(setup({nudgeCount: 1}).fixture.nativeElement.querySelector('.scene-stalled')).toBeNull();
        expect(setup({nudgeCount: 2}).fixture.nativeElement.querySelector('.scene-stalled')).not.toBeNull();
    });

    it('keeps the stalled banner from anyone who cannot act on it', () => {
        const {fixture} = setup({nudgeCount: 2}, false);
        expect(fixture.nativeElement.querySelector('.scene-stalled')).toBeNull();
    });

    it('shows the asks to a game master and to nobody else', () => {
        expect(
            setup({}, true, [request()]).fixture.nativeElement.querySelector('.scene-requests'),
        ).not.toBeNull();
        expect(
            setup({}, false, [request()]).fixture.nativeElement.querySelector('.scene-requests'),
        ).toBeNull();
    });

    it('names the character and its note, never the player behind it', () => {
        const {fixture} = setup({}, true, [request()]);
        const text = fixture.nativeElement.textContent as string;
        expect(text).toContain('Thessaly Quen');
        expect(text).toContain('She has history with Veyra.');
        expect(text).not.toContain('u2');
    });

    it('approves through the service', () => {
        const {fixture, scenes} = setup({}, true, [request()]);
        fixture.nativeElement.querySelector('.scene-request-approve').click();
        expect(scenes.approveRequest).toHaveBeenCalledWith('g1', 'ch_scene', 'scjr_1');
    });

    it('sends the reason with a denial', () => {
        const {fixture, scenes} = setup({}, true, [request()]);
        const component = fixture.componentInstance as unknown as {
            denyReason: {set: (v: string) => void};
            openDeny: (id: string, panel: {toggle: () => void; hide: () => void}, e: Event) => void;
            deny: (panel: {toggle: () => void; hide: () => void}) => void;
        };
        const panel = {toggle: vi.fn(), hide: vi.fn()};

        component.openDeny('scjr_1', panel, new Event('click'));
        component.denyReason.set('Not this arc.');
        component.deny(panel);

        expect(scenes.denyRequest).toHaveBeenCalledWith('g1', 'ch_scene', 'scjr_1', {
            reason: 'Not this arc.',
        });
    });

    it('skips the turn through the service', () => {
        const {fixture, scenes} = setup({nudgeCount: 2});
        const buttons: HTMLButtonElement[] = Array.from(
            fixture.nativeElement.querySelectorAll('.scene-stalled-action'),
        );
        buttons[1].click();
        expect(scenes.skipTurn).toHaveBeenCalledWith('g1', 'ch_scene');
    });
});
