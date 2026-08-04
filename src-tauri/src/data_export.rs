//! Downloading a GDPR data export (T1-7) to disk.
//!
//! The export endpoint answers `302` to a short-lived signed URL on Google Cloud Storage. The
//! webview cannot follow that redirect: the storage bucket serves no `Access-Control-Allow-Origin`,
//! so a `fetch`/`XMLHttpRequest` from the app origin is blocked by CORS and the client sees a
//! status-0 failure indistinguishable from the network being down - while the very same URL
//! downloads fine when pasted into a browser, because a navigation is not CORS-checked.
//!
//! Doing the request here sidesteps that entirely. CORS is a browser policy; a native HTTP client
//! is not subject to it, and the bytes go straight to the file the user picked instead of through a
//! `Blob` held in webview memory.

use std::fmt::Display;
use std::io::Write;

use serde::Serialize;

/// Why a download produced no file.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadError {
    /// The status the export endpoint answered with, or `None` if the request never got an answer.
    ///
    /// `409` (the export failed to build) and `410` (it has been deleted) are answers about the
    /// export rather than faults, and each needs a different sentence and a different next step in
    /// the UI - so the status is carried across rather than flattened into the message.
    pub status: Option<u16>,
    /// Diagnostic detail. Not shown to the user; the UI phrases its own message from `status`.
    pub message: String,
}

impl DownloadError {
    fn transport(e: impl Display) -> Self {
        Self { status: None, message: e.to_string() }
    }
}

/// Fetches `url` with `token` as a bearer and writes the body to `dest`.
///
/// Returns the number of bytes written.
#[tauri::command]
pub async fn download_data_export(
    url: String,
    token: String,
    dest: String,
) -> Result<u64, DownloadError> {
    let client = reqwest::Client::builder().build().map_err(DownloadError::transport)?;

    // reqwest's default redirect policy strips `Authorization` once a redirect crosses to another
    // host, so the signed storage URL is fetched with nothing but the signature it was issued with.
    // That matters beyond tidiness: Cloud Storage rejects a request carrying both an `Authorization`
    // header and a query signature.
    let mut response = client
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(DownloadError::transport)?;

    let status = response.status();
    if !status.is_success() {
        return Err(DownloadError {
            status: Some(status.as_u16()),
            message: format!("export download answered {}", status),
        });
    }

    let mut file = std::fs::File::create(&dest).map_err(DownloadError::transport)?;
    let outcome = stream_to_file(&mut response, &mut file).await;

    // Closed before any cleanup: Windows refuses to unlink a file that still has an open handle.
    drop(file);

    match outcome {
        Ok(written) => Ok(written),
        // A truncated zip that looks like a finished download is worse than no file at all, so a
        // stream that dies part-way takes the partial file with it.
        Err(e) => {
            let _ = std::fs::remove_file(&dest);
            Err(e)
        }
    }
}

/// Streamed rather than buffered: an export bundles every message and attachment the account ever
/// produced, so its size is bounded by the account, not by anything we control.
async fn stream_to_file(
    response: &mut reqwest::Response,
    file: &mut std::fs::File,
) -> Result<u64, DownloadError> {
    let mut written: u64 = 0;
    while let Some(chunk) = response.chunk().await.map_err(DownloadError::transport)? {
        file.write_all(&chunk).map_err(DownloadError::transport)?;
        written += chunk.len() as u64;
    }
    file.flush().map_err(DownloadError::transport)?;
    Ok(written)
}
