//! Viewer backend for files too large to load into the editor.
//!
//! The file is never read as a whole: a background thread builds an index of line
//! start offsets, and the frontend fetches only the lines it displays. Reads are
//! positional (no memory map), so the file stays writable for other processes,
//! e.g. a logger that is still appending to it. When the file grows, the index is
//! extended from where it stopped instead of being rebuilt.
//!
//! UTF-16 (with BOM) is indexed on 2-byte code units. Everything else is treated as
//! ASCII compatible, i.e. a line break is the byte 0x0A (true for UTF-8 and the
//! legacy code pages Kladde detects).
//!
//! Search works on chunks of about 8 MB that end at line breaks, so it needs no
//! index to run and finds early matches while the index is still being built. A
//! match cannot span two chunks (a multi-line pattern only works within one chunk);
//! inside a single line longer than a chunk, chunks overlap by 64 KB, so matches
//! longer than that can be missed there.
//!
//! Editing: the first edit (once the index is complete) puts a piece table (pieces.rs) over
//! the file, and from then on every read, line lookup and search goes through it. Inserted
//! text is encoded into the file's encoding and line ending, so untouched bytes (including
//! invalid ones and mixed line endings) are saved exactly as they were. Saving streams the
//! pieces into a temporary file next to the original, which then replaces it; the viewer
//! continues on the new file with an index derived from the piece table. While there are
//! unsaved edits, the file is not followed when it grows, and Kladde keeps a handle that
//! denies other programs write access, so the original the edits refer to stays intact.
//! Hot exit backs up a journal of the pieces plus the add buffer (append-only, like the
//! buffer itself), checked against the original's size, time and fingerprint on restore.
//!
//! Lines: a file that ends with a line break has an empty last line, like in the editor.

use crate::files::{detect_eol, encode_text, guess_encoding, mtime_ms, replace_file, sniff_bom, write_safely};
use crate::pieces::{EditKind, PieceTable, Replace, Source};
use base64::Engine;
use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const CHUNK: usize = 8 << 20;
/// How far to look for a line break to end a search chunk at.
const SNAP: u64 = 1 << 20;
/// Overlap of search chunks that had to be cut inside a line.
const OVERLAP: u64 = 64 << 10;
/// Longer lines are cut off for display; minified files can be one giant line.
const MAX_LINE_BYTES: u64 = 64 << 10;
/// Bytes at the start and at the end of the indexed part that tell whether the file was rewritten.
const FINGERPRINT: u64 = 4096;
/// Largest selection that is copied to the clipboard.
const MAX_COPY: u64 = 64 << 20;

/// How line breaks look in the file's encoding.
#[derive(Clone, Copy, PartialEq)]
enum Breaks {
    /// A 0x0A byte.
    Byte,
    /// 0x0A 0x00 on a 2-byte boundary.
    Utf16Le,
    /// 0x00 0x0A on a 2-byte boundary.
    Utf16Be,
}

/// Start and end of the file as read when it was last known to be unchanged.
struct Fingerprint {
    head: Vec<u8>,
    tail_at: u64,
    tail: Vec<u8>,
}

/// The edited document.
struct Edits {
    table: PieceTable,
    /// Modification time of the original when editing began (for the journal).
    mtime: u64,
}

/// The add buffer's backup file: its name part and how many bytes of the buffer it holds.
struct JournalState {
    generation: String,
    written: u64,
}

pub struct LargeFile {
    path: PathBuf,
    file: File,
    size: AtomicU64,
    encoding: &'static Encoding,
    breaks: Breaks,
    /// Bytes per code unit: 2 for UTF-16, else 1.
    unit: u64,
    bom_len: u64,
    /// Line ending of inserted line breaks, the one the file uses most: "CRLF" or "LF".
    eol: &'static str,
    index: RwLock<Vec<u64>>,
    /// Everything before this offset has been scanned for line breaks.
    indexed_to: AtomicU64,
    done: AtomicBool,
    cancelled: AtomicBool,
    /// An index worker is running (guards starting a second one when the file grows).
    worker: Mutex<bool>,
    fingerprint: Mutex<Fingerprint>,
    /// Bumped by every search, by cancelling and by edits; a running search stops when it changes.
    search_gen: AtomicU64,
    /// None until the first edit. Lock order: `edits` before `index`.
    edits: RwLock<Option<Edits>>,
    /// A save is streaming the document; edits wait until it is done.
    saving: AtomicBool,
    /// While there are unsaved edits: a handle that lets others read, rename and delete the file,
    /// but not write it, so the original the edits refer to cannot change underneath them.
    guard: Mutex<Option<File>>,
    journal: Mutex<JournalState>,
}

