
export interface ConversationMemberDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    userId: string;
    cachedUserName: string;
    cachedUserHash: number;
}
export interface ConversationDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    name: string | undefined;
    members: ConversationMemberDto[];
}