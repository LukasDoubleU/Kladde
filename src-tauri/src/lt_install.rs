//! Download and installation of the local LanguageTool and its Java runtime, into the data folder:
//! `languagetool/<version>/` and `jre/<version>/`. Nothing is bundled with Kladde and nothing is fetched
//! unless the user asks for it; this is the only network access besides the update check and the
//! LanguageTool server the user configured.
//!
//! Both archives are pinned with their SHA-256. A download goes to a temporary file, is hashed on the way
//! in and checked before anything is extracted; a mismatch deletes the file. A version folder only counts as
//! installed once `.kladde-complete` was written into it as the very last step, so an interrupted or failed
//! install (even a killed Kladde) leaves nothing that looks complete, and the next install starts over. A
//! folder is not extracted elsewhere and renamed into place: right after extraction a virus scanner holds the
//! new files open, and Windows then refuses to rename the folder ("access denied"). Folders of other
//! versions are removed once the pinned version is installed.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// LanguageTool 6.8 needs Java 17 or later (its README); the JRE is an LTS release of Eclipse Temurin. The zip is the
/// standalone distribution from Maven Central, whose URLs are permanent (languagetool.org/download only holds the
/// current release and moves it away); its SHA-256 is published next to it as `.zip.sha256`.
pub const LT_VERSION: &str = "6.8";
const LT_URL: &str =
    "https://repo1.maven.org/maven2/org/languagetool/languagetool-standalone/6.8/languagetool-standalone-6.8.zip";
const LT_SHA256: &str = "f04aecf37e35ef17d44b336da9668a5a3a871edd14bd83a766a7e110b9ebcd21";
const LT_SIZE: u64 = 258_509_167;

pub const JRE_VERSION: &str = "21.0.13+9";
const JRE_URL: &str = "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jre_x64_windows_hotspot_21.0.13_9.zip";
const JRE_SHA256: &str = "2332c0b4cff6bed722da3567c91d5e47568bcba863fa4945d0a8d6fc76158628";
const JRE_SIZE: u64 = 49_106_397;

/// Replaces the pinned downloads, a JSON object `{"languagetool": {url, sha256, size?}, "java": {…}}`, e.g.
/// to serve small test archives. Honored only with an isolated profile (`KLADDE_DATA_DIR`), like the other
/// test overrides, so a stray variable can never redirect a real installation.
pub const DOWNLOADS_ENV: &str = "KLADDE_LT_DOWNLOADS";

const LT_ROOT: &str = "languagetool";
const JRE_ROOT: &str = "jre";
/// A version folder is complete when it holds this file.
const LT_MARKER: &str = "languagetool-server.jar";
const JRE_MARKER: &str = "bin/java.exe";
const PART_FILE: &str = ".download.part";
/// Written into a version folder when everything is extracted and checked.
const COMPLETE: &str = ".kladde-complete";

#[derive(Debug, Clone, Deserialize)]
pub struct Source {
    pub url: String,
    pub sha256: String,
    /// Bytes, for the progress; the server's `Content-Length` is not needed for it.
    #[serde(default)]
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Sources {
    pub languagetool: Source,
    pub java: Source,
}

pub fn pinned_sources() -> Sources {
    Sources {
        languagetool: Source { url: LT_URL.into(), sha256: LT_SHA256.into(), size: LT_SIZE },
        java: Source { url: JRE_URL.into(), sha256: JRE_SHA256.into(), size: JRE_SIZE },
    }
}

/// The pinned downloads, or the test override.
pub fn sources() -> Sources {
    if crate::session::isolated_profile().is_some() {
        if let Some(sources) = std::env::var(DOWNLOADS_ENV).ok().and_then(|v| serde_json::from_str(&v).ok()) {
            return sources;
        }
    }
    pinned_sources()
}

pub fn lt_dir(data: &Path) -> PathBuf {
    data.join(LT_ROOT).join(LT_VERSION)
}

pub fn jre_dir(data: &Path) -> PathBuf {
    data.join(JRE_ROOT).join(JRE_VERSION)
}

pub fn java_exe(data: &Path) -> PathBuf {
    jre_dir(data).join(JRE_MARKER)
}

/// A version folder that was extracted completely.
fn is_complete(dir: &Path, marker: &str) -> bool {
    dir.join(COMPLETE).is_file() && dir.join(marker).is_file()
}

/// Both parts of the pinned version are in place.
pub fn is_installed(data: &Path) -> bool {
    is_complete(&lt_dir(data), LT_MARKER) && is_complete(&jre_dir(data), JRE_MARKER)
}

/// Deletes a folder, trying again for a while: a virus scanner may still hold files that were just written.
fn remove_dir(dir: &Path) -> io::Result<()> {
    let mut attempt = 0;
    loop {
        match fs::remove_dir_all(dir) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) if attempt >= 20 => return Err(e),
            Err(_) => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(250));
            }
            Ok(()) => return Ok(()),
        }
    }
}

