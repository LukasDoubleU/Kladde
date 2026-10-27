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

use crate::files::{guess_encoding, mtime_ms, sniff_bom};
use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
use serde::Serialize;
use std::borrow::Cow;
use std::collections::HashMap;
use std::fs::File;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

const CHUNK: usize = 8 << 20;
/// How far to look for a line break to end a search chunk at.
const SNAP: u64 = 1 << 20;
/// Overlap of search chunks that had to be cut inside a line.
const OVERLAP: u64 = 64 << 10;
/// Longer lines are cut off for display; minified files can be one giant line.
const MAX_LINE_BYTES: u64 = 64 << 10;
/// Bytes at the start and at the end of the indexed part that tell whether the file was rewritten.
const FINGERPRINT: u64 = 4096;

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

pub struct LargeFile {
    file: File,
    size: AtomicU64,
    encoding: &'static Encoding,
    breaks: Breaks,
    /// Bytes per code unit: 2 for UTF-16, else 1.
    unit: u64,
    bom_len: u64,
    index: RwLock<Vec<u64>>,
    /// Everything before this offset has been scanned for line breaks.
    indexed_to: AtomicU64,
    done: AtomicBool,
    cancelled: AtomicBool,
    /// An index worker is running (guards starting a second one when the file grows).
    worker: Mutex<bool>,
    /// The last scan ended in a line break exactly at the end of the file; the line after it is
    /// only added once the file grows.
    eof_break: AtomicBool,
    fingerprint: Mutex<Fingerprint>,
    /// Bumped by every search and by cancelling; a running search stops when it changes.
    search_gen: AtomicU64,
}

