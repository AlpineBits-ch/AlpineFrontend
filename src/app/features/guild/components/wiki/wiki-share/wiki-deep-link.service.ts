import {effect, inject, Injectable, signal, untracked} from '@angular/core';
import {NavigationService} from '../../../../main-page/navigation.service';
import {GuildService} from '../../../../../services/guild.service';
import {WikiService} from '../../../../../services/wiki.service';
import {WikiStateService} from '../wiki-state.service';
import {GuildFeature, guildHasFeature} from '../../../guild-features';

/**
 * Opens a wiki page named by a link somewhere else in the app (a card under a message, today).
 * There is no route to navigate to: the wiki is a `mainView`, so arriving at a page is three moves
 * (guild, then wiki, then page) against two services, the last of which cannot be made until that
 * guild's page listing has loaded. This holds the third move until it can be made, rather than
 * making every caller poll for a wiki it did not open.
 */
@Injectable({providedIn: 'root'})
export class WikiDeepLinkService {
    private readonly nav = inject(NavigationService);
    private readonly guildService = inject(GuildService);
    private readonly wikiService = inject(WikiService);
    private readonly state = inject(WikiStateService);

    /** The page we are on our way to, if any. Cleared the moment it is opened or abandoned. */
    private readonly pending = signal<{guildId: string; pageId: string} | null>(null);

    constructor() {
        effect(() => {
            const target = this.pending();
            if (!target) return;

            // Somebody navigated away before the listing arrived. Dropping the target here is what stops it firing later, when they next open that guild's wiki for their own reasons.
            const view = this.nav.mainView();
            if (view.type !== 'wiki' || view.guildId !== target.guildId) {
                untracked(() => this.pending.set(null));
                return;
            }

            // `guildId()` is set synchronously on initialize, so it is true before the fetch that would make it useful. The loaded wiki's own guildId is the honest signal.
            const wiki = this.state.wiki();
            if (!wiki || wiki.guildId !== target.guildId) return;

            untracked(() => {
                this.pending.set(null);
                const summary = wiki.pages.find(p => p.id === target.pageId);
                if (summary) {
                    this.state.openPage(summary);
                    return;
                }
                // A page created since this listing was fetched is absent from it but perfectly readable. `openPage` only needs an id, so the full page stands in for a summary.
                this.wikiService
                    .getPage(target.guildId, target.pageId)
                    .subscribe({next: page => this.state.openPage(page), error: () => undefined});
            });
        });
    }

    /** Whether a link into this guild's wiki could be followed at all: we are a member and the module is on. Read by cards so "Open" is never offered where it would go nowhere. */
    canOpen(guildId: string): boolean {
        const guild = this.guildService.guilds().find(g => g.id === guildId);
        return !!guild && guildHasFeature(guild, GuildFeature.Wiki);
    }

    /** Returns false when {@link canOpen} would have; the caller then says so rather than nothing. */
    open(guildId: string, pageId: string): boolean {
        const guild = this.guildService.guilds().find(g => g.id === guildId);
        if (!guild || !guildHasFeature(guild, GuildFeature.Wiki)) return false;

        // Both are no-ops when we are already there, and `selectServer` picking a channel first is immediately overridden by `openWiki`, so a same-guild click never flashes a channel.
        this.nav.selectServer(guild);
        this.nav.openWiki(guildId);
        this.pending.set({guildId, pageId});
        return true;
    }
}
