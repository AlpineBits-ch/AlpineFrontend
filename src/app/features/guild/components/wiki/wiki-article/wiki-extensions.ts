import {Extensions} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Underline from '@tiptap/extension-underline';
import {Table} from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import {Markdown} from '@tiptap/markdown';
import {WIKI_LINK_PROTOCOL} from '../wiki-links';
import {USER_LINK_PROTOCOL} from './wiki-mention-menu.component';
import {DEFAULT_WIKI_BLOCK_LABELS, WikiBlockLabels} from './blocks/wiki-block-labels';
import {WikiCallout} from './blocks/wiki-callout';
import {WikiToggle, WikiToggleBody, WikiToggleSummary} from './blocks/wiki-toggle';
import {WikiCodeBlock} from './blocks/wiki-code-block';
import {wikiImage, WikiImageSources} from './blocks/wiki-image';
import {WIKI_TABLE_CELL_MIN_WIDTH, WikiTableControls} from './blocks/wiki-table-controls';
import {WikiTabGuard, WikiTaskFromListItem} from './wiki-keymap';
import {WikiClipboardMarkdown} from './wiki-clipboard';

export {DEFAULT_WIKI_BLOCK_LABELS, wikiBlockLabels} from './blocks/wiki-block-labels';
export type {WikiBlockLabels} from './blocks/wiki-block-labels';
export {CALLOUT_VARIANTS} from './blocks/wiki-callout';
export type {CalloutVariant} from './blocks/wiki-callout';

/**
 * The one extension list, shared by read and edit mode.
 *
 * Read mode is the same editor with `setEditable(false)`, not a separate render path - that is
 * what makes "no layout shift between read and edit" structural rather than a pair of
 * stylesheets that have to be kept in agreement.
 *
 * Sanitisation comes from the schema: a node or mark with no extension here is dropped at parse
 * time. The one thing a schema does not constrain is mark attributes, hence the explicit protocol
 * allowlist on Link - without it a stored `javascript:` href would survive into a live anchor.
 *
 * `labels` carries the resolved translations for the block extensions. They render their own DOM
 * from ProseMirror node views, outside Angular, where neither a pipe nor an injected service is
 * reachable - so the strings are resolved once here and handed down. Omitting the argument falls
 * back to English rather than failing, which keeps this callable from tests and tooling.
 */
export function wikiExtensions(
    placeholder: string,
    labels: WikiBlockLabels = DEFAULT_WIKI_BLOCK_LABELS,
    images: WikiImageSources | null = null,
): Extensions {
    return [
        StarterKit.configure({
            trailingNode: {notAfter: ['taskList', 'bulletList', 'orderedList']},
            // StarterKit 3 bundles both. Registering them again below produced a duplicate-name
            // warning and left it undefined which configuration won - including the protocol
            // allowlist, which is a sanitisation control and not something to leave to chance.
            link: false,
            underline: false,
        }),
        Underline,
        Link.configure({
            openOnClick: false,
            // `user:` carries @mentions. Without it here the mark is dropped at parse time, so a
            // page would lose every mention the moment it was reloaded.
            protocols: ['http', 'https', 'mailto', WIKI_LINK_PROTOCOL, USER_LINK_PROTOCOL],
            // linkify would happily autolink a bare `wiki:` or `user:` string typed as prose.
            shouldAutoLink: url => !url.startsWith(`${WIKI_LINK_PROTOCOL}:`)
                && !url.startsWith(`${USER_LINK_PROTOCOL}:`),
        }),
        // `includeChildren` so the walk reaches inside a toggle - the summary is nested under a
        // non-textblock, and the default walk stops there before it ever sees it.
        Placeholder.configure({
            includeChildren: true,
            placeholder: ({node}) =>
                node.type.name === 'toggleSummary' ? labels.toggleSummaryPlaceholder : placeholder,
        }),
        // `resizable` stays off: it is decided once at construction from an `isEditable` that is
        // still false in read mode, so it would never turn on. WikiTableControls registers the
        // resize plugin itself, gated on the live value.
        Table.configure({resizable: false, cellMinWidth: WIKI_TABLE_CELL_MIN_WIDTH}),
        TableRow,
        TableHeader,
        TableCell,
        WikiTableControls.configure({labels}),
        wikiImage(labels, images),
        TaskList,
        // `nested: true` is what binds Tab inside a checklist. With it off the key was unbound
        // there, the browser's own handling took over, and focus jumped to the checkbox above -
        // reported as "Tab moves upward instead of indenting".
        TaskItem.configure({nested: true, HTMLAttributes: {'data-type': 'taskItem'}}),
        WikiCallout.configure({labels}),
        WikiToggle.configure({labels}),
        WikiToggleSummary,
        WikiToggleBody,
        WikiCodeBlock.configure({labels}),
        WikiTaskFromListItem,
        WikiTabGuard,
        Markdown,
        // After Markdown: it reads that extension's serializer out of editor storage.
        WikiClipboardMarkdown,
    ];
}
