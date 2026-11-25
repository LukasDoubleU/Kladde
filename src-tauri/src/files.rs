//! Reading and writing text files: encoding detection, BOMs and line endings.
//!
//! The editor always works with `\n` line breaks. Files are normalized on read and
//! converted back to their original line ending on write.

use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

/// How many bytes are inspected to guess encoding and line endings (and, for the large file viewer, whether
/// the file is text at all).
pub const SNIFF_LEN: usize = 1 << 20;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub text: String,
    pub encoding: String,
    pub bom: bool,
    pub eol: String,
    pub mtime: u64,
    pub size: u64,
    /// The file contains NUL bytes (outside UTF-16) and is probably not text.
    pub binary: bool,
    /// Decoding hit malformed sequences that were replaced with U+FFFD.
    pub lossy: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub exists: bool,
    pub is_file: bool,
    pub mtime: u64,
    pub size: u64,
}

pub fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn stat(path: &Path) -> FileStat {
    match fs::metadata(path) {
        Ok(meta) => FileStat {
            exists: true,
            is_file: meta.is_file(),
            mtime: mtime_ms(&meta),
            size: meta.len(),
        },
        Err(_) => FileStat { exists: false, is_file: false, mtime: 0, size: 0 },
    }
}

/// The largest document (Word file) the viewer reads: the page holds the bytes and the rendered DOM, so an
/// unbounded read could exhaust the WebView's memory.
pub const MAX_DOCUMENT_BYTES: u64 = 50 * 1024 * 1024;

/// Why a document could not be read for the viewer. `kind` lets the page tell a file that is too large (no retry,
/// offers other ways to open it) and one that another program holds (Word while saving: retry) from the rest.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentReadError {
    pub kind: &'static str,
    pub message: String,
    pub size: u64,
}

impl DocumentReadError {
    fn io(e: &std::io::Error) -> Self {
        // ERROR_SHARING_VIOLATION and ERROR_LOCK_VIOLATION: the writer has the file open for the moment.
        let kind = match e.raw_os_error() {
            Some(32) | Some(33) => "busy",
            _ if e.kind() == std::io::ErrorKind::NotFound => "notFound",
            _ => "io",
        };
        DocumentReadError { kind, message: e.to_string(), size: 0 }
    }

    fn too_large(size: u64, limit: u64) -> Self {
        DocumentReadError {
            kind: "tooLarge",
            message: format!("The file is larger than {} MB.", limit / 1024 / 1024),
            size,
        }
    }
}

/// Reads a whole file as bytes, refusing files above `limit` (also when it grew after the size was checked).
pub fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, DocumentReadError> {
    use std::io::Read;
    let file = fs::File::open(path).map_err(|e| DocumentReadError::io(&e))?;
    let meta = file.metadata().map_err(|e| DocumentReadError::io(&e))?;
    if !meta.is_file() {
        return Err(DocumentReadError { kind: "io", message: "This is not a file.".into(), size: 0 });
    }
    if meta.len() > limit {
        return Err(DocumentReadError::too_large(meta.len(), limit));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(limit + 1).read_to_end(&mut bytes).map_err(|e| DocumentReadError::io(&e))?;
    if bytes.len() as u64 > limit {
        return Err(DocumentReadError::too_large(bytes.len() as u64, limit));
    }
    Ok(bytes)
}

/// The document types the viewer shows (and the only files "Open in default app" will launch from the page).
pub fn is_document_path(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("docx"))
}

/// Returns the encoding signalled by a byte order mark and the BOM length.
pub fn sniff_bom(bytes: &[u8]) -> Option<(&'static Encoding, usize)> {
    Encoding::for_bom(bytes)
}

/// Guesses the encoding of BOM-less bytes: UTF-8 if valid, otherwise chardetng's best guess.
pub fn guess_encoding(sample: &[u8], is_complete: bool) -> &'static Encoding {
    match std::str::from_utf8(sample) {
        Ok(_) => UTF_8,
        // A sample cut in the middle of a multi-byte sequence is still UTF-8.
        Err(e) if !is_complete && e.error_len().is_none() => UTF_8,
        Err(_) => {
            let mut detector = chardetng::EncodingDetector::new();
            detector.feed(sample, is_complete);
            detector.guess(None, true)
        }
    }
}

