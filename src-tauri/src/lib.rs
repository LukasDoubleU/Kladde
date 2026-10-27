mod files;
mod integration;
mod large;
mod session;
mod update;

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_window_state::StateFlags;

/// Turns command line arguments into absolute file paths.
fn paths_from_args(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<String> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(&a);
            let p = if p.is_absolute() { p } else { cwd.join(p) };
            std::path::absolute(&p).unwrap_or(p).to_string_lossy().to_string()
        })
        .collect()
}

/// Frontend errors end up on stderr, visible when running a debug build from a console.
#[tauri::command]
fn frontend_log(message: String) {
    eprintln!("[frontend] {message}");
}

#[tauri::command]
fn initial_paths() -> Vec<String> {
    let cwd = std::env::current_dir().unwrap_or_default();
    paths_from_args(std::env::args().skip(1), &cwd)
}

#[tauri::command]
async fn read_file(path: String, encoding: Option<String>) -> Result<files::FileContent, String> {
    files::read(Path::new(&path), encoding.as_deref())
}

#[tauri::command]
async fn write_file(path: String, text: String, encoding: String, bom: bool, eol: String) -> Result<u64, String> {
    files::write(Path::new(&path), &text, &encoding, bom, &eol)
}

/// Writes binary data such as a pasted image, creating missing parent folders.
#[tauri::command]
async fn write_binary(path: String, base64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(base64).map_err(|e| e.to_string())?;
    let path = Path::new(&path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
async fn stat_file(path: String) -> files::FileStat {
    files::stat(Path::new(&path))
}

#[tauri::command]
async fn stat_files(paths: Vec<String>) -> Vec<files::FileStat> {
    paths.iter().map(|p| files::stat(Path::new(p))).collect()
}

#[tauri::command]
async fn large_open(path: String, state: State<'_, large::LargeFiles>) -> Result<large::LargeOpened, String> {
    state.open(Path::new(&path))
}

#[tauri::command]
async fn large_info(id: u32, state: State<'_, large::LargeFiles>) -> Result<large::LargeInfo, String> {
    state.info(id)
}

#[tauri::command]
async fn large_lines(
    id: u32,
    start: u64,
    count: u64,
    state: State<'_, large::LargeFiles>,
) -> Result<Vec<large::Line>, String> {
    state.lines(id, start, count)
}

#[tauri::command]
async fn large_search(
    id: u32,
    query: String,
    line: u64,
    col: u64,
    forward: bool,
    inclusive: bool,
    match_case: bool,
    state: State<'_, large::LargeFiles>,
) -> Result<Option<large::Match>, String> {
    state.search(id, &query, line, col, forward, inclusive, match_case)
}

#[tauri::command]
async fn large_close(id: u32, state: State<'_, large::LargeFiles>) -> Result<(), String> {
    state.close(id);
    Ok(())
}

#[tauri::command]
async fn session_load(app: AppHandle) -> Result<Option<String>, String> {
    session::load(&app)
}

#[tauri::command]
async fn session_save(app: AppHandle, json: String) -> Result<(), String> {
    session::save(&app, &json)
}

#[tauri::command]
async fn backup_write(app: AppHandle, id: String, text: String) -> Result<(), String> {
    session::backup_write(&app, &id, &text)
}

#[tauri::command]
async fn backup_read(app: AppHandle, id: String) -> Result<Option<String>, String> {
    session::backup_read(&app, &id)
}

#[tauri::command]
async fn backup_versions(app: AppHandle, id: String) -> Result<Vec<session::BackupVersion>, String> {
    session::backup_versions(&app, &id)
}

#[tauri::command]
async fn backup_read_version(app: AppHandle, id: String, n: u32) -> Result<Option<String>, String> {
    session::backup_read_version(&app, &id, n)
}

#[tauri::command]
async fn backup_prune(app: AppHandle, keep: Vec<String>) -> Result<(), String> {
    session::backup_prune(&app, &keep)
}

#[tauri::command]
async fn config_read(app: AppHandle, name: String) -> Result<Option<String>, String> {
    session::config_read(&app, &name)
}

#[tauri::command]
async fn config_file(app: AppHandle, name: String, default: String) -> Result<String, String> {
    session::config_file(&app, &name, &default)
}

#[tauri::command]
async fn config_dir(app: AppHandle) -> Result<String, String> {
    Ok(session::config_dir(&app)?.to_string_lossy().to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct IntegrationStatus {
    #[serde(flatten)]
    status: integration::Status,
    /// The start-up offer should be shown: nothing registered yet and not dismissed.
    offer: bool,
    /// All file type groups Kladde can register.
    available: Vec<integration::GroupInfo>,
}

fn current_exe() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| e.to_string())
}

#[tauri::command]
async fn integration_status(app: AppHandle) -> Result<IntegrationStatus, String> {
    let target = integration::target();
    let status = integration::status(&target.base, &current_exe()?);
    let offer = !status.present
        && !integration::offer_dismissed(&session::data_dir(&app)?)
        && (target.real || std::env::var_os(integration::TEST_OFFER_ENV).is_some());
    Ok(IntegrationStatus { status, offer, available: integration::group_infos() })
}

#[tauri::command]
async fn integration_register(groups: Vec<String>, context_menu: bool) -> Result<(), String> {
    let target = integration::target();
    integration::register(&target.base, &current_exe()?, &groups, context_menu)?;
    if target.real {
        integration::notify_shell();
    }
    Ok(())
}

#[tauri::command]
async fn integration_open_default_apps() {
    if integration::target().real {
        integration::open_default_apps();
    }
}

/// Removes everything Kladde registered. Also stops the start-up offer: the user just said no.
#[tauri::command]
async fn integration_unregister(app: AppHandle) -> Result<(), String> {
    let target = integration::target();
    integration::unregister(&target.base)?;
    if target.real {
        integration::notify_shell();
    }
    integration::set_offer_dismissed(&session::data_dir(&app)?)
}

#[tauri::command]
async fn integration_dismiss_offer(app: AppHandle) -> Result<(), String> {
    integration::set_offer_dismissed(&session::data_dir(&app)?)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The NSIS uninstaller runs this to remove the file associations before it deletes the exe. Handled
    // before anything else so a running instance (single-instance plugin) does not swallow it.
    if std::env::args().skip(1).any(|a| a == "--unregister-integration") {
        let target = integration::target();
        let _ = integration::unregister(&target.base);
        if target.real {
            integration::notify_shell();
        }
        return;
    }
    let mut builder = tauri::Builder::default();
    // An isolated profile (KLADDE_DATA_DIR) runs as its own instance, e.g. next to the normal one in tests.
    if session::isolated_profile().is_none() {
        // Must be registered first: a second launch hands its files to the running window.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let paths = paths_from_args(argv.into_iter().skip(1), Path::new(&cwd));
            let _ = app.emit("open-paths", paths);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }
    builder
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // The frontend shows the window once the first tab is rendered.
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(large::LargeFiles::default())
        .manage(update::Pending::default())
        .invoke_handler(tauri::generate_handler![
            frontend_log,
            initial_paths,
            read_file,
            write_file,
            write_binary,
            stat_file,
            stat_files,
            large_open,
            large_info,
            large_lines,
            large_search,
            large_close,
            session_load,
            session_save,
            backup_write,
            backup_read,
            backup_versions,
            backup_read_version,
            backup_prune,
            config_read,
            config_file,
            config_dir,
            integration_status,
            integration_register,
            integration_open_default_apps,
            integration_unregister,
            integration_dismiss_offer,
            update::update_check,
            update::update_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kladde");
}
