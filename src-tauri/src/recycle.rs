//! Moving a tab's file to the Recycle Bin, and back ("Move to Recycle Bin" and its Restore).
//!
//! **Only ever recycle, never delete permanently.** Windows silently deletes for good when a file cannot go to
//! the bin (a network share, a drive without one, a file larger than the bin) as soon as the confirmation is
//! switched off, which this code has to do. So it is the one place that may not rely on the shell's defaults:
//!
//! 1. A path that cannot have a bin (UNC, a network or optical drive, a RAM disk) is refused up front
//!    (`classify_location`).
//! 2. The shell is driven through `IFileOperation` with `FOFX_RECYCLEONDELETE` and a progress sink. In
//!    `PreDeleteItem` the shell says how it is about to delete: without `TSF_DELETE_RECYCLE_IF_POSSIBLE` that is a
//!    permanent delete, and the sink cancels it (`E_ABORT`) before anything happens.
//! 3. `PostDeleteItem` hands over the item in the Recycle Bin (`psiNewlyCreated`). A delete that succeeded without
//!    one is reported as an error, never as success.
//!
//! The recycled item is remembered by its path inside the bin (`C:\$Recycle.Bin\<sid>\$R…`, what
//! `psiNewlyCreated` names) under an id that the page keeps for its Restore button. Restore finds that item in the
//! bin's own folder (the shell namespace) and moves it back with `IFileOperation`, which is a restore.
//!
//! Tests never touch the real bin: with an isolated profile `KLADDE_RECYCLE_DIR=<folder>` moves the file into that
//! folder instead, `KLADDE_RECYCLE_REFUSE=1` simulates a location without a bin, and an isolated profile without
//! either refuses to recycle at all. A normal profile ignores both variables (`backend_for`, unit-tested).

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Test hook: a folder that receives the "recycled" files (isolated profile only).
pub const RECYCLE_DIR_ENV: &str = "KLADDE_RECYCLE_DIR";
/// Test hook: `1` makes every recycle fail like a location without a Recycle Bin (isolated profile only).
pub const RECYCLE_REFUSE_ENV: &str = "KLADDE_RECYCLE_REFUSE";

/// How many recycled files stay restorable in this run; the oldest are forgotten (their files stay in the bin).
const KEEP: usize = 32;

