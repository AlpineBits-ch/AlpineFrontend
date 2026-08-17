export interface CreateThreadDto {
    name: string;
    description?: string;
    /** Posted as the thread's first message server-side - no separate message-create call. */
    content?: string;
    /**
     * Forum posts only. Required (400 otherwise) when the forum has requireTag.
     * Applying a moderated tag needs ManageChannel/ManageAnyThread or the whole
     * request 403s rather than silently dropping the tag.
     */
    tagIds?: string[];
}
