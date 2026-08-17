/**
 * BlurHash decoding, for the blurred placeholder an embed image shows while it loads. Note that
 * Discord's same-named `placeholder` field is thumbhash, not BlurHash.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

/** The only `placeholder_version` this decoder understands. */
export const BLURHASH_PLACEHOLDER_VERSION = 1;

function decode83(str: string): number | null {
    let value = 0;
    for (const char of str) {
        const index = DIGITS.indexOf(char);
        if (index === -1) return null;
        value = value * 83 + index;
    }
    return value;
}

function srgbToLinear(value: number): number {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(value: number): number {
    const v = Math.max(0, Math.min(1, value));
    return v <= 0.0031308
        ? Math.round(v * 12.92 * 255 + 0.5)
        : Math.round((1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255 + 0.5);
}

function signPow(value: number, exp: number): number {
    return Math.sign(value) * Math.pow(Math.abs(value), exp);
}

/** Decodes a BlurHash into RGBA pixels, or null for anything it does not fully understand. */
export function decodeBlurHash(
    hash: string,
    width: number,
    height: number,
    punch = 1,
): Uint8ClampedArray<ArrayBuffer> | null {
    if (!hash || hash.length < 6) return null;

    const sizeFlag = decode83(hash[0]);
    if (sizeFlag === null) return null;
    const componentsX = (sizeFlag % 9) + 1;
    const componentsY = Math.floor(sizeFlag / 9) + 1;
    if (hash.length !== 4 + 2 * componentsX * componentsY) return null;

    const quantisedMax = decode83(hash[1]);
    if (quantisedMax === null) return null;
    const maxValue = (quantisedMax + 1) / 166;

    const colors: [number, number, number][] = new Array(componentsX * componentsY);
    for (let i = 0; i < colors.length; i++) {
        if (i === 0) {
            const value = decode83(hash.substring(2, 6));
            if (value === null) return null;
            colors[i] = [
                srgbToLinear(value >> 16),
                srgbToLinear((value >> 8) & 255),
                srgbToLinear(value & 255),
            ];
        } else {
            const value = decode83(hash.substring(4 + i * 2, 6 + i * 2));
            if (value === null) return null;
            const scale = maxValue * punch;
            colors[i] = [
                signPow((Math.floor(value / (19 * 19)) - 9) / 9, 2) * scale,
                signPow(((Math.floor(value / 19) % 19) - 9) / 9, 2) * scale,
                signPow(((value % 19) - 9) / 9, 2) * scale,
            ];
        }
    }

    const pixels = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let r = 0,
                g = 0,
                b = 0;
            for (let j = 0; j < componentsY; j++) {
                for (let i = 0; i < componentsX; i++) {
                    const basis = Math.cos((Math.PI * x * i) / width) * Math.cos((Math.PI * y * j) / height);
                    const color = colors[i + j * componentsX];
                    r += color[0] * basis;
                    g += color[1] * basis;
                    b += color[2] * basis;
                }
            }
            const offset = 4 * (x + y * width);
            pixels[offset] = linearToSrgb(r);
            pixels[offset + 1] = linearToSrgb(g);
            pixels[offset + 2] = linearToSrgb(b);
            pixels[offset + 3] = 255;
        }
    }
    return pixels;
}

/** Decoded blurs are tiny and identical across every viewer of the same message, so cache them. */
const dataUrlCache = new Map<string, string | null>();
const CACHE_LIMIT = 300;

/**
 * Turns a BlurHash into a `data:` URL usable as a CSS `background-image`, decoded at 32px on the
 * long edge. Null when the hash is unusable or the version is unrecognised.
 */
export function blurHashToDataUrl(
    hash: string | undefined,
    version: number | undefined,
    aspectRatio = 1,
): string | null {
    if (!hash) return null;
    // An unrecognised version is not a BlurHash, whatever it looks like.
    if (version !== undefined && version !== BLURHASH_PLACEHOLDER_VERSION) return null;

    const ratio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;
    const width = ratio >= 1 ? 32 : Math.max(8, Math.round(32 * ratio));
    const height = ratio >= 1 ? Math.max(8, Math.round(32 / ratio)) : 32;

    const cacheKey = `${hash}|${width}x${height}`;
    const cached = dataUrlCache.get(cacheKey);
    if (cached !== undefined) return cached;

    let result: string | null = null;
    try {
        const pixels = decodeBlurHash(hash, width, height);
        if (pixels) {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
                result = canvas.toDataURL();
            }
        }
    } catch {
        result = null;
    }

    if (dataUrlCache.size >= CACHE_LIMIT) dataUrlCache.clear();
    dataUrlCache.set(cacheKey, result);
    return result;
}
