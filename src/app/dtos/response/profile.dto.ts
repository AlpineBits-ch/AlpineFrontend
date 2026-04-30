export interface ProfileDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    userName: string;
    hash: number;
    bio: string | undefined;
    userId: string;
    avatarUrl: string | undefined;
}