/// The open large files. Cheap to clone (shared), so a save can run on the blocking pool.
#[derive(Default, Clone)]
pub struct LargeFiles {
    next_id: Arc<AtomicU32>,
    open: Arc<Mutex<HashMap<u32, Arc<LargeFile>>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeOpened {
    pub id: u32,
    pub size: u64,
    pub encoding: String,
    pub bom: bool,
    pub eol: String,
    pub mtime: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeInfo {
    pub lines: u64,
    pub done: bool,
    /// Size of the document (with edits).
    pub size: u64,
    pub dirty: bool,
}

/// A position: line and column, both 0-based; the column counts UTF-16 code units of the
/// decoded line, like JavaScript strings.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Pos {
    pub line: u64,
    pub col: u64,
}

#[derive(Deserialize)]
pub struct Change {
    pub from: Pos,
    pub to: Pos,
    /// Text with `\n` line breaks; inserted with the file's line ending.
    pub text: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Edited {
    pub lines: u64,
    pub size: u64,
    pub dirty: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    /// Undo/redo: where the caret goes (the end of the restored text).
    pub caret: Option<Pos>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Restored {
    /// "applied", "conflict" (the file changed since the edits were made; nothing applied) or
    /// "missing" (no journal).
    pub status: &'static str,
    pub lines: u64,
    pub size: u64,
    pub dirty: bool,
}

/// The hot-exit backup of an edited large file. The pieces only make sense on top of exactly the
/// original they were made for, so that is recorded too.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    version: u32,
    size: u64,
    mtime: u64,
    head: String,
    tail_at: u64,
    tail: String,
    /// The add buffer is `<tab>.<added>.add` next to the journal; only its first `added_len` bytes count.
    added: String,
    added_len: u64,
    /// The document as (0 = original, 1 = add buffer, start, length).
    pieces: Vec<(u8, u64, u64)>,
}

fn journal_path(dir: &Path, tab: &str) -> PathBuf {
    dir.join(format!("{tab}.large.json"))
}

fn added_path(dir: &Path, tab: &str, generation: &str) -> PathBuf {
    dir.join(format!("{tab}.{generation}.add"))
}

/// Removes the journal and add buffers of a tab, e.g. after its edits were saved.
pub fn remove_journal(dir: &Path, tab: &str) {
    let _ = fs::remove_file(journal_path(dir, tab));
    remove_added(dir, tab, None);
}

/// Removes the add buffers of a tab except the one named `keep`.
fn remove_added(dir: &Path, tab: &str, keep: Option<&str>) {
    let prefix = format!("{tab}.");
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(&prefix) && name.ends_with(".add") && Some(name.as_str()) != keep {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// A name part that is unique enough for this tab's add buffer files.
fn new_generation(id: u32) -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{:x}{:x}", nanos as u64, id)
}

#[cfg(windows)]
fn open_guard(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 0x1;
    const FILE_SHARE_DELETE: u32 = 0x4;
    std::fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE).open(path)
}

#[cfg(not(windows))]
fn open_guard(path: &Path) -> std::io::Result<File> {
    File::open(path)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeRefresh {
    pub size: u64,
    pub mtime: u64,
    /// Not just appended to (shorter, or the old content differs): reopen the file.
    pub changed: bool,
}

#[derive(Serialize)]
pub struct Line {
    pub text: String,
    pub truncated: bool,
}

#[derive(Serialize, Debug)]
pub struct Match {
    pub line: u64,
    pub col: u64,
    pub len: u64,
}

#[derive(Serialize)]
pub struct SearchResult {
    pub found: Option<Match>,
    /// A newer search or a cancel request stopped this one.
    pub cancelled: bool,
}

pub struct SearchRequest {
    pub query: String,
    pub line: u64,
    pub col: u64,
    pub forward: bool,
    /// Also accept a match starting exactly at the position (forward searches).
    pub inclusive: bool,
    pub match_case: bool,
    pub regex: bool,
}

/// Why a search ended without a result: a newer search or a cancel request.
enum Stop {
    Cancelled,
}

enum Matcher {
    /// Case-sensitive plain text in a UTF-8 file: a plain byte search.
    Literal(Vec<u8>),
    /// Anything else in a UTF-8 file, searched on the raw bytes.
    Bytes(regex::bytes::Regex),
    /// Other encodings: the chunk is decoded first.
    Text(regex::Regex),
}

#[cfg(windows)]
fn read_at(file: &File, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
    use std::os::windows::fs::FileExt;
    let mut filled = 0;
    while filled < buf.len() {
        match file.seek_read(&mut buf[filled..], offset + filled as u64)? {
            0 => break,
            n => filled += n,
        }
    }
    Ok(filled)
}

#[cfg(unix)]
fn read_at(file: &File, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
    use std::os::unix::fs::FileExt;
    let mut filled = 0;
    while filled < buf.len() {
        match file.read_at(&mut buf[filled..], offset + filled as u64)? {
            0 => break,
            n => filled += n,
        }
    }
    Ok(filled)
}

/// Calls `f` with the end (exclusive) of every line break in `buf`, which starts at file offset `base`.
fn for_each_line_end(breaks: Breaks, buf: &[u8], base: u64, mut f: impl FnMut(usize)) {
    match breaks {
        Breaks::Byte => memchr::memchr_iter(b'\n', buf).for_each(|p| f(p + 1)),
        Breaks::Utf16Le => {
            for p in memchr::memchr_iter(b'\n', buf) {
                if (base + p as u64) & 1 == 0 && buf.get(p + 1) == Some(&0) {
                    f(p + 2);
                }
            }
        }
        Breaks::Utf16Be => {
            for p in memchr::memchr_iter(b'\n', buf) {
                if (base + p as u64) & 1 == 1 && p > 0 && buf[p - 1] == 0 {
                    f(p + 1);
                }
            }
        }
    }
}

/// Number of characters in (possibly invalid) UTF-8.
fn count_chars(bytes: &[u8]) -> u64 {
    String::from_utf8_lossy(bytes).chars().count() as u64
}

fn regex_error(e: regex::Error) -> String {
    let text = e.to_string();
    let message = text.lines().rev().find_map(|l| l.strip_prefix("error: ")).unwrap_or(&text);
    format!("Invalid regular expression: {}", message.trim())
}

impl LargeFile {
    /// Bytes of the file on disk.
    fn read_file(&self, start: u64, end: u64) -> Vec<u8> {
        let mut buf = vec![0u8; end.saturating_sub(start) as usize];
        let n = read_at(&self.file, &mut buf, start).unwrap_or(0);
        buf.truncate(n);
        buf
    }

    /// Bytes of the document: the file, or the piece table over it once edited.
    fn read_range(&self, start: u64, end: u64) -> Vec<u8> {
        match &*self.edits.read().unwrap() {
            Some(e) => e.table.read(start, end, |at, buf| read_at(&self.file, buf, at).unwrap_or(0)),
            None => self.read_file(start, end),
        }
    }

    /// File size cut down to whole code units.
    fn size(&self) -> u64 {
        let size = self.size.load(Ordering::Acquire);
        size - size % self.unit
    }

    /// Size of the document.
    fn doc_size(&self) -> u64 {
        match &*self.edits.read().unwrap() {
            Some(e) => e.table.len(),
            None => self.size(),
        }
    }

    fn line_count(&self) -> u64 {
        match &*self.edits.read().unwrap() {
            Some(e) => e.table.lines(),
            None => self.index.read().unwrap().len() as u64,
        }
    }

    fn is_dirty(&self) -> bool {
        self.edits.read().unwrap().as_ref().is_some_and(|e| e.table.is_modified())
    }

    /// Byte range of line `i` of the document, including its line break; None past the end. Unedited
    /// and still indexing, the last line found so far has no known end: None, or with `partial` the
    /// end of the file.
    fn line_bounds(&self, i: u64, partial: bool) -> Option<(u64, u64)> {
        if let Some(e) = &*self.edits.read().unwrap() {
            let index = self.index.read().unwrap();
            let start = e.table.line_start(&index, i)?;
            let end = e.table.line_start(&index, i + 1).unwrap_or(e.table.len());
            return Some((start.max(self.bom_len), end));
        }
        let index = self.index.read().unwrap();
        let start = (*index.get(i as usize)?).max(self.bom_len);
        let end = match index.get(i as usize + 1) {
            Some(&next) => next,
            None if partial || self.done.load(Ordering::Acquire) => self.size(),
            None => return None,
        };
        Some((start, end))
    }

    /// The line containing a document offset (the index must have reached it).
    fn line_at(&self, offset: u64) -> u64 {
        if let Some(e) = &*self.edits.read().unwrap() {
            return e.table.line_of(&self.index.read().unwrap(), offset);
        }
        let index = self.index.read().unwrap();
        index.partition_point(|&o| o <= offset).saturating_sub(1) as u64
    }

    fn trim_break(&self, bytes: &mut Vec<u8>) {
        let is_break = |b: u8| b == b'\n' || b == b'\r';
        loop {
            let n = bytes.len();
            let trailing = match self.breaks {
                Breaks::Byte => n >= 1 && is_break(bytes[n - 1]),
                Breaks::Utf16Le => n >= 2 && bytes[n - 1] == 0 && is_break(bytes[n - 2]),
                Breaks::Utf16Be => n >= 2 && bytes[n - 2] == 0 && is_break(bytes[n - 1]),
            };
            if !trailing {
                break;
            }
            bytes.truncate(n - self.unit as usize);
        }
    }

    fn read_line(&self, start: u64, end: u64) -> (Vec<u8>, bool) {
        let truncated = end - start > MAX_LINE_BYTES;
        let mut bytes = self.read_range(start, if truncated { start + MAX_LINE_BYTES } else { end });
        if !truncated {
            self.trim_break(&mut bytes);
        }
        // A UTF-16 unit that is only half written yet.
        bytes.truncate(bytes.len() - bytes.len() % self.unit as usize);
        (bytes, truncated)
    }

    fn decode(&self, bytes: &[u8]) -> String {
        self.encoding.decode_without_bom_handling(bytes).0.into_owned()
    }

    /// Number of bytes the text takes in the file's encoding.
    fn encoded_len(&self, text: &str) -> u64 {
        if self.encoding == UTF_8 {
            text.len() as u64
        } else if self.unit == 2 {
            text.encode_utf16().count() as u64 * 2
        } else {
            self.encoding.encode(text).0.len() as u64
        }
    }

    /// How many bytes of `bytes` (a line from its start) make up the first `col` UTF-16 code units
    /// of its decoded text; all of them if the text is shorter. Exact for valid text; inside
    /// invalid sequences (shown as U+FFFD) the position may move to the end of the sequence.
    fn units_to_bytes(&self, bytes: &[u8], col: u64) -> usize {
        if col == 0 {
            return 0;
        }
        if self.encoding == UTF_8 {
            let (mut units, mut at) = (0u64, 0usize);
            for chunk in bytes.utf8_chunks() {
                for c in chunk.valid().chars() {
                    if units >= col {
                        return at;
                    }
                    units += c.len_utf16() as u64;
                    at += c.len_utf8();
                }
                // One U+FFFD per invalid sequence, as the decoder shows it.
                if !chunk.invalid().is_empty() {
                    if units >= col {
                        return at;
                    }
                    units += 1;
                    at += chunk.invalid().len();
                }
            }
            return at;
        }
        if self.encoding.is_single_byte() {
            return (col as usize).min(bytes.len());
        }
        // UTF-16 and the multi-byte code pages: feed the decoder byte by byte and count what it emits.
        let mut decoder = self.encoding.new_decoder_without_bom_handling();
        let mut out = String::with_capacity(32);
        let mut units = 0u64;
        for i in 0..bytes.len() {
            if units >= col {
                return i;
            }
            out.clear();
            let _ = decoder.decode_to_string(&bytes[i..i + 1], &mut out, false);
            units += out.encode_utf16().count() as u64;
        }
        bytes.len()
    }

    /// Document offset of a position. The column is clamped to the end of the line's text (before
    /// its line break); lines of any length work, only the bytes up to the column are read.
    fn offset_of(&self, pos: Pos) -> Result<u64, String> {
        let (start, end) = self.line_bounds(pos.line, false).ok_or_else(|| format!("Line {} does not exist.", pos.line + 1))?;
        // At most 4 bytes per UTF-16 code unit (GB18030), plus room to see the line break.
        let want = pos.col.saturating_mul(4).saturating_add(8).min(end - start);
        let mut bytes = self.read_range(start, start + want);
        if start + want == end {
            self.trim_break(&mut bytes);
        }
        bytes.truncate(bytes.len() - bytes.len() % self.unit as usize);
        Ok(start + self.units_to_bytes(&bytes, pos.col) as u64)
    }

    fn position_of(&self, offset: u64) -> Pos {
        let line = self.line_at(offset);
        let start = self.line_bounds(line, true).map_or(offset, |(s, _)| s);
        let bytes = self.read_range(start, offset.max(start));
        Pos { line, col: self.decode(&bytes).encode_utf16().count() as u64 }
    }

    /// Text to insert, in the file's encoding and line ending, and where its line breaks end.
    fn encode_insert(&self, text: &str) -> Result<(Vec<u8>, Vec<u64>), String> {
        let text = if text.contains('\r') { Cow::Owned(text.replace("\r\n", "\n").replace('\r', "\n")) } else { Cow::Borrowed(text) };
        let bytes = encode_text(&text, self.encoding, self.eol)?;
        let mut breaks = Vec::new();
        for_each_line_end(self.breaks, &bytes, 0, |end| breaks.push(end as u64));
        Ok((bytes, breaks))
    }

    // ------------------------------------------------------------------ index

    /// Scans the not yet indexed part of the file; runs until it has caught up with the size, which
    /// may grow meanwhile. Only one worker runs at a time.
    fn index_worker(&self) {
        let mut buf = vec![0u8; CHUNK];
        let mut batch: Vec<u64> = Vec::with_capacity(1 << 16);
        loop {
            let size = self.size.load(Ordering::Acquire);
            let mut offset = self.indexed_to.load(Ordering::Acquire);
            let mut stalled = false;
            while offset + self.unit <= size && !self.cancelled.load(Ordering::Relaxed) {
                let want = (size - offset).min(CHUNK as u64) as usize;
                let n = read_at(&self.file, &mut buf[..want], offset).unwrap_or(0);
                let usable = n - n % self.unit as usize;
                if usable == 0 {
                    stalled = true;
                    break;
                }
                // A break at the very end of the file starts an empty last line (filled when it grows).
                for_each_line_end(self.breaks, &buf[..usable], offset, |end| batch.push(offset + end as u64));
                self.index.write().unwrap().append(&mut batch);
                offset += usable as u64;
                self.indexed_to.store(offset, Ordering::Release);
            }
            // Decide under the lock, so a file that grows right now is not missed.
            let mut running = self.worker.lock().unwrap();
            if stalled || self.cancelled.load(Ordering::Relaxed) || offset + self.unit > self.size.load(Ordering::Acquire) {
                *running = false;
                self.done.store(true, Ordering::Release);
                return;
            }
        }
    }

    #[cfg(test)]
    fn wait_for_index(&self) {
        while !self.done.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn fingerprint_now(&self, size: u64) -> Fingerprint {
        let tail_at = size.saturating_sub(FINGERPRINT);
        Fingerprint { head: self.read_file(0, size.min(FINGERPRINT)), tail_at, tail: self.read_file(tail_at, size) }
    }

    /// Checks whether the file grew (the index is extended), shrank or was rewritten. With unsaved
    /// edits the document stays as it is: growth is not followed, the caller warns instead.
    fn refresh(self: &Arc<Self>) -> Result<LargeRefresh, String> {
        let meta = self.file.metadata().map_err(|e| e.to_string())?;
        let new_size = meta.len();
        let mtime = mtime_ms(&meta);
        let old_size = self.size.load(Ordering::Acquire);
        let unchanged_content = {
            let fp = self.fingerprint.lock().unwrap();
            self.read_file(0, fp.head.len() as u64) == fp.head
                && self.read_file(fp.tail_at, fp.tail_at + fp.tail.len() as u64) == fp.tail
        };
        let changed = new_size < old_size || !unchanged_content;
        {
            let mut edits = self.edits.write().unwrap();
            if edits.as_ref().is_some_and(|e| e.table.is_modified()) {
                return Ok(LargeRefresh { size: new_size, mtime, changed });
            }
            // Only undo history is left; following the file wins over it.
            if changed || new_size != old_size {
                *edits = None;
            }
        }
        if changed {
            return Ok(LargeRefresh { size: new_size, mtime, changed: true });
        }
        if new_size > old_size {
            *self.fingerprint.lock().unwrap() = self.fingerprint_now(new_size);
            self.size.store(new_size, Ordering::Release);
            let mut running = self.worker.lock().unwrap();
            if !*running {
                *running = true;
                self.done.store(false, Ordering::Release);
                let me = self.clone();
                std::thread::spawn(move || me.index_worker());
            }
        }
        Ok(LargeRefresh { size: new_size, mtime, changed: false })
    }

    // ------------------------------------------------------------------ search

    fn matcher(&self, req: &SearchRequest) -> Result<Matcher, String> {
        let utf8 = self.encoding == UTF_8;
        if utf8 && !req.regex && req.match_case {
            return Ok(Matcher::Literal(req.query.as_bytes().to_vec()));
        }
        let pattern: Cow<str> = if req.regex { Cow::Borrowed(&req.query) } else { Cow::Owned(regex::escape(&req.query)) };
        // ^ and $ match at line starts and ends (also before a CR), like in CodeMirror's search panel.
        if utf8 {
            regex::bytes::RegexBuilder::new(&pattern)
                .case_insensitive(!req.match_case)
                .multi_line(true)
                .crlf(true)
                .build()
                .map(Matcher::Bytes)
        } else {
            regex::RegexBuilder::new(&pattern)
                .case_insensitive(!req.match_case)
                .multi_line(true)
                .crlf(true)
                .build()
                .map(Matcher::Text)
        }
        .map_err(regex_error)
    }

    /// First line start at or after `from` (a line break may end exactly there), looking ahead at most SNAP.
    fn next_line_start(&self, from: u64, limit: u64) -> Option<u64> {
        let base = from.saturating_sub(self.unit);
        let buf = self.read_range(base, (from + SNAP).min(limit));
        let mut found = None;
        for_each_line_end(self.breaks, &buf, base, |end| {
            let at = base + end as u64;
            if found.is_none() && at >= from {
                found = Some(at);
            }
        });
        found
    }

    /// End of the search chunk starting at `pos`, and whether it is a line start.
    fn chunk_end(&self, pos: u64, size: u64) -> (u64, bool) {
        let target = pos + CHUNK as u64;
        if target >= size {
            return (size, true);
        }
        match self.next_line_start(target, size) {
            Some(end) => (end, true),
            None => (target, false),
        }
    }

    /// Start of the search chunk ending at `end`, and whether it is a line start.
    fn chunk_start(&self, end: u64) -> (u64, bool) {
        if end - self.bom_len <= CHUNK as u64 {
            return (self.bom_len, true);
        }
        let target = end - CHUNK as u64;
        match self.next_line_start(target, end) {
            Some(start) if start < end => (start, true),
            _ => (target, false),
        }
    }

    fn check(&self, generation: u64) -> Result<(), Stop> {
        if self.search_gen.load(Ordering::Relaxed) != generation || self.cancelled.load(Ordering::Relaxed) {
            Err(Stop::Cancelled)
        } else {
            Ok(())
        }
    }

    fn wait_until(&self, generation: u64, ready: impl Fn() -> bool) -> Result<(), Stop> {
        while !ready() {
            self.check(generation)?;
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(())
    }

    /// The line containing a byte offset and its start; waits until the index has reached it.
    fn line_of(&self, generation: u64, offset: u64) -> Result<(usize, u64), Stop> {
        if let Some(e) = &*self.edits.read().unwrap() {
            let index = self.index.read().unwrap();
            let line = e.table.line_of(&index, offset);
            return Ok((line as usize, e.table.line_start(&index, line).unwrap_or(0)));
        }
        self.wait_until(generation, || {
            self.done.load(Ordering::Acquire) || self.indexed_to.load(Ordering::Acquire) > offset
        })?;
        let index = self.index.read().unwrap();
        let line = index.partition_point(|&o| o <= offset).saturating_sub(1);
        Ok((line, index[line]))
    }

    /// Line and column (in characters) of the position after `prefix`, the UTF-8 text from the
    /// chunk start at file offset `start` to the match.
    fn locate(&self, generation: u64, start: u64, prefix: &[u8]) -> Result<(u64, u64), Stop> {
        let (line, line_start) = self.line_of(generation, start)?;
        let breaks = memchr::memchr_iter(b'\n', prefix).count() as u64;
        let tail_from = memchr::memrchr(b'\n', prefix).map_or(0, |p| p + 1);
        let tail = &prefix[tail_from..];
        // Columns far beyond the shortened display of a line are approximate.
        let chars = if tail.len() as u64 > MAX_LINE_BYTES {
            count_chars(&tail[..MAX_LINE_BYTES as usize]) + (tail.len() as u64 - MAX_LINE_BYTES)
        } else {
            count_chars(tail)
        };
        let base = if tail_from == 0 && line_start.max(self.bom_len) < start {
            let end = start.min(line_start.max(self.bom_len) + MAX_LINE_BYTES);
            self.decode(&self.read_range(line_start.max(self.bom_len), end)).chars().count() as u64
        } else {
            0
        };
        let col = if tail_from == 0 { base + chars } else { chars };
        Ok((line as u64 + breaks, col))
    }

    fn hit(&self, generation: u64, start: u64, utf8: &[u8], from: usize, to: usize) -> Result<Match, Stop> {
        let (line, col) = self.locate(generation, start, &utf8[..from])?;
        // Matches that run over a line break are highlighted on their first line only.
        let matched = &utf8[from..to];
        let matched = &matched[..matched.iter().position(|&b| b == b'\n' || b == b'\r').unwrap_or(matched.len())];
        Ok(Match { line, col, len: count_chars(matched) })
    }

    /// Searches one chunk (starting at file offset `start`). `anchor` is a byte offset in the chunk:
    /// forward matches start at or after it, backward matches end at or before it.
    fn scan(
        &self,
        generation: u64,
        matcher: &Matcher,
        start: u64,
        buf: &[u8],
        anchor: Option<usize>,
        forward: bool,
    ) -> Result<Option<Match>, Stop> {
        let found = match matcher {
            Matcher::Literal(needle) => {
                if forward {
                    let from = anchor.unwrap_or(0).min(buf.len());
                    memchr::memmem::find(&buf[from..], needle).map(|p| (from + p, from + p + needle.len()))
                } else {
                    let limit = anchor.unwrap_or(buf.len()).min(buf.len());
                    memchr::memmem::rfind(&buf[..limit], needle).map(|p| (p, p + needle.len()))
                }
            }
            Matcher::Bytes(re) => {
                if forward {
                    re.find_at(buf, anchor.unwrap_or(0).min(buf.len())).map(|m| (m.start(), m.end()))
                } else {
                    let limit = anchor.unwrap_or(buf.len());
                    re.find_iter(buf).take_while(|m| m.end() <= limit).last().map(|m| (m.start(), m.end()))
                }
            }
            Matcher::Text(re) => {
                let text = self.decode(buf);
                let anchor = anchor.map(|a| self.decode(&buf[..a.min(buf.len())]).len());
                let found = if forward {
                    re.find_at(&text, anchor.unwrap_or(0)).map(|m| (m.start(), m.end()))
                } else {
                    let limit = anchor.unwrap_or(text.len());
                    re.find_iter(&text).take_while(|m| m.end() <= limit).last().map(|m| (m.start(), m.end()))
                };
                // Positions in the decoded text, so the hit is computed from that.
                return found.map(|(from, to)| self.hit(generation, start, text.as_bytes(), from, to)).transpose();
            }
        };
        found.map(|(from, to)| self.hit(generation, start, buf, from, to)).transpose()
    }

    /// Where to start: the start of the line (a chunk always starts at a line start), the position
    /// in it, and the end of that line.
    fn anchor(&self, generation: u64, req: &SearchRequest) -> Result<(u64, u64, u64), Stop> {
        let size = self.doc_size();
        if req.line >= self.line_count() {
            // Past the end, e.g. a backward search starting at the end of the file: needs all lines.
            self.wait_until(generation, || self.done.load(Ordering::Acquire))?;
        }
        let Some((start, end)) = self.line_bounds(req.line, true) else {
            return Ok((size, size, size));
        };
        let target = req.col + (req.forward && !req.inclusive) as u64;
        let text = self.decode(&self.read_line(start, end).0);
        let from = if target <= text.chars().count() as u64 {
            let prefix: String = text.chars().take(target as usize).collect();
            start + self.encoded_len(&prefix)
        } else {
            // Stepping over the end of the line.
            end
        };
        Ok((start, from.min(size), end))
    }

    pub fn search(&self, req: &SearchRequest) -> Result<SearchResult, String> {
        let generation = self.search_gen.fetch_add(1, Ordering::Relaxed) + 1;
        let done = |found| Ok(SearchResult { found, cancelled: false });
        if req.query.is_empty() {
            return done(None);
        }
        let matcher = self.matcher(req)?;
        let outcome = if req.forward { self.search_forward(generation, &matcher, req) } else { self.search_backward(generation, &matcher, req) };
        match outcome {
            // An edit meanwhile makes the position meaningless.
            Ok(Some(_)) if self.check(generation).is_err() => Ok(SearchResult { found: None, cancelled: true }),
            Ok(found) => done(found),
            Err(Stop::Cancelled) => Ok(SearchResult { found: None, cancelled: true }),
        }
    }

    fn search_forward(&self, generation: u64, matcher: &Matcher, req: &SearchRequest) -> Result<Option<Match>, Stop> {
        let (mut pos, from, _) = self.anchor(generation, req)?;
        let size = self.doc_size();
        let mut anchor = Some(from);
        while pos < size {
            self.check(generation)?;
            let (end, snapped) = self.chunk_end(pos, size);
            let buf = self.read_range(pos, end);
            let rel = anchor.take().map(|f| f.saturating_sub(pos) as usize);
            if let Some(found) = self.scan(generation, matcher, pos, &buf, rel, true)? {
                return Ok(Some(found));
            }
            if end >= size {
                break;
            }
            pos = if snapped { end } else { end - OVERLAP };
        }
        Ok(None)
    }

    fn search_backward(&self, generation: u64, matcher: &Matcher, req: &SearchRequest) -> Result<Option<Match>, Stop> {
        let (_, from, mut end) = self.anchor(generation, req)?;
        let mut anchor = Some(from);
        while end > self.bom_len {
            self.check(generation)?;
            let (pos, snapped) = self.chunk_start(end);
            let buf = self.read_range(pos, end);
            let rel = anchor.take().map(|f| f.saturating_sub(pos) as usize);
            if let Some(found) = self.scan(generation, matcher, pos, &buf, rel, false)? {
                return Ok(Some(found));
            }
            if pos <= self.bom_len {
                break;
            }
            end = if snapped { pos } else { pos + OVERLAP };
        }
        Ok(None)
    }
}

impl LargeFile {
    // ------------------------------------------------------------------ editing

    fn check_editable(&self) -> Result<(), String> {
        self.check_not_saving()?;
        if !self.done.load(Ordering::Acquire) {
            return Err("The file is still being indexed; editing works once that is done.".into());
        }
        Ok(())
    }

    /// Checked again under the write lock on the edits: an edit that slipped past the first check
    /// while the save streamed the document would otherwise land in the table that `save` discards.
    fn check_not_saving(&self) -> Result<(), String> {
        if self.saving.load(Ordering::Acquire) {
            return Err("The file is being saved; try again when that is done.".into());
        }
        Ok(())
    }

    fn edited(&self, caret: Option<Pos>) -> Edited {
        let edits = self.edits.read().unwrap();
        let table = edits.as_ref().map(|e| &e.table);
        Edited {
            lines: table.map_or_else(|| self.index.read().unwrap().len() as u64, |t| t.lines()),
            size: table.map_or_else(|| self.size(), |t| t.len()),
            dirty: table.is_some_and(|t| t.is_modified()),
            can_undo: table.is_some_and(|t| t.can_undo()),
            can_redo: table.is_some_and(|t| t.can_redo()),
            caret,
        }
    }

    /// Takes or releases the write guard as the document becomes dirty or clean again.
    fn update_guard(&self, dirty: bool) {
        let mut guard = self.guard.lock().unwrap();
        if !dirty {
            *guard = None;
        } else if guard.is_none() {
            // Fails when another program has the file open for writing right now (e.g. a logger);
            // then changes are only noticed, not prevented.
            *guard = open_guard(&self.path).ok();
        }
    }

    /// Applies changes (positions refer to the document before them) as one undo step.
    pub fn edit(&self, changes: &[Change], kind: EditKind) -> Result<Edited, String> {
        self.check_editable()?;
        let mut list = Vec::with_capacity(changes.len());
        for change in changes {
            let (a, b) = (self.offset_of(change.from)?, self.offset_of(change.to)?);
            let (bytes, breaks) = self.encode_insert(&change.text)?;
            list.push(Replace { from: a.min(b), to: a.max(b), bytes, breaks });
        }
        {
            let mut edits = self.edits.write().unwrap();
            self.check_not_saving()?;
            let index = self.index.read().unwrap();
            let edits = edits.get_or_insert_with(|| Edits {
                table: PieceTable::new(&index, self.size()),
                mtime: self.file.metadata().map(|m| mtime_ms(&m)).unwrap_or(0),
            });
            if !edits.table.edit(&index, list, kind, Instant::now()) {
                return Err("The changes overlap.".into());
            }
        }
        // A running search would report positions in the old text.
        self.search_gen.fetch_add(1, Ordering::Relaxed);
        let result = self.edited(None);
        self.update_guard(result.dirty);
        Ok(result)
    }

    pub fn undo(&self, redo: bool) -> Result<Edited, String> {
        self.check_editable()?;
        let range = {
            let mut edits = self.edits.write().unwrap();
            self.check_not_saving()?;
            let index = self.index.read().unwrap();
            match edits.as_mut() {
                Some(e) if redo => e.table.redo(&index),
                Some(e) => e.table.undo(&index),
                None => None,
            }
        };
        self.search_gen.fetch_add(1, Ordering::Relaxed);
        let result = self.edited(range.map(|(_, end)| self.position_of(end)));
        self.update_guard(result.dirty);
        Ok(result)
    }

    /// The text between two positions, e.g. for the clipboard.
    pub fn text(&self, from: Pos, to: Pos) -> Result<String, String> {
        let (a, b) = (self.offset_of(from)?, self.offset_of(to)?);
        let (a, b) = (a.min(b), a.max(b));
        if b - a > MAX_COPY {
            return Err(format!(
                "The selection is too large to copy ({} MB, at most {} MB).",
                (b - a) >> 20,
                MAX_COPY >> 20
            ));
        }
        Ok(self.decode(&self.read_range(a, b)))
    }

    // ------------------------------------------------------------------ saving

    /// Writes the document to `tmp`: original pieces are copied from the file in chunks, inserted
    /// ones from the add buffer, then the bytes in the range `tail` of the file.
    fn stream_to(&self, table: Option<&PieceTable>, tail: (u64, u64), tmp: &Path) -> std::io::Result<()> {
        let mut out = BufWriter::with_capacity(1 << 20, File::create(tmp)?);
        let mut buf = vec![0u8; CHUNK];
        let mut copy = |out: &mut BufWriter<File>, start: u64, len: u64| -> std::io::Result<()> {
            let mut at = start;
            while at < start + len {
                let n = ((start + len - at) as usize).min(CHUNK);
                if read_at(&self.file, &mut buf[..n], at)? < n {
                    // Never write a shortened copy: the original changed underneath.
                    return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "the file became shorter while saving"));
                }
                out.write_all(&buf[..n])?;
                at += n as u64;
            }
            Ok(())
        };
        match table {
            Some(table) => {
                for p in table.pieces() {
                    match p.source {
                        Source::Original => copy(&mut out, p.start, p.len)?,
                        Source::Added => out.write_all(&table.added()[p.start as usize..p.end() as usize])?,
                    }
                }
            }
            None => copy(&mut out, 0, self.size())?,
        }
        // What other programs appended to the original meanwhile goes after the document.
        copy(&mut out, tail.0, tail.1 - tail.0)?;
        out.into_inner().map_err(|e| e.into_error())?.sync_all()
    }

    /// The part of the file on disk that was appended to the original the edits refer to (e.g. by a
    /// logger that had the file open before the edits began): saved after the document, so it is not
    /// lost. Fails if the original itself changed or became shorter, because the edits would then
    /// describe bytes that are not there any more; the journal keeps them safe meanwhile.
    fn appended_since(&self, original_len: u64) -> Result<(u64, u64), String> {
        let size = self.file.metadata().map_err(|e| e.to_string())?.len();
        let size = size - size % self.unit;
        let unchanged = size >= original_len && {
            let fp = self.fingerprint.lock().unwrap();
            self.read_file(0, fp.head.len() as u64) == fp.head
                && self.read_file(fp.tail_at, fp.tail_at + fp.tail.len() as u64) == fp.tail
        };
        if unchanged {
            Ok((original_len, size))
        } else {
            Err("The file was changed by another program since you started editing it, so the edits no longer fit.                  Your changes are kept; reload the file to discard them."
                .into())
        }
    }

    /// Saves the document to `target` like `write_safely`: a temporary file next to it, flushed to
    /// disk, then swapped in with ReplaceFileW (keeping attributes and permissions). Unlike
    /// `write_safely` there is no fallback to writing in place, because the document is partly read
    /// from the very file that would be overwritten. Returns the line index of the written file.
    fn write_to(&self, target: &Path) -> Result<Vec<u64>, String> {
        let (Some(dir), Some(name)) = (target.parent(), target.file_name()) else {
            return Err("Invalid file name.".into());
        };
        let name = name.to_string_lossy();
        let tmp = dir.join(format!(".{name}.kladde-save"));
        let edits = self.edits.read().unwrap();
        let tail = match edits.as_ref().filter(|e| e.table.is_modified()) {
            Some(e) => self.appended_since(e.table.original_len())?,
            None => (self.size(), self.size()),
        };
        let index = match &*edits {
            Some(e) => e.table.line_starts(&self.index.read().unwrap()),
            None => self.index.read().unwrap().clone(),
        };
        if let Err(e) = self.stream_to(edits.as_ref().map(|e| &e.table), tail, &tmp) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("Could not write a temporary file next to {name}: {e}"));
        }
        let dirty = edits.as_ref().is_some_and(|e| e.table.is_modified());
        drop(edits);
        // The guard denies writing, which the replacement needs.
        *self.guard.lock().unwrap() = None;
        let swapped = if target.exists() {
            replace_file(target, &tmp).or_else(|_| fs::rename(&tmp, target))
        } else {
            fs::rename(&tmp, target)
        };
        if let Err(e) = swapped {
            let _ = fs::remove_file(&tmp);
            self.update_guard(dirty);
            return Err(format!("Could not replace {name}: {e}"));
        }
        Ok(index)
    }

