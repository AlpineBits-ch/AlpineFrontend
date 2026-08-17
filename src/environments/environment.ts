export const environment = {
    production: true,
    /** Publish screen shares from Rust (hardware H.264) instead of the canvas pipeline, which stays as the fallback. */
    rustPublisher: true,
    apiUrl: 'https://api.venta.gg',
    klipyApiKey: 'urPFHj6XtUHQIo9G5XD3nvudiXcyRIiad68WfDV0DV8WmJXSFfxFC4PGqcRTXuL5',
    /** Stripe's publishable key: a fallback only. The instance's own key from the entitlement snapshot wins. */
    stripePublishableKey:
        'pk_live_51TY1AeK8q2dIPPgJeECY30hR7n6iuBTacdUVE7FNEQ5WSe38VUBbiUJehoqx9Xua0vnFAWUiFGKicu3KTNkvWpLC009vrw8XAE',
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
        },
    ],
    /** Dev-only tuning for Isle proximity (positional) voice. Consumed by {@link SpatialAudioService}. */
    isleVoice: {
        /** Directional intensity, 0 to 1: 1 = full HRTF panning, 0 = mono/centered. Spatial toggle only. */
        spatialIntensity: 0.6,
        /** Web Audio panning model: 'HRTF' (binaural) or 'equalpower' (cheaper, softer). */
        panningModel: 'HRTF',
        /** Full-volume radius in Unreal units (cm) = 15 m; fades gradually past it. */
        refDistance: 1500,
        /** Inaudible beyond this (cm). Must stay <= backend CellSize (80 m). */
        maxDistance: 8000,
        /** Distance attenuation steepness (inverse model). Above 1, or distant peers stay audible and the mix muddies. */
        rolloffFactor: 1.6,
    },
};
