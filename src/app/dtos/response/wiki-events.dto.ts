export interface WsWikiPageCreated {
    pageId: string;
    guildId: string;
}

export interface WsWikiPageUpdated {
    pageId: string;
    guildId: string;
}

export interface WsWikiPageDeleted {
    pageId: string;
    guildId: string;
}

export interface WsWikiCategoryCreated {
    categoryId: string;
    guildId: string;
}

export interface WsWikiCategoryUpdated {
    categoryId: string;
    guildId: string;
}

export interface WsWikiCategoryDeleted {
    categoryId: string;
    guildId: string;
}
