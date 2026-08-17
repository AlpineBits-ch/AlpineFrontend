/**
 * The desktop-only half of a GDPR data-export download.
 *
 * <p><b>Why this is not {@code FileSaver}.</b> That port takes the bytes as an argument, and these
 * bytes must never pass through the webview. The export endpoint answers `302` to a short-lived signed
 * URL on Google Cloud Storage, and that bucket serves no `Access-Control-Allow-Origin`, so a fetch from
 * the page is blocked by CORS for an artifact that is sitting there intact. The native client is not
 * subject to CORS and streams straight to the chosen file instead of holding an account-sized zip in
 * webview memory as a `Blob`. See `DataExportService.saveToDisk`.</p>
 *
 * <p>So the shape here is "pick a path, then have Rust write it", which no port models - and one is not
 * invented for it, because this is one screen's need rather than a platform capability. What makes it
 * legal instead is the boundary rule: the plugin imports live under `src/app/platform/`, and both
 * functions are reached only after `DataExportService.canSaveToDisk` has said this is a desktop host.
 * Both {@code import()} their dependency on call, so a browser client loads neither.</p>
 */

/** The `download_data_export` Rust command's arguments, spelled exactly as `data_export.rs` reads them. */
export interface DataExportDownloadArgs {
    /** The `/download` endpoint. Rust follows the redirect it answers with. */
    url: string;
    /**
     * The bearer, passed explicitly.
     *
     * <p>The HTTP interceptors do not reach a request made outside the webview. `reqwest` drops it
     * again when the redirect crosses to the storage host, so the signed URL is fetched with nothing
     * but its own signature.</p>
     */
    token: string;
    /** An absolute path the shell has already confirmed the user chose. */
    dest: string;
}

/**
 * Asks the shell where to put the archive. Null when the dialog was dismissed.
 *
 * <p>A path rather than a boolean, which is the other reason {@code FileSaver} cannot serve: the
 * destination has to be handed to Rust, and that port deliberately never reveals one.</p>
 */
export async function chooseDataExportPath(suggestedName: string): Promise<string | null> {
    const {save} = await import('@tauri-apps/plugin-dialog');
    return save({
        defaultPath: suggestedName,
        filters: [{name: 'Zip archive', extensions: ['zip']}],
    });
}

/**
 * Streams the artifact to `dest` through the native HTTP client. Resolves with the bytes written.
 *
 * <p>Rejects with the `DownloadError` shape from `src-tauri/src/data_export.rs`, which
 * `downloadErrorStatus` reads the status out of - a `409`, `410` or `401` here is an answer about the
 * export, not a transport failure.</p>
 */
export async function streamDataExportToFile(args: DataExportDownloadArgs): Promise<number> {
    const {invoke} = await import('@tauri-apps/api/core');
    return invoke<number>('download_data_export', {...args});
}
