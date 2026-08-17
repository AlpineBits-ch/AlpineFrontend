export interface ReorderChannesDto {
    categories: CategoryPositionDto[];
    channels: ChannelPositionDto[];
}

export interface CategoryPositionDto {
    categoryId: string;
    position: number;
}

export interface ChannelPositionDto {
    channelId: string;
    position: number;
    categoryId?: string | null;
}
