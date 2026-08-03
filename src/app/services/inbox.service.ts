import {computed, inject, Injectable, signal} from '@angular/core';
import {ChannelDto, GuildDto} from '../dtos/response/guild.dto';
import {ConversationDto} from '../dtos/response/conversation.dto';
import {GuildService} from './guild.service';
import {GuildReadStateService} from './guild-read-state.service';
import {ConversationStore} from '../stores/conversation.store';
import {ProfileService} from './profile.service';
import {ConversationUtilsService} from './conversation-utils.service';
import {NavigationService} from '../features/main-page/navigation.service';

/** One thing waiting for the user, in the form the titlebar's inbox draws it. */
export type InboxEntry =
    | { kind: 'channel'; id: string; title: string; context: string; mentionCount: number; guild: GuildDto; channel: ChannelDto }
    | { kind: 'conversation'; id: string; title: string; context: string; mentionCount: number; conversation: ConversationDto };

/**
 * Everything that mentioned the user, from every guild and every DM at once.
 *
 * <p>The sidebar answers "what is unread *here*"; nothing before this answered "what is unread
 * anywhere", which is the question the inbox exists for. It owns no state of its own - the counts
 * are the same ones the channel rows and the server rail already read - it only gathers them.</p>
 */
@Injectable({providedIn: 'root'})
export class InboxService {
    private guildService = inject(GuildService);
    private readState = inject(GuildReadStateService);
    private conversationStore = inject(ConversationStore);
    private profileService = inject(ProfileService);
    private convUtils = inject(ConversationUtilsService);
    private navService = inject(NavigationService);

    /** Mentions inside guild channels, newest guild order, highest count first within a guild. */
    readonly channelEntries = computed<InboxEntry[]>(() => {
        const states = this.readState.channelStates();
        const entries: InboxEntry[] = [];
        for (const guild of this.guildService.guilds()) {
            for (const channel of guild.channels) {
                const count = states[channel.id]?.mentionCount ?? 0;
                if (count <= 0) continue;
                entries.push({
                    kind: 'channel',
                    id: channel.id,
                    title: channel.name,
                    context: guild.name,
                    mentionCount: count,
                    guild,
                    channel,
                });
            }
        }
        return entries;
    });

    /** Direct messages that named the user. Reads the server's own per-member counter. */
    readonly conversationEntries = computed<InboxEntry[]>(() => {
        const ownId = this.profileService.ownProfile()?.userId;
        if (!ownId) return [];
        return this.conversationStore.entities()
            .map(conv => ({conv, count: conv.members.find(m => m.userId === ownId)?.mentionCount ?? 0}))
            .filter(({count}) => count > 0)
            .map(({conv, count}): InboxEntry => ({
                kind: 'conversation',
                id: conv.id,
                title: this.convUtils.getChatTitle(conv),
                context: 'Direct Message',
                mentionCount: count,
                conversation: conv,
            }));
    });

    readonly entries = computed<InboxEntry[]>(() => [
        ...this.conversationEntries(),
        ...this.channelEntries(),
    ]);

    readonly totalMentions = computed(() =>
        this.entries().reduce((sum, e) => sum + e.mentionCount, 0)
    );

    /** True once {@link primeReadState} has asked for every guild's read state at least once. */
    private readonly primed = signal(false);

    /**
     * Pulls read state for guilds the user has not opened this session.
     *
     * <p>{@link GuildReadStateService} is loaded by the channel list, so until a guild has been
     * visited its mentions exist only on the server. The inbox is the one surface that claims to
     * speak for *all* guilds, so it pays for that claim - once, when first opened, rather than at
     * launch where it would be one request per guild against a cold start.</p>
     */
    primeReadState(): void {
        if (this.primed()) return;
        this.primed.set(true);
        for (const guild of this.guildService.guilds()) {
            this.readState.loadForGuild(guild.id);
        }
    }

    /** Jumps to whatever the entry points at, switching workspace first when it is elsewhere. */
    open(entry: InboxEntry): void {
        if (entry.kind === 'conversation') {
            this.navService.openConversation(entry.conversation);
            return;
        }
        this.navService.selectServer(entry.guild);
        this.navService.openChannel(entry.channel);
    }
}
