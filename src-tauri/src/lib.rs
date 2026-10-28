mod files;
mod integration;
mod languagetool;
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

/// Runs on the blocking pool: a search can take seconds on a multi-GB file, and a new search or
/// `large_search_cancel` stops it.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn large_search(
    id: u32,
    query: String,
    line: u64,
    col: u64,
    forward: bool,
    inclusive: bool,
    match_case: bool,
    regex: bool,
    state: State<'_, large::LargeFiles>,
) -> Result<large::SearchResult, String> {
    let file = state.get(id)?;
    let request = large::SearchRequest { query, line, col, forward, inclusive, match_case, regex };
    tauri::async_runtime::spawn_blocking(move || file.search(&request)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn large_search_cancel(id: u32, state: State<'_, large::LargeFiles>) -> Result<(), String> {
    state.cancel_search(id);
    Ok(())
}

#[tauri::command]
async fn large_refresh(id: u32, state: State<'_, large::LargeFiles>) -> Result<large::LargeRefresh, String> {
    state.refresh(id)
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

/// One LanguageTool check request (see languagetool.rs); the blocking HTTP call runs off the async runtime.
#[tauri::command]
async fn languagetool_check(
    server: String,
    data: String,
    language: String,
    variants: String,
) -> Result<String, languagetool::CheckError> {
    tauri::async_runtime::spawn_blocking(move || languagetool::check(&server, &data, &language, &variants))
        .await
        .map_err(|e| languagetool::CheckError { kind: "network", status: None, retry_after: None, message: e.to_string() })?
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

/// WebView2 features wry turns off by default (mini menu, SmartScreen); own browser arguments replace wry's.
const WEBVIEW_DISABLED_FEATURES: &str = "msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// Where a test instance's window lives: far outside any monitor, so it never shows up on the user's screen.
/// Physical pixels, clear of -32000, which Windows uses for minimized windows.
const BACKGROUND_POSITION: i32 = -20000;

/// Browser arguments of a test instance. Its window is off screen, which Chromium treats as occluded and
/// would stop painting and throttle timers for; tests also run while other windows cover it.
fn background_browser_args(devtools_port: Option<u16>) -> String {
    let mut args = format!(
        "--disable-features={WEBVIEW_DISABLED_FEATURES},CalculateNativeWinOcclusion \
         --disable-backgrounding-occluded-windows --disable-renderer-backgrounding \
         --disable-background-timer-throttling"
    );
    if let Some(port) = devtools_port {
        args.push_str(&format!(" --remote-debugging-port={port}"));
    }
    args
}

/// Creates the main window from its config (`create: false` there), so an isolated profile can set up
/// the window and WebView2 itself.
fn create_main_window(app: &AppHandle) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .expect("tauri.conf.json defines the main window");
    let mut window = tauri::WebviewWindowBuilder::from_config(app, &config)?;
    let isolated = session::isolated_profile();
    if let Some(dir) = &isolated {
        // A test instance runs next to the user's work and must never take the focus or appear on screen.
        window = window
            .focused(false)
            .focusable(false)
            .skip_taskbar(true)
            // Its own WebView2 profile, never the one of the normal installation.
            .data_directory(dir.join("webview"))
            // WebView2's environment variables for browser arguments are not honored everywhere (the GitHub
            // Windows runner ignores them), so the DevTools port for the e2e harness is passed here.
            .additional_browser_args(&background_browser_args(session::devtools_port()));
    }
    let window = window.build()?;
    if isolated.is_some() {
        show_in_background(&window)?;
    }
    Ok(())
}

/// Shows a test instance's still hidden window off screen, without activating it and without a taskbar
/// button. Done with Win32 directly: tao moves a window that is to be created outside every monitor back
/// onto the primary one, and its `show()` activates the window.
#[cfg(windows)]
fn show_in_background(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, SWP_NOACTIVATE,
        SWP_NOSIZE, SWP_NOZORDER, SW_SHOWNA, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };
    let hwnd = window.hwnd()?.0;
    // SAFETY: plain Win32 calls on our own, live window, on the thread that owns it.
    unsafe {
        // A tool window has no taskbar button and is not in Alt+Tab.
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (style & !(WS_EX_APPWINDOW as isize)) | WS_EX_TOOLWINDOW as isize);
        let flags = SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE;
        SetWindowPos(hwnd, std::ptr::null_mut(), BACKGROUND_POSITION, BACKGROUND_POSITION, 0, 0, flags);
        ShowWindow(hwnd, SW_SHOWNA);
    }
    Ok(())
}

#[cfg(not(windows))]
fn show_in_background(_window: &tauri::WebviewWindow) -> tauri::Result<()> {
    Ok(())
}

/// Shows the main window once the first tab is rendered (it starts hidden to avoid a flash). A test
/// instance is already shown off screen (`show_in_background`) and must not be activated: `show()` would
/// activate it and `set_focus` even simulates an Alt key press to get the foreground.
#[tauri::command]
fn show_window(window: tauri::WebviewWindow) -> Result<(), String> {
    if session::isolated_profile().is_some() {
        return Ok(());
    }
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
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
        // Not for an isolated profile: the window state lives in the normal config folder, and file dialogs,
        // the browser or Explorer would pop up on the user's screen during a test.
        builder = builder
            .plugin(
                tauri_plugin_window_state::Builder::default()
                    // The frontend shows the window once the first tab is rendered.
                    .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                    .build(),
            )
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_opener::init());
    }
    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(large::LargeFiles::default())
        .manage(update::Pending::default())
        .setup(|app| {
            create_main_window(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            frontend_log,
            show_window,
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
            large_search_cancel,
            large_refresh,
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
            languagetool_check,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_instances_keep_rendering_and_open_devtools_only_on_request() {
        let args = background_browser_args(None);
        // One --disable-features switch: Chromium only reads the last one, so wry's defaults go in it too.
        assert_eq!(args.matches("--disable-features=").count(), 1);
        assert!(args.contains(WEBVIEW_DISABLED_FEATURES));
        assert!(args.contains("CalculateNativeWinOcclusion"));
        assert!(!args.contains("--remote-debugging-port"));
        assert!(background_browser_args(Some(9340)).ends_with(" --remote-debugging-port=9340"));
    }
}
