import {channelScope, categoryScope} from './permission-scope';
import {CategoryDto, ChannelDto, ChannelType} from '../../../../dtos/response/guild.dto';

describe('permission scope', () => {
    it('carries the channel type for a channel, so household groups render', () => {
        const scope = channelScope({
            id: 'chan_1',
            type: ChannelType.List,
            permissions: [],
        } as unknown as ChannelDto);

        expect(scope).toEqual({kind: 'channel', id: 'chan_1', channelType: ChannelType.List, overrides: []});
    });

    // A category-wide household grant would mean "controls every list in here", which is not a
    // thing the server resolves. Categories offer no module groups at all.
    it('carries no channel type for a category', () => {
        const scope = categoryScope({id: 'cat_1', permissions: []} as unknown as CategoryDto);

        expect(scope.channelType).toBeNull();
        expect(scope.kind).toBe('category');
    });
});