pub fn encoding_by_label(label: &str) -> Result<&'static Encoding, String> {
    Encoding::for_label(label.trim().as_bytes()).ok_or_else(|| format!("Unknown encoding: {label}"))
}

pub fn detect_eol(text: &str) -> &'static str {
    let sample = &text.as_bytes()[..text.len().min(SNIFF_LEN)];
    let (mut crlf, mut lf, mut cr) = (0usize, 0usize, 0usize);
    let mut i = 0;
    while i < sample.len() {
        match sample[i] {
            b'\r' if sample.get(i + 1) == Some(&b'\n') => {
                crlf += 1;
                i += 1;
            }
            b'\r' => cr += 1,
            b'\n' => lf += 1,
            _ => {}
        }
        i += 1;
    }
    if crlf == 0 && lf == 0 && cr == 0 {
        // No line breaks at all: use the platform default for new lines.
        "CRLF"
    } else if crlf >= lf && crlf >= cr {
        "CRLF"
    } else if lf >= cr {
        "LF"
    } else {
        "CR"
    }
}

pub fn read(path: &Path, forced_encoding: Option<&str>) -> Result<FileContent, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;

    let bom = sniff_bom(&bytes);
    let (encoding, bom_len) = match forced_encoding {
        Some(label) => {
            let enc = encoding_by_label(label)?;
            let bom_len = bom.filter(|(b, _)| *b == enc).map_or(0, |(_, len)| len);
            (enc, bom_len)
        }
        None => match bom {
            Some(found) => found,
            None => {
                let sample = &bytes[..bytes.len().min(SNIFF_LEN)];
                (guess_encoding(sample, sample.len() == bytes.len()), 0)
            }
        },
    };

    let body = &bytes[bom_len..];
    let is_utf16 = encoding == UTF_16LE || encoding == UTF_16BE;
    // The whole file, not just the sniffed start: the text is in memory anyway, and a NUL byte anywhere means
    // that saving the decoded text could change bytes.
    let binary = !is_utf16 && memchr::memchr(0, body).is_some();
    let (decoded, lossy) = encoding.decode_without_bom_handling(body);

    let eol = detect_eol(&decoded);
    let text = if decoded.contains('\r') {
        decoded.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        decoded.into_owned()
    };

    Ok(FileContent {
        text,
        encoding: encoding.name().to_string(),
        bom: bom_len > 0,
        eol: eol.to_string(),
        mtime: mtime_ms(&meta),
        size: meta.len(),
        binary,
        lossy,
    })
}

/// Whether the start of a file (`body`, after the BOM) is not text: `(binary, lossy)` like `FileContent`.
/// `complete` says that `body` is the whole file; otherwise a multi-byte sequence cut off at its end is
/// not counted as malformed. Used by the large file viewer, which only reads the start.
pub fn sniff_flags(body: &[u8], encoding: &'static Encoding, complete: bool) -> (bool, bool) {
    let is_utf16 = encoding == UTF_16LE || encoding == UTF_16BE;
    let binary = !is_utf16 && memchr::memchr(0, body).is_some();
    let mut decoder = encoding.new_decoder_without_bom_handling();
    let Some(capacity) = decoder.max_utf8_buffer_length_without_replacement(body.len()) else {
        return (binary, false);
    };
    let mut out = String::with_capacity(capacity);
    let (result, _) = decoder.decode_to_string_without_replacement(body, &mut out, complete);
    (binary, matches!(result, encoding_rs::DecoderResult::Malformed(..)))
}

/// Encodes `text` (with `\n` line breaks) with the given line ending, without a BOM.
pub fn encode_text(text: &str, enc: &'static Encoding, eol: &str) -> Result<Vec<u8>, String> {
    let text = match eol {
        "CRLF" => text.replace('\n', "\r\n"),
        "CR" => text.replace('\n', "\r"),
        _ => text.to_string(),
    };
    if enc == UTF_8 {
        Ok(text.into_bytes())
    } else if enc == UTF_16LE || enc == UTF_16BE {
        // encoding_rs only decodes UTF-16 (per the WHATWG spec), so encode by hand.
        let le = enc == UTF_16LE;
        let mut out = Vec::with_capacity(text.len() * 2);
        for unit in text.encode_utf16() {
            out.extend_from_slice(&if le { unit.to_le_bytes() } else { unit.to_be_bytes() });
        }
        Ok(out)
    } else {
        let (encoded, _, unmappable) = enc.encode(&text);
        if unmappable {
            return Err(format!(
                "The text contains characters that cannot be saved as {}. Save it as UTF-8 instead.",
                enc.name()
            ));
        }
        Ok(encoded.into_owned())
    }
}

