//! Windows integration: lets Kladde appear in "Open with" and in Windows' default apps, and adds an
//! optional "Edit with Kladde" entry to the Explorer context menu.
//!
//! Windows does not let an app make itself the default for a file type: the choice is protected and
//! belongs to the user. What an app can do is register itself as a capable handler, per user (HKCU, no
//! admin rights). The user then picks Kladde in the Windows settings. Everything lives under one registry
//! `base` ("Software" for real), so tests can run against a throwaway key instead.
//!
//! Written under `<base>`:
//! - `Classes\Kladde.Document`: the ProgID with icon and open command,
//! - `Kladde\Capabilities` and `RegisteredApplications\Kladde`: make Kladde selectable in Settings,
//! - `Classes\.<ext>\OpenWithProgids\Kladde.Document`: lists Kladde in "Open with" without becoming the
//!   default; the same under `Classes\*` offers it for every file,
//! - `Classes\*\shell\Kladde`: the context menu entry (optional),
//! - `Kladde`: our own bookkeeping (chosen groups, exe path, list version).
//!
//! `unregister` removes exactly these again.

use serde::Serialize;

pub const PROG_ID: &str = "Kladde.Document";
const APP_NAME: &str = "Kladde";
const APP_DESCRIPTION: &str = "A lightweight text editor with first-class Markdown";
const MENU_LABEL: &str = "Edit with Kladde";

/// Bumped whenever the extension list below changes, so an installed version re-registers itself quietly.
const LIST_VERSION: u32 = 1;

/// The file types Kladde offers to open, in groups the user can opt into.
pub struct Group {
    pub id: &'static str,
    pub label: &'static str,
    pub extensions: &'static [&'static str],
}

pub const GROUPS: &[Group] = &[
    Group { id: "text", label: "Plain text", extensions: &["txt", "text"] },
    Group { id: "logs", label: "Log files", extensions: &["log"] },
    Group { id: "markdown", label: "Markdown", extensions: &["md", "markdown", "mdown", "mkd"] },
    Group {
        id: "data",
        label: "Config and data files",
        extensions: &[
            "json", "jsonc", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "csv", "tsv", "properties", "env",
            "editorconfig", "gitignore", "gitattributes",
        ],
    },
    Group {
        id: "code",
        label: "Scripts and source code",
        extensions: &[
            "bat", "cmd", "ps1", "psm1", "sh", "bash", "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "scss",
            "less", "html", "htm", "svg", "sql", "java", "kt", "gradle", "c", "h", "cpp", "hpp", "cs", "go", "rs",
            "rb", "php", "lua",
        ],
    },
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub extensions: &'static [&'static str],
}

pub fn group_infos() -> Vec<GroupInfo> {
    GROUPS.iter().map(|g| GroupInfo { id: g.id, label: g.label, extensions: g.extensions }).collect()
}

/// What Kladde has registered right now.
#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Anything of Kladde is registered (file types or the context menu entry).
    pub present: bool,
    /// Registered for this exe path and the current extension list. False means it should be refreshed.
    pub current: bool,
    /// Group ids registered as file types.
    pub groups: Vec<String>,
    pub context_menu: bool,
}

fn known_group(ids: &[String]) -> Result<Vec<&'static Group>, String> {
    ids.iter()
        .map(|id| GROUPS.iter().find(|g| g.id == id).ok_or_else(|| format!("Unknown file type group: {id}")))
        .collect()
}

/// Where to read and write. Isolated profiles (tests) get a throwaway key and never touch the shell, so
/// a test run cannot change the real file associations of the machine.
pub struct Target {
    pub base: String,
    /// Real registry root: notify Explorer and open the Windows settings.
    pub real: bool,
}

pub const TEST_KEY_ENV: &str = "KLADDE_TEST_KEY";
/// Makes isolated profiles offer the registration like a normal profile does, to test the banner.
pub const TEST_OFFER_ENV: &str = "KLADDE_TEST_OFFER";

pub fn target() -> Target {
    let key = std::env::var(TEST_KEY_ENV).unwrap_or_default();
    target_for(crate::session::isolated_profile().is_some(), &key)
}

fn target_for(isolated: bool, test_key: &str) -> Target {
    if !isolated {
        return Target { base: "Software".into(), real: true };
    }
    let key: String =
        test_key.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')).take(64).collect();
    let key = if key.is_empty() { "isolated" } else { &key };
    Target { base: format!(r"Software\KladdeTest\{key}"), real: false }
}

/// "Don't ask again" is a marker file in the data folder, so settings.json stays untouched.
const DISMISSED_FILE: &str = "no-default-editor-offer";

