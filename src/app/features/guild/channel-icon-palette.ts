export interface ChannelIconSwatch {
    /** Suffix of `CHANNEL_SETTINGS.ICON_COLOR.<name>`. */
    name: string;
    value: string;
}

/** Every value clears 3:1 against the sidebar surface; `channel-icon-palette.spec.ts` holds that line. */
export const CHANNEL_ICON_PALETTE: readonly ChannelIconSwatch[] = [
    {name: 'red', value: '#F87171'},
    {name: 'orange', value: '#FB923C'},
    {name: 'amber', value: '#FBBF24'},
    {name: 'lime', value: '#A3E635'},
    {name: 'green', value: '#4ADE80'},
    {name: 'teal', value: '#2DD4BF'},
    {name: 'cyan', value: '#22D3EE'},
    {name: 'blue', value: '#60A5FA'},
    {name: 'indigo', value: '#818CF8'},
    {name: 'violet', value: '#A78BFA'},
    {name: 'pink', value: '#F472B6'},
    {name: 'rose', value: '#FB7185'},
];
