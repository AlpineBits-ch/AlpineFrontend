import {WikiVisibility} from '../response/wiki.dto';

export interface CreateWikiPageDto {
    title: string;
    content?: string;
    parentPageId?: string;
    categoryId?: string;
    visibility?: WikiVisibility;
    tags?: string[];
    isPinned?: boolean;
}

export interface UpdateWikiPageDto {
    title?: string;
    content?: string;
    parentPageId?: string | null;
    categoryId?: string | null;
    visibility?: WikiVisibility;
    tags?: string[];
    isPinned?: boolean;
}

export interface CreateWikiCategoryDto {
    name: string;
    position?: number;
    parentCategoryId?: string;
}

export interface UpdateWikiCategoryDto {
    name?: string;
    position?: number;
    parentCategoryId?: string | null;
}