/// Bytes on disk of everything below `languagetool/` and `jre/` (every version, leftovers included).
pub fn size_on_disk(data: &Path) -> u64 {
    fn walk(dir: &Path) -> u64 {
        let Ok(entries) = fs::read_dir(dir) else { return 0 };
        entries
            .flatten()
            .map(|e| match e.metadata() {
                Ok(m) if m.is_dir() => walk(&e.path()),
                Ok(m) => m.len(),
                Err(_) => 0,
            })
            .sum()
    }
    walk(&data.join(LT_ROOT)) + walk(&data.join(JRE_ROOT))
}

/// Deletes the local LanguageTool, every version. The caller stops the server first.
pub fn remove(data: &Path) -> Result<(), String> {
    for root in [LT_ROOT, JRE_ROOT] {
        let dir = data.join(root);
        remove_dir(&dir).map_err(|e| format!("Could not delete {}: {e}", dir.display()))?;
    }
    Ok(())
}

// ------------------------------------------------------------------ errors and progress

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallError {
    /// `cancelled`, `network`, `hash`, `disk` or `other`.
    pub kind: &'static str,
    pub message: String,
}

impl InstallError {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        InstallError { kind, message: message.into() }
    }

    pub fn other(message: impl Into<String>) -> Self {
        Self::new("other", message)
    }

    fn cancelled() -> Self {
        Self::new("cancelled", "Cancelled.")
    }
}

impl From<io::Error> for InstallError {
    fn from(e: io::Error) -> Self {
        if e.kind() == io::ErrorKind::StorageFull {
            Self::new("disk", "There is not enough free disk space. Free some space and try again.")
        } else {
            Self::new("other", e.to_string())
        }
    }
}

