export const environment = {
    production: false,
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
    ]
};
