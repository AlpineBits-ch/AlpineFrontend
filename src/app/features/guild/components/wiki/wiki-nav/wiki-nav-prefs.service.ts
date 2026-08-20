import {Injectable, signal} from '@angular/core';
// The shortcuts strip is the only place recents are shown, so remembering more than it can draw would strand them.
import {SHORTCUT_LIMIT} from './wiki-nav-rows';

type PrefKind = 'favourites' | 'recents' | 'collapsed';

/**
 * Per-user nav preferences: favourited pages, recently viewed pages, folded categories. Local
 * only, on purpose: `isPinned` already covers the shared, everyone-sees-it case. Storage handling
 * follows `wiki-drafts.service.ts`: every access is wrapped, since storage that is disabled, full
 * or corrupt must degrade to "no preferences" rather than break the tree.
 */
@Injectable({providedIn: 'root'})
export class WikiNavPrefsService {
    private readonly favouriteIds = signal<readonly string[]>([]);
    private readonly recentIds = signal<readonly string[]>([]);
    private readonly collapsedIds = signal<readonly string[]>([]);

    readonly favourites = this.favouriteIds.asReadonly();
    /** Most recently viewed first. */
    readonly recents = this.recentIds.asReadonly();
    readonly collapsed = this.collapsedIds.asReadonly();

    private guildId = '';

    /** Points the service at a guild. Idempotent, since the caller is an effect that also runs for unrelated signal changes; re-reading storage there would clobber unwritten state. */
    load(guildId: string): void {
        if (!guildId || this.guildId === guildId) return;
        this.guildId = guildId;
        this.favouriteIds.set(this.read('favourites'));
        this.recentIds.set(this.read('recents'));
        this.collapsedIds.set(this.read('collapsed'));
    }

    isFavourite(pageId: string): boolean {
        return this.favouriteIds().includes(pageId);
    }

    toggleFavourite(pageId: string): void {
        const next = this.isFavourite(pageId)
            ? this.favouriteIds().filter(id => id !== pageId)
            : [...this.favouriteIds(), pageId];
        this.favouriteIds.set(next);
        this.write('favourites', next);
    }

    /** Records a visit. Moves an already-known page to the front rather than duplicating it. */
    recordVisit(pageId: string): void {
        const next = [pageId, ...this.recentIds().filter(id => id !== pageId)].slice(0, SHORTCUT_LIMIT);
        // A revisit of the page that is already at the front happens on every render pass of the article; writing storage for it would be a write per change detection.
        if (next.length === this.recentIds().length && next[0] === this.recentIds()[0]) return;
        this.recentIds.set(next);
        this.write('recents', next);
    }

    clearRecents(): void {
        this.recentIds.set([]);
        this.write('recents', []);
    }

    isCollapsed(categoryId: string): boolean {
        return this.collapsedIds().includes(categoryId);
    }

    toggleCollapsed(categoryId: string): void {
        const next = this.isCollapsed(categoryId)
            ? this.collapsedIds().filter(id => id !== categoryId)
            : [...this.collapsedIds(), categoryId];
        this.collapsedIds.set(next);
        this.write('collapsed', next);
    }

    /** Drops every trace of a page or category that no longer exists. */
    forget(id: string): void {
        if (this.favouriteIds().includes(id)) this.toggleFavourite(id);
        if (this.recentIds().includes(id)) {
            const next = this.recentIds().filter(x => x !== id);
            this.recentIds.set(next);
            this.write('recents', next);
        }
        if (this.collapsedIds().includes(id)) this.toggleCollapsed(id);
    }

    private read(kind: PrefKind): string[] {
        try {
            const raw = localStorage.getItem(this.key(kind));
            const parsed: unknown = raw ? JSON.parse(raw) : null;
            return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
        } catch {
            return [];
        }
    }

    private write(kind: PrefKind, value: readonly string[]): void {
        try {
            localStorage.setItem(this.key(kind), JSON.stringify(value));
        } catch {
            // Quota exceeded or storage disabled. Preferences degrade to session-only; the tree still works, it just forgets on reload.
        }
    }

    /** Guild-scoped: a favourite in one server must not surface in another's tree. */
    private key(kind: PrefKind): string {
        return `wiki-nav:${kind}:${this.guildId}`;
    }
}
