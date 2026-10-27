//! Update check and install on top of tauri-plugin-updater.
//!
//! The webview never talks to the updater plugin directly (no permissions in the capability file): it
//! calls the commands below, so the endpoint, the once-a-day limit and the portable/installed decision
//! stay in one place. Releases publish a signed `latest.json` (see .github/workflows/release.yml); the
//! public key that verifies the installer is in `plugins.updater.pubkey` of tauri.conf.json.

use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Replaces the manifest URL, e.g. to serve a fake `latest.json` in tests. Honored only with an isolated
/// profile (`KLADDE_DATA_DIR`), so a stray variable can never redirect a real installation. An isolated
/// profile without it does not check at all.
pub const URL_ENV: &str = "KLADDE_UPDATE_URL";

/// Time of the last successful check, kept in the data folder (not in settings.json).
const CHECK_FILE: &str = "last-update-check";
const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// The update found by the last check, waiting for "Update now".
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    /// The release notes field of the manifest, if any.
    notes: Option<String>,
    /// A portable exe cannot be replaced by the installer: it is only offered the download page.
    portable: bool,
}

#[derive(Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum Progress {
    Downloading { downloaded: u64, total: Option<u64> },
    Installing,
}

/// The NSIS installer writes `uninstall.exe` into the install folder, a portable exe has none next to it.
pub fn is_installed(exe: &Path) -> bool {
    exe.parent().is_some_and(|dir| dir.join("uninstall.exe").is_file())
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// A check is due once a day. A timestamp in the future (clock changed) counts as due.
fn is_due(last: Option<u64>, now: u64) -> bool {
    match last {
        Some(last) if last <= now => now - last >= CHECK_INTERVAL.as_secs(),
        _ => true,
    }
}

fn last_check(dir: &Path) -> Option<u64> {
    std::fs::read_to_string(dir.join(CHECK_FILE)).ok()?.trim().parse().ok()
}

fn endpoint_override() -> Option<String> {
    crate::session::isolated_profile()?;
    std::env::var(URL_ENV).ok().filter(|v| !v.is_empty())
}

async fn find_update(app: &AppHandle) -> Result<Option<Update>, String> {
    let mut builder = app.updater_builder().timeout(REQUEST_TIMEOUT);
    if let Some(url) = endpoint_override() {
        let url = url.parse().map_err(|e| format!("{URL_ENV} is not a URL: {e}"))?;
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    builder.build().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())
}

/// Looks for a newer version. `manual` (the command) always asks; the automatic check at start skips the
/// request when one succeeded within the last day. Returns None when there is nothing new (or nothing to do).
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    pending: State<'_, Pending>,
    manual: bool,
) -> Result<Option<UpdateInfo>, String> {
    let dir = crate::session::data_dir(&app)?;
    if !manual && !is_due(last_check(&dir), now_secs()) {
        return Ok(None);
    }
    // Test profiles never talk to the real GitHub: they get a fake manifest or no check at all.
    if crate::session::isolated_profile().is_some() && endpoint_override().is_none() {
        return if manual { Err(format!("Set {URL_ENV} to check for updates in an isolated profile.")) } else { Ok(None) };
    }
    let update = find_update(&app).await?;
    // Only a completed check counts: while offline Kladde asks again at the next start.
    let _ = std::fs::write(dir.join(CHECK_FILE), now_secs().to_string());
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        notes: u.body.clone().filter(|b| !b.trim().is_empty()),
        portable: std::env::current_exe().map(|exe| !is_installed(&exe)).unwrap_or(true),
    });
    *pending.0.lock().map_err(|e| e.to_string())? = update;
    Ok(info)
}

/// Downloads and verifies the update found by `update_check`, then runs the installer (passive mode). On
/// Windows the installer replaces the app, so this does not return on success: the app exits and the
/// installer starts the new version. The frontend saves the session first.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    pending: State<'_, Pending>,
    on_event: Channel<Progress>,
) -> Result<(), String> {
    // Never run an installer from a test profile, whatever the manifest says.
    if crate::session::isolated_profile().is_some() {
        return Err("Updates are not installed in an isolated profile.".into());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if !is_installed(&exe) {
        return Err("This portable copy cannot update itself. Download the new version instead.".into());
    }
    // A failed attempt consumed the update, so look again instead of making the user do it.
    let kept = pending.0.lock().map_err(|e| e.to_string())?.take();
    let update = match kept {
        Some(update) => update,
        None => find_update(&app).await?.ok_or("There is no newer version.")?,
    };
    let mut downloaded = 0u64;
    let progress = on_event.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress.send(Progress::Downloading { downloaded, total });
            },
            move || {
                let _ = on_event.send(Progress::Installing);
            },
        )
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("kladde-update-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn check_is_due_once_a_day() {
        let day = CHECK_INTERVAL.as_secs();
        assert!(is_due(None, 1_000_000));
        assert!(!is_due(Some(1_000_000), 1_000_000 + day - 1));
        assert!(is_due(Some(1_000_000), 1_000_000 + day));
        // Clock set back: ask again instead of waiting for the old timestamp.
        assert!(is_due(Some(2_000_000), 1_000_000));
    }

    #[test]
    fn last_check_reads_the_marker() {
        let dir = temp("marker");
        assert_eq!(last_check(&dir), None);
        std::fs::write(dir.join(CHECK_FILE), "1234\n").unwrap();
        assert_eq!(last_check(&dir), Some(1234));
        std::fs::write(dir.join(CHECK_FILE), "garbage").unwrap();
        assert_eq!(last_check(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn installed_means_uninstaller_next_to_the_exe() {
        let dir = temp("installed");
        let exe = dir.join("kladde.exe");
        std::fs::write(&exe, "").unwrap();
        assert!(!is_installed(&exe));
        std::fs::write(dir.join("uninstall.exe"), "").unwrap();
        assert!(is_installed(&exe));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
