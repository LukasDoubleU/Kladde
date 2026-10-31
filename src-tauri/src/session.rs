//! Persistence in the app data directory: the session (open tabs) with backups of
//! unsaved content for hot exit, and the user's config files.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager};

/// Older backups kept per tab, and the minimum time between two of them.
const BACKUP_VERSIONS: u32 = 5;
const BACKUP_VERSION_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// Set to a folder to run Kladde with its own profile (settings, session, backups), e.g. for tests.
pub const DATA_DIR_ENV: &str = "KLADDE_DATA_DIR";

pub fn isolated_profile() -> Option<PathBuf> {
    std::env::var_os(DATA_DIR_ENV).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// DevTools port for end-to-end tests. Kladde passes it to WebView2 itself because some machines (the
/// GitHub Windows runner) ignore `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`.
pub const DEVTOOLS_PORT_ENV: &str = "KLADDE_DEVTOOLS_PORT";

/// The DevTools port requested by an isolated profile. Never set in a normal run: an open debugging port
/// would let any local program drive the editor and read its files.
pub fn devtools_port() -> Option<u16> {
    devtools_port_for(isolated_profile().is_some(), std::env::var(DEVTOOLS_PORT_ENV).ok())
}

fn devtools_port_for(isolated: bool, value: Option<String>) -> Option<u16> {
    // Port 0 would make WebView2 pick a random port the tests cannot find.
    value.filter(|_| isolated)?.trim().parse().ok().filter(|&port| port != 0)
}

pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = match isolated_profile() {
        Some(dir) => dir,
        None => app.path().app_data_dir().map_err(|e| e.to_string())?,
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn backup_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("backup");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = match isolated_profile() {
        Some(dir) => dir,
        None => app.path().app_config_dir().map_err(|e| e.to_string())?,
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Test hooks: wait this many milliseconds before writing `session.json` / a backup. They widen the window
/// between the two writes of a session save so a test can kill Kladde inside it (see `writeSession`).
pub const SESSION_DELAY_ENV: &str = "KLADDE_SESSION_DELAY_MS";
pub const BACKUP_DELAY_ENV: &str = "KLADDE_BACKUP_DELAY_MS";

/// Honored only in an isolated profile: a normal run never waits on its own data.
fn delay_for(isolated: bool, value: Option<String>) -> Option<Duration> {
    let ms: u64 = value.filter(|_| isolated)?.trim().parse().ok()?;
    (ms > 0).then(|| Duration::from_millis(ms))
}

/// Blocks the calling command thread; only ever for a test.
fn test_delay(var: &str) {
    if let Some(delay) = delay_for(isolated_profile().is_some(), std::env::var(var).ok()) {
        std::thread::sleep(delay);
    }
}

/// Only plain names may reach the file system, never paths.
pub fn check_name(name: &str) -> Result<&str, String> {
    let valid = !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if valid {
        Ok(name)
    } else {
        Err(format!("Invalid name: {name}"))
    }
}

fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    crate::files::write_safely(path, contents).map_err(|e| e.to_string())
}

fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn load(app: &AppHandle) -> Result<Option<String>, String> {
    read_optional(&data_dir(app)?.join("session.json"))
}

pub fn save(app: &AppHandle, json: &str) -> Result<(), String> {
    test_delay(SESSION_DELAY_ENV);
    write_atomic(&data_dir(app)?.join("session.json"), json.as_bytes())
}

fn version_path(dir: &Path, id: &str, n: u32) -> PathBuf {
    dir.join(format!("{id}.{n}.txt"))
}

fn modified(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Writes the backup of a tab. The previous backup becomes version 1 (shifting older ones) when the
/// newest version is at least five minutes old, so a few older states survive a mistake too.
pub fn backup_write(app: &AppHandle, id: &str, text: &str) -> Result<(), String> {
    test_delay(BACKUP_DELAY_ENV);
    write_backup(&backup_dir(app)?, check_name(id)?, text)
}

/// The current backup stays where restore looks for it until the new one replaces it in one step: the older
/// version is a copy (written next to it, then renamed), so a crash at any point leaves a complete
/// `<id>.txt`.
fn write_backup(dir: &Path, id: &str, text: &str) -> Result<(), String> {
    let current = dir.join(format!("{id}.txt"));
    let newest = modified(&version_path(dir, id, 1));
    let due = newest.is_none_or(|t| t.elapsed().unwrap_or_default() >= BACKUP_VERSION_INTERVAL);
    if due && current.exists() {
        for n in (1..BACKUP_VERSIONS).rev() {
            let _ = fs::rename(version_path(dir, id, n), version_path(dir, id, n + 1));
        }
        let copy = dir.join(format!("{id}.1.tmp"));
        if fs::copy(&current, &copy).is_ok() {
            let _ = fs::rename(&copy, version_path(dir, id, 1));
        }
    }
    write_atomic(&current, text.as_bytes())
}

#[derive(Serialize)]
pub struct BackupVersion {
    pub n: u32,
    pub mtime: u64,
    pub size: u64,
}

pub fn backup_versions(app: &AppHandle, id: &str) -> Result<Vec<BackupVersion>, String> {
    let id = check_name(id)?;
    let dir = backup_dir(app)?;
    Ok((1..=BACKUP_VERSIONS)
        .filter_map(|n| {
            let meta = fs::metadata(version_path(&dir, id, n)).ok()?;
            Some(BackupVersion { n, mtime: crate::files::mtime_ms(&meta), size: meta.len() })
        })
        .collect())
}

pub fn backup_read_version(app: &AppHandle, id: &str, n: u32) -> Result<Option<String>, String> {
    read_optional(&version_path(&backup_dir(app)?, check_name(id)?, n))
}

pub fn backup_read(app: &AppHandle, id: &str) -> Result<Option<String>, String> {
    read_backup(&backup_dir(app)?, check_name(id)?)
}

/// The current backup, or else the newest older version: versions written before the current one was kept
/// in place (a crash while they were rotated) must not be lost.
fn read_backup(dir: &Path, id: &str) -> Result<Option<String>, String> {
    if let Some(text) = read_optional(&dir.join(format!("{id}.txt")))? {
        return Ok(Some(text));
    }
    for n in 1..=BACKUP_VERSIONS {
        if let Some(text) = read_optional(&version_path(dir, id, n))? {
            return Ok(Some(text));
        }
    }
    Ok(None)
}

/// Deletes all backups except those of the given tabs.
pub fn backup_prune(app: &AppHandle, keep: &[String]) -> Result<(), String> {
    for entry in fs::read_dir(backup_dir(app)?).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // "<id>.txt" and the versions "<id>.<n>.txt"
        let id = name.split('.').next().unwrap_or(&name);
        if !keep.iter().any(|k| k == id) {
            let _ = fs::remove_file(entry.path());
        }
    }
    Ok(())
}

pub fn config_read(app: &AppHandle, name: &str) -> Result<Option<String>, String> {
    read_optional(&config_dir(app)?.join(check_name(name)?))
}

/// Path of a config file, created with `default` content if it does not exist yet.
pub fn config_file(app: &AppHandle, name: &str, default: &str) -> Result<String, String> {
    let path = config_dir(app)?.join(check_name(name)?);
    if !path.exists() {
        fs::write(&path, default).map_err(|e| e.to_string())?;
    }
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devtools_port_needs_an_isolated_profile() {
        assert_eq!(devtools_port_for(false, Some("9340".into())), None);
        assert_eq!(devtools_port_for(true, Some("9340".into())), Some(9340));
        assert_eq!(devtools_port_for(true, None), None);
        assert_eq!(devtools_port_for(true, Some("".into())), None);
        assert_eq!(devtools_port_for(true, Some("0".into())), None);
        assert_eq!(devtools_port_for(true, Some("port".into())), None);
    }

    fn backup_dir_for(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kladde-backup-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rotating_a_version_keeps_the_current_backup_in_place() {
        let dir = backup_dir_for("rotate");
        write_backup(&dir, "t1", "first").unwrap();
        // No version yet, so the next write keeps "first" as version 1; the current file is copied, not moved.
        write_backup(&dir, "t1", "second").unwrap();
        assert_eq!(fs::read_to_string(dir.join("t1.txt")).unwrap(), "second");
        assert_eq!(fs::read_to_string(version_path(&dir, "t1", 1)).unwrap(), "first");
        assert!(!dir.join("t1.1.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_falls_back_to_the_newest_version() {
        let dir = backup_dir_for("fallback");
        assert_eq!(read_backup(&dir, "t1").unwrap(), None);
        fs::write(version_path(&dir, "t1", 2), "older").unwrap();
        assert_eq!(read_backup(&dir, "t1").unwrap().as_deref(), Some("older"));
        fs::write(version_path(&dir, "t1", 1), "newer").unwrap();
        assert_eq!(read_backup(&dir, "t1").unwrap().as_deref(), Some("newer"));
        fs::write(dir.join("t1.txt"), "current").unwrap();
        assert_eq!(read_backup(&dir, "t1").unwrap().as_deref(), Some("current"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_delays_need_an_isolated_profile() {
        assert_eq!(delay_for(false, Some("500".into())), None);
        assert_eq!(delay_for(true, Some("500".into())), Some(Duration::from_millis(500)));
        assert_eq!(delay_for(true, Some(" 20 ".into())), Some(Duration::from_millis(20)));
        assert_eq!(delay_for(true, Some("0".into())), None);
        assert_eq!(delay_for(true, Some("-5".into())), None);
        assert_eq!(delay_for(true, Some("soon".into())), None);
        assert_eq!(delay_for(true, None), None);
    }
}
