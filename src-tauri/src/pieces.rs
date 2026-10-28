//! Piece table for editing files that are too large to load.
//!
//! The document is a list of pieces, each a byte range of either the original file (read
//! positionally, never loaded) or an append-only buffer that holds every inserted text. An edit
//! only splits and replaces piece descriptors, so it costs the same in a 10 KB file and a 10 GB
//! one, and the original bytes are never copied or rewritten until the file is saved.
//!
//! Lines: every piece caches how many line breaks end inside it. The breaks of the original come
//! from the viewer's line index, those of the add buffer from a list kept while appending, so line
//! lookups are binary searches over prefix sums instead of scans.
//!
//! Undo: an operation records the piece descriptors it removed and inserted. Both sources are
//! immutable (the add buffer only grows), so the descriptors stay valid forever and undo is the
//! same splice in the other direction, whatever the size of the change.
//!
//! The table knows nothing about encodings: offsets are bytes in the file's encoding, and the
//! caller tells where the line breaks of inserted bytes end.

use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Original,
    Added,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Piece {
    pub source: Source,
    pub start: u64,
    pub len: u64,
    /// Line breaks that end inside the piece, i.e. in (start, start + len].
    pub breaks: u64,
}

impl Piece {
    pub fn end(&self) -> u64 {
        self.start + self.len
    }
}

/// How an edit came about; consecutive edits of the same kind are undone together.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EditKind {
    /// Typed text (also replacing a selection by typing).
    Type,
    /// Backspace.
    DeleteBackward,
    /// Delete.
    DeleteForward,
    /// Anything else (paste, cut, line commands): always its own undo step.
    Other,
}

/// One change of a batch: replace [from, to) with `bytes`, whose line breaks end at `breaks`
/// (offsets relative to `bytes`).
pub struct Replace {
    pub from: u64,
    pub to: u64,
    pub bytes: Vec<u8>,
    pub breaks: Vec<u64>,
}

struct Op {
    at: u64,
    removed: Vec<Piece>,
    inserted: Vec<Piece>,
}

struct Group {
    ops: Vec<Op>,
    kind: EditKind,
    time: Instant,
    /// Undo and redo close a group: typing after an undo starts a new step.
    open: bool,
}

/// Undo steps kept; the descriptors are small, but a long session should not grow without bound.
const MAX_UNDO: usize = 10_000;
/// Edits of the same kind closer together than this are one undo step (like CodeMirror).
const GROUP_DELAY: Duration = Duration::from_millis(500);

/// Line break ends in (start, end] of a sorted list of break ends.
pub fn breaks_in(ends: &[u64], start: u64, end: u64) -> u64 {
    (ends.partition_point(|&o| o <= end) - ends.partition_point(|&o| o <= start)) as u64
}

/// The end of the n-th (1-based) line break after `start`.
fn nth_break(ends: &[u64], start: u64, n: u64) -> u64 {
    ends[ends.partition_point(|&o| o <= start) + n as usize - 1]
}

fn total(pieces: &[Piece]) -> u64 {
    pieces.iter().map(|p| p.len).sum()
}

pub struct PieceTable {
    pieces: Vec<Piece>,
    /// Document offset where each piece starts, plus the document length at the end.
    starts: Vec<u64>,
    /// Line breaks before each piece, plus the total at the end.
    lines_before: Vec<u64>,
    added: Vec<u8>,
    /// Ends of the line breaks in `added`, sorted.
    added_breaks: Vec<u64>,
    original_len: u64,
    undo: Vec<Group>,
    redo: Vec<Group>,
}

impl PieceTable {
    /// The unmodified original of `len` bytes, whose line breaks end at `original` (the sorted line
    /// starts of the viewer's index; a leading 0 is fine).
    pub fn new(original: &[u64], len: u64) -> Self {
        let pieces = if len == 0 {
            Vec::new()
        } else {
            vec![Piece { source: Source::Original, start: 0, len, breaks: breaks_in(original, 0, len) }]
        };
        let mut table = PieceTable {
            pieces,
            starts: vec![0],
            lines_before: vec![0],
            added: Vec::new(),
            added_breaks: Vec::new(),
            original_len: len,
            undo: Vec::new(),
            redo: Vec::new(),
        };
        table.rebuild(0);
        table
    }