/// The byte order mark of an encoding (empty for encodings without one).
pub fn bom_of(enc: &'static Encoding) -> &'static [u8] {
    if enc == UTF_8 {
        b"\xEF\xBB\xBF"
    } else if enc == UTF_16LE {
        b"\xFF\xFE"
    } else if enc == UTF_16BE {
        b"\xFE\xFF"
    } else {
        b""
    }
}

/// Encodes `text` (with `\n` line breaks) and writes it. Returns the new modification time.
pub fn write(path: &Path, text: &str, encoding: &str, bom: bool, eol: &str) -> Result<u64, String> {
    let enc = encoding_by_label(encoding)?;
    let body = encode_text(text, enc, eol)?;
    let out = if bom { [bom_of(enc), &body].concat() } else { body };

    write_safely(path, &out).map_err(|e| e.to_string())?;
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    Ok(mtime_ms(&meta))
}

/// Writes a file so that a crash or power loss never leaves it half-written: the bytes go to a
/// temporary file next to it, which then replaces the original (`swap_in`). On Windows, ReplaceFileW keeps the
/// original's attributes, permissions and creation time. Where no temporary file can be created
/// (e.g. a folder that only allows writing existing files) or the swap fails, it falls back to writing in place.
pub fn write_safely(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    // Follow symlinks, so the link stays a link and its target gets the new content.
    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let Some(tmp) = sibling(&target, SAVE_SUFFIX) else {
        return fs::write(&target, bytes);
    };
    let written = fs::File::create(&tmp).and_then(|mut file| {
        file.write_all(bytes)?;
        file.sync_all()
    });
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
        return fs::write(&target, bytes);
    }
    // A failed swap leaves the target with its old content (or absent, when even the old file could not be put
    // back), so the bytes are written once more, in place: the user's text is worth more than the metadata
    // and the atomicity that this last resort gives up.
    if swap_in(&target, &tmp).is_err() {
        let _ = fs::remove_file(&tmp);
        return fs::write(&target, bytes);
    }
    Ok(())
}

/// The suffixes of the two files that a save of a user's file leaves next to it while it runs (see `swap_in`).
const SAVE_SUFFIX: &str = ".kladde-save";
const OLD_SUFFIX: &str = ".kladde-old";

/// `.<name><suffix>` in the folder of `path`.
fn sibling(path: &Path, suffix: &str) -> Option<std::path::PathBuf> {
    Some(path.parent()?.join(format!(".{}{suffix}", path.file_name()?.to_string_lossy())))
}

/// Puts the finished temporary file `tmp` (`.<name>.kladde-save`, flushed) in the place of `target`. A file
/// that is not there yet gets a plain rename; an existing one goes through `replace_file`, which keeps its
/// attributes, ACL and creation time, with the old file moved to `.<name>.kladde-old` first.
///
/// `ReplaceFileW` is not one step: it moves the old file away and then renames the new one in, so a process
/// killed in between leaves nothing under the name (issue #28; `write_atomic` has one rename, but loses the
/// metadata that a user's file should keep). With a backup name of Kladde's own, the old content sits under a
/// name that `finish_interrupted_save` knows during the swap, and the next start puts the file back together.
///
/// On success the backup is deleted (when that fails, the leftover is harmless and removed by the next start).
/// An error leaves the user with their content: `ReplaceFileW` reports `ERROR_UNABLE_TO_REMOVE_REPLACED` (1175,
/// nothing moved) and `ERROR_UNABLE_TO_MOVE_REPLACEMENT` (1176, with a backup name both files keep their names)
/// without touching the target. `ERROR_UNABLE_TO_MOVE_REPLACEMENT_2` (1177) means that the old file already moved
/// to the backup name and the new one stays under its temporary name, so the old file is renamed back here.
/// The temporary file is left for the caller, who decides what to do (`write_safely` writes in place, the large
/// save renames it over the target).
pub fn swap_in(target: &Path, tmp: &Path) -> std::io::Result<()> {
    if !target.exists() {
        return fs::rename(tmp, target);
    }
    let Some(old) = sibling(target, OLD_SUFFIX) else {
        return replace_file(target, tmp, None);
    };
    // The target exists, so a backup that is still there belongs to a save that completed.
    let _ = fs::remove_file(&old);
    match replace_file(target, tmp, Some(&old)) {
        Ok(()) => {
            let _ = fs::remove_file(&old);
            Ok(())
        }
        Err(e) => {
            if !target.exists() && old.exists() {
                let _ = fs::rename(&old, target);
            }
            Err(e)
        }
    }
}