#[derive(Default)]
pub struct LargeFiles {
    next_id: AtomicU32,
    open: Mutex<HashMap<u32, Arc<LargeFile>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeOpened {
    pub id: u32,
    pub size: u64,
    pub encoding: String,
    pub mtime: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeInfo {
    pub lines: u64,
    pub done: bool,
    pub size: u64,
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
    fn read_range(&self, start: u64, end: u64) -> Vec<u8> {
        let mut buf = vec![0u8; end.saturating_sub(start) as usize];
        let n = read_at(&self.file, &mut buf, start).unwrap_or(0);
        buf.truncate(n);
        buf
    }

    /// File size cut down to whole code units.
    fn size(&self) -> u64 {
        let size = self.size.load(Ordering::Acquire);
        size - size % self.unit
    }

    /// Byte range of line `i` without its line break, or None if not indexed yet.
    fn line_range(&self, index: &[u64], i: usize) -> Option<(u64, u64)> {
        let start = (*index.get(i)?).max(self.bom_len);
        let end = match index.get(i + 1) {
            Some(&next) => next,
            None if self.done.load(Ordering::Acquire) => self.size(),
            None => return None,
        };
        Some((start, end))
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

    // ------------------------------------------------------------------ index

    /// Scans the not yet indexed part of the file; runs until it has caught up with the size, which
    /// may grow meanwhile. Only one worker runs at a time.
    fn index_worker(&self) {
        let mut buf = vec![0u8; CHUNK];
        let mut batch: Vec<u64> = Vec::with_capacity(1 << 16);
        loop {
            let size = self.size.load(Ordering::Acquire);
            let mut offset = self.indexed_to.load(Ordering::Acquire);
            if self.eof_break.swap(false, Ordering::Relaxed) && offset < size {
                batch.push(offset);
            }
            let mut stalled = false;
            while offset + self.unit <= size && !self.cancelled.load(Ordering::Relaxed) {
                let want = (size - offset).min(CHUNK as u64) as usize;
                let n = read_at(&self.file, &mut buf[..want], offset).unwrap_or(0);
                let usable = n - n % self.unit as usize;
                if usable == 0 {
                    stalled = true;
                    break;
                }
                for_each_line_end(self.breaks, &buf[..usable], offset, |end| {
                    let next = offset + end as u64;
                    // A line starting at the very end of the file is not a line (yet).
                    if next < size {
                        batch.push(next);
                    } else {
                        self.eof_break.store(true, Ordering::Relaxed);
                    }
                });
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
        Fingerprint { head: self.read_range(0, size.min(FINGERPRINT)), tail_at, tail: self.read_range(tail_at, size) }
    }

    /// Checks whether the file grew (the index is extended), shrank or was rewritten.
    fn refresh(self: &Arc<Self>) -> Result<LargeRefresh, String> {
        let meta = self.file.metadata().map_err(|e| e.to_string())?;
        let new_size = meta.len();
        let mtime = mtime_ms(&meta);
        let old_size = self.size.load(Ordering::Acquire);
        let unchanged_content = {
            let fp = self.fingerprint.lock().unwrap();
            self.read_range(0, fp.head.len() as u64) == fp.head
                && self.read_range(fp.tail_at, fp.tail_at + fp.tail.len() as u64) == fp.tail
        };
        if new_size < old_size || !unchanged_content {
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

    /// The line containing a byte offset; waits until the index has reached it.
    fn line_of(&self, generation: u64, offset: u64) -> Result<(usize, u64), Stop> {
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
        let size = self.size();
        let line = req.line as usize;
        if line >= self.index.read().unwrap().len() {
            // Past the end, e.g. a backward search starting at the end of the file: needs all lines.
            self.wait_until(generation, || self.done.load(Ordering::Acquire))?;
        }
        let (start, end) = {
            let index = self.index.read().unwrap();
            if line >= index.len() {
                return Ok((size, size, size));
            }
            let start = index[line].max(self.bom_len);
            (start, index.get(line + 1).copied().unwrap_or(size))
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
            Ok(found) => done(found),
            Err(Stop::Cancelled) => Ok(SearchResult { found: None, cancelled: true }),
        }
    }

    fn search_forward(&self, generation: u64, matcher: &Matcher, req: &SearchRequest) -> Result<Option<Match>, Stop> {
        let (mut pos, from, _) = self.anchor(generation, req)?;
        let size = self.size();
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
        let breaks = if encoding == UTF_16LE {
            Breaks::Utf16Le
        } else if encoding == UTF_16BE {
            Breaks::Utf16Be
        } else {
            Breaks::Byte
        };

        let large = Arc::new(LargeFile {
            file,
            size: AtomicU64::new(size),
            encoding,
            breaks,
            unit: if breaks == Breaks::Byte { 1 } else { 2 },
            bom_len,
            index: RwLock::new(vec![0]),
            indexed_to: AtomicU64::new(0),
            done: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            worker: Mutex::new(true),
            eof_break: AtomicBool::new(false),
            fingerprint: Mutex::new(Fingerprint { head: Vec::new(), tail_at: 0, tail: Vec::new() }),
            search_gen: AtomicU64::new(0),
        });
        *large.fingerprint.lock().unwrap() = large.fingerprint_now(size);
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.open.lock().unwrap().insert(id, large.clone());
        std::thread::spawn(move || large.index_worker());

        Ok(LargeOpened { id, size, encoding: encoding.name().to_string(), mtime: mtime_ms(&meta) })
    }

    pub fn get(&self, id: u32) -> Result<Arc<LargeFile>, String> {
        self.open.lock().unwrap().get(&id).cloned().ok_or_else(|| "File is no longer open".to_string())
    }

    pub fn info(&self, id: u32) -> Result<LargeInfo, String> {
        let file = self.get(id)?;
        let lines = file.index.read().unwrap().len() as u64;
        Ok(LargeInfo { lines, done: file.done.load(Ordering::Acquire), size: file.size.load(Ordering::Acquire) })
    }

    pub fn lines(&self, id: u32, start: u64, count: u64) -> Result<Vec<Line>, String> {
        let file = self.get(id)?;
        let ranges: Vec<(u64, u64)> = {
            let index = file.index.read().unwrap();
            (start..start + count).map_while(|i| file.line_range(&index, i as usize)).collect()
        };
        Ok(ranges
            .into_iter()
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

    pub fn close(&self, id: u32) {
        if let Some(file) = self.open.lock().unwrap().remove(&id) {
            file.cancelled.store(true, Ordering::Relaxed);
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
        // The empty line after the last break is not a line.
        assert_eq!(files.info(id).unwrap().lines, 2);
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
        assert_eq!(files.info(id).unwrap().lines, 2);

        // Append a partial line, then complete it: the last line grows in place.
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
        assert_eq!(files.info(id).unwrap().lines, 4);
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
        assert_eq!(files.info(id).unwrap().lines, 1);
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
}