    /// A document from a backup: pieces as (source, start, len) over the original and `added`.
    pub fn restore(
        original: &[u64],
        original_len: u64,
        added: Vec<u8>,
        added_breaks: Vec<u64>,
        pieces: &[(Source, u64, u64)],
    ) -> Result<Self, String> {
        let mut table = PieceTable::new(original, original_len);
        table.added = added;
        table.added_breaks = added_breaks;
        let mut list = Vec::with_capacity(pieces.len());
        for &(source, start, len) in pieces {
            let limit = if source == Source::Original { original_len } else { table.added.len() as u64 };
            if start.checked_add(len).is_none_or(|end| end > limit) {
                return Err("The backed up edits do not fit the file.".into());
            }
            if len > 0 {
                let breaks = breaks_in(table.ends(original, source), start, start + len);
                list.push(Piece { source, start, len, breaks });
            }
        }
        table.pieces = list;
        table.merge(0, table.pieces.len());
        table.rebuild(0);
        Ok(table)
    }

    fn ends<'a>(&'a self, original: &'a [u64], source: Source) -> &'a [u64] {
        match source {
            Source::Original => original,
            Source::Added => &self.added_breaks,
        }
    }

    pub fn len(&self) -> u64 {
        *self.starts.last().unwrap()
    }

    /// Number of lines: one more than line breaks, so a final break is followed by an empty line.
    pub fn lines(&self) -> u64 {
        self.lines_before.last().unwrap() + 1
    }

    pub fn original_len(&self) -> u64 {
        self.original_len
    }

    pub fn pieces(&self) -> &[Piece] {
        &self.pieces
    }

    pub fn added(&self) -> &[u8] {
        &self.added
    }

