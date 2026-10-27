//! Viewer backend for files too large to load into the editor.
//!
//! The file is never read as a whole: a background thread builds an index of line
//! start offsets, and the frontend fetches only the lines it displays. Reads are
//! positional (no memory map), so the file stays writable for other processes,
//! e.g. a logger that is still appending to it.

use crate::files::{guess_encoding, sniff_bom};
use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

const CHUNK: usize = 8 << 20;
/// Longer lines are cut off for display; minified files can be one giant line.
const MAX_LINE_BYTES: u64 = 64 << 10;

pub struct LargeFile {
    file: File,
    size: u64,
    encoding: &'static Encoding,
    bom_len: u64,
    index: RwLock<Vec<u64>>,
    done: AtomicBool,
    cancelled: AtomicBool,
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
}

#[derive(Serialize)]
pub struct Line {
    pub text: String,
    pub truncated: bool,
}

#[derive(Serialize)]
pub struct Match {
    pub line: u64,
    pub col: u64,
    pub len: u64,
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

impl LargeFile {
    fn read_range(&self, start: u64, end: u64) -> Vec<u8> {
        let mut buf = vec![0u8; end.saturating_sub(start) as usize];
        let n = read_at(&self.file, &mut buf, start).unwrap_or(0);
        buf.truncate(n);
        buf
    }

    /// Byte range of line `i` without its line break, or None if not indexed yet.
    fn line_range(&self, index: &[u64], i: usize) -> Option<(u64, u64)> {
        let start = (*index.get(i)?).max(self.bom_len);
        let end = match index.get(i + 1) {
            Some(&next) => next,
            None if self.done.load(Ordering::Acquire) => self.size,
            None => return None,
        };
        Some((start, end))
    }

    fn read_line(&self, start: u64, end: u64) -> (Vec<u8>, bool) {
        let truncated = end - start > MAX_LINE_BYTES;
        let mut bytes = self.read_range(start, if truncated { start + MAX_LINE_BYTES } else { end });
        if !truncated {
            while matches!(bytes.last(), Some(b'\n' | b'\r')) {
                bytes.pop();
            }
        }
        (bytes, truncated)
    }

    fn decode(&self, bytes: &[u8]) -> String {
        self.encoding.decode_without_bom_handling(bytes).0.into_owned()
    }

    fn build_index(&self) {
        let mut offset = 0u64;
        let mut buf = vec![0u8; CHUNK];
        let mut batch = Vec::with_capacity(1 << 16);
        while offset < self.size && !self.cancelled.load(Ordering::Relaxed) {
            let n = read_at(&self.file, &mut buf, offset).unwrap_or(0);
            if n == 0 {
                break;
            }
            for pos in memchr::memchr_iter(b'\n', &buf[..n]) {
                let next = offset + pos as u64 + 1;
                if next < self.size {
                    batch.push(next);
                }
            }
            self.index.write().unwrap().append(&mut batch);
            offset += n as u64;
        }
        self.done.store(true, Ordering::Release);
    }