/// Follows a symlink (also in the folders of the path) to the file that a save writes: `write_safely` and the
/// large save put their temporary files next to the link's target, so that is where a killed save left them.
/// `canonicalize` fails when the target is missing (killed inside the swap), so the links are followed by hand.
fn save_target(path: &Path) -> std::path::PathBuf {
    if let Ok(real) = fs::canonicalize(path) {
        return real;
    }
    let mut at = path.to_path_buf();
    for _ in 0..8 {
        if !fs::symlink_metadata(&at).is_ok_and(|m| m.file_type().is_symlink()) {
            break;
        }
        let Ok(link) = fs::read_link(&at) else { break };
        at = if link.is_absolute() { link } else { at.parent().map_or(link.clone(), |dir| dir.join(&link)) };
    }
    match (at.parent().and_then(|dir| fs::canonicalize(dir).ok()), at.file_name()) {
        (Some(dir), Some(name)) => dir.join(name),
        _ => at,
    }
}

/// Resolves what a killed save of `path` left behind, so that the user's file is back under its name before a
/// tab opens it. A save leaves `.<name>.kladde-save` (the new content, complete once it was flushed) and, during
/// the swap, `.<name>.kladde-old` (the old content), see `swap_in`:
///
/// - the file is there and `.kladde-old` too: the save completed and only the delete was missed, the backup goes;
///   `.kladde-save` too: killed before the swap, the temporary file may be partial, it goes;
/// - the file is missing, `.kladde-old` and `.kladde-save` are there: killed inside the swap. The old file is put
///   back and the save is finished with the new content (the same swap, so attributes and ACL are kept; when that
///   fails, a plain rename of the new file; when that fails as well, the old file stays and the new content
///   under `.kladde-save`);
/// - the file is missing, only `.kladde-old` is there: it is put back;
/// - the file is missing and there is no `.kladde-old`: nothing is touched (a lone `.kladde-save` may be partial,
///   or the start of a file that never existed).
///
/// A symlink is followed to its target. Not found: a link whose target is missing as well as the leftovers of a
/// Save as under another name than the path asked for. Best effort: an error stops the recovery of this path;
/// what is left is found by the next start.
pub fn finish_interrupted_save(path: &Path) -> std::io::Result<()> {
    // Runs for every file of the session before the first tab opens: a path that cannot be looked up (a network
    // share that does not answer, no permission) or whose folder is not there is left alone after one or two
    // lookups, instead of waiting for the same timeout in every check below.
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) if !path.parent().is_some_and(|dir| dir.is_dir()) => return Ok(()),
        _ => {}
    }
    let target = save_target(path);
    let (Some(old), Some(tmp)) = (sibling(&target, OLD_SUFFIX), sibling(&target, SAVE_SUFFIX)) else {
        return Ok(());
    };
    let remove = |p: &Path| match fs::remove_file(p) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    };
    if target.exists() {
        remove(&old)?;
        return remove(&tmp);
    }
    if !old.exists() {
        return Ok(());
    }
    fs::rename(&old, &target)?;
    if tmp.exists() {
        if let Err(e) = swap_in(&target, &tmp) {
            // The new content is what the user saved: keep it even without the old file's metadata.
            fs::rename(&tmp, &target).map_err(|_| e)?;
        }
    }
    Ok(())
}