impl From<zip::result::ZipError> for InstallError {
    fn from(e: zip::result::ZipError) -> Self {
        match e {
            zip::result::ZipError::Io(e) => e.into(),
            e => Self::new("other", format!("The archive is damaged: {e}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum Progress {
    /// Bytes of both downloads together.
    Downloading { downloaded: u64, total: u64 },
    /// Bytes of the unpacked files of the archive being extracted.
    Extracting { done: u64, total: u64 },
}

// ------------------------------------------------------------------ download

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_recv_response(Some(Duration::from_secs(30)))
        .timeout_recv_body(Some(Duration::from_secs(30 * 60)))
        .http_status_as_error(false)
        .user_agent(concat!("Kladde/", env!("CARGO_PKG_VERSION")))
        .tls_config(crate::languagetool::tls_config())
        .build()
        .into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Checks the hash of a downloaded file; a mismatch deletes the file.
fn check_hash(actual: &str, expected: &str, file: &Path) -> Result<(), InstallError> {
    if actual.eq_ignore_ascii_case(expected.trim()) {
        return Ok(());
    }
    let _ = fs::remove_file(file);
    Err(InstallError::new(
        "hash",
        "The download does not match its published checksum and was deleted. Nothing was installed.",
    ))
}

/// Copies `reader` to `writer` in chunks, hashing on the way. Stops when `cancel` is set; `on_bytes` gets
/// the size of every chunk.
fn copy_hashed(
    reader: &mut dyn Read,
    writer: &mut dyn Write,
    cancel: &AtomicBool,
    on_bytes: &mut dyn FnMut(u64),
) -> Result<String, InstallError> {
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(InstallError::cancelled());
        }
        let n = reader.read(&mut buf).map_err(|e| InstallError::new("network", format!("The download was interrupted: {e}")))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        writer.write_all(&buf[..n])?;
        on_bytes(n as u64);
    }
    writer.flush()?;
    Ok(hex(&hasher.finalize()))
}

/// Downloads `source` to `dest` and verifies its hash. `dest` does not exist afterwards unless everything
/// went well.
fn download(
    source: &Source,
    dest: &Path,
    cancel: &AtomicBool,
    on_bytes: &mut dyn FnMut(u64),
) -> Result<(), InstallError> {
    let result = (|| {
        let mut response = agent()
            .get(&source.url)
            .call()
            .map_err(|e| InstallError::new("network", format!("Could not reach {}: {e}", host_of(&source.url))))?;
        let status = response.status().as_u16();
        if status != 200 {
            return Err(InstallError::new("network", format!("{} answered with status {status}.", host_of(&source.url))));
        }
        let mut file = fs::File::create(dest)?;
        let actual = copy_hashed(&mut response.body_mut().as_reader(), &mut file, cancel, on_bytes)?;
        file.sync_all()?;
        drop(file);
        check_hash(&actual, &source.sha256, dest)
    })();
    if result.is_err() {
        let _ = fs::remove_file(dest);
    }
    result
}

fn host_of(url: &str) -> &str {
    url.split("://").nth(1).and_then(|rest| rest.split('/').next()).unwrap_or(url)
}

// ------------------------------------------------------------------ extraction

/// Unpacks `archive` into `dest`, dropping the archive's top-level folder (`LanguageTool-6.8/`,
/// `jdk-…-jre/`). Entries that would leave `dest` are skipped.
fn extract(
    archive: &Path,
    dest: &Path,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(Progress),
) -> Result<(), InstallError> {
    let mut zip = zip::ZipArchive::new(io::BufReader::new(fs::File::open(archive)?))?;
    let mut total = 0u64;
    for i in 0..zip.len() {
        total += zip.by_index_raw(i)?.size();
    }
    fs::create_dir_all(dest)?;
    let mut done = 0u64;
    let mut buf = vec![0u8; 64 * 1024];
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        let Some(name) = entry.enclosed_name() else { continue };
        let relative: PathBuf = name.components().skip(1).filter(|c| matches!(c, Component::Normal(_))).collect();
        if relative.as_os_str().is_empty() {
            continue;
        }
        let target = dest.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = fs::File::create(&target)?;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(InstallError::cancelled());
            }
            let n = entry.read(&mut buf)?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n])?;
            done += n as u64;
            on_progress(Progress::Extracting { done, total });
        }
    }
    on_progress(Progress::Extracting { done: total, total });
    Ok(())
}

// ------------------------------------------------------------------ installing

/// The state of the install command: one install at a time, and a flag the page sets to cancel it.
#[derive(Default)]
pub struct Installer {
    busy: AtomicBool,
    cancel: AtomicBool,
}

impl Installer {
    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::Relaxed)
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    /// Runs `install`, unless another one runs.
    pub fn run(&self, data: &Path, sources: &Sources, report: &mut dyn FnMut(Progress)) -> Result<(), InstallError> {
        if self.busy.swap(true, Ordering::SeqCst) {
            return Err(InstallError::other("LanguageTool is already being downloaded."));
        }
        self.cancel.store(false, Ordering::Relaxed);
        let result = install(data, sources, &self.cancel, report);
        self.busy.store(false, Ordering::SeqCst);
        result
    }
}

/// Removes everything below `root` except the folder named `keep`: other versions, and the temporary
/// download of an install that was interrupted. Only call it while no install runs.
fn prune(root: &Path, keep: Option<&str>) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        if keep.is_some_and(|k| entry.file_name() == k) {
            continue;
        }
        let path = entry.path();
        let _ = if path.is_dir() { remove_dir(&path) } else { fs::remove_file(&path) };
    }
}

