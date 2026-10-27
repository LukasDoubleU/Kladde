//! Persistence in the app data directory: the session (open tabs) with backups of
//! unsaved content for hot exit, and the user's config files.

use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn backup_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("backup");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Only plain names may reach the file system, never paths.
fn check_name(name: &str) -> Result<&str, String> {
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

/// Writes via a temporary file so a crash never leaves a half-written file behind.
fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
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
    write_atomic(&data_dir(app)?.join("session.json"), json.as_bytes())
}

pub fn backup_write(app: &AppHandle, id: &str, text: &str) -> Result<(), String> {
    let path = backup_dir(app)?.join(format!("{}.txt", check_name(id)?));
    write_atomic(&path, text.as_bytes())
}

pub fn backup_read(app: &AppHandle, id: &str) -> Result<Option<String>, String> {
    read_optional(&backup_dir(app)?.join(format!("{}.txt", check_name(id)?)))
}

/// Deletes all backups except those of the given tabs.
pub fn backup_prune(app: &AppHandle, keep: &[String]) -> Result<(), String> {
    for entry in fs::read_dir(backup_dir(app)?).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let id = name.strip_suffix(".txt").unwrap_or(&name);
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
