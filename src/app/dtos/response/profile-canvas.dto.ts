/** ISO 8601. The server writes it; nothing on the client parses it except a cache buster. */
export type IsoDate = string;

export type CanvasVisibility = 'everyone' | 'friends' | 'mutuals';

export interface CanvasBackdrop {
    kind: 'gradient' | 'image';
    /** Gradient stops. Ignored when kind is 'image'. */
    from?: string;
    to?: string;
    /** Canvas image id. Ignored when kind is 'gradient'. */
    imageId?: string;
}

export interface CanvasTheme {
    /** Widget accent. Null falls back to the profile's accentColor, then the brand. */
    accent: string | null;
    backdrop: CanvasBackdrop | null;
}

export interface CanvasWidgetDto {
    id: string;
    /** Not a union: an unknown type draws nothing rather than breaking the canvas. */
    type: string;
    x: number;
    y: number;
    w: number;
    h: number;
    visibility: CanvasVisibility;
    /** Drawn in the popout's one column preview. At most two per canvas. */
    card: boolean;
    /** Opaque outside the widget component that owns this type. */
    config: unknown;
}

export interface ProfileCanvasDto {
    profileId: string;
    updatedAt: IsoDate;
    version: number;
    theme: CanvasTheme;
    widgets: CanvasWidgetDto[];
}

/** What PUT sends. The server owns profileId, updatedAt and version. */
export interface CanvasWriteDto {
    theme: CanvasTheme;
    widgets: CanvasWidgetDto[];
}

export interface CanvasImageDto {
    imageId: string;
    url: string;
}