/// What a recycle really does.
#[derive(Debug, PartialEq)]
pub enum Backend {
    /// The Windows Recycle Bin (every normal profile).
    Shell,
    /// A test profile's folder.
    Folder(PathBuf),
    /// Nothing is moved: the message says why.
    Refused(&'static str),
}

const NO_BIN_HERE: &str = "This location has no Recycle Bin.";

/// Picks the backend. The hooks only exist for an isolated profile; one without a folder never reaches the real bin.
pub fn backend_for(isolated: bool, folder: Option<OsString>, refuse: Option<OsString>) -> Backend {
    if !isolated {
        return Backend::Shell;
    }
    if refuse.is_some_and(|v| v == "1") {
        return Backend::Refused(NO_BIN_HERE);
    }
    match folder.filter(|v| !v.is_empty()) {
        Some(dir) => Backend::Folder(PathBuf::from(dir)),
        None => Backend::Refused("A test profile needs KLADDE_RECYCLE_DIR: it never touches the real Recycle Bin."),
    }
}

pub fn backend() -> Backend {
    backend_for(
        crate::session::isolated_profile().is_some(),
        std::env::var_os(RECYCLE_DIR_ENV),
        std::env::var_os(RECYCLE_REFUSE_ENV),
    )
}

/// Windows drive types (`GetDriveTypeW`) that have a Recycle Bin: removable media and fixed disks.
const DRIVE_REMOVABLE: u32 = 2;
const DRIVE_FIXED: u32 = 3;

/// Whether a file at `path` can have a Recycle Bin at all: only a local drive letter, of a removable or fixed
/// drive. `drive_type` answers for a drive letter. Defense in depth: the progress sink is what really decides.
fn classify_location(path: &str, drive_type: impl Fn(char) -> u32) -> Result<(), &'static str> {
    // `\\?\C:\x` is a drive path in disguise; `\\?\UNC\…` and `\\server\…` are network paths.
    let local = path.strip_prefix(r"\\?\").unwrap_or(path);
    let mut chars = local.chars();
    let (Some(letter), Some(':'), Some('\\' | '/')) = (chars.next(), chars.next(), chars.next()) else {
        return Err("Only files on a local drive can go to the Recycle Bin.");
    };
    if !letter.is_ascii_alphabetic() {
        return Err("Only files on a local drive can go to the Recycle Bin.");
    }
    match drive_type(letter.to_ascii_uppercase()) {
        DRIVE_FIXED | DRIVE_REMOVABLE => Ok(()),
        _ => Err("The drive of this file has no Recycle Bin (a network or other special drive)."),
    }
}

/// A recycled file that can come back.
enum Entry {
    /// A test profile's folder: where the file is now.
    Folder { original: PathBuf, stored: PathBuf },
    #[cfg(windows)]
    /// The Windows bin: the item in it.
    Shell { original: PathBuf, item: String },
}

impl Entry {
    fn original(&self) -> &Path {
        match self {
            Entry::Folder { original, .. } => original,
            #[cfg(windows)]
            Entry::Shell { original, .. } => original,
        }
    }
}

#[derive(Default)]
struct Inner {
    next: u32,
    items: Vec<(u32, Entry)>,
}

/// The recycled files of this run, by the id the page holds. Cheap to clone (shared state): commands move a
/// clone into a worker thread.
#[derive(Clone, Default)]
pub struct Recycler(Arc<Mutex<Inner>>);

impl Recycler {
    /// Moves the file to the Recycle Bin and returns the id for `restore`. Nothing is deleted when it fails.
    pub fn recycle(&self, backend: &Backend, path: &Path) -> Result<u32, String> {
        let entry = match backend {
            Backend::Refused(message) => return Err((*message).into()),
            Backend::Folder(dir) => recycle_into_folder(dir, path)?,
            Backend::Shell => {
                check_file(path)?;
                #[cfg(windows)]
                {
                    classify_location(&path.to_string_lossy(), shell::drive_type)?;
                    Entry::Shell { original: path.to_path_buf(), item: shell::recycle(path)? }
                }
                #[cfg(not(windows))]
                return Err("The Recycle Bin is only supported on Windows.".into());
            }
        };
        let mut inner = self.0.lock().map_err(|_| "internal error")?;
        inner.next += 1;
        let id = inner.next;
        inner.items.push((id, entry));
        if inner.items.len() > KEEP {
            inner.items.remove(0);
        }
        Ok(id)
    }

    /// Puts a recycled file back where it was and returns that path. Nothing at the path is ever overwritten.
    /// A refusal because of the place (taken, folder gone) keeps the id, so it works once the obstacle is gone;
    /// an attempt spends it: the file is then in its folder or still in the bin for Explorer.
    pub fn restore(&self, id: u32) -> Result<PathBuf, String> {
        let original = {
            let inner = self.0.lock().map_err(|_| "internal error")?;
            let (_, entry) = inner.items.iter().find(|(i, _)| *i == id).ok_or("This file can no longer be restored from here.")?;
            entry.original().to_path_buf()
        };
        // Not a file, a folder or a link: whatever is there stays untouched.
        if fs::symlink_metadata(&original).is_ok() {
            return Err(format!("{} already exists. Nothing was overwritten.", original.display()));
        }
        match original.parent() {
            Some(dir) if dir.is_dir() => {}
            _ => return Err("The folder the file was in no longer exists.".into()),
        }
        let entry = {
            let mut inner = self.0.lock().map_err(|_| "internal error")?;
            let at = inner.items.iter().position(|(i, _)| *i == id).ok_or("This file can no longer be restored from here.")?;
            inner.items.remove(at).1
        };
        match entry {
            Entry::Folder { stored, .. } => {
                if !stored.is_file() {
                    return Err("The file is no longer in the Recycle Bin.".into());
                }
                move_file(&stored, &original)?;
            }
            #[cfg(windows)]
            Entry::Shell { item, .. } => shell::restore(&item, &original)?,
        }
        Ok(original)
    }
}

/// Whether the shell's name for the restored file is the path asked for. Compared by what the file system says
/// (case, `\?\` prefixes and short names do not matter), not by text, where it can.
fn same_path(a: &str, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a.eq_ignore_ascii_case(&b.to_string_lossy()),
    }
}