    // ------------------------------------------------------------------ hot exit

    /// Writes the journal of the edits into the backup folder: the add buffer is appended to its
    /// own file (it only ever grows), then the piece list is written atomically. A crash in between
    /// leaves the previous journal, which only refers to bytes that are already on disk.
    pub fn backup(&self, dir: &Path, tab: &str) -> Result<(), String> {
        // Held for the whole backup, so two of them never write the same files; the disk I/O below
        // happens without the lock on the document, so typing does not wait for a flush.
        let mut state = self.journal.lock().unwrap();
        let path = added_path(dir, tab, &state.generation);
        let appendable = fs::metadata(&path).map(|m| m.len()).ok() == Some(state.written);
        let (chunk, appended, added_len, pieces, size, mtime) = {
            let edits = self.edits.read().unwrap();
            let Some(e) = edits.as_ref() else { return Ok(()) };
            let added = e.table.added();
            let appended = appendable && state.written <= added.len() as u64;
            let from = if appended { state.written as usize } else { 0 };
            let pieces: Vec<(u8, u64, u64)> =
                e.table.pieces().iter().map(|p| ((p.source == Source::Added) as u8, p.start, p.len)).collect();
            (added[from..].to_vec(), appended, added.len() as u64, pieces, e.table.original_len(), e.mtime)
        };
        let written = (|| -> std::io::Result<()> {
            if appended {
                if !chunk.is_empty() {
                    let mut file = fs::OpenOptions::new().append(true).open(&path)?;
                    file.write_all(&chunk)?;
                    file.sync_data()?;
                }
            } else {
                // The first backup, or the file was removed meanwhile (the tab was clean for a moment).
                let mut file = File::create(&path)?;
                file.write_all(&chunk)?;
                file.sync_data()?;
            }
            Ok(())
        })();
        written.map_err(|e| e.to_string())?;
        state.written = added_len;
        let journal = {
            let fp = self.fingerprint.lock().unwrap();
            Journal {
                version: 1,
                size,
                mtime,
                head: base64(&fp.head),
                tail_at: fp.tail_at,
                tail: base64(&fp.tail),
                added: state.generation.clone(),
                added_len,
                pieces,
            }
        };
        let json = serde_json::to_vec(&journal).map_err(|e| e.to_string())?;
        write_safely(&journal_path(dir, tab), &json).map_err(|e| e.to_string())?;
        // Buffers of earlier documents of this tab (before a save or a reload).
        remove_added(dir, tab, path.file_name().and_then(|n| n.to_str()));
        Ok(())
    }

