//! Runtime provisioning of Cisco's precompiled OpenH264 binary.
//!
//! # Why this exists
//!
//! H.264 is patent-encumbered. OpenH264's source is BSD-2-Clause, which grants copyright rights but
//! *not* patent rights, so compiling it ourselves would make us an independent implementer owing
//! royalties to the AVC pool. Cisco pays those royalties -but only for the binary modules they
//! themselves compile and distribute. Using their binary puts us downstream of a licence that has
//! already been paid for; building from source does not.
//!
//! Two consequences shape this module:
//!
//! - The binary is downloaded from Cisco at runtime rather than vendored. We must not bundle or
//!   mirror it, because a copy we redistribute is no longer the copy Cisco licensed. That rules out
//!   the obvious reliability fix, so robustness here comes from retries, a permanent cache and a
//!   graceful fallback instead.
//! - The download is unattended. Cisco's FAQ frames this as happening "at the time the product is
//!   installed"; we do it on first run, which is also how Firefox ships OpenH264.
//!
//! If provisioning never succeeds, screen sharing still works -it falls back to the existing
//! capture path, where the webview does the encoding under Microsoft's own codec licence.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use sha2::Digest;

/// The only version `openh264-sys2` will load: it checks a downloaded blob's SHA-256 against a
/// baked-in list, and 0.9 ships hashes for 2.6.0. Bumping the crate means revisiting this.
const VERSION: &str = "2.6.0";
const BASE_URL: &str = "https://ciscobinary.openh264.org";

/// Attempts before giving up for this run. Provisioning retries again on the next app start, and
/// the cache makes success permanent, so there is no need to be aggressive.
const MAX_ATTEMPTS: u32 = 3;
const RETRY_BACKOFF: Duration = Duration::from_secs(5);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);

/// Cisco's binary for one platform.
struct Blob {
    /// File name as published by Cisco, and as named in `openh264-sys2`'s hash list.
    file: &'static str,
    /// SHA-256 of the *decompressed* library.
    sha256: &'static str,
}

/// Path to the verified local copy, once provisioning has succeeded.
static RESOLVED: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

fn resolved_slot() -> &'static Mutex<Option<PathBuf>> {
    RESOLVED.get_or_init(|| Mutex::new(None))
}

/// The blob for the current platform, or `None` where Cisco publishes nothing we can use.
fn blob() -> Option<Blob> {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return Some(Blob {
        file: "openh264-2.6.0-win64.dll",
        sha256: "2076cb5675ec6c1a4c70e7a2a322552f547b6eeed649d6dfcd9e02a543b24691",
    });

    #[cfg(all(target_os = "windows", target_arch = "x86"))]
    return Some(Blob {
        file: "openh264-2.6.0-win32.dll",
        sha256: "b0098db6acbd290a1fe13997d61d461e7327e39b42bf868db41faf498b7621a2",
    });

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return Some(Blob {
        file: "libopenh264-2.6.0-mac-arm64.dylib",
        sha256: "052e98bfcf7a9167d22f3bbb3f5988ef79065591f36af8b52924b22b13624551",
    });

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return Some(Blob {
        file: "libopenh264-2.6.0-mac-x64.dylib",
        sha256: "e3dc8bc01fe69363f61fd3c02fd27798537a585eadd38cd808f303d1ee505a19",
    });

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return Some(Blob {
        file: "libopenh264-2.6.0-linux64.8.so",
        sha256: "2f0cde7c6a6abcf5cae76942894ea42897fa677bce4ed6c91a24dd1b041d5f04",
    });

    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    return Some(Blob {
        file: "libopenh264-2.6.0-linux-arm64.8.so",
        sha256: "12e7b33623667cdab0e575170c147b1b36eadb77d0d2aa7ceb5afd3e58902140",
    });

    #[cfg(not(any(
        all(target_os = "windows", any(target_arch = "x86_64", target_arch = "x86")),
        all(target_os = "macos", any(target_arch = "aarch64", target_arch = "x86_64")),
        all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64")),
    )))]
    return None;
}