pub fn offer_dismissed(data_dir: &std::path::Path) -> bool {
    data_dir.join(DISMISSED_FILE).exists()
}

pub fn set_offer_dismissed(data_dir: &std::path::Path) -> Result<(), String> {
    std::fs::write(data_dir.join(DISMISSED_FILE), "").map_err(|e| e.to_string())
}

#[cfg(windows)]
mod registry {
    use super::*;
    use std::borrow::Cow;
    use std::io;
    use std::path::Path;
    use winreg::enums::*;
    use winreg::{RegKey, RegValue};

    fn hkcu() -> RegKey {
        RegKey::predef(HKEY_CURRENT_USER)
    }

    fn ignore_missing(r: io::Result<()>) -> Result<(), String> {
        match r {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }

    /// Creates the key (and parents) and sets its default value.
    fn put(path: &str, default: &str) -> Result<RegKey, String> {
        let (key, _) = hkcu().create_subkey(path).map_err(|e| format!("{path}: {e}"))?;
        key.set_value("", &default).map_err(|e| format!("{path}: {e}"))?;
        Ok(key)
    }

    fn put_value(key: &RegKey, name: &str, value: &str) -> Result<(), String> {
        key.set_value(name, &value).map_err(|e| format!("{name}: {e}"))
    }

    /// An empty REG_NONE value, the form OpenWithProgids uses.
    fn put_marker(path: &str, name: &str) -> Result<(), String> {
        let (key, _) = hkcu().create_subkey(path).map_err(|e| format!("{path}: {e}"))?;
        let empty = RegValue { bytes: Cow::Borrowed(&[]), vtype: REG_NONE };
        key.set_raw_value(name, &empty).map_err(|e| format!("{path}: {e}"))
    }

    /// Deletes a key that has neither values nor subkeys; anything else is not ours and stays.
    fn remove_if_empty(path: &str) {
        let Ok(key) = hkcu().open_subkey(path) else { return };
        if key.query_info().is_ok_and(|i| i.sub_keys == 0 && i.values == 0) {
            let _ = hkcu().delete_subkey(path);
        }
    }

    fn remove_tree(path: &str) -> Result<(), String> {
        ignore_missing(hkcu().delete_subkey_all(path))
    }

    fn command(exe: &Path) -> String {
        format!("\"{}\" \"%1\"", exe_text(exe))
    }

    /// `\\?\` prefixes confuse the shell.
    fn exe_text(exe: &Path) -> String {
        let text = exe.to_string_lossy();
        text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
    }

    pub fn status(base: &str, exe: &Path) -> Status {
        let app = format!(r"{base}\{APP_NAME}");
        let Ok(key) = hkcu().open_subkey(&app) else { return Status::default() };
        let groups: Vec<String> = key
            .get_value::<String, _>("Groups")
            .unwrap_or_default()
            .split(',')
            .filter(|g| GROUPS.iter().any(|known| known.id == *g))
            .map(String::from)
            .collect();
        let registered_exe = key.get_value::<String, _>("Exe").unwrap_or_default();
        let version = key.get_value::<u32, _>("ListVersion").unwrap_or(0);
        let context_menu = hkcu().open_subkey(format!(r"{base}\Classes\*\shell\{APP_NAME}")).is_ok();
        Status {
            present: true,
            current: registered_exe.eq_ignore_ascii_case(&exe_text(exe)) && version == LIST_VERSION,
            groups,
            context_menu,
        }
    }

    pub fn register(base: &str, exe: &Path, groups: &[String], context_menu: bool) -> Result<(), String> {
        let selected = known_group(groups)?;
        if selected.is_empty() && !context_menu {
            return Err("Nothing to register".into());
        }
        // Start clean so deselected groups and an old exe path leave nothing behind.
        unregister(base)?;

        let exe_path = exe_text(exe);
        let icon = format!("{exe_path},0");
        let classes = format!(r"{base}\Classes");
        let app = format!(r"{base}\{APP_NAME}");

        let key = put(&app, "")?;
        put_value(&key, "Groups", &selected.iter().map(|g| g.id).collect::<Vec<_>>().join(","))?;
        put_value(&key, "Exe", &exe_path)?;
        key.set_value("ListVersion", &LIST_VERSION).map_err(|e| e.to_string())?;

        if !selected.is_empty() {
            let prog = format!(r"{classes}\{PROG_ID}");
            let key = put(&prog, "Kladde document")?;
            put_value(&key, "FriendlyTypeName", "Kladde document")?;
            put(&format!(r"{prog}\DefaultIcon"), &icon)?;
            let open = put(&format!(r"{prog}\shell\open"), "")?;
            put_value(&open, "FriendlyAppName", APP_NAME)?;
            put(&format!(r"{prog}\shell\open\command"), &command(exe))?;

            let caps = put(&format!(r"{app}\Capabilities"), "")?;
            put_value(&caps, "ApplicationName", APP_NAME)?;
            put_value(&caps, "ApplicationDescription", APP_DESCRIPTION)?;
            put_value(&caps, "ApplicationIcon", &icon)?;
            let assoc = put(&format!(r"{app}\Capabilities\FileAssociations"), "")?;
            for group in &selected {
                for ext in group.extensions {
                    put_value(&assoc, &format!(".{ext}"), PROG_ID)?;
                    put_marker(&format!(r"{classes}\.{ext}\OpenWithProgids"), PROG_ID)?;
                }
            }
            // Offered in "Open with" for every file, including those with unusual extensions.
            put_marker(&format!(r"{classes}\*\OpenWithProgids"), PROG_ID)?;

            let (apps, _) = hkcu().create_subkey(format!(r"{base}\RegisteredApplications")).map_err(|e| e.to_string())?;
            put_value(&apps, APP_NAME, &format!(r"{app}\Capabilities"))?;
        }

        if context_menu {
            let menu = format!(r"{classes}\*\shell\{APP_NAME}");
            let key = put(&menu, MENU_LABEL)?;
            put_value(&key, "Icon", &icon)?;
            put(&format!(r"{menu}\command"), &command(exe))?;
        }
        Ok(())
    }

    /// Removes everything `register` wrote, and nothing else: foreign values next to ours stay.
    pub fn unregister(base: &str) -> Result<(), String> {
        let classes = format!(r"{base}\Classes");
        let app = format!(r"{base}\{APP_NAME}");

        // The registered extensions, plus everything the current list knows in case the stored list is lost.
        let mut exts: Vec<String> = GROUPS.iter().flat_map(|g| g.extensions.iter().map(|e| format!(".{e}"))).collect();
        if let Ok(assoc) = hkcu().open_subkey(format!(r"{app}\Capabilities\FileAssociations")) {
            exts.extend(assoc.enum_values().flatten().map(|(name, _)| name));
        }
        exts.sort();
        exts.dedup();
        for ext in exts.iter().map(String::as_str).chain(["*"]) {
            let progids = format!(r"{classes}\{ext}\OpenWithProgids");
            if let Ok(key) = hkcu().open_subkey_with_flags(&progids, KEY_SET_VALUE) {
                ignore_missing(key.delete_value(PROG_ID))?;
            }
            remove_if_empty(&progids);
            remove_if_empty(&format!(r"{classes}\{ext}"));
        }

        remove_tree(&format!(r"{classes}\*\shell\{APP_NAME}"))?;
        remove_if_empty(&format!(r"{classes}\*\shell"));
        remove_if_empty(&format!(r"{classes}\*"));
        remove_tree(&format!(r"{classes}\{PROG_ID}"))?;
        remove_tree(&app)?;
        let apps = format!(r"{base}\RegisteredApplications");
        if let Ok(key) = hkcu().open_subkey_with_flags(&apps, KEY_SET_VALUE) {
            ignore_missing(key.delete_value(APP_NAME))?;
        }
        remove_if_empty(&apps);
        Ok(())
    }

    #[cfg(test)]
    pub fn read(path: &str, name: &str) -> Option<String> {
        hkcu().open_subkey(path).ok()?.get_value::<String, _>(name).ok()
    }
}

#[cfg(windows)]
pub use registry::{register, status, unregister};

#[cfg(not(windows))]
pub fn status(_base: &str, _exe: &std::path::Path) -> Status {
    Status::default()
}
#[cfg(not(windows))]
pub fn register(_base: &str, _exe: &std::path::Path, _groups: &[String], _menu: bool) -> Result<(), String> {
    Err("Only available on Windows".into())
}
#[cfg(not(windows))]
pub fn unregister(_base: &str) -> Result<(), String> {
    Ok(())
}

/// Tells Explorer that associations changed, so it refreshes its "Open with" lists and icons.
#[cfg(windows)]
pub fn notify_shell() {
    use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
    // SAFETY: both item pointers are unused (null) for this event.
    unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED as i32, SHCNF_IDLIST, std::ptr::null(), std::ptr::null()) };
}
#[cfg(not(windows))]
pub fn notify_shell() {}

