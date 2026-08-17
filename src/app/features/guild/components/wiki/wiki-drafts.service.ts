import {Injectable} from '@angular/core';

/**
 * A local, unpublished edit.
 *
 * `baseUpdatedAt` records which server revision the draft was started from, so a draft can be
 * recognised as stale when the page has moved on underneath it.
 */
export interface WikiDraft {
    title: string;
    content: string;
    categoryId?: string;
    parentPageId?: string;
    tags: string[];
    isPinned: boolean;
    baseUpdatedAt: string | null;
    savedAt: number;
}

/**
 * Drafts survive navigation, reloads and crashes; they are never sent to the server on their own.
 * Publishing stays explicit, because autosaving to the server would mint a revision per keystroke
 * and turn the revision list into a keylog.
 */
@Injectable({providedIn: 'root'})
export class WikiDraftsService {
    read(guildId: string, pageId: string | null): WikiDraft | null {
        try {
            const raw = localStorage.getItem(this.key(guildId, pageId));
            return raw ? (JSON.parse(raw) as WikiDraft) : null;
        } catch {
            // Corrupt entry or storage unavailable. A missing draft is recoverable; a thrown
            // error while opening a page is not.
            return null;
        }
    }

    write(guildId: string, pageId: string | null, draft: WikiDraft): void {
        try {
            localStorage.setItem(this.key(guildId, pageId), JSON.stringify(draft));
        } catch {
            // Quota exceeded or storage disabled. Drafts degrade to off rather than
            // interrupting the edit; the status pill omits the draft state accordingly.
        }
    }

    clear(guildId: string, pageId: string | null): void {
        try {
            localStorage.removeItem(this.key(guildId, pageId));
        } catch {
            // Nothing to recover from - the draft is already unreachable.
        }
    }

    /** Whether restoring this draft would actually change anything the user can see. */
    divergesFrom(draft: WikiDraft, title: string, content: string): boolean {
        return draft.title !== title || draft.content !== content;
    }

    /** Guild-scoped: two guilds can each hold an unsaved new page at the same time. */
    private key(guildId: string, pageId: string | null): string {
        return `wiki-draft:${guildId}:${pageId ?? 'new'}`;
    }
}
