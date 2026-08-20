import {columnsFor, columnsPresent} from './role-channel-columns';
import {ChannelType} from '../../../../../../../dtos/response/guild.dto';

describe('role channel columns', () => {
    it('gives a text channel the message columns', () => {
        expect(columnsFor(ChannelType.Text)).toEqual([
            'ViewChannel',
            'SendMessages',
            'ReadMessageHistory',
            'CreateThreads',
            'ManageChannel',
        ]);
    });

    it('gives a voice channel the voice columns and no Send', () => {
        const columns = columnsFor(ChannelType.Voice);

        expect(columns).toContain('Connect');
        expect(columns).toContain('Speak');
        expect(columns).not.toContain('SendMessages');
    });

    it('treats a forum like a text channel', () => {
        expect(columnsFor(ChannelType.Forum)).toEqual(columnsFor(ChannelType.Text));
    });

    it('gives a household channel only View', () => {
        expect(columnsFor(ChannelType.Ledger)).toEqual(['ViewChannel']);
    });

    it('drops voice columns from the header when no channel is voice', () => {
        const header = columnsPresent([ChannelType.Text, ChannelType.Text, ChannelType.Forum]);

        expect(header).not.toContain('Connect');
        expect(header).not.toContain('Speak');
        expect(header).not.toContain('Stream');
    });

    it('adds voice columns to the header once a voice channel is present', () => {
        const header = columnsPresent([ChannelType.Text, ChannelType.Voice]);

        expect(header).toContain('Connect');
        expect(header).toContain('Speak');
        expect(header).toContain('Stream');
    });

    it('keeps a stable, canonical order regardless of channel order', () => {
        const forward = columnsPresent([ChannelType.Text, ChannelType.Voice, ChannelType.Ledger]);
        const backward = columnsPresent([ChannelType.Ledger, ChannelType.Voice, ChannelType.Text]);

        expect(forward).toEqual(backward);
        expect(forward).toEqual([
            'ViewChannel',
            'SendMessages',
            'ReadMessageHistory',
            'CreateThreads',
            'Connect',
            'Speak',
            'Stream',
            'ManageChannel',
        ]);
    });
});