    /// Applies the journal of a tab to this (freshly opened) file. Without `force`, only if the
    /// file is still exactly the one the edits were made to; otherwise nothing changes and the
    /// journal stays, so the user can decide.
    pub fn restore(&self, dir: &Path, tab: &str, force: bool) -> Result<Restored, String> {
        let json = match fs::read(journal_path(dir, tab)) {
            Ok(json) => json,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let state = self.edited(None);
                return Ok(Restored { status: "missing", lines: state.lines, size: state.size, dirty: state.dirty });
            }
            Err(e) => return Err(e.to_string()),
        };
        let journal: Journal = serde_json::from_slice(&json).map_err(|e| format!("Unreadable backup: {e}"))?;
        if journal.version != 1 || !journal.added.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err("Unknown backup format.".into());
        }
        while !self.done.load(Ordering::Acquire) {
            if self.cancelled.load(Ordering::Relaxed) {
                return Err("File is no longer open".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let mtime = self.file.metadata().map(|m| mtime_ms(&m)).unwrap_or(0);
        let same = {
            let fp = self.fingerprint.lock().unwrap();
            journal.size == self.size()
                && journal.mtime == mtime
                && journal.head == base64(&fp.head)
                && journal.tail_at == fp.tail_at
                && journal.tail == base64(&fp.tail)
        };
        if !same && !force {
            return Ok(Restored { status: "conflict", lines: self.line_count(), size: self.doc_size(), dirty: false });
        }
        let mut added = if journal.added_len == 0 {
            Vec::new()
        } else {
            fs::read(added_path(dir, tab, &journal.added)).map_err(|e| format!("The backup is incomplete: {e}"))?
        };
        if (added.len() as u64) < journal.added_len {
            return Err("The backup is incomplete.".into());
        }
        added.truncate(journal.added_len as usize);
        let mut breaks = Vec::new();
        for_each_line_end(self.breaks, &added, 0, |end| breaks.push(end as u64));
        let pieces: Vec<(Source, u64, u64)> = journal
            .pieces
            .iter()
            .map(|&(source, start, len)| (if source == 1 { Source::Added } else { Source::Original }, start, len))
            .collect();
        {
            let mut edits = self.edits.write().unwrap();
            let index = self.index.read().unwrap();
            // Forced onto a file that only grew, the edits still describe the original's length; what
            // was appended after it is saved behind the document (appended_since).
            if journal.size > self.size() {
                return Err("The file is shorter than the one the edits were made to.".into());
            }
            let table = PieceTable::restore(&index, journal.size, added, breaks, &pieces)?;
            *edits = Some(Edits { table, mtime });
        }
        *self.journal.lock().unwrap() = JournalState { generation: journal.added, written: journal.added_len };
        self.search_gen.fetch_add(1, Ordering::Relaxed);
        let state = self.edited(None);
        self.update_guard(state.dirty);
        Ok(Restored { status: "applied", lines: state.lines, size: state.size, dirty: state.dirty })
    }
}

/// What `LargeFiles::register` needs to know about a file that was just opened.
struct Opening {
    path: PathBuf,
    file: File,
    size: u64,
    mtime: u64,
    encoding: &'static Encoding,
    bom_len: u64,
    eol: &'static str,
    /// A complete line index (after saving); None starts the background indexer.
    index: Option<Vec<u64>>,
}

impl LargeFiles {
    pub fn open(&self, path: &Path) -> Result<LargeOpened, String> {
        let file = File::open(path).map_err(|e| e.to_string())?;
        let meta = file.metadata().map_err(|e| e.to_string())?;
        let size = meta.len();

        let mut head = vec![0u8; (size.min(1 << 20)) as usize];
        let n = read_at(&file, &mut head, 0).map_err(|e| e.to_string())?;
        head.truncate(n);
        let (encoding, bom_len) = match sniff_bom(&head) {
            Some((enc, len)) => (enc, len as u64),
            None => (guess_encoding(&head, n as u64 == size), 0),
        };
        // Lines are split at LF only, so a classic Mac (CR) file gets LF for new lines.
        let decoded = encoding.decode_without_bom_handling(&head[bom_len as usize..]).0;
        let eol = if detect_eol(&decoded) == "CRLF" { "CRLF" } else { "LF" };
        Ok(self.register(Opening { path: path.to_path_buf(), file, size, mtime: mtime_ms(&meta), encoding, bom_len, eol, index: None }))
    }

    fn register(&self, opening: Opening) -> LargeOpened {
        let Opening { path, file, size, mtime, encoding, bom_len, eol, index } = opening;
        let breaks = if encoding == UTF_16LE {
            Breaks::Utf16Le
        } else if encoding == UTF_16BE {
            Breaks::Utf16Be
        } else {
            Breaks::Byte
        };
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let indexed = index.is_some();
        let large = Arc::new(LargeFile {
            path,
            file,
            size: AtomicU64::new(size),
            encoding,
            breaks,
            unit: if breaks == Breaks::Byte { 1 } else { 2 },
            bom_len,
            eol,
            index: RwLock::new(index.unwrap_or_else(|| vec![0])),
            indexed_to: AtomicU64::new(if indexed { size } else { 0 }),
            done: AtomicBool::new(indexed),
            cancelled: AtomicBool::new(false),
            worker: Mutex::new(!indexed),
            fingerprint: Mutex::new(Fingerprint { head: Vec::new(), tail_at: 0, tail: Vec::new() }),
            search_gen: AtomicU64::new(0),
            edits: RwLock::new(None),
            saving: AtomicBool::new(false),
            guard: Mutex::new(None),
            journal: Mutex::new(JournalState { generation: new_generation(id), written: 0 }),
        });
        *large.fingerprint.lock().unwrap() = large.fingerprint_now(size);
        self.open.lock().unwrap().insert(id, large.clone());
        if !indexed {
            std::thread::spawn(move || large.index_worker());
        }
        LargeOpened { id, size, encoding: encoding.name().to_string(), bom: bom_len > 0, eol: eol.to_string(), mtime }
    }

    pub fn get(&self, id: u32) -> Result<Arc<LargeFile>, String> {
        self.open.lock().unwrap().get(&id).cloned().ok_or_else(|| "File is no longer open".to_string())
    }

    pub fn info(&self, id: u32) -> Result<LargeInfo, String> {
        let file = self.get(id)?;
        Ok(LargeInfo {
            lines: file.line_count(),
            done: file.done.load(Ordering::Acquire),
            size: file.doc_size(),
            dirty: file.is_dirty(),
        })
    }

    pub fn lines(&self, id: u32, start: u64, count: u64) -> Result<Vec<Line>, String> {
        let file = self.get(id)?;
        Ok((start..start.saturating_add(count))
            .map_while(|i| file.line_bounds(i, false))
            .map(|(s, e)| {
                let (bytes, truncated) = file.read_line(s, e);
                Line { text: file.decode(&bytes), truncated }
            })
            .collect())
    }

    /// Picks up appended data (the index grows with it) and tells whether the file was replaced.
    pub fn refresh(&self, id: u32) -> Result<LargeRefresh, String> {
        self.get(id)?.refresh()
    }

    /// Stops a running search of the file.
    pub fn cancel_search(&self, id: u32) {
        if let Ok(file) = self.get(id) {
            file.search_gen.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Saves the document to its file, or to `target` (save as), and opens the result in place of
    /// the old one: the returned id replaces `id`, which is closed. `journal` (backup folder and tab
    /// id) is removed once the file is replaced, so a crash right after the save does not restore
    /// edits that are already in the file.
    pub fn save(&self, id: u32, target: Option<&Path>, journal: Option<(&Path, &str)>) -> Result<LargeOpened, String> {
        let file = self.get(id)?;
        if !file.done.load(Ordering::Acquire) {
            return Err("The file is still being indexed; save once that is done.".into());
        }
        if file.saving.swap(true, Ordering::AcqRel) {
            return Err("The file is already being saved.".into());
        }
        let path = target.map_or_else(|| file.path.clone(), Path::to_path_buf);
        // Follow symlinks like write_safely: the link stays, its target gets the content.
        let real = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        let expected = file.doc_size();
        // `saving` stays set from here on when the save succeeds: the document is replaced by the
        // written file below, so an edit to it now would be lost together with the journal.
        let index = file.write_to(&real).inspect_err(|_| file.saving.store(false, Ordering::Release))?;
        if let Some((dir, tab)) = journal {
            remove_journal(dir, tab);
        }
        let reopened = File::open(&path).and_then(|f| Ok((f.metadata()?, f))).map_err(|e| e.to_string());
        self.close(id);
        let (meta, handle) = reopened?;
        // The index of the document is the index of the saved file, unless the file is not what was
        // written (another program got in between): then it is indexed again.
        let size = meta.len();
        let index = (size == expected).then_some(index);
        Ok(self.register(Opening {
            path,
            file: handle,
            size,
            mtime: mtime_ms(&meta),
            encoding: file.encoding,
            bom_len: file.bom_len,
            eol: file.eol,
            index,
        }))
    }

    pub fn close(&self, id: u32) {
        if let Some(file) = self.open.lock().unwrap().remove(&id) {
            file.cancelled.store(true, Ordering::Relaxed);
            *file.guard.lock().unwrap() = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("kladde-tests");
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    fn utf16(text: &str, little_endian: bool, bom: bool) -> Vec<u8> {
        let mut bytes = Vec::new();
        if bom {
            bytes.extend(if little_endian { [0xFF, 0xFE] } else { [0xFE, 0xFF] });
        }
        for unit in text.encode_utf16() {
            bytes.extend(if little_endian { unit.to_le_bytes() } else { unit.to_be_bytes() });
        }
        bytes
    }

    fn open(files: &LargeFiles, path: &Path) -> (u32, Arc<LargeFile>) {
        let opened = files.open(path).unwrap();
        let file = files.get(opened.id).unwrap();
        file.wait_for_index();
        (opened.id, file)
    }

    fn query(text: &str, line: u64, col: u64, forward: bool, inclusive: bool, match_case: bool, regex: bool) -> SearchRequest {
        SearchRequest { query: text.into(), line, col, forward, inclusive, match_case, regex }
    }

    fn find(file: &LargeFile, req: SearchRequest) -> Option<(u64, u64, u64)> {
        let result = file.search(&req).unwrap();
        assert!(!result.cancelled);
        result.found.map(|m| (m.line, m.col, m.len))
    }

    #[test]
    fn index_lines_and_search() {
        let path = temp("large.log");
        let mut text = String::new();
        for i in 0..50_000 {
            text.push_str(&format!("line {i} INFO something\r\n"));
        }
        text.push_str("last line without newline ERROR");
        std::fs::write(&path, &text).unwrap();

        let files = LargeFiles::default();
        let (id, file) = open(&files, &path);
        assert_eq!(files.info(id).unwrap().lines, 50_001);

        let lines = files.lines(id, 49_999, 5).unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].text, "line 49999 INFO something");
        assert_eq!(lines[1].text, "last line without newline ERROR");

        assert_eq!(find(&file, query("error", 0, 0, true, false, false, false)), Some((50_000, 26, 5)));
        assert_eq!(find(&file, query("error", 0, 0, true, false, true, false)), None);
        assert_eq!(find(&file, query("line 0 ", 0, 0, true, true, true, false)), Some((0, 0, 7)));
        assert_eq!(find(&file, query("line 7 ", 50_000, 0, false, false, true, false)), Some((7, 0, 7)));
        // Exclusive forward search skips a match at the position itself.
        assert_eq!(find(&file, query("line 0 ", 0, 0, true, false, true, false)), None);
        // Backward from the end of the file (a line past the last one).
        assert_eq!(find(&file, query("INFO", u64::MAX, 0, false, false, true, false)), Some((49_999, 11, 4)));
        files.close(id);
    }

    #[test]
    fn regex_search() {
        let path = temp("regex.log");
        std::fs::write(&path, "alpha 12\r\nbeta 345 gamma\r\nline three\r\nend 6\r\n").unwrap();
        let files = LargeFiles::default();
        let (id, file) = open(&files, &path);

        assert_eq!(find(&file, query(r"\d{3}", 0, 0, true, true, true, true)), Some((1, 5, 3)));
        // ^ and $ work per line, also with CRLF.
        assert_eq!(find(&file, query(r"^beta", 0, 0, true, true, true, true)), Some((1, 0, 4)));
        assert_eq!(find(&file, query(r"gamma$", 0, 0, true, true, true, true)), Some((1, 9, 5)));
        assert_eq!(find(&file, query(r"^line$", 0, 0, true, true, true, true)), None);
        // Case-insensitive regex, and the toggle off for plain text matching the regex syntax.
        assert_eq!(find(&file, query(r"BETA \d+", 0, 0, true, true, false, true)), Some((1, 0, 8)));
        assert_eq!(find(&file, query(r"a.b", 0, 0, true, true, true, false)), None);
        assert_eq!(find(&file, query(r"\d+", 3, 4, false, false, true, true)), Some((1, 5, 3)));
        // Last match before the position, from the end.
        assert_eq!(find(&file, query(r"\d+", u64::MAX, 0, false, false, true, true)), Some((3, 4, 1)));
        // A match over a line break is reported on its first line.
        assert_eq!(find(&file, query(r"gamma\s+line", 0, 0, true, true, true, true)), Some((1, 9, 5)));
        // An invalid pattern is an error message, not a panic.
        let err = file.search(&query("(", 0, 0, true, true, true, true)).err().unwrap();
        assert!(err.starts_with("Invalid regular expression"), "{err}");
        files.close(id);
    }

    #[test]
    fn unicode_case_insensitive() {
        let path = temp("unicode.txt");
        std::fs::write(&path, "Grüße aus München\nÄRGER mit Ärger\nΣίσυφος\n").unwrap();
        let files = LargeFiles::default();
        let (id, file) = open(&files, &path);

        assert_eq!(find(&file, query("münchen", 0, 0, true, true, false, false)), Some((0, 10, 7)));
        assert_eq!(find(&file, query("münchen", 0, 0, true, true, true, false)), None);
        assert_eq!(find(&file, query("ärger", 1, 1, true, false, false, false)), Some((1, 10, 5)));
        assert_eq!(find(&file, query("σίσυφος", 0, 0, true, true, false, false)), Some((2, 0, 7)));
        // Columns count characters, not bytes.
        assert_eq!(find(&file, query("aus", 0, 0, true, true, true, false)), Some((0, 6, 3)));
        files.close(id);
    }

    #[test]
    fn utf16_both_byte_orders() {
        for little_endian in [true, false] {
            let path = temp(if little_endian { "utf16le.txt" } else { "utf16be.txt" });
            let mut text = String::new();
            for i in 0..2000 {
                text.push_str(&format!("zeile {i} Grüße 😀 ok\r\n"));
            }
            text.push_str("ende ohne Umbruch");
            std::fs::write(&path, utf16(&text, little_endian, true)).unwrap();

            let files = LargeFiles::default();
            let opened = files.open(&path).unwrap();
            assert_eq!(opened.encoding, if little_endian { "UTF-16LE" } else { "UTF-16BE" });
            let file = files.get(opened.id).unwrap();
            file.wait_for_index();
            assert_eq!(files.info(opened.id).unwrap().lines, 2001);

            let lines = files.lines(opened.id, 0, 2).unwrap();
            assert_eq!(lines[0].text, "zeile 0 Grüße 😀 ok");
            assert_eq!(lines[1].text, "zeile 1 Grüße 😀 ok");
            let lines = files.lines(opened.id, 1999, 5).unwrap();
            assert_eq!(lines.len(), 2);
            assert_eq!(lines[1].text, "ende ohne Umbruch");

            // Plain, case-insensitive (Unicode) and regex search; columns count characters (the
            // emoji is one character, two code units).
            assert_eq!(find(&file, query("zeile 1500 ", 0, 0, true, true, true, false)), Some((1500, 0, 11)));
            assert_eq!(find(&file, query("GRÜSSE", 5, 0, true, true, false, false)), None);
            assert_eq!(find(&file, query("GRÜẞE", 5, 0, true, true, false, false)), Some((5, 8, 5)));
            assert_eq!(find(&file, query("ok", 5, 0, true, false, true, false)), Some((5, 16, 2)));
            assert_eq!(find(&file, query(r"ohne \w+", 0, 0, true, true, true, true)), Some((2000, 5, 12)));
            assert_eq!(find(&file, query("zeile 3 ", 1000, 0, false, false, true, false)), Some((3, 0, 8)));
            // Following matches go on from the column.
            assert_eq!(find(&file, query("ok", 5, 16, true, false, true, false)), Some((6, 16, 2)));
            files.close(opened.id);
        }
    }

    #[test]
    fn utf16_without_trailing_newline_and_odd_tail() {
        let path = temp("utf16tail.txt");
        let mut bytes = utf16("a\r\nb\r\n", true, true);
        std::fs::write(&path, &bytes).unwrap();
        let files = LargeFiles::default();
        let (id, _) = open(&files, &path);
        // A final break is followed by an empty line, like in the editor.
        assert_eq!(files.info(id).unwrap().lines, 3);
        assert_eq!(files.lines(id, 2, 1).unwrap()[0].text, "");
        files.close(id);

        // A half written code unit at the end is ignored.
        bytes.push(b'c');
        std::fs::write(&path, &bytes).unwrap();
        let (id, _) = open(&files, &path);
        let lines = files.lines(id, 0, 5).unwrap();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[1].text, "b");
        assert_eq!(lines[2].text, "");
        files.close(id);
    }

    #[test]
    fn index_grows_with_the_file() {
        let path = temp("growing.log");
        std::fs::write(&path, "one\ntwo\n").unwrap();
        let files = LargeFiles::default();
        let (id, file) = open(&files, &path);
        assert_eq!(files.info(id).unwrap().lines, 3);

        // Append a partial line, then complete it: the empty last line grows in place.
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b"thr").unwrap();
        let r = files.refresh(id).unwrap();
        assert!(!r.changed);
        assert_eq!(r.size, 11);
        file.wait_for_index();
        assert_eq!(files.info(id).unwrap().lines, 3);
        assert_eq!(files.lines(id, 2, 1).unwrap()[0].text, "thr");

        f.write_all(b"ee\nfour\n").unwrap();
        assert!(!files.refresh(id).unwrap().changed);
        file.wait_for_index();
        assert_eq!(files.info(id).unwrap().lines, 5);
        assert_eq!(files.lines(id, 2, 2).unwrap().iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), ["three", "four"]);
        assert_eq!(find(&file, query("four", 0, 0, true, true, true, false)), Some((3, 0, 4)));

        // Nothing new: still unchanged.
        assert!(!files.refresh(id).unwrap().changed);
        // Shorter: reopen. Rewritten with the same start: also reopen.
        std::fs::write(&path, "one\n").unwrap();
        assert!(files.refresh(id).unwrap().changed);
        files.close(id);

        std::fs::write(&path, "one\ntwo\n").unwrap();
        let (id, _) = open(&files, &path);
        std::fs::write(&path, "uno\ntwo\nthree\n").unwrap();
        assert!(files.refresh(id).unwrap().changed);
        files.close(id);
    }

    #[test]
    fn utf16_index_grows() {
        let path = temp("growing16.log");
        std::fs::write(&path, utf16("eins\r\n", false, true)).unwrap();
        let files = LargeFiles::default();
        let (id, file) = open(&files, &path);
        assert_eq!(files.info(id).unwrap().lines, 2);
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(&utf16("zwei\r\ndrei", false, false)).unwrap();
        assert!(!files.refresh(id).unwrap().changed);
        file.wait_for_index();
        assert_eq!(files.info(id).unwrap().lines, 3);
        assert_eq!(files.lines(id, 1, 5).unwrap().iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), ["zwei", "drei"]);
        files.close(id);
    }

