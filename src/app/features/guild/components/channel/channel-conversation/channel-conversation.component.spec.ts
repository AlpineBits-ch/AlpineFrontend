/**
 * Characterization of the send path and read tracking. Written against ChannelComponent before the
 * move and re-pointed here unaltered, which is what makes it evidence the move changed nothing.
 *
 * The template is overridden away: every child component in it drags its own DI chain, and none of
 * them is what this file is about.
 */
import {TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';

import {messageFixture, sendPayload, settle, setup} from './channel-conversation.harness';
import {NavigationService} from '../../../../main-page/navigation.service';
import {MessageDto} from '../../../../../dtos/response/message.dto';

describe('ChannelConversationComponent send path', () => {
    it('adds an optimistic message before the request settles', async () => {
        const {component, store} = await setup();

        component.createMessage(sendPayload());

        expect(store.addMessage).toHaveBeenCalledOnce();
        const optimistic = store.addMessage.mock.calls[0][0] as MessageDto;
        expect(optimistic.isPending).toBe(true);
        expect(optimistic.channelId).toBe('chan1');
        expect(atob(optimistic.content)).toBe('hello');
    });

    it('confirms the optimistic message with the server copy', async () => {
        const {component, store} = await setup('ok');

        component.createMessage(sendPayload());
        await settle();

        expect(store.confirmMessage).toHaveBeenCalled();
        expect(store.failMessage).not.toHaveBeenCalled();
    });

    it('marks the message failed when the send errors', async () => {
        const {component, store} = await setup('fail');

        component.createMessage(sendPayload());
        await settle();

        expect(store.failMessage).toHaveBeenCalled();
        expect(store.removeMessage).not.toHaveBeenCalled();
    });

    it('removes the message and raises the banner on an auto-mod refusal', async () => {
        const {component, store, sending} = await setup('automod');

        component.createMessage(sendPayload());
        await settle();

        expect(store.removeMessage).toHaveBeenCalled();
        expect(sending.autoModError()).toBe('blocked_word');
    });
});

describe('ChannelConversationComponent read from the start', () => {
    it('opens an ordinary channel at the present', async () => {
        const {store} = await setup();

        expect(store.loadForChannel).toHaveBeenCalledWith('chan1');
        expect(store.loadChannelOldest).not.toHaveBeenCalled();
    });

    it('anchors at the beginning when read-from-the-start named this channel', async () => {
        const {store} = await setup('ok', [], 'chan1');

        expect(store.loadChannelOldest).toHaveBeenCalledWith('chan1');
        expect(store.loadForChannel).not.toHaveBeenCalled();
    });

    it('ignores a request naming a different channel', async () => {
        const {store} = await setup('ok', [], 'chan-other');

        expect(store.loadForChannel).toHaveBeenCalledWith('chan1');
        expect(store.loadChannelOldest).not.toHaveBeenCalled();
    });

    it('consumes the request, so the next open lands at the present', async () => {
        const {store} = await setup('ok', [], 'chan1');
        const nav = TestBed.inject(NavigationService) as unknown as {readFromStart: () => string | null};

        expect(store.loadChannelOldest).toHaveBeenCalledOnce();
        expect(nav.readFromStart()).toBeNull();
    });
});

describe('ChannelConversationComponent read tracking', () => {
    it('reports the newest settled message as read', async () => {
        const {guildWs, readState} = await setup('ok', [
            messageFixture({id: 'mesg_old', createdAt: new Date('2026-08-19T00:00:00Z')}),
            messageFixture({id: 'mesg_new', createdAt: new Date('2026-08-19T01:00:00Z')}),
        ]);

        expect(guildWs.updateLastReadMessageByChannel).toHaveBeenCalledWith('mesg_new', 'chan1');
        expect(readState.markChannelRead).toHaveBeenCalledWith('chan1');
    });

    it('does not report a pending message as read', async () => {
        const {guildWs} = await setup('ok', [messageFixture({id: 'mesg_pending', isPending: true})]);

        expect(guildWs.updateLastReadMessageByChannel).not.toHaveBeenCalled();
    });
});
