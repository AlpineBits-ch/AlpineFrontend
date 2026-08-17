import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection} from '@angular/core';
import {of, Subject, throwError} from 'rxjs';

import {MlsJoinRequestReviewComponent} from './mls-join-request-review.component';
import {
    JoinRequestVerificationError,
    MlsJoinRequestDto,
    MlsJoinRequestService,
} from '../../services/mls-join-request.service';
import {MessagingWebsocketService, MlsJoinRequestEvent} from '../../services/messaging-websocket.service';
import {GuildWebsocketService} from '../../services/guild-websocket.service';
import {MlsService} from '../../services/mls.service';
import {DeviceIdentityService} from '../../services/device-identity.service';
import {ProfileService} from '../../services/profile.service';

const CONTEXT = 'conv-1';
const OWN_USER = 'user-a';
const PEER_USER = 'user-b';
const OWN_DEVICE = 'device-this-one';
const FINGERPRINT = '517F4-D75A0-AD0A2-6BBCF';

function pending(overrides: Partial<MlsJoinRequestDto> = {}): MlsJoinRequestDto {
    return {
        id: 'mljr-1',
        contextId: CONTEXT,
        conversationId: CONTEXT,
        generation: 1,
        requesterUserId: PEER_USER,
        requesterDeviceId: 'device-theirs',
        keyPackageHash: 'a-hash-that-changes-every-single-request',
        signatureKeyFingerprint: FINGERPRINT,
        state: 'Pending',
        createdAt: '2026-08-02T00:00:00.000Z',
        expiresAt: '2026-08-16T00:00:00.000Z',
        requiredApprovals: 1,
        approverUserIds: [],
        ...overrides,
    };
}

function setup(
    options: {
        requests?: MlsJoinRequestDto[];
        /** Null means this device holds no group for the context, so it can admit nobody. */
        activeGroupId?: string | null;
        listFails?: boolean;
        approveRejects?: unknown;
    } = {},
) {
    const {requests = [pending()], activeGroupId = 'Z3JvdXA=', listFails = false, approveRejects} = options;

    const list = vi.fn(() => (listFails ? throwError(() => new Error('offline')) : of(requests)));
    const approve = vi.fn(async () => {
        if (approveRejects) throw approveRejects;
        return true;
    });
    const deny = vi.fn(() => of(undefined as void));
    const pushes = new Subject<MlsJoinRequestEvent>();
    /** The channel-side twin, which reaches the same panel via `guild.ChannelMlsJoinRequested`. */
    const channelPushes = new Subject<MlsJoinRequestEvent>();

    TestBed.configureTestingModule({
        imports: [MlsJoinRequestReviewComponent],
        providers: [
            provideZonelessChangeDetection(),
            {provide: MlsJoinRequestService, useValue: {list, approve, deny}},
            {provide: MlsService, useValue: {getActiveGroupId: vi.fn(async () => activeGroupId)}},
            {provide: DeviceIdentityService, useValue: {deviceId: async () => OWN_DEVICE}},
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: OWN_USER})}},
            {provide: MessagingWebsocketService, useValue: {mlsJoinRequestObservable: pushes}},
            {provide: GuildWebsocketService, useValue: {mlsJoinRequestObservable: channelPushes}},
        ],
    });

    const fixture: ComponentFixture<MlsJoinRequestReviewComponent> = TestBed.createComponent(
        MlsJoinRequestReviewComponent,
    );
    fixture.componentRef.setInput('contextId', CONTEXT);
    fixture.componentRef.setInput('participantNames', {[PEER_USER]: 'Bob'});
    fixture.detectChanges();

    const element = () => fixture.nativeElement as HTMLElement;

    return {
        fixture,
        list,
        approve,
        deny,
        pushes,
        channelPushes,
        text: () => element().textContent ?? '',
        /** Lets the component's async refresh finish, then re-renders. Must be a macrotask, not `whenStable`. */
        settle: async () => {
            await new Promise(resolve => setTimeout(resolve, 0));
            fixture.detectChanges();
        },
        buttonLabelled: (label: string) =>
            Array.from(element().querySelectorAll('button')).find(b =>
                (b.textContent ?? '').includes(label),
            ) ?? null,
    };
}

beforeEach(() => TestBed.resetTestingModule());