    fn wait_for_index(&self) {
        while !self.done.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn find(&self, needle: &[u8], from: u64, forward: bool, match_case: bool) -> Option<u64> {
        if needle.is_empty() {
            return None;
        }
        let overlap = needle.len() as u64 - 1;
        let prepare = |mut chunk: Vec<u8>| {
            if !match_case {
                chunk.make_ascii_lowercase();
            }
            chunk
        };
        if forward {
            let mut start = from;
            while start < self.size {
                let end = (start + CHUNK as u64).min(self.size);
                let chunk = prepare(self.read_range(start, end));
                if let Some(pos) = memchr::memmem::find(&chunk, needle) {
                    return Some(start + pos as u64);
                }
                if end == self.size {
                    break;
                }
                start = end - overlap;
            }
        } else {
            let mut end = from.min(self.size);
            while end > 0 {
                let start = end.saturating_sub(CHUNK as u64);
                let chunk = prepare(self.read_range(start, end));
                if let Some(pos) = memchr::memmem::rfind(&chunk, needle) {
                    return Some(start + pos as u64);
                }
                if start == 0 {
                    break;
                }
                end = start + overlap;
            }
        }
        None
    }

    /// Converts a character column in a line to a byte offset into the line.
    fn byte_col(&self, line_bytes: &[u8], char_col: u64) -> u64 {
        if self.encoding != UTF_8 {
            return char_col.min(line_bytes.len() as u64);
        }
        let text = String::from_utf8_lossy(line_bytes);
        text.char_indices().nth(char_col as usize).map_or(line_bytes.len() as u64, |(i, _)| i as u64)
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
        if encoding == UTF_16LE || encoding == UTF_16BE {
            return Err("UTF-16 files are not supported in large file mode yet.".into());
        }

        let large = Arc::new(LargeFile {
            file,
            size,
            encoding,
            bom_len,
            index: RwLock::new(vec![0]),
            done: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
        });
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.open.lock().unwrap().insert(id, large.clone());
        std::thread::spawn(move || large.build_index());

        Ok(LargeOpened {
            id,
            size,
            encoding: encoding.name().to_string(),
            mtime: crate::files::mtime_ms(&meta),
        })
    }

    fn get(&self, id: u32) -> Result<Arc<LargeFile>, String> {
        self.open.lock().unwrap().get(&id).cloned().ok_or_else(|| "File is no longer open".to_string())
    }

    pub fn info(&self, id: u32) -> Result<LargeInfo, String> {
        let file = self.get(id)?;
        let lines = file.index.read().unwrap().len() as u64;
        Ok(LargeInfo { lines, done: file.done.load(Ordering::Acquire) })
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

    /// Finds `query` after (forward) or before (backward) the given position.
    /// `inclusive` also accepts a match starting exactly at the position.
    #[allow(clippy::too_many_arguments)]
    pub fn search(
        &self,
        id: u32,
        query: &str,
        line: u64,
        col: u64,
        forward: bool,
        inclusive: bool,
        match_case: bool,
    ) -> Result<Option<Match>, String> {
        let file = self.get(id)?;
        file.wait_for_index();

        let (encoded, _, _) = file.encoding.encode(query);
        let mut needle = encoded.into_owned();
        if !match_case {
            needle.make_ascii_lowercase();
        }

        let index = file.index.read().unwrap();
        let line = (line as usize).min(index.len() - 1);
        let (start, end) = file.line_range(&index, line).unwrap_or((0, 0));
        let from = start + file.byte_col(&file.read_line(start, end).0, col);
        let from = if forward && !inclusive { from + 1 } else { from };

        let Some(found) = file.find(&needle, from, forward, match_case) else {
            return Ok(None);
        };
        let line = index.partition_point(|&o| o <= found) - 1;
        let line_start = index[line].max(file.bom_len);
        let prefix = file.read_range(line_start, found);
        Ok(Some(Match {
            line: line as u64,
            col: file.decode(&prefix).chars().count() as u64,
            len: query.chars().count() as u64,
        }))
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

    #[test]
    fn index_lines_and_search() {
        let dir = std::env::temp_dir().join("kladde-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("large.log");
        let mut text = String::new();
        for i in 0..50_000 {
            text.push_str(&format!("line {i} INFO something\r\n"));
        }
        text.push_str("last line without newline ERROR");
        std::fs::write(&path, &text).unwrap();

        let files = LargeFiles::default();
        let opened = files.open(&path).unwrap();
        files.get(opened.id).unwrap().wait_for_index();
        assert_eq!(files.info(opened.id).unwrap().lines, 50_001);

        let lines = files.lines(opened.id, 49_999, 5).unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].text, "line 49999 INFO something");
        assert_eq!(lines[1].text, "last line without newline ERROR");

        let m = files.search(opened.id, "error", 0, 0, true, false, false).unwrap().unwrap();
        assert_eq!((m.line, m.col, m.len), (50_000, 26, 5));
        assert!(files.search(opened.id, "error", 0, 0, true, false, true).unwrap().is_none());
        let m = files.search(opened.id, "line 0 ", 0, 0, true, true, true).unwrap().unwrap();
        assert_eq!((m.line, m.col), (0, 0));

        let m = files.search(opened.id, "line 7 ", 50_000, 0, false, false, true).unwrap().unwrap();
        assert_eq!((m.line, m.col), (7, 0));
        files.close(opened.id);
    }
}
