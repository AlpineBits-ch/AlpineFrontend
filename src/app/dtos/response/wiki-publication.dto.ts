/** Where a guild's wiki lives on the public internet, if it lives there at all. */
export interface WikiPublicationDto {
    guildId: string;
    /** The DNS label the wiki is served under. Null when the wiki is not public. */
    slug: string | null;
    /**
     * The zone published wikis sit in, e.g. `wiki.venta.gg`. Instance-specific, so it comes from
     * the server; `PUBLIC_WIKI_HOST_FALLBACK` stands in only until this read lands.
     */
    host?: string | null;
    /** How many pages have opted in, whether or not the wiki itself is published. */
    publishedPageCount?: number;
}

export interface SetWikiPublicationDto {
    /** Null or empty takes the whole wiki off the public host. */
    slug: string | null;
}

export interface WikiPagePublicationDto {
    pageId: string;
    published: boolean;
}

export interface SetWikiPagePublicationDto {
    published: boolean;
}