describe('MlsJoinRequestReviewComponent', () => {
    it('asks the question nobody was being asked', async () => {
        const {settle, text} = setup();
        await settle();

        expect(text()).toContain('waiting to be let into this conversation');
        expect(text()).toContain('Bob added a device');
    });

    it('shows the fingerprint and never the key-package hash', async () => {
        const {settle, text, fixture} = setup();
        await settle();

        const fingerprint = (fixture.nativeElement as HTMLElement).querySelector(
            '[data-testid="fingerprint"]',
        );
        expect(fingerprint?.textContent?.trim()).toBe(FINGERPRINT);
        // The hash changes on every request, so a human comparing it would be comparing noise.
        expect(text()).not.toContain('a-hash-that-changes-every-single-request');
    });

    it("words another of your own devices as a different question from a correspondent's", async () => {
        const {settle, text} = setup({
            requests: [pending({requesterUserId: OWN_USER, requesterDeviceId: 'device-my-laptop'})],
        });
        await settle();

        expect(text()).toContain('Another of your own devices');
        // "Check with Bob out of band" is nonsense when Bob is you.
        expect(text()).toContain('Open the device that is asking');
        expect(text()).not.toContain('added a device');
    });

    it('tells a peer review to go around the server, not through it', async () => {
        const {settle, text} = setup();
        await settle();

        expect(text()).toContain('Check with Bob some other way');
        expect(text()).toContain("do not take the server's word for it");
    });

    it('offers nothing when this device holds no group and could not admit anyone', async () => {
        const {settle, text, list, buttonLabelled} = setup({activeGroupId: null});
        await settle();

        // Admission is an Add commit, and only a device holding the group can produce one.
        expect(buttonLabelled('Approve')).toBeNull();
        expect(text()).not.toContain('waiting to be let into this conversation');
        expect(list).not.toHaveBeenCalled();
    });

    it('does not offer this device the chance to approve its own request', async () => {
        const {settle, text, buttonLabelled} = setup({
            requests: [pending({requesterUserId: OWN_USER, requesterDeviceId: OWN_DEVICE})],
        });
        await settle();

        expect(buttonLabelled('Approve')).toBeNull();
        expect(text()).not.toContain('waiting to be let into this conversation');
    });

    it('admits the device through the existing approval path', async () => {
        const {settle, approve, buttonLabelled} = setup();
        await settle();

        buttonLabelled('Approve')!.click();
        await settle();

        expect(approve).toHaveBeenCalledWith(CONTEXT, false, expect.objectContaining({id: 'mljr-1'}));
    });

    it('denies through the existing path', async () => {
        const {settle, deny, buttonLabelled} = setup();
        await settle();

        buttonLabelled('Deny')!.click();
        await settle();

        expect(deny).toHaveBeenCalledWith(CONTEXT, false, 'mljr-1');
    });

    it('says a key mismatch may be tampering rather than "something went wrong"', async () => {
        const {settle, text, buttonLabelled, fixture} = setup({
            approveRejects: new JoinRequestVerificationError(
                'The identity key does not match the one that was reviewed. Nothing was added.',
            ),
        });
        await settle();

        buttonLabelled('Approve')!.click();
        await settle();

        const block = (fixture.nativeElement as HTMLElement).querySelector(
            '[data-testid="verification-error"]',
        );
        expect(block).not.toBeNull();
        expect(block!.textContent).toContain('The identity key does not match');
        expect(block!.textContent).toContain('tampering');
        // The request was not fulfilled, so it must still be there to be denied.
        expect(text()).toContain(FINGERPRINT);
    });

    it('does not leave a tampering warning standing over the next conversation', async () => {
        const {settle, fixture, buttonLabelled} = setup({
            approveRejects: new JoinRequestVerificationError('The identity key does not match.'),
        });
        await settle();
        buttonLabelled('Approve')!.click();
        await settle();

        const warning = () =>
            (fixture.nativeElement as HTMLElement).querySelector('[data-testid="verification-error"]');
        expect(warning()).not.toBeNull();

        fixture.componentRef.setInput('contextId', 'conv-2');
        await settle();

        expect(warning()).toBeNull();
    });

    it('keeps an ordinary refusal out of the tampering channel', async () => {
        const {settle, buttonLabelled, fixture} = setup({
            approveRejects: new Error('This request is no longer open.'),
        });
        await settle();

        buttonLabelled('Approve')!.click();
        await settle();

        const root = fixture.nativeElement as HTMLElement;
        expect(root.querySelector('[data-testid="verification-error"]')).toBeNull();
        expect(root.querySelector('[data-testid="action-error"]')?.textContent).toContain(
            'This request is no longer open.',
        );
    });

    it('picks up a request that arrives while the conversation is open', async () => {
        const {settle, text, pushes, list} = setup({requests: []});
        await settle();
        expect(text()).not.toContain('waiting to be let into this conversation');

        list.mockReturnValue(of([pending()]));
        pushes.next({
            contextId: CONTEXT,
            isChannel: false,
            generation: 1,
            requestId: 'mljr-1',
            requesterUserId: PEER_USER,
            requesterDeviceId: 'device-theirs',
            requesterDeviceName: 'Bob desktop',
            signatureKeyFingerprint: FINGERPRINT,
            requiresManualApproval: true,
        });
        await settle();

        expect(text()).toContain('waiting to be let into this conversation');
        // The push is the only place a device name appears; the queue read omits it.
        expect(text()).toContain('Bob desktop');
    });

    it('ignores a push about a different conversation', async () => {
        const {settle, pushes, list} = setup({requests: []});
        await settle();
        const before = list.mock.calls.length;

        pushes.next({
            contextId: 'conv-somewhere-else',
            isChannel: false,
            generation: 1,
            requestId: 'mljr-2',
            requesterUserId: PEER_USER,
            requesterDeviceId: 'device-theirs',
            requesterDeviceName: null,
            signatureKeyFingerprint: FINGERPRINT,
            requiresManualApproval: true,
        });
        await settle();

        expect(list.mock.calls.length).toBe(before);
    });

    it('re-reads the queue for a channel join request pushed on the guild socket', async () => {
        const {settle, channelPushes, list} = setup({requests: []});
        await settle();
        const before = list.mock.calls.length;

        channelPushes.next({
            contextId: CONTEXT,
            isChannel: true,
            generation: 0,
            requestId: '',
            requesterUserId: PEER_USER,
            requesterDeviceId: '',
            requesterDeviceName: null,
            signatureKeyFingerprint: '',
            requiresManualApproval: true,
        });
        await settle();

        expect(list.mock.calls.length).toBe(before + 1);
    });

    it('says the queue could not be read instead of showing an empty one', async () => {
        const {settle, fixture} = setup({listFails: true});
        await settle();

        // A failed read is not "nobody is asking".
        expect(
            (fixture.nativeElement as HTMLElement).querySelector('[data-testid="load-error"]'),
        ).not.toBeNull();
    });
});
