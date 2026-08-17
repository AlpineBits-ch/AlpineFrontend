export interface PendingWelcomeDto {
    conversationId: string;
    userId: string;
    deviceId: string;
    createdAt: Date;
    welcome: string;
}