/// One of the two archives and where it goes.
struct Part<'a> {
    root: &'a Path,
    version: &'a str,
    /// A file the extracted folder must contain.
    marker: &'a str,
    source: &'a Source,
}

/// Installs one archive as `root/<version>`: download, verify, extract, and finally mark the folder complete.
/// `downloaded` counts the bytes of all downloads of this install, `total` is what they add up to.
fn install_part(
    part: &Part,
    cancel: &AtomicBool,
    report: &mut dyn FnMut(Progress),
    downloaded: &mut u64,
    total: u64,
) -> Result<(), InstallError> {
    let Part { root, version, marker, source } = *part;
    let part = root.join(PART_FILE);
    let target = root.join(version);
    let result = (|| {
        fs::create_dir_all(root)?;
        // A folder of this version that is not complete is what an install that did not finish left behind.
        remove_dir(&target)?;
        download(source, &part, cancel, &mut |n| {
            *downloaded += n;
            report(Progress::Downloading { downloaded: (*downloaded).min(total), total });
        })?;
        extract(&part, &target, cancel, report)?;
        if !target.join(marker).is_file() {
            return Err(InstallError::new("other", format!("The archive does not contain {marker}.")));
        }
        let mut done = fs::File::create(target.join(COMPLETE))?;
        done.write_all(version.as_bytes())?;
        done.sync_all()?;
        Ok(())
    })();
    let _ = fs::remove_file(&part);
    if result.is_err() {
        let _ = remove_dir(&target);
    }
    result
}

