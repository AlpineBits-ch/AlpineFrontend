export const environment = {
    production: false,
    /**
     * Publish screen shares from Rust (hardware H.264, no JPEG round trip) instead of the
     * canvas pipeline. The canvas path remains as the fallback and is what runs when this is
     * false, so flipping it back is a one-line rollback if the publisher misbehaves.
     */
    rustPublisher: true,
    apiUrl: 'https://api.venta.gg',
    klipyApiKey: 'urPFHj6XtUHQIo9G5XD3nvudiXcyRIiad68WfDV0DV8WmJXSFfxFC4PGqcRTXuL5',
    iceServers: [
        {
            urls: [
                'stun:stun.cloudflare.com:3478',
                'turn:turn.cloudflare.com:3478?transport=udp',
                'turn:turn.cloudflare.com:3478?transport=tcp',
                'turns:turn.cloudflare.com:5349?transport=tcp',
            ],
            username: 'xxxx',
            credential: 'yyyy',
        }
    ],
    /**
     * Dev-only tuning for Isle proximity (positional) voice. Consumed by
     * {@link SpatialAudioService}. Not surfaced in the UI -tweak here.
     */
    isleVoice: {
        /**
         * Directional intensity, 0–1. 1 = full HRTF panning (a 90° source lands
         * almost entirely in one ear); 0 = mono/centered (no direction). Values
         * in between blend the panned signal with a centered copy so direction is
         * still findable without being ear-exclusive. Only applies when the user's
         * spatial toggle is on.
         */
        spatialIntensity: 0.6,
        /** Web Audio panning model: 'HRTF' (binaural) or 'equalpower' (cheaper, softer). */
        panningModel: 'HRTF',
        /** Full-volume radius in Unreal units (cm) = 15 m; fades gradually past it. */
        refDistance: 1500,
        /** Inaudible beyond this (cm) -must stay <= backend CellSize (80 m). */
        maxDistance: 8000,
        /**
         * Distance attenuation steepness (inverse model). Raised above 1 because
         * the inverse tail is long over 80 m -a flatter curve leaves a crowd of
         * distant peers audible at once and the mix turns muddy.
         */
        rolloffFactor: 1.6,
    },
};
