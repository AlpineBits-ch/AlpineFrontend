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
}

export interface WikiPageDto extends WikiPageSummaryDto {
  content: string;
}

export interface WikiCategoryDto {
  id: string;
  guildId: string;
  name: string;
  position: number;
}

export interface WikiDto {
  id: string;
  guildId: string;
  categories: WikiCategoryDto[];
  pages: WikiPageSummaryDto[];
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