    /// The document differs from the original. Undoing every edit makes it equal again, because
    /// neighbouring pieces of the same source are merged back into one.
    pub fn is_modified(&self) -> bool {
        match self.pieces.as_slice() {
            [] => self.original_len != 0,
            [p] => !(p.source == Source::Original && p.start == 0 && p.len == self.original_len),
            _ => true,
        }
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    /// Recomputes the prefix sums from piece `from` on (the entries before it are still right).
    fn rebuild(&mut self, from: usize) {
        self.starts.truncate(from + 1);
        self.lines_before.truncate(from + 1);
        for k in from..self.pieces.len() {
            let p = self.pieces[k];
            self.starts.push(self.starts[k] + p.len);
            self.lines_before.push(self.lines_before[k] + p.breaks);
        }
    }

    /// Merges neighbours in pieces [lo, hi] that continue each other in the same source.
    fn merge(&mut self, lo: usize, hi: usize) {
        let mut k = lo;
        let mut hi = hi.min(self.pieces.len().saturating_sub(1));
        while k < hi {
            let (a, b) = (self.pieces[k], self.pieces[k + 1]);
            if a.source == b.source && a.end() == b.start {
                self.pieces[k].len += b.len;
                self.pieces[k].breaks += b.breaks;
                self.pieces.remove(k + 1);
                hi -= 1;
            } else {
                k += 1;
            }
        }
    }

    /// Index of the piece containing document offset `at` (the number of pieces at the end).
    fn locate(&self, at: u64) -> usize {
        self.starts.partition_point(|&s| s <= at) - 1
    }

    /// Makes `at` a piece boundary; returns the index of the piece that starts there.
    fn split(&mut self, original: &[u64], at: u64) -> usize {
        let k = self.locate(at);
        if k == self.pieces.len() || self.starts[k] == at {
            return k;
        }
        let p = self.pieces[k];
        let rel = at - self.starts[k];
        let left = breaks_in(self.ends(original, p.source), p.start, p.start + rel);
        self.pieces[k] = Piece { len: rel, breaks: left, ..p };
        self.pieces.insert(k + 1, Piece { start: p.start + rel, len: p.len - rel, breaks: p.breaks - left, ..p });
        self.starts.insert(k + 1, at);
        self.lines_before.insert(k + 1, self.lines_before[k] + left);
        k + 1
    }

    /// Replaces `len` bytes at `at` with the given pieces; returns the pieces taken out.
    fn splice(&mut self, original: &[u64], at: u64, len: u64, insert: &[Piece]) -> Vec<Piece> {
        let i = self.split(original, at);
        let j = self.split(original, at + len);
        let removed: Vec<Piece> = self.pieces.splice(i..j, insert.iter().copied()).collect();
        let lo = i.saturating_sub(1);
        self.merge(lo, i + insert.len());
        self.rebuild(lo);
        removed
    }

    /// Applies a batch of non-overlapping changes as one undo step (merged with the step before
    /// when it continues the same typing or deleting). Offsets refer to the document before the
    /// batch. Returns false and changes nothing if a change is out of range or they overlap.
    pub fn edit(&mut self, original: &[u64], mut changes: Vec<Replace>, kind: EditKind, now: Instant) -> bool {
        changes.sort_by_key(|c| std::cmp::Reverse(c.from));
        let len = self.len();
        let valid = changes.iter().all(|c| c.from <= c.to && c.to <= len)
            && changes.windows(2).all(|w| w[1].to <= w[0].from);
        if !valid {
            return false;
        }
        let mut ops = Vec::with_capacity(changes.len());
        // From the back, so the offsets of the changes still to come stay valid.
        for change in changes {
            if change.from == change.to && change.bytes.is_empty() {
                continue;
            }
            let inserted = if change.bytes.is_empty() {
                Vec::new()
            } else {
                let start = self.added.len() as u64;
                self.added.extend_from_slice(&change.bytes);
                self.added_breaks.extend(change.breaks.iter().map(|b| start + b));
                vec![Piece { source: Source::Added, start, len: change.bytes.len() as u64, breaks: change.breaks.len() as u64 }]
            };
            let removed = self.splice(original, change.from, change.to - change.from, &inserted);
            ops.push(Op { at: change.from, removed, inserted });
        }
        if ops.is_empty() {
            return true;
        }
        self.redo.clear();
        if ops.len() == 1 && self.extend_last(&ops[0], kind, now) {
            return true;
        }
        self.undo.push(Group { ops, kind, time: now, open: true });
        if self.undo.len() > MAX_UNDO {
            self.undo.remove(0);
        }
        true
    }

    /// Folds a single operation into the last undo step if it continues it.
    fn extend_last(&mut self, op: &Op, kind: EditKind, now: Instant) -> bool {
        let Some(group) = self.undo.last_mut() else { return false };
        if !group.open || group.kind != kind || group.ops.len() != 1 || now.duration_since(group.time) > GROUP_DELAY {
            return false;
        }
        let last = &mut group.ops[0];
        let merged = match kind {
            // Typing goes on right after the text typed so far.
            EditKind::Type if op.removed.is_empty() && op.at == last.at + total(&last.inserted) => {
                last.inserted.extend_from_slice(&op.inserted);
                true
            }
            // Backspace eats the text before the previous deletion.
            EditKind::DeleteBackward
                if op.inserted.is_empty() && last.inserted.is_empty() && op.at + total(&op.removed) == last.at =>
            {
                let mut removed = op.removed.clone();
                removed.append(&mut last.removed);
                last.removed = removed;
                last.at = op.at;
                true
            }
            // Delete eats the text after it, at the same position.
            EditKind::DeleteForward if op.inserted.is_empty() && last.inserted.is_empty() && op.at == last.at => {
                last.removed.extend_from_slice(&op.removed);
                true
            }
            _ => false,
        };
        if merged {
            group.time = now;
        }
        merged
    }

    /// Undoes the last step. Returns the range of the restored text (of the first change in the
    /// document if the step had several).
    pub fn undo(&mut self, original: &[u64]) -> Option<(u64, u64)> {
        let mut group = self.undo.pop()?;
        let mut range: Option<(u64, u64)> = None;
        for op in group.ops.iter().rev() {
            self.splice(original, op.at, total(&op.inserted), &op.removed);
            if range.is_none_or(|(from, _)| op.at <= from) {
                range = Some((op.at, op.at + total(&op.removed)));
            }
        }
        group.open = false;
        self.redo.push(group);
        range
    }

    /// Redoes the last undone step; returns the range of the inserted text like `undo`.
    pub fn redo(&mut self, original: &[u64]) -> Option<(u64, u64)> {
        let mut group = self.redo.pop()?;
        let mut range: Option<(u64, u64)> = None;
        for op in &group.ops {
            self.splice(original, op.at, total(&op.removed), &op.inserted);
            if range.is_none_or(|(from, _)| op.at <= from) {
                range = Some((op.at, op.at + total(&op.inserted)));
            }
        }
        group.open = false;
        self.undo.push(group);
        range
    }

    /// The bytes [from, to) of the document; `read_original(offset, buf)` fills `buf` from the
    /// original and returns how much it read.
    pub fn read(&self, from: u64, to: u64, mut read_original: impl FnMut(u64, &mut [u8]) -> usize) -> Vec<u8> {
        let to = to.min(self.len());
        let mut out = Vec::with_capacity(to.saturating_sub(from) as usize);
        if from >= to {
            return out;
        }
        let mut k = self.locate(from);
        while k < self.pieces.len() && self.starts[k] < to {
            let p = self.pieces[k];
            let a = p.start + from.max(self.starts[k]) - self.starts[k];
            let b = p.start + to.min(self.starts[k + 1]) - self.starts[k];
            match p.source {
                Source::Added => out.extend_from_slice(&self.added[a as usize..b as usize]),
                Source::Original => {
                    let at = out.len();
                    out.resize(at + (b - a) as usize, 0);
                    let n = read_original(a, &mut out[at..]);
                    // A shorter original (changed behind our back) must not shift the rest.
                    if n < (b - a) as usize {
                        out.truncate(at + n);
                        return out;
                    }
                }
            }
            k += 1;
        }
        out
    }

    /// Start of line `n` (0-based), or None past the last line.
    pub fn line_start(&self, original: &[u64], n: u64) -> Option<u64> {
        if n == 0 {
            return Some(0);
        }
        if n >= self.lines() {
            return None;
        }
        // The first piece whose breaks reach the n-th one.
        let k = self.lines_before[1..].partition_point(|&c| c < n);
        let p = self.pieces[k];
        let end = nth_break(self.ends(original, p.source), p.start, n - self.lines_before[k]);
        Some(self.starts[k] + end - p.start)
    }

    /// The line containing document offset `at` (a line starts right after a break).
    pub fn line_of(&self, original: &[u64], at: u64) -> u64 {
        let k = self.locate(at.min(self.len()));
        if k == self.pieces.len() {
            return self.lines() - 1;
        }
        let p = self.pieces[k];
        self.lines_before[k] + breaks_in(self.ends(original, p.source), p.start, p.start + at - self.starts[k])
    }

    /// All line starts of the document: the index of the file it is saved to.
    pub fn line_starts(&self, original: &[u64]) -> Vec<u64> {
        let mut index = Vec::with_capacity(self.lines() as usize);
        index.push(0);
        for (k, p) in self.pieces.iter().enumerate() {
            let ends = self.ends(original, p.source);
            let (i, j) = (ends.partition_point(|&o| o <= p.start), ends.partition_point(|&o| o <= p.end()));
            index.extend(ends[i..j].iter().map(|&e| self.starts[k] + e - p.start));
        }
        index
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Line starts (after each \n) of a byte string, with the leading 0 like the viewer's index.
    fn index_of(bytes: &[u8]) -> Vec<u64> {
        let mut index = vec![0];
        index.extend(bytes.iter().enumerate().filter(|(_, &b)| b == b'\n').map(|(i, _)| i as u64 + 1));
        index
    }

    fn breaks_of(bytes: &[u8]) -> Vec<u64> {
        index_of(bytes)[1..].to_vec()
    }

    fn change(from: u64, to: u64, text: &str) -> Replace {
        Replace { from, to, bytes: text.as_bytes().to_vec(), breaks: breaks_of(text.as_bytes()) }
    }

    fn content(table: &PieceTable, original: &[u8]) -> Vec<u8> {
        table.read(0, u64::MAX, |at, buf| {
            let at = at as usize;
            let n = buf.len().min(original.len().saturating_sub(at));
            buf[..n].copy_from_slice(&original[at..at + n]);
            n
        })
    }

    /// Checks every line lookup of the table against the plain text.
    fn check_lines(table: &PieceTable, index: &[u64], text: &[u8]) {
        let expected = index_of(text);
        assert_eq!(table.lines(), expected.len() as u64);
        assert_eq!(table.line_starts(index), expected);
        for (n, &start) in expected.iter().enumerate() {
            assert_eq!(table.line_start(index, n as u64), Some(start), "line {n}");
        }
        assert_eq!(table.line_start(index, expected.len() as u64), None);
        for at in 0..=text.len() as u64 {
            let line = expected.partition_point(|&s| s <= at) - 1;
            assert_eq!(table.line_of(index, at), line as u64, "offset {at}");
        }
    }

    #[test]
    fn edits_lines_and_undo() {
        let original = b"one\ntwo\nthree\n".to_vec();
        let index = index_of(&original);
        let mut table = PieceTable::new(&index, original.len() as u64);
        let t = Instant::now();
        assert!(!table.is_modified());
        assert_eq!(table.lines(), 4);

        // Insert a line in the middle, delete across a break, replace at both ends.
        assert!(table.edit(&index, vec![change(4, 4, "new\n")], EditKind::Other, t));
        assert_eq!(content(&table, &original), b"one\nnew\ntwo\nthree\n");
        check_lines(&table, &index, b"one\nnew\ntwo\nthree\n");
        assert!(table.edit(&index, vec![change(2, 5, "")], EditKind::Other, t));
        assert_eq!(content(&table, &original), b"onew\ntwo\nthree\n");
        check_lines(&table, &index, b"onew\ntwo\nthree\n");
        assert!(table.edit(&index, vec![change(0, 0, "<"), change(15, 15, ">")], EditKind::Other, t));
        assert_eq!(content(&table, &original), b"<onew\ntwo\nthree\n>");
        check_lines(&table, &index, b"<onew\ntwo\nthree\n>");
        assert!(table.is_modified());

        // The batch is one step; undoing everything gives back the plain original.
        assert_eq!(table.undo(&index), Some((0, 0)));
        assert_eq!(content(&table, &original), b"onew\ntwo\nthree\n");
        table.undo(&index);
        table.undo(&index);
        assert_eq!(content(&table, &original), original);
        assert!(!table.is_modified());
        assert_eq!(table.pieces().len(), 1);
        assert!(table.undo(&index).is_none());

        table.redo(&index);
        table.redo(&index);
        assert_eq!(content(&table, &original), b"onew\ntwo\nthree\n");
        // A new edit drops what could be redone.
        assert!(table.edit(&index, vec![change(0, 4, "ONE")], EditKind::Other, t));
        assert!(!table.can_redo());
        assert_eq!(content(&table, &original), b"ONE\ntwo\nthree\n");
        check_lines(&table, &index, b"ONE\ntwo\nthree\n");
    }

    #[test]
    fn typing_and_deleting_are_grouped() {
        let original = b"hello world".to_vec();
        let index = index_of(&original);
        let mut table = PieceTable::new(&index, original.len() as u64);
        let t = Instant::now();
        for (i, c) in "abc".chars().enumerate() {
            table.edit(&index, vec![change(5 + i as u64, 5 + i as u64, &c.to_string())], EditKind::Type, t);
        }
        // Three keystrokes, one piece of added text, one undo step.
        assert_eq!(content(&table, &original), b"helloabc world");
        assert_eq!(table.pieces().len(), 3);
        // Backspace twice, then delete forward twice: two more steps.
        table.edit(&index, vec![change(7, 8, "")], EditKind::DeleteBackward, t);
        table.edit(&index, vec![change(6, 7, "")], EditKind::DeleteBackward, t);
        table.edit(&index, vec![change(6, 7, "")], EditKind::DeleteForward, t);
        table.edit(&index, vec![change(6, 7, "")], EditKind::DeleteForward, t);
        assert_eq!(content(&table, &original), b"helloaorld");
        table.undo(&index);
        assert_eq!(content(&table, &original), b"helloa world");
        assert_eq!(table.undo(&index), Some((6, 8)));
        assert_eq!(content(&table, &original), b"helloabc world");
        table.undo(&index);
        assert_eq!(content(&table, &original), original);

        // A pause, or typing somewhere else, starts a new step.
        table.edit(&index, vec![change(0, 0, "x")], EditKind::Type, t);
        table.edit(&index, vec![change(1, 1, "y")], EditKind::Type, t + Duration::from_secs(2));
        table.edit(&index, vec![change(0, 0, "z")], EditKind::Type, t + Duration::from_secs(2));
        table.undo(&index);
        assert_eq!(content(&table, &original), b"xyhello world");
        table.undo(&index);
        assert_eq!(content(&table, &original), b"xhello world");
        // Typing after an undo does not join the undone step's neighbour.
        table.edit(&index, vec![change(1, 1, "q")], EditKind::Type, t + Duration::from_secs(2));
        table.undo(&index);
        assert_eq!(content(&table, &original), b"xhello world");
    }

    #[test]
    fn invalid_batches_change_nothing() {
        let original = b"abcdef".to_vec();
        let index = index_of(&original);
        let mut table = PieceTable::new(&index, 6);
        let t = Instant::now();
        assert!(!table.edit(&index, vec![change(2, 9, "")], EditKind::Other, t));
        assert!(!table.edit(&index, vec![change(1, 3, "x"), change(2, 4, "y")], EditKind::Other, t));
        assert_eq!(content(&table, &original), original);
        assert!(!table.can_undo());
        // Deleting everything leaves one empty line; the original is still restorable.
        assert!(table.edit(&index, vec![change(0, 6, "")], EditKind::Other, t));
        assert_eq!(table.len(), 0);
        assert_eq!(table.lines(), 1);
        assert_eq!(table.line_of(&index, 0), 0);
        table.undo(&index);
        assert!(!table.is_modified());
    }

    #[test]
    fn random_edits_match_a_plain_buffer() {
        // A small deterministic generator, so failures are reproducible.
        let mut seed = 0x2545F4914F6CDD1Du64;
        let mut next = |n: u64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed % n.max(1)
        };
        let original: Vec<u8> = (0..2000).map(|i| if i % 37 == 36 { b'\n' } else { b'a' + (i % 26) as u8 }).collect();
        let index = index_of(&original);
        let mut table = PieceTable::new(&index, original.len() as u64);
        let mut history = vec![original.clone()];
        let mut future: Vec<Vec<u8>> = Vec::new();
        let t = Instant::now();
        for round in 0..1500 {
            let mut text = history.last().unwrap().clone();
            match next(10) {
                0 if table.can_undo() => {
                    table.undo(&index);
                    future.push(history.pop().unwrap());
                }
                1 if table.can_redo() => {
                    table.redo(&index);
                    history.push(future.pop().unwrap());
                }
                _ => {
                    let from = next(text.len() as u64 + 1);
                    let to = (from + next(30)).min(text.len() as u64);
                    let insert: String = (0..next(12)).map(|_| if next(5) == 0 { '\n' } else { 'X' }).collect();
                    if from == to && insert.is_empty() {
                        // Nothing to do, and no undo step for it.
                        continue;
                    }
                    text.splice(from as usize..to as usize, insert.bytes());
                    // Other: every edit is its own step, so the model's history matches.
                    assert!(table.edit(&index, vec![change(from, to, &insert)], EditKind::Other, t));
                    history.push(text);
                    future.clear();
                }
            }
            let expected = history.last().unwrap();
            assert_eq!(&content(&table, &original), expected, "round {round}");
            if round % 50 == 0 {
                check_lines(&table, &index, expected);
            }
            if expected != &original {
                assert!(table.is_modified());
            }
            if history.len() == 1 {
                assert!(!table.is_modified());
            }
        }
    }

    #[test]
    fn huge_offsets() {
        // A 6 GB original that only exists as a function of the offset: a line break every MB.
        const STEP: u64 = 1 << 20;
        let len: u64 = 6 << 30;
        let byte = |at: u64| if at % STEP == STEP - 1 { b'\n' } else { b'a' + (at % 26) as u8 };
        let index: Vec<u64> = (0..=len / STEP).map(|i| i * STEP).collect();
        let read = |at: u64, buf: &mut [u8]| {
            for (i, b) in buf.iter_mut().enumerate() {
                *b = byte(at + i as u64);
            }
            buf.len()
        };
        let mut table = PieceTable::new(&index, len);
        let lines = table.lines();
        // The file ends with a break, so the last line is empty.
        assert_eq!(lines, len / STEP + 1);
        let t = Instant::now();
        let near_end = len - 50;
        let past_4g = (5u64 << 30) + 1;
        let batch = vec![change(near_end, near_end + 3, "END\n"), change(past_4g, past_4g, "MID")];
        assert!(table.edit(&index, batch, EditKind::Other, t));
        assert_eq!(table.len(), len + 4);
        assert_eq!(table.lines(), lines + 1);
        assert_eq!(table.read(past_4g, past_4g + 3, read), b"MID");
        // Everything after the first change moved by its three bytes.
        let at = near_end + 3;
        let expected: Vec<u8> = b"END\n".iter().copied().chain((near_end + 3..near_end + 6).map(byte)).collect();
        assert_eq!(table.read(at, at + 7, read), expected);
        let line = table.line_of(&index, at);
        assert_eq!(table.line_start(&index, line + 1), Some(at + 4));
        assert_eq!(table.line_of(&index, at + 4), line + 1);
        assert_eq!(table.line_start(&index, table.lines() - 1), Some(table.len()));
        assert_eq!(table.line_starts(&index).len() as u64, table.lines());
        table.undo(&index);
        assert!(!table.is_modified());
        assert_eq!(table.read(len - 3, len, read), [byte(len - 3), byte(len - 2), byte(len - 1)]);
    }
}