/// The bin keeps `$I<id><ext>` (where the file came from, its size, the time) next to `$R<id><ext>` (the file).
/// Moving the file out leaves the first behind. With no `$R` next to it, it describes nothing: remove it, and only
/// that, and only when the name is the `$R` file's own with the letter changed.
fn remove_orphan_metadata(recycled: &Path) {
    let (Some(dir), Some(name)) = (recycled.parent(), recycled.file_name().map(|n| n.to_string_lossy().into_owned())) else {
        return;
    };
    let Some(rest) = name.strip_prefix("$R") else { return };
    if recycled.exists() {
        return;
    }
    let metadata = dir.join(format!("$I{rest}"));
    if fs::symlink_metadata(&metadata).is_ok_and(|m| m.is_file() && m.len() < 4096) {
        let _ = fs::remove_file(metadata);
    }
}

/// A plain file that exists: the page only offers it for tabs of files, but the check is cheap and the answer is
/// clearer than the shell's.
fn check_file(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("The path is not absolute.".into());
    }
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => Ok(()),
        Ok(_) => Err("This is not a file.".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err("The file does not exist.".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// `fs::rename`, with a copy for another drive. Never replaces an existing file (the callers checked).
fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    fs::copy(from, to).map_err(|e| e.to_string())?;
    fs::remove_file(from).map_err(|e| e.to_string())
}

fn recycle_into_folder(dir: &Path, path: &Path) -> Result<Entry, String> {
    check_file(path)?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let name = path.file_name().ok_or("The path has no file name.")?.to_string_lossy();
    // Unique per recycle: the same name can be recycled twice.
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let stored = dir.join(format!("{nanos}-{name}"));
    move_file(path, &stored)?;
    Ok(Entry::Folder { original: path.to_path_buf(), stored })
}

#[cfg(windows)]
mod shell {
    use std::path::Path;
    use std::sync::{Arc, Mutex};
    use windows::core::{implement, Ref, HRESULT, PCWSTR};
    use windows::Win32::Foundation::E_ABORT;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{
        FileOperation, IEnumShellItems, IFileOperation, IFileOperationProgressSink, IFileOperationProgressSink_Impl, IShellItem,
        SHCreateItemFromParsingName, SHGetKnownFolderItem, BHID_EnumItems, FOLDERID_RecycleBinFolder, KF_FLAG_DEFAULT,
        SIGDN_FILESYSPATH, FOFX_RECYCLEONDELETE, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_RENAMEONCOLLISION, FOF_SILENT,
        TSF_DELETE_RECYCLE_IF_POSSIBLE,
    };

    const SINK_REFUSED: &str = "Windows cannot move this file to the Recycle Bin (it would be deleted for good).";

    /// The type of the drive with this letter (`GetDriveTypeW`).
    pub fn drive_type(letter: char) -> u32 {
        let root: Vec<u16> = format!("{letter}:\\").encode_utf16().chain(std::iter::once(0)).collect();
        unsafe { windows_sys::Win32::Storage::FileSystem::GetDriveTypeW(root.as_ptr()) }
    }

    /// The file system path of a shell item (for a bin item: `C:\$Recycle.Bin\<sid>\$R…`).
    fn path_of(item: &IShellItem) -> Option<String> {
        use windows::Win32::System::Com::CoTaskMemFree;
        let name = unsafe { item.GetDisplayName(SIGDN_FILESYSPATH) }.ok()?;
        let path = unsafe { name.to_string() }.ok();
        unsafe { CoTaskMemFree(Some(name.0 as *const _)) };
        path
    }

    /// COM on the calling thread, apartment-threaded (the shell's context menus and file operations want a
    /// single-threaded apartment), undone when it ends. The caller's thread is a dedicated one, never Tauri's.
    struct Apartment(bool);

    impl Apartment {
        fn enter() -> Apartment {
            // S_FALSE (already initialized) still counts and needs its CoUninitialize; a different mode fails.
            Apartment(unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok())
        }
    }

    impl Drop for Apartment {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    /// Runs `work` on a fresh thread with COM initialized: the thread is the apartment, so nothing leaks into the
    /// blocking pool's threads or Tauri's.
    fn on_com_thread<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
        std::thread::Builder::new()
            .name("recycle".into())
            .spawn(move || {
                let _apartment = Apartment::enter();
                work()
            })
            .map_err(|e| e.to_string())?
            .join()
            .map_err(|_| "The Recycle Bin operation crashed.".to_string())?
    }

    fn hresult_message(e: &windows::core::Error) -> String {
        let text = e.message();
        if text.is_empty() {
            format!("Windows error {:#010x}", e.code().0)
        } else {
            text
        }
    }

    #[derive(Default)]
    struct SinkState {
        /// `PreDeleteItem` saw a delete that would not be a recycle, and cancelled it.
        refused: bool,
        /// `PostDeleteItem` came, with its result.
        deleted: Option<HRESULT>,
        /// The item in the Recycle Bin that `PostDeleteItem` reported.
        recycled: Option<String>,
        /// `PostMoveItem` came (a restore), with its result and the path the file really got.
        moved: Option<HRESULT>,
        moved_to: Option<String>,
    }

    /// The progress sink that makes a permanent delete impossible (see the module's header).
    #[implement(IFileOperationProgressSink)]
    struct Sink {
        state: Arc<Mutex<SinkState>>,
    }

    impl Sink {
        fn state(&self) -> std::sync::MutexGuard<'_, SinkState> {
            self.state.lock().unwrap_or_else(|e| e.into_inner())
        }
    }

    #[allow(non_snake_case)]
    impl IFileOperationProgressSink_Impl for Sink_Impl {
        fn StartOperations(&self) -> windows::core::Result<()> {
            Ok(())
        }
        fn FinishOperations(&self, _hrresult: HRESULT) -> windows::core::Result<()> {
            Ok(())
        }
        fn PreRenameItem(&self, _flags: u32, _item: Ref<IShellItem>, _new_name: &PCWSTR) -> windows::core::Result<()> {
            Ok(())
        }
        fn PostRenameItem(&self, _flags: u32, _item: Ref<IShellItem>, _new_name: &PCWSTR, _hr: HRESULT, _created: Ref<IShellItem>) -> windows::core::Result<()> {
            Ok(())
        }
        fn PreMoveItem(&self, _flags: u32, _item: Ref<IShellItem>, _dest: Ref<IShellItem>, _new_name: &PCWSTR) -> windows::core::Result<()> {
            Ok(())
        }
        fn PostMoveItem(&self, _flags: u32, _item: Ref<IShellItem>, _dest: Ref<IShellItem>, _new_name: &PCWSTR, hr: HRESULT, created: Ref<IShellItem>) -> windows::core::Result<()> {
            let mut state = self.state();
            state.moved = Some(hr);
            state.moved_to = created.as_ref().and_then(path_of);
            Ok(())
        }
        fn PreCopyItem(&self, _flags: u32, _item: Ref<IShellItem>, _dest: Ref<IShellItem>, _new_name: &PCWSTR) -> windows::core::Result<()> {
            Ok(())
        }
        fn PostCopyItem(&self, _flags: u32, _item: Ref<IShellItem>, _dest: Ref<IShellItem>, _new_name: &PCWSTR, _hr: HRESULT, _created: Ref<IShellItem>) -> windows::core::Result<()> {
            Ok(())
        }
        fn PreDeleteItem(&self, flags: u32, _item: Ref<IShellItem>) -> windows::core::Result<()> {
            // Without this flag the shell is going to delete the file for good (no bin there, or the file does not
            // fit): cancel before anything happens.
            if flags & (TSF_DELETE_RECYCLE_IF_POSSIBLE.0 as u32) == 0 {
                self.state().refused = true;
                return Err(E_ABORT.into());
            }
            Ok(())
        }
        fn PostDeleteItem(&self, _flags: u32, _item: Ref<IShellItem>, hr: HRESULT, created: Ref<IShellItem>) -> windows::core::Result<()> {
            let mut state = self.state();
            state.deleted = Some(hr);
            if hr.is_ok() {
                state.recycled = created.as_ref().and_then(path_of);
            }
            Ok(())
        }
        fn PreNewItem(&self, _flags: u32, _dest: Ref<IShellItem>, _new_name: &PCWSTR) -> windows::core::Result<()> {
            Ok(())
        }
        fn PostNewItem(&self, _flags: u32, _dest: Ref<IShellItem>, _new_name: &PCWSTR, _template: &PCWSTR, _attributes: u32, _hr: HRESULT, _item: Ref<IShellItem>) -> windows::core::Result<()> {
            Ok(())
        }
        fn UpdateProgress(&self, _total: u32, _so_far: u32) -> windows::core::Result<()> {
            Ok(())
        }
        fn ResetTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }
        fn PauseTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }
        fn ResumeTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }
    }

    fn wide(path: &Path) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    }

    /// Moves the file into the Recycle Bin through `IFileOperation`; the sink cancels anything that would delete it
    /// for good. The caller's location check (`classify_location`) comes before; the tests call this directly to
    /// prove that the sink alone keeps a file that cannot be recycled from being deleted.
    pub fn recycle(path: &Path) -> Result<String, String> {
        let path = path.to_path_buf();
        on_com_thread(move || {
            let wide = wide(&path);
            let item: IShellItem = unsafe { SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None) }.map_err(|e| hresult_message(&e))?;
            let operation: IFileOperation =
                unsafe { CoCreateInstance(&FileOperation, None, CLSCTX_ALL) }.map_err(|e| hresult_message(&e))?;
            let flags = FOFX_RECYCLEONDELETE.0 | FOF_NOCONFIRMATION.0 | FOF_SILENT.0 | FOF_NOERRORUI.0;
            unsafe { operation.SetOperationFlags(windows::Win32::UI::Shell::FILEOPERATION_FLAGS(flags)) }.map_err(|e| hresult_message(&e))?;
            let state = Arc::new(Mutex::new(SinkState::default()));
            let sink: IFileOperationProgressSink = Sink { state: state.clone() }.into();
            let cookie = unsafe { operation.Advise(&sink) }.map_err(|e| hresult_message(&e))?;
            let outcome = unsafe { operation.DeleteItem(&item, None) }.and_then(|_| unsafe { operation.PerformOperations() });
            unsafe { operation.Unadvise(cookie).ok() };
            let mut state = state.lock().unwrap_or_else(|e| e.into_inner());
            if state.refused {
                return Err(SINK_REFUSED.into());
            }
            if let Err(e) = outcome {
                return Err(hresult_message(&e));
            }
            if unsafe { operation.GetAnyOperationsAborted() }.map(|b| b.as_bool()).unwrap_or(false) {
                return Err("Moving the file to the Recycle Bin was cancelled.".into());
            }
            match state.deleted {
                Some(hr) if hr.is_err() => Err(hresult_message(&windows::core::Error::from(hr))),
                // Deleted, but no item in the bin to show for it. The sink's check makes this impossible; if it
                // happens anyway the user must hear that the file is gone and where to look.
                Some(_) => state.recycled.take().ok_or_else(|| {
                    "The file left its folder, but Windows did not say where it went. Look in the Recycle Bin.".to_string()
                }),
                None => Err("Windows did not move the file.".into()),
            }
        })
    }

    /// Moves the item in the bin's own folder (the shell namespace) back to its folder: that is a restore.
    ///
    /// The item `psiNewlyCreated` names is a plain file inside `$Recycle.Bin`: moving that would not be one, and its
    /// context menu has no "undelete" verb. The bin's own folder is searched for the item with that path.
    pub fn restore(item: &str, original: &Path) -> Result<(), String> {
        let item = item.to_string();
        let original = original.to_path_buf();
        on_com_thread(move || {
            let gone = || "The file is no longer in the Recycle Bin.".to_string();
            let bin: IShellItem = unsafe { SHGetKnownFolderItem(&FOLDERID_RecycleBinFolder, KF_FLAG_DEFAULT, None) }.map_err(|e| hresult_message(&e))?;
            let items: IEnumShellItems = unsafe { bin.BindToHandler(None, &BHID_EnumItems) }.map_err(|e| hresult_message(&e))?;
            let mut found = None;
            loop {
                let mut next: [Option<IShellItem>; 1] = [None];
                let mut fetched = 0u32;
                if unsafe { items.Next(&mut next, Some(&mut fetched)) }.is_err() || fetched == 0 {
                    break;
                }
                if let Some(candidate) = next[0].take() {
                    if path_of(&candidate).is_some_and(|p| p.eq_ignore_ascii_case(&item)) {
                        found = Some(candidate);
                        break;
                    }
                }
            }
            let found = found.ok_or_else(gone)?;
            let dir = original.parent().ok_or_else(|| "The path has no folder.".to_string())?;
            let dir_wide = wide(dir);
            let folder: IShellItem = unsafe { SHCreateItemFromParsingName(PCWSTR(dir_wide.as_ptr()), None) }.map_err(|e| hresult_message(&e))?;
            let name = wide(Path::new(original.file_name().ok_or_else(|| "The path has no file name.".to_string())?));
            let operation: IFileOperation = unsafe { CoCreateInstance(&FileOperation, None, CLSCTX_ALL) }.map_err(|e| hresult_message(&e))?;
            // No dialogs. Something that appeared at the path since the caller looked is not replaced: the shell
            // gives the moved file another name instead, which `moved_to` shows.
            let flags = FOF_NOCONFIRMATION.0 | FOF_SILENT.0 | FOF_NOERRORUI.0 | FOF_RENAMEONCOLLISION.0;
            unsafe { operation.SetOperationFlags(windows::Win32::UI::Shell::FILEOPERATION_FLAGS(flags)) }.map_err(|e| hresult_message(&e))?;
            let state = Arc::new(Mutex::new(SinkState::default()));
            let sink: IFileOperationProgressSink = Sink { state: state.clone() }.into();
            let cookie = unsafe { operation.Advise(&sink) }.map_err(|e| hresult_message(&e))?;
            let outcome = unsafe { operation.MoveItem(&found, &folder, PCWSTR(name.as_ptr()), None) }.and_then(|_| unsafe { operation.PerformOperations() });
            unsafe { operation.Unadvise(cookie).ok() };
            outcome.map_err(|e| hresult_message(&e))?;
            let state = state.lock().unwrap_or_else(|e| e.into_inner());
            match (state.moved, &state.moved_to) {
                (Some(hr), Some(to)) if hr.is_ok() => {
                    // The bin leaves the metadata file of an item that was moved out (the shell's own Restore
                    // does the same, checked); with its item gone it is an orphan.
                    super::remove_orphan_metadata(Path::new(&item));
                    if !super::same_path(to, &original) {
                        return Err(format!("Something appeared at the old path meanwhile, so the file came back as {to} instead. Nothing was overwritten."));
                    }
                }
                (Some(hr), _) if hr.is_err() => return Err(hresult_message(&windows::core::Error::from(hr))),
                _ => return Err(gone()),
            }
            if std::fs::symlink_metadata(&original).is_err() {
                return Err(gone());
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(s: &str) -> Option<OsString> {
        Some(OsString::from(s))
    }

    #[test]
    fn only_an_isolated_profile_gets_the_hooks_and_it_never_reaches_the_real_bin() {
        // A normal profile ignores both variables.
        assert_eq!(backend_for(false, os("dir"), None), Backend::Shell);
        assert_eq!(backend_for(false, os("dir"), os("1")), Backend::Shell);
        assert_eq!(backend_for(false, None, None), Backend::Shell);
        // An isolated profile moves into the folder, or refuses; there is no way to the real bin.
        assert_eq!(backend_for(true, os("dir"), None), Backend::Folder(PathBuf::from("dir")));
        assert_eq!(backend_for(true, os("dir"), os("1")), Backend::Refused(NO_BIN_HERE));
        assert_eq!(backend_for(true, os("dir"), os("0")), Backend::Folder(PathBuf::from("dir")));
        assert!(matches!(backend_for(true, None, None), Backend::Refused(_)));
        assert!(matches!(backend_for(true, os(""), None), Backend::Refused(_)));
    }

    #[test]
    fn only_local_fixed_and_removable_drives_can_have_a_bin() {
        let drives = |letter: char| match letter {
            'C' | 'D' => DRIVE_FIXED,
            'E' => DRIVE_REMOVABLE,
            'Z' => 4, // DRIVE_REMOTE
            _ => 1,   // DRIVE_NO_ROOT_DIR
        };
        assert!(classify_location(r"C:\a\b.txt", drives).is_ok());
        assert!(classify_location(r"d:\b.txt", drives).is_ok());
        assert!(classify_location(r"E:/b.txt", drives).is_ok());
        assert!(classify_location(r"\\?\C:\a\b.txt", drives).is_ok());
        for refused in [
            r"Z:\mapped\b.txt",
            r"F:\gone\b.txt",
            r"\\server\share\b.txt",
            r"\\localhost\C$\b.txt",
            r"\\?\UNC\server\share\b.txt",
            r"\\?\Volume{1234}\b.txt",
            r"b.txt",
            r"C:b.txt",
            r"1:\b.txt",
            "",
        ] {
            assert!(classify_location(refused, drives).is_err(), "{refused}");
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kladde-recycle-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_test_folder_takes_a_file_and_gives_it_back() {
        let dir = scratch("folder");
        let bin = Backend::Folder(dir.join("bin"));
        let recycler = Recycler::default();
        let file = dir.join("a.txt");
        fs::write(&file, b"one").unwrap();
        let id = recycler.recycle(&bin, &file).unwrap();
        assert!(!file.exists());
        assert_eq!(fs::read_dir(dir.join("bin")).unwrap().count(), 1);
        assert_eq!(recycler.restore(id).unwrap(), file);
        assert_eq!(fs::read(&file).unwrap(), b"one");
        assert_eq!(fs::read_dir(dir.join("bin")).unwrap().count(), 0);
        // The id is spent.
        assert!(recycler.restore(id).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_refused_recycle_and_a_missing_file_leave_everything_as_it_is() {
        let dir = scratch("refuse");
        let recycler = Recycler::default();
        let file = dir.join("a.txt");
        fs::write(&file, b"one").unwrap();
        assert!(recycler.recycle(&Backend::Refused(NO_BIN_HERE), &file).is_err());
        assert_eq!(fs::read(&file).unwrap(), b"one");
        let bin = Backend::Folder(dir.join("bin"));
        assert!(recycler.recycle(&bin, &dir.join("nope.txt")).is_err());
        assert!(recycler.recycle(&bin, &dir).is_err(), "a folder is not a file");
        assert!(recycler.recycle(&bin, Path::new("relative.txt")).is_err());
        assert_eq!(fs::read(&file).unwrap(), b"one");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_overwrites_nothing_and_does_not_invent_folders() {
        let dir = scratch("occupied");
        let bin = Backend::Folder(dir.join("bin"));
        let recycler = Recycler::default();
        let file = dir.join("a.txt");
        fs::write(&file, b"old").unwrap();
        let id = recycler.recycle(&bin, &file).unwrap();
        // Something else took the place.
        fs::write(&file, b"new").unwrap();
        let err = recycler.restore(id).unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert_eq!(fs::read(&file).unwrap(), b"new");
        // The refusal keeps the id: with the place free again the file comes back.
        fs::remove_file(&file).unwrap();
        assert_eq!(recycler.restore(id).unwrap(), file);
        assert_eq!(fs::read(&file).unwrap(), b"old");
        // A folder that is gone is not made up.
        let sub = dir.join("sub");
        fs::create_dir(&sub).unwrap();
        let inner = sub.join("b.txt");
        fs::write(&inner, b"b").unwrap();
        let id = recycler.recycle(&bin, &inner).unwrap();
        fs::remove_dir(&sub).unwrap();
        assert!(recycler.restore(id).unwrap_err().contains("no longer exists"));
        assert!(!sub.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_the_metadata_of_an_item_that_left_the_bin_is_removed() {
        let dir = scratch("orphan");
        let r = dir.join("$RAB12CD.txt");
        let i = dir.join("$IAB12CD.txt");
        let other = dir.join("$IZZ99ZZ.txt");
        fs::write(&i, vec![0u8; 200]).unwrap();
        fs::write(&other, vec![0u8; 200]).unwrap();
        // The item is still in the bin: nothing happens.
        fs::write(&r, b"x").unwrap();
        remove_orphan_metadata(&r);
        assert!(i.exists());
        // It left: its own metadata goes, another item's stays.
        fs::remove_file(&r).unwrap();
        remove_orphan_metadata(&r);
        assert!(!i.exists());
        assert!(other.exists());
        // Not a bin name, or not a small metadata file: untouched.
        let plain = dir.join("note.txt");
        let lookalike = dir.join("$IAB12CD.bin");
        fs::write(&lookalike, b"keep").unwrap();
        fs::write(&plain, b"keep").unwrap();
        remove_orphan_metadata(&plain);
        remove_orphan_metadata(&r);
        assert!(lookalike.exists(), "only the matching $I<id><ext> may go");
        assert!(plain.exists());
        let big = dir.join("$IBIG.txt");
        fs::write(&big, vec![0u8; 10_000]).unwrap();
        remove_orphan_metadata(&dir.join("$RBIG.txt"));
        assert!(big.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_says_so_when_the_recycled_file_is_gone() {
        let dir = scratch("emptied");
        let bin = Backend::Folder(dir.join("bin"));
        let recycler = Recycler::default();
        let file = dir.join("a.txt");
        fs::write(&file, b"x").unwrap();
        let id = recycler.recycle(&bin, &file).unwrap();
        for entry in fs::read_dir(dir.join("bin")).unwrap() {
            fs::remove_file(entry.unwrap().path()).unwrap();
        }
        assert!(recycler.restore(id).unwrap_err().contains("no longer in the Recycle Bin"));
        assert!(!file.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    /// The `$R` file of a recycled item.
    #[cfg(windows)]
    fn bin_item(recycler: &Recycler, id: u32) -> Option<PathBuf> {
        let inner = recycler.0.lock().unwrap();
        match &inner.items.iter().find(|(i, _)| *i == id)?.1 {
            Entry::Shell { item, .. } => Some(PathBuf::from(item)),
            _ => None,
        }
    }

    /// Touches the real Recycle Bin of whoever runs it, so it only runs on request:
    /// `cargo test real_recycle_and_restore -- --ignored --nocapture`. Leaves nothing behind.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn real_recycle_and_restore() {
        let dir = scratch("real");
        let file = dir.join("kladde recycle test \u{fc}\u{ef}.txt");
        let bytes: Vec<u8> = (0..=255u8).cycle().take(5000).collect();
        fs::write(&file, &bytes).unwrap();
        let recycler = Recycler::default();
        let id = recycler.recycle(&Backend::Shell, &file).expect("recycle");
        assert!(!file.exists(), "the file must have left its folder");
        let r_file = bin_item(&recycler, id).expect("the bin item has a path");
        println!("bin item: {}", r_file.display());
        assert!(r_file.is_file(), "the $R file is in the bin");
        assert_eq!(fs::read(&r_file).unwrap(), bytes);
        let i_file = r_file.with_file_name(r_file.file_name().unwrap().to_string_lossy().replacen("$R", "$I", 1));
        assert!(i_file.is_file(), "the $I metadata is in the bin: {}", i_file.display());

        // Something else at the path: nothing is overwritten, the file stays in the bin, the id stays valid.
        fs::write(&file, b"occupied").unwrap();
        assert!(recycler.restore(id).unwrap_err().contains("already exists"));
        assert_eq!(fs::read(&file).unwrap(), b"occupied");
        assert!(r_file.is_file() && i_file.is_file(), "a refused restore leaves the bin as it was");
        fs::remove_file(&file).unwrap();

        // Restore for real.
        assert_eq!(recycler.restore(id).expect("restore"), file);
        assert_eq!(fs::read(&file).unwrap(), bytes, "identical bytes");
        assert!(!r_file.exists(), "no $R left in the bin");
        assert!(!i_file.exists(), "no $I left in the bin");

        // The race the check cannot see: the path is taken after the check. `shell::restore` is called directly,
        // which has no check; it must not replace the file, and the recycled one must not be lost.
        let id = recycler.recycle(&Backend::Shell, &file).expect("second recycle");
        let r_file = bin_item(&recycler, id).expect("second bin item");
        let i_file = r_file.with_file_name(r_file.file_name().unwrap().to_string_lossy().replacen("$R", "$I", 1));
        fs::write(&file, b"raced").unwrap();
        let raced = shell::restore(&r_file.to_string_lossy(), &file);
        println!("restore onto an occupied path: {raced:?}");
        assert!(raced.is_err());
        assert_eq!(fs::read(&file).unwrap(), b"raced", "an occupied path is never overwritten");
        let came_back: Vec<_> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).filter(|p| *p != file).collect();
        assert_eq!(came_back.len(), 1, "the recycled file came back under another name: {came_back:?}");
        assert_eq!(fs::read(&came_back[0]).unwrap(), bytes);
        assert!(!r_file.exists() && !i_file.exists(), "nothing of the test is left in the bin");
        let _ = fs::remove_dir_all(&dir);
    }

    /// The sink alone keeps a file that cannot be recycled: `shell::recycle` is called directly, without the
    /// up-front location check, on a path through the admin share (a network path, which has no bin).
    /// `cargo test sink_alone -- --ignored --nocapture`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn sink_alone_keeps_a_file_that_cannot_be_recycled() {
        let dir = scratch("share");
        let file = dir.join("must survive.txt");
        fs::write(&file, b"still here").unwrap();
        let local = file.to_string_lossy().into_owned();
        let (drive, rest) = local.split_at(2); // "C:" and the rest
        let share = PathBuf::from(format!(r"\\localhost\{}${}", &drive[..1], rest));
        println!("through the share: {}", share.display());
        assert!(share.is_file(), "the admin share must reach the file for this experiment");
        // The up-front check alone already refuses it.
        assert!(classify_location(&share.to_string_lossy(), shell::drive_type).is_err());
        let result = shell::recycle(&share);
        println!("shell::recycle without the location check: {:?}", result.as_ref().err());
        assert!(result.is_err(), "the sink must cancel a permanent delete");
        assert!(file.is_file(), "the file must still exist");
        assert_eq!(fs::read(&file).unwrap(), b"still here");
        let _ = fs::remove_dir_all(&dir);
    }
}
