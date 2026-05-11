use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager};
use windows::{
    core::{IInspectable, HSTRING, PCWSTR},
    Data::Xml::Dom::XmlDocument,
    Foundation::TypedEventHandler,
    UI::Notifications::{ToastNotification, ToastNotificationManager},
    Win32::System::Registry::{
        RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    },
    Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID,
};

const AUMID: &str = "Alpine";

pub fn setup(display_name: &str) {
    if let Err(e) = register_aumid(display_name) {
        eprintln!("[notifications] AUMID registration failed: {e}");
    }
    if let Err(e) = set_process_aumid() {
        eprintln!("[notifications] SetCurrentProcessExplicitAppUserModelID failed: {e}");
    }
}

fn register_aumid(display_name: &str) -> windows::core::Result<()> {
    let key_path = format!("Software\\Classes\\AppUserModelId\\{AUMID}");
    let key_path_w: Vec<u16> = key_path.encode_utf16().chain([0u16]).collect();
    let value_name_w: Vec<u16> = "DisplayName\0".encode_utf16().collect();
    let display_w: Vec<u16> = display_name.encode_utf16().chain([0u16]).collect();

    let mut hkey = HKEY::default();
    unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(key_path_w.as_ptr()),
            0,
            PCWSTR(std::ptr::null()),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            None,
            &mut hkey,
            None,
        )
        .ok()?;

        RegSetValueExW(
            hkey,
            PCWSTR(value_name_w.as_ptr()),
            0,
            REG_SZ,
            Some(std::slice::from_raw_parts(
                display_w.as_ptr().cast::<u8>(),
                display_w.len() * 2,
            )),
        )
        .ok()?;
    }
    Ok(())
}

fn set_process_aumid() -> windows::core::Result<()> {
    unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(AUMID)) }
}

pub async fn send_toast(
    app: AppHandle,
    title: &str,
    body: &str,
    icon_url: Option<&str>,
    extra: HashMap<String, String>,
) -> Result<(), String> {
    let local_icon = if let Some(url) = icon_url {
        crate::desktop_notifications::fetch_icon(url).await
    } else {
        None
    };

    let icon_xml = local_icon
        .as_deref()
        .map(|u| {
            format!(
                r#"<image placement="appLogoOverride" hint-crop="circle" src="{}"/>"#,
                escape_xml(u)
            )
        })
        .unwrap_or_default();

    let args = serde_json::to_string(&extra).map_err(|e| e.to_string())?;
    let args_esc = escape_xml(&args);

    let xml = format!(
        r#"<toast activationType="foreground" launch="{args}">
  <visual>
    <binding template="ToastGeneric">
      <text>{title}</text>
      <text>{body}</text>
      {icon}
    </binding>
  </visual>
</toast>"#,
        args = args_esc,
        title = escape_xml(title),
        body = escape_xml(body),
        icon = icon_xml,
    );

    let doc = XmlDocument::new().map_err(|e| e.to_string())?;
    doc.LoadXml(&HSTRING::from(xml)).map_err(|e| e.to_string())?;

    let toast =
        ToastNotification::CreateToastNotification(&doc).map_err(|e| e.to_string())?;

    toast
        .Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new({
            let app = app.clone();
            move |_, _| {
                let _ = app.emit("notification-action", &extra);
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
                Ok(())
            }
        }))
        .map_err(|e| e.to_string())?;

    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID))
        .map_err(|e| e.to_string())?
        .Show(&toast)
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
