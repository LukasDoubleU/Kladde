//! Reading and writing text files: encoding detection, BOMs and line endings.
//!
//! The editor always works with `\n` line breaks. Files are normalized on read and
//! converted back to their original line ending on write.

use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

/// How many bytes are inspected to guess encoding, line endings and binary-ness.
const SNIFF_LEN: usize = 1 << 20;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub text: String,
    pub encoding: String,
    pub bom: bool,
    pub eol: String,
    pub mtime: u64,
    pub size: u64,
    /// The file contains NUL bytes and is probably not text.
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
    let binary = !is_utf16 && memchr::memchr(0, &body[..body.len().min(SNIFF_LEN)]).is_some();
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
/// temporary file next to it, which then replaces the original. On Windows, ReplaceFileW keeps the
/// original's attributes, permissions and creation time. Where no temporary file can be created
/// (e.g. a folder that only allows writing existing files), it falls back to writing in place.
pub fn write_safely(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    // Follow symlinks, so the link stays a link and its target gets the new content.
    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let (Some(dir), Some(name)) = (target.parent(), target.file_name()) else {
        return fs::write(&target, bytes);
    };
    let tmp = dir.join(format!(".{}.kladde-save", name.to_string_lossy()));
    let written = fs::File::create(&tmp).and_then(|mut file| {
        file.write_all(bytes)?;
        file.sync_all()
    });
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
        return fs::write(&target, bytes);
    }
    let swapped = if target.exists() { replace_file(&target, &tmp) } else { fs::rename(&tmp, &target) };
    if swapped.is_err() {
        let _ = fs::remove_file(&tmp);
        return fs::write(&target, bytes);
    }
    Ok(())
}

#[cfg(windows)]
pub fn replace_file(target: &Path, replacement: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        ReplaceFileW, REPLACEFILE_IGNORE_ACL_ERRORS, REPLACEFILE_IGNORE_MERGE_ERRORS,
    };
    let wide = |p: &Path| p.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<u16>>();
    let (target, replacement) = (wide(target), wide(replacement));
    let flags = REPLACEFILE_IGNORE_MERGE_ERRORS | REPLACEFILE_IGNORE_ACL_ERRORS;
    // SAFETY: both paths are NUL-terminated UTF-16 strings that outlive the call.
    let ok = unsafe {
        ReplaceFileW(
            target.as_ptr(),
            replacement.as_ptr(),
            std::ptr::null(),
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
pub fn replace_file(target: &Path, replacement: &Path) -> std::io::Result<()> {
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
}
