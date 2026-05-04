export function decodeContent(encoded: string): string {
  try {
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

export function fileIcon(contentType: string): string {
  if (contentType.startsWith('video/')) return 'pi-video';
  if (contentType.startsWith('audio/')) return 'pi-volume-up';
  if (contentType === 'application/pdf') return 'pi-file-pdf';
  if (contentType.includes('zip') || contentType.includes('rar') || contentType.includes('tar')) return 'pi-folder';
  if (contentType.startsWith('text/')) return 'pi-file-edit';
  return 'pi-file';
}