/// Opens Windows' default apps page, preselected on Kladde where Windows supports it (11).
#[cfg(windows)]
pub fn open_default_apps() {
    use std::os::windows::ffi::OsStrExt;
    let wide = |s: &str| std::ffi::OsStr::new(s).encode_wide().chain(Some(0)).collect::<Vec<u16>>();
    for uri in ["ms-settings:defaultapps?registeredAppUser=Kladde", "ms-settings:defaultapps"] {
        let (verb, uri) = (wide("open"), wide(uri));
        // SAFETY: all strings are NUL-terminated and outlive the call.
        let result = unsafe {
            windows_sys::Win32::UI::Shell::ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                uri.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            )
        };
        // Values above 32 mean success.
        if result as usize > 32 {
            return;
        }
    }
}
#[cfg(not(windows))]
pub fn open_default_apps() {}

#[cfg(all(test, windows))]
mod tests {
    use super::registry::read;
    use super::*;
    use std::path::Path;
    use winreg::enums::*;
    use winreg::RegKey;

    const EXE: &str = r"C:\Some Folder\kladde.exe";

    /// A throwaway registry root that is deleted afterwards, even when the test fails. Nothing here ever
    /// touches the real `Software\Classes`.
    struct Sandbox {
        base: String,
    }

    impl Sandbox {
        fn new(name: &str) -> Self {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let base = format!(r"Software\KladdeTest\unit-{name}-{}-{nanos}", std::process::id());
            Sandbox { base }
        }
        fn key(&self, rest: &str) -> Option<RegKey> {
            RegKey::predef(HKEY_CURRENT_USER).open_subkey(format!(r"{}\{rest}", self.base)).ok()
        }
        fn exists(&self, rest: &str) -> bool {
            self.key(rest).is_some()
        }
        fn put_foreign(&self, rest: &str, name: &str, value: &str) {
            let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(format!(r"{}\{rest}", self.base)).unwrap();
            key.set_value(name, &value).unwrap();
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            assert!(self.base.starts_with(r"Software\KladdeTest\"));
            let hkcu = RegKey::predef(HKEY_CURRENT_USER);
            let _ = hkcu.delete_subkey_all(&self.base);
            // Remove the shared parent when no other test is using it.
            if let Ok(parent) = hkcu.open_subkey(r"Software\KladdeTest") {
                if parent.query_info().is_ok_and(|i| i.sub_keys == 0 && i.values == 0) {
                    let _ = hkcu.delete_subkey(r"Software\KladdeTest");
                }
            }
        }
    }

    fn all_groups() -> Vec<String> {
        GROUPS.iter().map(|g| g.id.to_string()).collect()
    }

    #[test]
    fn registers_and_reports_status() {
        let sb = Sandbox::new("register");
        let exe = Path::new(EXE);
        assert_eq!(status(&sb.base, exe), Status::default());

        register(&sb.base, exe, &all_groups(), true).unwrap();
        let st = status(&sb.base, exe);
        assert!(st.present && st.current && st.context_menu);
        assert_eq!(st.groups, all_groups());

        let cmd = r#""C:\Some Folder\kladde.exe" "%1""#;
        assert_eq!(read(&format!(r"{}\Classes\{PROG_ID}\shell\open\command", sb.base), "").unwrap(), cmd);
        assert_eq!(read(&format!(r"{}\Classes\*\shell\Kladde\command", sb.base), "").unwrap(), cmd);
        assert_eq!(read(&format!(r"{}\Classes\*\shell\Kladde", sb.base), "").unwrap(), MENU_LABEL);
        assert_eq!(
            read(&format!(r"{}\RegisteredApplications", sb.base), "Kladde").unwrap(),
            format!(r"{}\Kladde\Capabilities", sb.base)
        );
        let assoc = format!(r"{}\Kladde\Capabilities\FileAssociations", sb.base);
        assert_eq!(read(&assoc, ".md").unwrap(), PROG_ID);
        assert_eq!(read(&assoc, ".rs").unwrap(), PROG_ID);
        assert!(sb.exists(&format!(r"Classes\.txt\OpenWithProgids")));
        assert!(sb.exists(r"Classes\*\OpenWithProgids"));
    }

    #[test]
    fn groups_and_context_menu_are_independent() {
        let sb = Sandbox::new("groups");
        let exe = Path::new(EXE);

        register(&sb.base, exe, &["markdown".to_string()], false).unwrap();
        let st = status(&sb.base, exe);
        assert_eq!(st.groups, ["markdown"]);
        assert!(!st.context_menu);
        assert!(sb.exists(r"Classes\.md\OpenWithProgids"));
        assert!(!sb.exists(r"Classes\.json\OpenWithProgids"));
        assert!(!sb.exists(r"Classes\*\shell\Kladde"));

        // Only the context menu: no ProgID, no capabilities.
        register(&sb.base, exe, &[], true).unwrap();
        let st = status(&sb.base, exe);
        assert!(st.present && st.context_menu && st.groups.is_empty());
        assert!(!sb.exists(&format!(r"Classes\{PROG_ID}")));
        assert!(!sb.exists(r"Classes\.md"));
        assert!(!sb.exists(r"Kladde\Capabilities"));
        assert!(!sb.exists("RegisteredApplications"));

        assert!(register(&sb.base, exe, &[], false).is_err());
        assert!(register(&sb.base, exe, &["nope".to_string()], false).is_err());
    }

    #[test]
    fn detects_a_moved_exe() {
        let sb = Sandbox::new("moved");
        register(&sb.base, Path::new(EXE), &all_groups(), false).unwrap();
        assert!(status(&sb.base, Path::new(r"c:\some folder\KLADDE.exe")).current);
        assert!(!status(&sb.base, Path::new(r"D:\portable\kladde.exe")).current);
        // Registering again points everything at the new location.
        register(&sb.base, Path::new(r"D:\portable\kladde.exe"), &all_groups(), false).unwrap();
        assert!(status(&sb.base, Path::new(r"D:\portable\kladde.exe")).current);
        let cmd = read(&format!(r"{}\Classes\{PROG_ID}\shell\open\command", sb.base), "").unwrap();
        assert!(cmd.contains(r"D:\portable"));
    }

    #[test]
    fn unregister_removes_only_what_kladde_wrote() {
        let sb = Sandbox::new("unregister");
        let exe = Path::new(EXE);
        // Pre-existing associations of other programs.
        sb.put_foreign(r"Classes\.txt", "", "txtfile");
        sb.put_foreign(r"Classes\.md\OpenWithProgids", "Other.Document", "");
        sb.put_foreign("RegisteredApplications", "Other", r"Software\Other\Capabilities");

        register(&sb.base, exe, &all_groups(), true).unwrap();
        unregister(&sb.base).unwrap();

        assert_eq!(status(&sb.base, exe), Status::default());
        for gone in [
            "Kladde",
            r"Classes\Kladde.Document",
            r"Classes\*",
            r"Classes\.json",
            r"Classes\.rs",
            r"Classes\.txt\OpenWithProgids",
        ] {
            assert!(!sb.exists(gone), "{gone} should be gone");
        }
        // Foreign data stays.
        assert_eq!(read(&format!(r"{}\Classes\.txt", sb.base), "").unwrap(), "txtfile");
        assert!(sb.key(r"Classes\.md\OpenWithProgids").unwrap().get_raw_value("Other.Document").is_ok());
        assert!(sb.key(r"Classes\.md\OpenWithProgids").unwrap().get_raw_value(PROG_ID).is_err());
        assert_eq!(read(&format!(r"{}\RegisteredApplications", sb.base), "Other").unwrap(), r"Software\Other\Capabilities");
        assert!(read(&format!(r"{}\RegisteredApplications", sb.base), "Kladde").is_none());

        // Twice is fine.
        unregister(&sb.base).unwrap();
    }

    #[test]
    fn unregister_leaves_nothing_in_an_empty_sandbox() {
        let sb = Sandbox::new("clean");
        register(&sb.base, Path::new(EXE), &all_groups(), true).unwrap();
        unregister(&sb.base).unwrap();
        // Only the (empty) containers of the sandbox itself remain.
        let root = sb.key("").unwrap();
        let leftovers: Vec<String> = root.enum_keys().flatten().collect();
        assert_eq!(leftovers, ["Classes"], "unexpected leftovers: {leftovers:?}");
        assert!(sb.key("Classes").unwrap().enum_keys().next().is_none());
    }

    #[test]
    fn isolated_profiles_never_target_the_real_registry() {
        let real = target_for(false, "whatever");
        assert_eq!((real.base.as_str(), real.real), ("Software", true));
        const PREFIX: &str = r"Software\KladdeTest\";
        for key in ["", "abc", r"a/b\c", "..", "e2e-1_2"] {
            let t = target_for(true, key);
            assert!(!t.real);
            assert!(t.base.starts_with(PREFIX), "{}", t.base);
            assert!(!t.base[PREFIX.len()..].contains(['\\', '/', '.']), "{}", t.base);
        }
        assert_eq!(target_for(true, "").base, r"Software\KladdeTest\isolated");
    }

    #[test]
    fn extension_lists_are_sane() {
        let mut seen = std::collections::HashSet::new();
        for group in GROUPS {
            for ext in group.extensions {
                assert!(ext.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()), "{ext}");
                assert!(seen.insert(*ext), "{ext} appears twice");
            }
        }
    }
}
