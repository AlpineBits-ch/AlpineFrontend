/** Body for snapshotting an existing guild's structure into a template. */
export interface CreateTemplateDto {
    name: string;
    description?: string;
}

/** Body for creating a brand-new guild from an existing template. */
export interface UseTemplateDto {
    name: string;
    description?: string;
}