    #[test]
    fn search_spans_chunks_and_can_be_cancelled() {
        // Bigger than one search chunk, so matches in later chunks need correct line numbers.
        let path = temp("chunks.log");
        let mut f = std::io::BufWriter::new(std::fs::File::create(&path).unwrap());
        let line = "0123456789 abcdefghij klmnopqrst uvwxyz\n";
        let lines = (CHUNK * 2 + 123_456) / line.len();
        for i in 0..lines {
            if i == lines - 3 {
                f.write_all(b"needle at the end\n").unwrap();
            } else {
                f.write_all(line.as_bytes()).unwrap();
            }
        }
        drop(f);
        let files = LargeFiles::default();
        let (id, file) = open(&files, &path);
        assert_eq!(find(&file, query("needle", 0, 0, true, true, true, false)), Some((lines as u64 - 3, 0, 6)));
        assert_eq!(find(&file, query("NEEDLE", 0, 0, true, true, false, true)), Some((lines as u64 - 3, 0, 6)));
        assert_eq!(find(&file, query("^0123", u64::MAX, 0, false, false, true, true)), Some((lines as u64 - 1, 0, 4)));
        assert_eq!(find(&file, query("needle", u64::MAX, 0, false, false, true, false)), Some((lines as u64 - 3, 0, 6)));
        assert_eq!(find(&file, query("nowhere", 0, 0, true, true, true, false)), None);

        // A search that was superseded reports cancelled.
        let generation = file.search_gen.fetch_add(1, Ordering::Relaxed) + 1;
        assert!(matches!(file.check(generation - 1), Err(Stop::Cancelled)));
        files.cancel_search(id);
        assert!(matches!(file.check(generation), Err(Stop::Cancelled)));
        files.close(id);
    }