/// Download URL for the current platform's blob. Cisco serves them bzip2-compressed.
fn download_url(blob: &Blob) -> String {
    format!("{BASE_URL}/{}.bz2", blob.file)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = sha2::Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Path the verified library is cached at, given the app's data directory.
pub fn cache_path(data_dir: &Path, blob_file: &str) -> PathBuf {
    data_dir.join("openh264").join(blob_file)
}

/// Path to a provisioned, hash-verified OpenH264, if one is ready.
///
/// Cheap and synchronous: the encoder calls this on every session start and must not block.
pub fn ready_path() -> Option<PathBuf> {
    resolved_slot().lock().ok()?.clone()
}

/// Make a verified OpenH264 available, downloading it if necessary.
///
/// Safe to call repeatedly; returns immediately once the cache is populated. Errors are returned
/// rather than logged-and-swallowed so the caller can decide whether a failure is worth surfacing.
pub async fn ensure(data_dir: PathBuf) -> Result<PathBuf, String> {
    if let Some(path) = ready_path() {
        return Ok(path);
    }

    let blob = blob().ok_or_else(|| {
        format!(
            "Cisco publishes no OpenH264 build for {}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;
    let path = cache_path(&data_dir, blob.file);

    // A previous run may already have fetched it. Re-verify rather than trust the file name: a
    // truncated or tampered cache should be replaced, not loaded.
    if let Ok(bytes) = std::fs::read(&path) {
        if sha256_hex(&bytes) == blob.sha256 {
            *resolved_slot().lock().map_err(|e| e.to_string())? = Some(path.clone());
            return Ok(path);
        }
        let _ = std::fs::remove_file(&path);
    }

    let mut last_error = String::new();
    for attempt in 1..=MAX_ATTEMPTS {
        match fetch_and_verify(&blob).await {
            Ok(bytes) => {
                write_atomically(&path, &bytes)?;
                *resolved_slot().lock().map_err(|e| e.to_string())? = Some(path.clone());
                eprintln!("[openh264] provisioned {} from Cisco", blob.file);
                return Ok(path);
            }
            Err(e) => {
                last_error = e;
                eprintln!("[openh264] provisioning attempt {attempt}/{MAX_ATTEMPTS} failed: {last_error}");
                if attempt < MAX_ATTEMPTS {
                    tokio::time::sleep(RETRY_BACKOFF * attempt).await;
                }
            }
        }
    }

    Err(last_error)
}

async fn fetch_and_verify(blob: &Blob) -> Result<Vec<u8>, String> {
    let url = download_url(blob);
    let client = reqwest::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;

    let response = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("{url} returned HTTP {}", response.status()));
    }

    let compressed = response.bytes().await.map_err(|e| e.to_string())?;
    let library = decompress_bz2(&compressed)?;

    // The whole point of using Cisco's build is that it is *their* build. A hash mismatch means we
    // have something else, and loading it would forfeit both the licence and the trust assumption.
    let actual = sha256_hex(&library);
    if actual != blob.sha256 {
        return Err(format!(
            "hash mismatch for {}: expected {}, got {actual}",
            blob.file, blob.sha256
        ));
    }

    Ok(library)
}

fn decompress_bz2(compressed: &[u8]) -> Result<Vec<u8>, String> {
    use std::io::Read;

    let mut decoder = bzip2_rs::DecoderReader::new(compressed);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

/// Write via a temporary file and rename, so a crash or a second instance mid-write can never leave
/// a half-written library that later passes as cached.
fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let temp = path.with_extension(format!("part{}", std::process::id()));
    std::fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    // Windows rename fails onto an existing path.
    let _ = std::fs::remove_file(path);
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        e.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publishes_a_blob_for_this_platform() {
        // Every platform the desktop app targets must resolve, or screen sharing silently loses
        // its encoder there.
        assert!(blob().is_some(), "no OpenH264 blob mapped for this platform");
    }

    #[test]
    fn expected_hash_is_a_sha256_hex_digest() {
        let blob = blob().unwrap();
        assert_eq!(blob.sha256.len(), 64);
        assert!(blob.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
    }

    #[test]
    fn download_url_targets_ciscos_bzip2_archive() {
        let blob = blob().unwrap();
        let url = download_url(&blob);
        assert!(url.starts_with("https://ciscobinary.openh264.org/"));
        assert!(url.ends_with(".bz2"));
        assert!(url.contains(VERSION), "url must pin the version the crate can verify");
    }

    #[test]
    fn cache_path_is_namespaced_under_the_data_dir() {
        let path = cache_path(Path::new("/data"), "openh264-2.6.0-win64.dll");
        assert!(path.ends_with("openh264/openh264-2.6.0-win64.dll"));
    }

    #[test]
    fn sha256_matches_a_known_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn atomic_write_replaces_an_existing_file() {
        let dir = std::env::temp_dir().join(format!("alpine-oh264-{}", std::process::id()));
        let path = dir.join("lib.bin");

        write_atomically(&path, b"first").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"first");

        write_atomically(&path, b"second").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second");

        // No stray temp files survive a successful write.
        let strays: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("part"))
            .collect();
        assert!(strays.is_empty(), "temporary files left behind: {strays:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn decompresses_a_bzip2_stream() {
        // "hello openh264\n" compressed with `bzip2 -9`. Cisco serves the library bzip2-compressed,
        // so a decoder that silently produced nothing would poison the cache with an empty file.
        let compressed = [
            0x42u8, 0x5a, 0x68, 0x39, 0x31, 0x41, 0x59, 0x26, 0x53, 0x59, 0x61, 0xa8,
            0x18, 0xe8, 0x00, 0x00, 0x04, 0x59, 0x80, 0x00, 0x10, 0x40, 0x00, 0x15,
            0x00, 0x02, 0x45, 0xc0, 0x00, 0x20, 0x00, 0x22, 0x00, 0x69, 0x90, 0x80,
            0x69, 0xa6, 0x8a, 0x23, 0x76, 0x52, 0x05, 0x44, 0x23, 0xe2, 0xee, 0x48,
            0xa7, 0x0a, 0x12, 0x0c, 0x35, 0x03, 0x1d, 0x00,
        ];
        assert_eq!(decompress_bz2(&compressed).unwrap(), b"hello openh264\n");
    }

    #[test]
    fn rejects_a_malformed_bzip2_stream() {
        // Must error rather than yield a truncated library that would then fail the hash check
        // with a confusing message -or worse, be written to the cache.
        assert!(decompress_bz2(&[0x00, 0x01, 0x02]).is_err());
    }
}
