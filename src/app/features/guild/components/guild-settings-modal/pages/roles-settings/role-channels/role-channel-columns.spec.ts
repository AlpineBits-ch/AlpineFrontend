import {columnsFor} from './role-channel-columns';
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
});