    fn pos(line: u64, col: u64) -> Pos {
        Pos { line, col }
    }

    fn insert(file: &LargeFile, line: u64, col: u64, text: &str) -> Edited {
        file.edit(&[Change { from: pos(line, col), to: pos(line, col), text: text.into() }], EditKind::Other).unwrap()
    }

    fn delete(file: &LargeFile, from: Pos, to: Pos) -> Edited {
        file.edit(&[Change { from, to, text: String::new() }], EditKind::Other).unwrap()
    }

    fn texts(files: &LargeFiles, id: u32, start: u64, count: u64) -> Vec<String> {
        files.lines(id, start, count).unwrap().into_iter().map(|l| l.text).collect()
    }

    #[test]
    fn edit_utf8_crlf_search_undo_and_save() {
        let path = temp("edit-crlf.txt");
        let row = |i: usize| format!("line {i} äöü");
        let text: String = (0..1000).map(|i| row(i) + "\r\n").collect();
        std::fs::write(&path, &text).unwrap();
        let files = LargeFiles::default();
        let (id, file) = open(&files, &path);
        assert_eq!(files.info(id).unwrap().lines, 1001);

        // Columns count UTF-16 code units: after "line 10 ä".
        let r = insert(&file, 10, 9, "X\nY");
        assert!(r.dirty && r.can_undo);
        assert_eq!(r.lines, 1002);
        assert_eq!(texts(&files, id, 10, 3), ["line 10 äX", "Yöü", "line 11 äöü"]);
        // Join the first two lines (a column past the end means the end), then type at both ends.
        delete(&file, pos(0, 100), pos(1, 0));
        assert_eq!(texts(&files, id, 0, 1), ["line 0 äöüline 1 äöü"]);
        let last = files.info(id).unwrap().lines - 1;
        assert_eq!(texts(&files, id, last, 1), [""]);
        insert(&file, last, 0, "end");
        insert(&file, 0, 0, "start ");

        // Search and copying see the edited document.
        assert_eq!(find(&file, query("äX", 0, 0, true, true, true, false)), Some((9, 8, 2)));
        assert_eq!(find(&file, query("end", u64::MAX, 0, false, false, true, false)), Some((last, 0, 3)));
        assert_eq!(file.text(pos(9, 8), pos(10, 1)).unwrap(), "äX\r\nY");

        // Undo and redo the last step.
        let undone = file.undo(false).unwrap();
        assert_eq!(undone.caret, Some(pos(0, 0)));
        assert_eq!(texts(&files, id, 0, 1), ["line 0 äöüline 1 äöü"]);
        let redone = file.undo(true).unwrap();
        assert_eq!(redone.caret, Some(pos(0, 6)));

        let mut expected = format!("start {}{}\r\n", row(0), row(1));
        for i in 2..1000 {
            expected += &if i == 10 { "line 10 äX\r\nYöü".to_string() } else { row(i) };
            expected += "\r\n";
        }
        expected += "end";
        let saved = files.save(id, None, None).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), expected);
        assert!(!path.with_file_name(".edit-crlf.txt.kladde-save").exists());
        // The viewer continues on the saved file, with the index it already knew.
        assert!(files.get(id).is_err());
        let info = files.info(saved.id).unwrap();
        assert!(info.done && !info.dirty);
        assert_eq!(info.lines, 1001);
        assert_eq!(texts(&files, saved.id, 9, 2), ["line 10 äX", "Yöü"]);
        assert_eq!(texts(&files, saved.id, 1000, 1), ["end"]);
        assert_eq!(saved.eol, "CRLF");
        // Editing goes on in the new file.
        insert(&files.get(saved.id).unwrap(), 1000, 3, "!");
        assert_eq!(texts(&files, saved.id, 1000, 1), ["end!"]);
        files.close(saved.id);
    }

    #[test]
    fn utf16_edits_and_save() {
        for little_endian in [true, false] {
            let path = temp(if little_endian { "edit16le.txt" } else { "edit16be.txt" });
            std::fs::write(&path, utf16("eins\r\nzwei 😀 drei\r\nletzte", little_endian, true)).unwrap();
            let files = LargeFiles::default();
            let (id, file) = open(&files, &path);
            assert_eq!(files.info(id).unwrap().lines, 3);
            // After the emoji: 5 + 2 code units.
            insert(&file, 1, 7, "ä\n");
            assert_eq!(texts(&files, id, 1, 2), ["zwei 😀ä", " drei"]);
            // Right after the BOM, and joining lines over a CRLF.
            insert(&file, 0, 0, "> ");
            delete(&file, pos(0, 6), pos(1, 0));
            assert_eq!(texts(&files, id, 0, 1), ["> einszwei 😀ä"]);
            // Delete the emoji (two code units) and type at the end of the file.
            delete(&file, pos(0, 11), pos(0, 13));
            insert(&file, 2, 6, " ende");
            assert_eq!(file.text(pos(0, 0), pos(2, 11)).unwrap(), "> einszwei ä\r\n drei\r\nletzte ende");
            files.save(id, None, None).unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), utf16("> einszwei ä\r\n drei\r\nletzte ende", little_endian, true));
        }
    }

    #[test]
    fn legacy_encoding_edits() {
        let path = temp("edit1252.txt");
        // "Größe" in windows-1252, LF line endings.
        std::fs::write(&path, b"Gr\xF6\xDFe\nzwei\n").unwrap();
        let files = LargeFiles::default();
        let (id, file) = open(&files, &path);
        assert_eq!(file.encoding.name(), "windows-1252");
        insert(&file, 0, 5, "nä\nneu");
        let err = file.edit(&[Change { from: pos(0, 0), to: pos(0, 0), text: "日本".into() }], EditKind::Type).unwrap_err();
        assert!(err.contains("cannot be saved"), "{err}");
        files.save(id, None, None).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"Gr\xF6\xDFen\xE4\nneu\nzwei\n");
    }

    #[test]
    fn save_as_leaves_the_original() {
        let path = temp("save-as-src.txt");
        let target = temp("save-as-dst.txt");
        let _ = std::fs::remove_file(&target);
        std::fs::write(&path, "a\nb\n").unwrap();
        let files = LargeFiles::default();
        let (id, file) = open(&files, &path);
        insert(&file, 1, 1, "c");
        let saved = files.save(id, Some(&target), None).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"a\nb\n");
        assert_eq!(std::fs::read(&target).unwrap(), b"a\nbc\n");
        assert!(!files.info(saved.id).unwrap().dirty);
        files.close(saved.id);
    }

    #[test]
    fn journal_backup_and_restore() {
        let dir = temp("journal");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = temp("journal.log");
        let text: String = (0..500).map(|i| format!("entry {i}\n")).collect();
        std::fs::write(&path, &text).unwrap();

        let files = LargeFiles::default();
        let (id, file) = open(&files, &path);
        insert(&file, 3, 0, "first ");
        file.backup(&dir, "tab").unwrap();
        // More edits: the add buffer file is appended to, the piece list rewritten.
        insert(&file, 499, 9, "\nadded at the end");
        delete(&file, pos(0, 0), pos(2, 0));
        file.backup(&dir, "tab").unwrap();
        let expected: Vec<String> = texts(&files, id, 0, 1000);
        files.close(id);

        // Like the next start after a crash: the file is opened again and the journal applied.
        let files = LargeFiles::default();
        let (id, file) = open(&files, &path);
        let restored = file.restore(&dir, "tab", false).unwrap();
        assert_eq!(restored.status, "applied");
        assert!(restored.dirty);
        assert_eq!(texts(&files, id, 0, 1000), expected);
        assert_eq!(texts(&files, id, 1, 1), ["first entry 3"]);
        // Editing and backing up go on from the restored state.
        insert(&file, 0, 0, "x");
        file.backup(&dir, "tab").unwrap();
        files.close(id);

        // The file changed meanwhile: nothing is applied unless forced, and the journal stays.
        std::fs::write(&path, text.replace("entry 7\n", "ENTRY 7\n")).unwrap();
        let (id, file) = open(&files, &path);
        assert_eq!(file.restore(&dir, "tab", false).unwrap().status, "conflict");
        assert!(!files.info(id).unwrap().dirty);
        let forced = file.restore(&dir, "tab", true).unwrap();
        assert_eq!(forced.status, "applied");
        assert_eq!(texts(&files, id, 0, 1), ["xentry 2"]);
        files.close(id);

        // Saved (or discarded): nothing left to restore.
        remove_journal(&dir, "tab");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let (id, file) = open(&files, &path);
        assert_eq!(file.restore(&dir, "tab", false).unwrap().status, "missing");
        files.close(id);
    }

    #[test]
    fn forced_restore_onto_a_grown_file_keeps_the_appended_lines() {
        let dir = temp("journal-grown");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = temp("journal-grown.log");
        std::fs::write(&path, "one
two
").unwrap();
        let files = LargeFiles::default();
        let (id, file) = open(&files, &path);
        insert(&file, 0, 3, "!");
        file.backup(&dir, "tab").unwrap();
        files.close(id);

        std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(b"three
").unwrap();
        let (id, file) = open(&files, &path);
        assert_eq!(file.restore(&dir, "tab", false).unwrap().status, "conflict");
        assert_eq!(file.restore(&dir, "tab", true).unwrap().status, "applied");
        let saved = files.save(id, None, Some((&dir, "tab"))).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"one!
two
three
");
        files.close(saved.id);
    }

    #[test]
    fn saving_removes_the_journal() {
        let dir = temp("journal-save");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = temp("journal-save.txt");
        std::fs::write(&path, "one\ntwo\n").unwrap();
        let files = LargeFiles::default();
        let (id, file) = open(&files, &path);
        insert(&file, 0, 3, "!");
        file.backup(&dir, "tab").unwrap();
        assert!(journal_path(&dir, "tab").exists());
        let saved = files.save(id, None, Some((&dir, "tab"))).unwrap();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        assert_eq!(std::fs::read(&path).unwrap(), b"one!\ntwo\n");
        files.close(saved.id);
    }

    #[test]
    fn save_keeps_what_was_appended_and_refuses_a_rewritten_original() {
        let path = temp("appended.log");
        std::fs::write(&path, "a
b
").unwrap();
        let files = LargeFiles::default();
        let (id, file) = open(&files, &path);
        insert(&file, 0, 1, "!");
        // A logger that had the file open before the edits began keeps appending (no guard here).
        *file.guard.lock().unwrap() = None;
        std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(b"c
").unwrap();
        let saved = files.save(id, None, None).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"a!
b
c
");
        // The index of the written file was not the document's: the viewer indexed it again.
        files.get(saved.id).unwrap().wait_for_index();
        assert_eq!(texts(&files, saved.id, 0, 4), ["a!", "b", "c", ""]);

        // Rewritten or shortened behind the edits' back: nothing is written, the edits stay.
        let file = files.get(saved.id).unwrap();
        insert(&file, 0, 0, "x");
        *file.guard.lock().unwrap() = None;
        std::fs::write(&path, "A!
b
c
").unwrap();
        let err = files.save(saved.id, None, None).map(|_| ()).unwrap_err();
        assert!(err.contains("changed by another program"), "{err}");
        assert_eq!(std::fs::read(&path).unwrap(), b"A!
b
c
");
        assert!(files.info(saved.id).unwrap().dirty);
        assert!(!path.with_file_name(".appended.log.kladde-save").exists());
        std::fs::write(&path, "A").unwrap();
        assert!(files.save(saved.id, None, None).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"A");
        files.close(saved.id);
    }

    /// Measures a ~200 MB file: `cargo test --release perf_200mb -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn perf_200mb() {
        let path = temp("perf-200mb.log");
        {
            let mut out = std::io::BufWriter::new(File::create(&path).unwrap());
            let line = format!("2026-10-28 12:00:00 INFO request handled {}
", "x".repeat(60));
            for i in 0..1_800_000u32 {
                write!(out, "{i:>7} {line}").unwrap();
            }
        }
        let size = std::fs::metadata(&path).unwrap().len();
        let files = LargeFiles::default();
        let t = Instant::now();
        let (id, file) = open(&files, &path);
        println!("open + index {} MB, {} lines: {:?}", size >> 20, files.info(id).unwrap().lines, t.elapsed());

        // Typing in the middle and near the end: one edit per keystroke, and the lines fetched after it.
        let mut worst = Duration::ZERO;
        let t = Instant::now();
        for i in 0..2000u64 {
            let at = Instant::now();
            let line = if i % 2 == 0 { 900_000 } else { 1_799_000 };
            file.edit(&[Change { from: pos(line, 5), to: pos(line, 5), text: "x".into() }], EditKind::Type).unwrap();
            files.lines(id, line.saturating_sub(20), 50).unwrap();
            worst = worst.max(at.elapsed());
        }
        println!("2000 keystrokes (edit + 50 lines): avg {:?}, worst {:?}", t.elapsed() / 2000, worst);

        let t = Instant::now();
        file.edit(&[Change { from: pos(0, 0), to: pos(1_000_000, 0), text: String::new() }], EditKind::Other).unwrap();
        println!("delete 1,000,000 lines: {:?}", t.elapsed());
        file.undo(false).unwrap();

        let dir = temp("perf-journal");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let t = Instant::now();
        file.backup(&dir, "tab").unwrap();
        println!("journal backup ({} pieces): {:?}", file.edits.read().unwrap().as_ref().unwrap().table.pieces().len(), t.elapsed());
        let _ = std::fs::remove_dir_all(&dir);

        let t = Instant::now();
        let found = find(&file, query("999999 ", 0, 0, true, true, true, false));
        println!("search in the edited document: {:?} ({found:?})", t.elapsed());

        let t = Instant::now();
        let saved = files.save(id, None, None).unwrap();
        println!("save: {:?}", t.elapsed());
        files.close(saved.id);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn growth_is_not_followed_while_edited() {
        let path = temp("guarded.log");
        std::fs::write(&path, "a\nb\n").unwrap();
        let files = LargeFiles::default();
        let (id, file) = open(&files, &path);
        insert(&file, 2, 0, "c");
        assert_eq!(texts(&files, id, 0, 5), ["a", "b", "c"]);

        // While edited, other programs cannot write the original underneath the edits (Windows).
        #[cfg(windows)]
        assert!(std::fs::OpenOptions::new().append(true).open(&path).is_err());
        let refreshed = files.refresh(id).unwrap();
        assert!(!refreshed.changed);
        assert_eq!(texts(&files, id, 0, 5), ["a", "b", "c"]);

        // Undone: the guard is gone, and growth is followed again (the undo history goes).
        assert!(!file.undo(false).unwrap().dirty);
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b"d\n").unwrap();
        assert!(!files.refresh(id).unwrap().changed);
        file.wait_for_index();
        assert_eq!(texts(&files, id, 0, 5), ["a", "b", "d", ""]);
        assert!(!file.edited(None).can_redo);
        files.close(id);
    }
}
