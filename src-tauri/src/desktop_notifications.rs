use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

/// Downloads an image URL to a temp file (cached by URL hash) and returns
/// a `file:///` URI that WinRT / UNUserNotificationCenter can load locally.
pub async fn fetch_icon(url: &str) -> Option<String> {
    let mut h = DefaultHasher::new();
    url.hash(&mut h);
    let hash = h.finish();

    let mut path = std::env::temp_dir();
    path.push(format!("alpine_avatar_{hash:016x}.png"));

    if !path.exists() {
        let bytes = reqwest::get(url).await.ok()?.bytes().await.ok()?;
        std::fs::write(&path, &bytes).ok()?;
    }

    path.to_str()
        .map(|p| format!("file:///{}", p.replace('\\', "/")))
}