/// Writes one of Kladde's own files (the session, a backup, a journal) so that a crash at any moment leaves
/// either the old or the new content under its name: the bytes go to a temporary file next to it, which is
/// flushed and then renamed over it in one step.
///
/// Not `ReplaceFileW` (`write_safely`): it first moves the old file away (to `<name>~RF<hex>.TMP`) and only then
/// renames the new one in, so a process killed in between leaves no file under the name at all. A session that
/// vanished like this restored nothing, and the next save pruned every backup it no longer named (issue #26).
/// Kladde's own files have no attributes, permissions or creation time worth keeping, and there is no fallback
/// to writing in place: an error is reported instead (the caller keeps the old file and tries again later).
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a file path"));
    };
    let tmp = dir.join(format!(".{}.kladde-save", name.to_string_lossy()));
    let written = fs::File::create(&tmp).and_then(|mut file| {
        file.write_all(bytes)?;
        file.sync_all()
    });
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    // A virus scanner or indexer may hold the old file for a moment: try the rename a few times.
    let mut attempt = 0;
    loop {
        match fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(_) if attempt < 5 => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(20 * attempt));
            }
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                return Err(e);
            }
        }
    }
}

/// ReplaceFileW: `replacement` takes the place of `target` and keeps its attributes, ACL, streams and creation
/// time. With `backup`, the old file ends up under that name instead of in a `<name>~RF<hex>.TMP` that nobody
/// owns.
#[cfg(windows)]
fn replace_file(target: &Path, replacement: &Path, backup: Option<&Path>) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        ReplaceFileW, REPLACEFILE_IGNORE_ACL_ERRORS, REPLACEFILE_IGNORE_MERGE_ERRORS,
    };
    let wide = |p: &Path| p.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<u16>>();
    let (target, replacement) = (wide(target), wide(replacement));
    let backup = backup.map(wide);
    let flags = REPLACEFILE_IGNORE_MERGE_ERRORS | REPLACEFILE_IGNORE_ACL_ERRORS;
    // SAFETY: all paths are NUL-terminated UTF-16 strings that outlive the call.
    let ok = unsafe {
        ReplaceFileW(
            target.as_ptr(),
            replacement.as_ptr(),
            backup.as_ref().map_or(std::ptr::null(), |b| b.as_ptr()),
            flags,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(target: &Path, replacement: &Path, _backup: Option<&Path>) -> std::io::Result<()> {
    fs::rename(replacement, target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("kladde-tests");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn utf8_crlf_roundtrip() {
        let path = temp_file("crlf.txt", b"a\r\nb\r\nc");
        let content = read(&path, None).unwrap();
        assert_eq!(content.text, "a\nb\nc");
        assert_eq!(content.encoding, "UTF-8");
        assert_eq!(content.eol, "CRLF");
        write(&path, &content.text, &content.encoding, content.bom, &content.eol).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"a\r\nb\r\nc");
    }

    #[test]
    fn utf16le_bom_roundtrip() {
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "hä\nx".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let path = temp_file("utf16.txt", &bytes);
        let content = read(&path, None).unwrap();
        assert_eq!(content.text, "hä\nx");
        assert_eq!(content.encoding, "UTF-16LE");
        assert!(content.bom);
        assert!(!content.binary);
        write(&path, &content.text, &content.encoding, content.bom, &content.eol).unwrap();
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }

    #[test]
    fn legacy_8bit_roundtrip() {
        // "Größe" in windows-1252
        let bytes = b"Gr\xF6\xDFe\n";
        let path = temp_file("ansi.txt", bytes);
        let content = read(&path, None).unwrap();
        assert_eq!(content.text, "Größe\n");
        assert_eq!(content.encoding, "windows-1252");
        assert_eq!(content.eol, "LF");
        write(&path, &content.text, &content.encoding, content.bom, &content.eol).unwrap();
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }

    #[test]
    fn unmappable_characters_are_rejected() {
        let path = temp_file("unmappable.txt", b"x");
        assert!(write(&path, "日本", "windows-1252", false, "LF").is_err());
    }

    #[test]
    fn safe_write_replaces_content_and_leaves_no_temp_file() {
        let path = temp_file("safe.txt", b"old content that is longer");
        write_safely(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        let dir = path.parent().unwrap();
        assert!(!dir.join(".safe.txt.kladde-save").exists());
        // A file that does not exist yet is created.
        let fresh = dir.join("fresh-safe.txt");
        let _ = fs::remove_file(&fresh);
        write_safely(&fresh, b"x").unwrap();
        assert_eq!(fs::read(&fresh).unwrap(), b"x");
    }

    /// The files in a folder, to say what a test found.
    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    fn save_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("kladde-tests-save-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_normal_save_leaves_no_leftovers() {
        let dir = save_dir("normal");
        let path = dir.join("doc.txt");
        fs::write(&path, b"old").unwrap();
        write_safely(&path, b"new").unwrap();
        write_safely(&path, b"newer").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"newer");
        assert_eq!(names(&dir), ["doc.txt"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_save_that_completed_loses_its_old_file() {
        // The file is there and so is the backup: only the delete was missed.
        let dir = save_dir("completed");
        let path = dir.join("doc.txt");
        fs::write(&path, b"new").unwrap();
        fs::write(dir.join(".doc.txt.kladde-old"), b"old").unwrap();
        finish_interrupted_save(&path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(names(&dir), ["doc.txt"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_save_killed_before_the_swap_loses_its_partial_temp_file() {
        let dir = save_dir("before");
        let path = dir.join("doc.txt");
        fs::write(&path, b"old").unwrap();
        fs::write(dir.join(".doc.txt.kladde-save"), b"ne").unwrap();
        finish_interrupted_save(&path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"old");
        assert_eq!(names(&dir), ["doc.txt"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_save_killed_inside_the_swap_is_finished() {
        let dir = save_dir("inside");
        let path = dir.join("doc.txt");
        fs::write(dir.join(".doc.txt.kladde-old"), b"old").unwrap();
        fs::write(dir.join(".doc.txt.kladde-save"), b"new").unwrap();
        finish_interrupted_save(&path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(names(&dir), ["doc.txt"]);
        // Asking again changes nothing.
        finish_interrupted_save(&path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_with_only_its_backup_is_put_back() {
        let dir = save_dir("only-old");
        let path = dir.join("doc.txt");
        fs::write(dir.join(".doc.txt.kladde-old"), b"old").unwrap();
        finish_interrupted_save(&path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"old");
        assert_eq!(names(&dir), ["doc.txt"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_file_without_a_backup_is_left_alone() {
        // A lone temporary file may be partial or the start of a file that never existed.
        let dir = save_dir("lone-save");
        let path = dir.join("doc.txt");
        fs::write(dir.join(".doc.txt.kladde-save"), b"maybe partial").unwrap();
        finish_interrupted_save(&path).unwrap();
        assert!(!path.exists());
        assert_eq!(names(&dir), [".doc.txt.kladde-save"]);
        // Nothing at all is fine too.
        finish_interrupted_save(&dir.join("other.txt")).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn finishing_a_save_keeps_the_attributes() {
        use std::os::windows::fs::MetadataExt;
        let dir = save_dir("inside-hidden");
        let path = dir.join("doc.txt");
        fs::write(dir.join(".doc.txt.kladde-old"), b"old").unwrap();
        std::process::Command::new("attrib").arg("+h").arg(dir.join(".doc.txt.kladde-old")).status().unwrap();
        fs::write(dir.join(".doc.txt.kladde-save"), b"new").unwrap();
        finish_interrupted_save(&path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        // The old file's attributes moved to the new one with the swap.
        assert_ne!(fs::metadata(&path).unwrap().file_attributes() & 0x2, 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_symlink_is_followed_to_its_target() {
        let dir = save_dir("link");
        let real = dir.join("real");
        fs::create_dir_all(&real).unwrap();
        let link = dir.join("doc.txt");
        let target = real.join("target.txt");
        fs::write(&target, b"x").unwrap();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&target, &link);
        #[cfg(not(windows))]
        let linked = std::os::unix::fs::symlink(&target, &link);
        if linked.is_err() {
            // Windows only allows symlinks with the developer mode or as an administrator.
            eprintln!("symlinks are not allowed here, the test checked nothing");
            let _ = fs::remove_dir_all(&dir);
            return;
        }
        // Killed inside the swap of the target: it is missing, the link dangles.
        fs::remove_file(&target).unwrap();
        fs::write(real.join(".target.txt.kladde-old"), b"old").unwrap();
        fs::write(real.join(".target.txt.kladde-save"), b"new").unwrap();
        finish_interrupted_save(&link).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert_eq!(fs::read(&link).unwrap(), b"new");
        assert_eq!(names(&real), ["target.txt"]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A swap that cannot happen leaves the user with their content and reports an error; `write_safely` then has
    /// nothing better to do than the same in place, which fails as well while another program holds the file.
    #[cfg(windows)]
    #[test]
    fn a_failed_swap_keeps_the_old_content() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = save_dir("locked");
        let path = dir.join("doc.txt");
        fs::write(&path, b"old").unwrap();
        // Another program holds the file without sharing.
        let held = fs::OpenOptions::new().read(true).share_mode(0).open(&path).unwrap();
        fs::write(dir.join(".doc.txt.kladde-save"), b"new").unwrap();
        assert!(swap_in(&path, &dir.join(".doc.txt.kladde-save")).is_err());
        assert!(write_safely(&path, b"new").is_err());
        drop(held);
        assert_eq!(fs::read(&path).unwrap(), b"old");
        assert!(!dir.join(".doc.txt.kladde-old").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    /// The writer half of `a_save_survives_a_kill`: saves a user's file again and again until it is killed.
    #[test]
    #[ignore]
    fn safe_write_loop() {
        let Some(path) = std::env::var_os("KLADDE_TEST_SAFE_LOOP") else { return };
        for n in 0u64.. {
            write_safely(Path::new(&path), format!("version {n} {}", "x".repeat(4096)).as_bytes()).unwrap();
        }
    }

    /// A process killed while it saves a user's file leaves nothing under the name for about every fifth kill with
    /// a plain `ReplaceFileW` (issue #28); with the backup name and `finish_interrupted_save` the file is there
    /// afterwards, complete (the old or the new version), and no `.kladde-old` is left.
    #[test]
    fn a_save_survives_a_kill() {
        use std::time::{Duration, Instant};
        let dir = save_dir("kill");
        let path = dir.join("doc.txt");
        let mut missing = 0;
        for round in 0..60u64 {
            let _ = fs::remove_file(dir.join(".doc.txt.kladde-save"));
            fs::write(&path, b"start").unwrap();
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["files::tests::safe_write_loop", "--exact", "--ignored", "--test-threads=1"])
                .env("KLADDE_TEST_SAFE_LOOP", &path)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            let started = Instant::now();
            while fs::read(&path).map_or(true, |bytes| bytes == b"start") {
                assert!(started.elapsed() < Duration::from_secs(30), "the writer did not start");
                std::thread::sleep(Duration::from_millis(1));
            }
            std::thread::sleep(Duration::from_millis(5 + round * 7 % 60));
            let _ = child.kill();
            child.wait().unwrap();
            if !path.exists() {
                missing += 1;
            }
            let before = names(&dir);
            finish_interrupted_save(&path).unwrap();
            let bytes = fs::read(&path).unwrap_or_else(|e| panic!("round {round}: no file after the recovery ({e}), the folder had {before:?}"));
            assert!(bytes.starts_with(b"version ") && bytes.ends_with(b"x") && bytes.len() > 4000, "round {round}: a partial file");
            assert!(!dir.join(".doc.txt.kladde-old").exists(), "round {round}: the backup is left, the folder had {before:?}");
        }
        eprintln!("the file was missing after {missing} of 60 kills, before the recovery");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_replaces_content_and_leaves_no_temp_file() {
        let path = temp_file("atomic.json", b"old content that is longer");
        write_atomic(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert!(!path.parent().unwrap().join(".atomic.json.kladde-save").exists());
    }

    /// The writer half of `atomic_write_survives_a_kill`: rewrites the file until it is killed.
    #[test]
    #[ignore]
    fn atomic_write_loop() {
        let Some(path) = std::env::var_os("KLADDE_TEST_ATOMIC_LOOP") else { return };
        for n in 0u64.. {
            write_atomic(Path::new(&path), format!("version {n} {}", "x".repeat(4096)).as_bytes()).unwrap();
        }
    }

    /// A process killed while it replaces one of Kladde's files leaves the old or the new content under the
    /// name, never nothing. `ReplaceFileW` fails this about every fifth kill: it moves the old file away
    /// before it renames the new one in (issue #26).
    #[test]
    fn atomic_write_survives_a_kill() {
        use std::time::{Duration, Instant};
        let dir = std::env::temp_dir().join(format!("kladde-tests-atomic-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.json");
        for round in 0..30u64 {
            fs::write(&path, b"start").unwrap();
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["files::tests::atomic_write_loop", "--exact", "--ignored", "--test-threads=1"])
                .env("KLADDE_TEST_ATOMIC_LOOP", &path)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            // Kill the writer once it runs, at a different point of its loop each round.
            let started = Instant::now();
            while fs::read(&path).map_or(true, |bytes| bytes == b"start") {
                assert!(started.elapsed() < Duration::from_secs(30), "the writer did not start");
                std::thread::sleep(Duration::from_millis(1));
            }
            std::thread::sleep(Duration::from_millis(5 + round * 7 % 60));
            let _ = child.kill();
            child.wait().unwrap();
            let left: Vec<_> = fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name()).collect();
            let bytes = fs::read(&path).unwrap_or_else(|e| panic!("round {round}: no file after the kill ({e}), the folder has {left:?}"));
            assert!(bytes.starts_with(b"version ") && bytes.ends_with(b"x"), "round {round}: a partial file");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn safe_write_keeps_file_attributes() {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN: u32 = 0x2;
        let path = temp_file("hidden.txt", b"secret");
        std::process::Command::new("attrib").arg("+h").arg(&path).status().unwrap();
        write_safely(&path, b"still hidden").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"still hidden");
        assert_ne!(fs::metadata(&path).unwrap().file_attributes() & HIDDEN, 0);
        std::process::Command::new("attrib").arg("-h").arg(&path).status().unwrap();
    }

    #[test]
    fn binary_is_flagged() {
        let path = temp_file("bin.dat", b"ab\x00cd");
        assert!(read(&path, None).unwrap().binary);
    }

    #[test]
    fn a_nul_byte_after_the_sniffed_start_still_flags_binary() {
        let mut bytes = vec![b'a'; SNIFF_LEN + 100];
        bytes[SNIFF_LEN + 50] = 0;
        let path = temp_file("late-nul.dat", &bytes);
        assert!(read(&path, None).unwrap().binary);
    }

    #[test]
    fn sniff_flags_tell_binary_and_lossy_apart() {
        assert_eq!(sniff_flags(b"plain text\n", UTF_8, true), (false, false));
        assert_eq!(sniff_flags(b"ab\x00cd", UTF_8, true), (true, false));
        // Invalid UTF-8 without any NUL: lossy, not binary.
        assert_eq!(sniff_flags(b"caf\xE9\xFF", UTF_8, true), (false, true));
        // A sequence cut at the end of a partial read is not malformed; in a complete file it is.
        let cut = &"é".as_bytes()[..1];
        assert_eq!(sniff_flags(cut, UTF_8, false), (false, false));
        assert_eq!(sniff_flags(cut, UTF_8, true), (false, true));
        // NUL is part of UTF-16 text.
        assert_eq!(sniff_flags(b"a\x00b\x00", UTF_16LE, true), (false, false));
    }

    #[test]
    fn lossy_is_flagged() {
        let path = temp_file("lossy.txt", b"caf\xE9 \xC3(");
        // Forced to UTF-8: the invalid bytes are replaced when decoding.
        let content = read(&path, Some("UTF-8")).unwrap();
        assert!(content.lossy);
        assert!(!content.binary);
    }

    #[test]
    fn document_read_has_a_limit() {
        let path = temp_file("limit.docx", &[7u8; 100]);
        assert_eq!(read_limited(&path, 100).unwrap().len(), 100);
        let err = read_limited(&path, 99).unwrap_err();
        assert_eq!((err.kind, err.size), ("tooLarge", 100));
        assert_eq!(read_limited(&path.with_file_name("missing.docx"), 100).unwrap_err().kind, "notFound");
        assert_eq!(read_limited(path.parent().unwrap(), 100).unwrap_err().kind, "io");
    }

    #[test]
    fn document_paths_are_recognized_by_extension() {
        assert!(is_document_path(Path::new("Folder/Report.DOCX")));
        assert!(is_document_path(Path::new("a.docx")));
        assert!(!is_document_path(Path::new("a.docm")));
        assert!(!is_document_path(Path::new("a.exe")));
        assert!(!is_document_path(Path::new("docx")));
    }
}
