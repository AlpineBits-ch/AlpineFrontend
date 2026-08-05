import {Extensions} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Underline from '@tiptap/extension-underline';
import {Table} from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import Image from '@tiptap/extension-image';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import {Markdown} from '@tiptap/markdown';
import {WIKI_LINK_PROTOCOL} from '../wiki-links';

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
 */
export function wikiExtensions(placeholder: string): Extensions {
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
            protocols: ['http', 'https', 'mailto', WIKI_LINK_PROTOCOL],
            // linkify would happily autolink a bare `wiki:` string typed as prose.
            shouldAutoLink: url => !url.startsWith(`${WIKI_LINK_PROTOCOL}:`),
        }),
        Placeholder.configure({placeholder}),
        Table.configure({resizable: false}),
        TableRow,
        TableHeader,
        TableCell,
        Image.configure({inline: false, allowBase64: false}),
        TaskList,
        TaskItem.configure({nested: false, HTMLAttributes: {'data-type': 'taskItem'}}),
        Markdown,
    ];
}
