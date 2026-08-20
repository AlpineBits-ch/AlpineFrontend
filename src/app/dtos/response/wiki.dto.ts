export type WikiVisibility = 'public' | 'private';

export interface WikiPageSummaryDto {
    id: string;
    guildId: string;
    title: string;
    slug: string;
    authorId: string;
    lastEditorId?: string;
    createdAt: Date;
    updatedAt: Date;
    parentPageId?: string;
    categoryId?: string;
    visibility: WikiVisibility;
    tags: string[];
    isPinned: boolean;
    revisionCount: number;
    /** Present only when the wiki was fetched with `includeContent`. */
    content?: string;
    /** An emoji shown beside the title. */
    icon?: string | null;
    coverUrl?: string | null;
    /** The character this page is, when it is one. */
    personaId?: string | null;
    /** Opaque to everything but the infobox renderer. Shaped by the category's template. */
    infoboxJson?: string | null;
    /**
     * When this page opted into the public host, null otherwise. The server sends a timestamp, not
     * a boolean - read it through {@link isPagePublished}. Necessary for public readability, never
     * sufficient: the guild needs a published slug too. Distinct from {@link visibility}, which has
     * never been read.
     */
    publishedAt?: string | null;
}

/** The one place the timestamp becomes the boolean every caller actually wants. */
export function isPagePublished(page: Pick<WikiPageSummaryDto, 'publishedAt'> | null | undefined): boolean {
    return page?.publishedAt != null;
}

/** Writes the flag back optimistically in the shape the server would have sent. */
export function withPagePublished<T extends Pick<WikiPageSummaryDto, 'publishedAt'>>(
    page: T,
    published: boolean,
): T {
    return {...page, publishedAt: published ? new Date().toISOString() : null};
}

export interface WikiPageDto extends WikiPageSummaryDto {
    content: string;
}

export interface WikiCategoryDto {
    id: string;
    guildId: string;
    name: string;
    position: number;
    parentCategoryId?: string;
    /** The field list every infobox in this category is drawn from. See `persona-infobox.ts`. */
    infoboxTemplateJson?: string | null;
}

export interface WikiDto {
    id: string;
    guildId: string;
    categories: WikiCategoryDto[];
    pages: WikiPageSummaryDto[];
}

export interface WikiGraphNodeDto {
    id: string;
    title: string;
    icon?: string | null;
    parentPageId?: string | null;
    categoryId?: string | null;
}

export interface WikiGraphEdgeDto {
    sourcePageId: string;
    targetPageId: string;
    /** The section of the target the link points at, null for the page as a whole. */
    headingId?: string | null;
}

export interface WikiGraphDto {
    nodes: WikiGraphNodeDto[];
    /** Body links only. The tree is not in here: derive it from `nodes[].parentPageId`. */
    edges: WikiGraphEdgeDto[];
}

export interface WikiRevisionDto {
    id: string;
    pageId: string;
    content: string;
    editorId: string;
    createdAt: Date;
    revisionNumber: number;
    summary?: string;
}
