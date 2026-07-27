export function cacheBustedUrl(url: string | null | undefined, updatedAt: Date | string | null | undefined): string | undefined {
    if (!url) return undefined;
    if (!updatedAt) return url;
    const version = new Date(updatedAt).getTime();
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}_t=${version}`;
}