/// Installs what is missing of the pinned version, then removes the other versions. Blocking; `report` is
/// called often, so the caller throttles it.
pub fn install(
    data: &Path,
    sources: &Sources,
    cancel: &AtomicBool,
    report: &mut dyn FnMut(Progress),
) -> Result<(), InstallError> {
    let lt_root = data.join(LT_ROOT);
    let jre_root = data.join(JRE_ROOT);
    // Leftovers of an earlier attempt must not count towards, or block, this one.
    for root in [&lt_root, &jre_root] {
        let _ = fs::remove_file(root.join(PART_FILE));
    }
    let need_jre = !is_complete(&jre_dir(data), JRE_MARKER);
    let need_lt = !is_complete(&lt_dir(data), LT_MARKER);
    let total = if need_jre { sources.java.size } else { 0 } + if need_lt { sources.languagetool.size } else { 0 };
    let mut downloaded = 0u64;
    if need_jre {
        let part = Part { root: &jre_root, version: JRE_VERSION, marker: JRE_MARKER, source: &sources.java };
        install_part(&part, cancel, report, &mut downloaded, total)?;
    }
    if need_lt {
        let part = Part { root: &lt_root, version: LT_VERSION, marker: LT_MARKER, source: &sources.languagetool };
        install_part(&part, cancel, report, &mut downloaded, total)?;
    }
    prune(&lt_root, Some(LT_VERSION));
    prune(&jre_root, Some(JRE_VERSION));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::net::TcpListener;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kladde-ltinstall-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sha(bytes: &[u8]) -> String {
        hex(&Sha256::digest(bytes))
    }

    /// A zip with one top-level folder, as the real archives have.
    fn zip_of(top: &str, files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        writer.add_directory(format!("{top}/"), options).unwrap();
        for (name, content) in files {
            writer.start_file(format!("{top}/{name}"), options).unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    /// Serves `body` to every request until the process ends; returns the URL.
    fn serve(body: Vec<u8>) -> String {
        let claimed = body.len();
        serve_claiming(body, claimed)
    }

    /// Like `serve`, but announces `claimed` bytes: fewer than sent is a connection that breaks off.
    fn serve_claiming(body: Vec<u8>, claimed: usize) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/archive.zip", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let body = body.clone();
                std::thread::spawn(move || {
                    let mut buf = [0u8; 2048];
                    let _ = stream.read(&mut buf);
                    let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {claimed}\r\nConnection: close\r\n\r\n");
                    let _ = stream.write_all(head.as_bytes());
                    let _ = stream.write_all(&body);
                });
            }
        });
        url
    }

    fn sources_for(lt: &[u8], jre: &[u8]) -> Sources {
        Sources {
            languagetool: Source { url: serve(lt.to_vec()), sha256: sha(lt), size: lt.len() as u64 },
            java: Source { url: serve(jre.to_vec()), sha256: sha(jre), size: jre.len() as u64 },
        }
    }

    fn archives() -> (Vec<u8>, Vec<u8>) {
        (
            zip_of("LanguageTool-6.8", &[("languagetool-server.jar", b"jar"), ("libs/a.jar", b"a")]),
            zip_of("jdk-21-jre", &[("bin/java.exe", b"exe")]),
        )
    }

    #[test]
    fn pinned_hashes_are_sha256_hex() {
        for hash in [LT_SHA256, JRE_SHA256] {
            assert_eq!(hash.len(), 64);
            assert!(hash.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "{hash}");
        }
        let pinned = pinned_sources();
        assert!(pinned.languagetool.url.starts_with("https://") && pinned.java.url.starts_with("https://"));
        assert!(pinned.languagetool.url.contains(LT_VERSION));
    }

    #[test]
    fn a_matching_hash_passes_and_a_mismatch_deletes_the_file() {
        let dir = temp("hash");
        let file = dir.join("download.part");
        fs::write(&file, b"payload").unwrap();
        let good = sha(b"payload");
        check_hash(&good, &good.to_uppercase(), &file).unwrap();
        assert!(file.exists());
        let error = check_hash(&good, &sha(b"something else"), &file).unwrap_err();
        assert_eq!(error.kind, "hash");
        assert!(!file.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn download_streams_to_a_file_and_checks_the_hash() {
        let dir = temp("download");
        let body = vec![7u8; 300_000];
        let url = serve(body.clone());
        let cancel = AtomicBool::new(false);
        let file = dir.join("ok.part");
        let mut seen = 0u64;
        download(&Source { url: url.clone(), sha256: sha(&body), size: 0 }, &file, &cancel, &mut |n| seen += n).unwrap();
        assert_eq!((seen, fs::read(&file).unwrap()), (300_000, body));

        let bad = dir.join("bad.part");
        let error = download(&Source { url, sha256: sha(b"other"), size: 0 }, &bad, &cancel, &mut |_| {}).unwrap_err();
        assert_eq!(error.kind, "hash");
        assert!(!bad.exists(), "a download that fails the check is deleted");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn download_reports_unreachable_servers_and_cancelling() {
        let dir = temp("network");
        let closed = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}/x.zip", listener.local_addr().unwrap())
        };
        let cancel = AtomicBool::new(false);
        let file = dir.join("x.part");
        let source = Source { url: closed, sha256: sha(b""), size: 0 };
        assert_eq!(download(&source, &file, &cancel, &mut |_| {}).unwrap_err().kind, "network");
        assert!(!file.exists());

        // The connection breaks off before the announced size.
        let source = Source { url: serve_claiming(vec![1; 1000], 100_000), sha256: sha(b""), size: 0 };
        let error = download(&source, &file, &cancel, &mut |_| {}).unwrap_err();
        assert_eq!(error.kind, "network", "{}", error.message);
        assert!(!file.exists());

        let source = Source { url: serve(vec![1; 100_000]), sha256: sha(b""), size: 0 };
        cancel.store(true, Ordering::Relaxed);
        assert_eq!(download(&source, &file, &cancel, &mut |_| {}).unwrap_err().kind, "cancelled");
        assert!(!file.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_puts_both_parts_in_place_and_reports_progress() {
        let data = temp("install");
        let (lt, jre) = archives();
        let sources = sources_for(&lt, &jre);
        assert!(!is_installed(&data));
        let mut events = Vec::new();
        install(&data, &sources, &AtomicBool::new(false), &mut |p| events.push(p)).unwrap();
        assert!(is_installed(&data));
        assert_eq!(fs::read(lt_dir(&data).join("libs/a.jar")).unwrap(), b"a");
        assert!(size_on_disk(&data) > 0);
        // No temporary leftovers, and the download total counts both archives.
        for root in [LT_ROOT, JRE_ROOT] {
            let names: Vec<_> = fs::read_dir(data.join(root)).unwrap().flatten().map(|e| e.file_name()).collect();
            assert_eq!(names.len(), 1, "{names:?}");
        }
        let last_download = events.iter().rev().find_map(|p| match p {
            Progress::Downloading { downloaded, total } => Some((*downloaded, *total)),
            _ => None,
        });
        let total = (lt.len() + jre.len()) as u64;
        assert_eq!(last_download, Some((total, total)));
        assert!(events.iter().any(|p| matches!(p, Progress::Extracting { .. })));
        // A second run has nothing to do.
        let dead = Sources {
            languagetool: Source { url: "http://127.0.0.1:1/".into(), sha256: String::new(), size: 0 },
            java: Source { url: "http://127.0.0.1:1/".into(), sha256: String::new(), size: 0 },
        };
        install(&data, &dead, &AtomicBool::new(false), &mut |_| {}).unwrap();

        remove(&data).unwrap();
        assert!(!is_installed(&data));
        assert_eq!(size_on_disk(&data), 0);
        remove(&data).unwrap();
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn an_interrupted_install_leaves_nothing_that_looks_installed() {
        let data = temp("interrupted");
        let (lt, jre) = archives();

        // A truncated archive with the right hash for what was served: extraction fails half way.
        let cut = lt[..lt.len() / 2].to_vec();
        let sources = Sources {
            languagetool: Source { url: serve(cut.clone()), sha256: sha(&cut), size: cut.len() as u64 },
            java: Source { url: serve(jre.clone()), sha256: sha(&jre), size: jre.len() as u64 },
        };
        let error = install(&data, &sources, &AtomicBool::new(false), &mut |_| {}).unwrap_err();
        assert_eq!(error.kind, "other", "{}", error.message);
        assert!(!is_installed(&data));
        assert!(!lt_dir(&data).exists());
        // Only the part that completed (the runtime) is there; no temporary download or folder is left.
        assert!(java_exe(&data).is_file());
        let names: Vec<_> = fs::read_dir(data.join(LT_ROOT)).unwrap().flatten().collect();
        assert!(names.is_empty(), "{names:?}");

        // Cancelled while downloading, and a wrong hash: same.
        let cancel = AtomicBool::new(true);
        let fresh = sources_for(&lt, &jre);
        assert_eq!(install(&data, &fresh, &cancel, &mut |_| {}).unwrap_err().kind, "cancelled");
        assert!(!is_installed(&data));
        let mut wrong = sources_for(&lt, &jre);
        wrong.languagetool.sha256 = sha(b"not the archive");
        assert_eq!(install(&data, &wrong, &AtomicBool::new(false), &mut |_| {}).unwrap_err().kind, "hash");
        assert!(!is_installed(&data));
        assert!(fs::read_dir(data.join(LT_ROOT)).unwrap().next().is_none());

        // The next attempt works.
        install(&data, &fresh, &AtomicBool::new(false), &mut |_| {}).unwrap();
        assert!(is_installed(&data));
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn a_folder_without_the_complete_marker_is_not_an_install() {
        let data = temp("killed");
        let (lt, jre) = archives();
        // What a Kladde killed in the middle of extracting leaves: files, but no marker.
        fs::create_dir_all(lt_dir(&data)).unwrap();
        fs::write(lt_dir(&data).join(LT_MARKER), "half").unwrap();
        fs::create_dir_all(java_exe(&data).parent().unwrap()).unwrap();
        fs::write(java_exe(&data), "half").unwrap();
        assert!(!is_installed(&data));
        install(&data, &sources_for(&lt, &jre), &AtomicBool::new(false), &mut |_| {}).unwrap();
        assert!(is_installed(&data));
        // The leftovers were replaced, not extended.
        assert_eq!(fs::read(lt_dir(&data).join(LT_MARKER)).unwrap(), b"jar");
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn an_archive_without_the_expected_file_is_not_installed() {
        let data = temp("marker");
        let (_, jre) = archives();
        let lt = zip_of("LanguageTool-6.8", &[("readme.txt", b"no server in here")]);
        let sources = sources_for(&lt, &jre);
        let error = install(&data, &sources, &AtomicBool::new(false), &mut |_| {}).unwrap_err();
        assert!(error.message.contains(LT_MARKER), "{}", error.message);
        assert!(!lt_dir(&data).exists());
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn extraction_drops_the_top_folder_and_stays_inside_the_target() {
        let dir = temp("extract");
        let archive = dir.join("a.zip");
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file("top/inside.txt", options).unwrap();
        writer.write_all(b"in").unwrap();
        writer.start_file("top/../../escape.txt", options).unwrap();
        writer.write_all(b"out").unwrap();
        fs::write(&archive, writer.finish().unwrap().into_inner()).unwrap();
        let dest = dir.join("out");
        extract(&archive, &dest, &AtomicBool::new(false), &mut |_| {}).unwrap();
        assert_eq!(fs::read(dest.join("inside.txt")).unwrap(), b"in");
        assert!(!dir.join("escape.txt").exists() && !dir.parent().unwrap().join("escape.txt").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn newer_versions_replace_older_ones() {
        let data = temp("versions");
        let (lt, jre) = archives();
        // What an earlier Kladde left behind, complete or not, and a temporary leftover.
        for old in ["languagetool/6.5", "languagetool/6.4", "jre/17.0.1+1", "languagetool/.extract"] {
            fs::create_dir_all(data.join(old)).unwrap();
            fs::write(data.join(old).join(LT_MARKER), "old").unwrap();
            fs::write(data.join(old).join(COMPLETE), "old").unwrap();
        }
        fs::write(data.join("languagetool/.download.part"), "half").unwrap();
        install(&data, &sources_for(&lt, &jre), &AtomicBool::new(false), &mut |_| {}).unwrap();
        let names = |root: &str| -> Vec<String> {
            let mut v: Vec<_> = fs::read_dir(data.join(root)).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
            v.sort();
            v
        };
        assert_eq!(names(LT_ROOT), [LT_VERSION]);
        assert_eq!(names(JRE_ROOT), [JRE_VERSION]);
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn prune_keeps_only_the_named_folder() {
        let dir = temp("prune");
        for name in ["a", "b", ".extract"] {
            fs::create_dir_all(dir.join(name)).unwrap();
        }
        fs::write(dir.join(".download.part"), "x").unwrap();
        prune(&dir, Some("b"));
        let left: Vec<_> = fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(left, ["b"]);
        prune(&dir.join("missing"), Some("b"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_full_disk_is_explained() {
        let error: InstallError = io::Error::from(io::ErrorKind::StorageFull).into();
        assert_eq!(error.kind, "disk");
        assert!(error.message.contains("disk space"));
        let error: InstallError = io::Error::other("boom").into();
        assert_eq!((error.kind, error.message.as_str()), ("other", "boom"));
    }

    #[test]
    fn the_override_is_ignored_without_an_isolated_profile() {
        // The pinned values are what a normal run uses, whatever the environment says.
        if crate::session::isolated_profile().is_none() {
            std::env::set_var(DOWNLOADS_ENV, r#"{"languagetool":{"url":"http://x","sha256":"0"},"java":{"url":"http://y","sha256":"0"}}"#);
            assert_eq!(sources().languagetool.url, LT_URL);
            std::env::remove_var(DOWNLOADS_ENV);
        }
    }
}

#[cfg(test)]
mod real_archive {
    use super::*;

    /// Not part of the suite: `KLADDE_TEST_ZIP=<zip> cargo test real_extract -- --ignored --nocapture` times the
    /// extraction of a real archive.
    #[test]
    #[ignore]
    fn real_extract() {
        let zip = std::env::var("KLADDE_TEST_ZIP").unwrap();
        let dest = std::env::temp_dir().join(format!("kladde-real-extract-{}", std::process::id()));
        let start = std::time::Instant::now();
        extract(Path::new(&zip), &dest, &AtomicBool::new(false), &mut |_| {}).unwrap();
        eprintln!("extracted in {:.1}s", start.elapsed().as_secs_f32());
        let _ = fs::remove_dir_all(&dest);
    }
}
