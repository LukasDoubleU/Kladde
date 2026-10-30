//! The local LanguageTool server, started and stopped by Kladde.
//!
//! It is started lazily by the first check request that is routed to it (an empty `languageToolServer`
//! and an installed LanguageTool), listens on a free port of the loopback interface only, is stopped after
//! 15 minutes without a request or when grammar checking is turned off, and starts again on demand. The
//! child lives in a Windows job object that kills it when the handle closes, i.e. when Kladde exits, is
//! killed or crashes, so no Java process is left behind.

use crate::languagetool::{self, CheckError};
use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// Stop after this long without a check request.
const IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Heap limit of the Java process, in MB (measured, see docs/architecture.md).
const HEAP_MB: u32 = 768;
/// How long a start may take until the server answers. A cold start with a virus scanner looking at
/// 400 MB of jars takes tens of seconds.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(120);
const POLL: Duration = Duration::from_millis(150);
const MONITOR_TICK: Duration = Duration::from_secs(1);
const SERVER_CLASS: &str = "org.languagetool.server.HTTPServer";
const SERVER_JAR: &str = "languagetool-server.jar";

/// Replaces the Java command with another program, a JSON array `[program, args…]`; Kladde appends
/// `--port <n>`. Tests use it for a stand-in server. Honored only with an isolated profile.
pub const COMMAND_ENV: &str = "KLADDE_LT_COMMAND";

/// Makes the idle stop fire after this many seconds instead of 15 minutes. Honored only with an isolated
/// profile.
pub const IDLE_ENV: &str = "KLADDE_LT_IDLE_SECS";

/// Where a check request goes: the server the user configured always wins; otherwise the local LanguageTool,
/// if it is installed.
#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    Configured,
    Local,
    NotInstalled,
}

pub fn route(server: &str, installed: bool) -> Route {
    if !server.trim().is_empty() {
        Route::Configured
    } else if installed {
        Route::Local
    } else {
        Route::NotInstalled
    }
}

pub fn idle_timeout() -> Duration {
    if crate::session::isolated_profile().is_some() {
        if let Some(secs) = std::env::var(IDLE_ENV).ok().and_then(|v| v.trim().parse::<u64>().ok()).filter(|&s| s > 0) {
            return Duration::from_secs(secs);
        }
    }
    IDLE_TIMEOUT
}

fn idle_expired(last_used: Instant, now: Instant, timeout: Duration) -> bool {
    now.saturating_duration_since(last_used) >= timeout
}

fn command_override() -> Option<Vec<String>> {
    crate::session::isolated_profile()?;
    let list: Vec<String> = serde_json::from_str(&std::env::var(COMMAND_ENV).ok()?).ok()?;
    (!list.is_empty()).then_some(list)
}

/// The arguments of the real server process, after `java`.
fn java_args(port: u16) -> Vec<String> {
    vec![
        format!("-Xmx{HEAP_MB}m"),
        "-cp".into(),
        SERVER_JAR.into(),
        SERVER_CLASS.into(),
        "--port".into(),
        port.to_string(),
    ]
}

/// The command that starts the server on `port`: the bundled Java (or the test override).
fn launch_command(data: &Path, port: u16) -> Command {
    let mut command = match command_override() {
        Some(list) => {
            let mut c = Command::new(&list[0]);
            c.args(&list[1..]).args(["--port", &port.to_string()]);
            c
        }
        None => {
            let mut c = Command::new(crate::lt_install::java_exe(data));
            c.args(java_args(port));
            c
        }
    };
    command.current_dir(crate::lt_install::lt_dir(data));
    command
}

/// A port that is free right now. Another program can still take it before the server binds it, which
/// the start notices (the server exits with a bind error) and answers with a new port.
fn free_port() -> std::io::Result<u16> {
    Ok(std::net::TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

fn is_bind_error(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("address already in use") || lower.contains("bindexception") || lower.contains("only one usage of each socket")
}

// ------------------------------------------------------------------ job object

#[cfg(windows)]
mod job {
    use std::ffi::c_void;
    use std::io;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// A job object that terminates every process in it when the last handle to it closes: Kladde's
    /// handle closes when the process ends, however it ends.
    pub struct Job(HANDLE);

    // The handle is only used from behind the mutex that owns the job.
    unsafe impl Send for Job {}

    impl Job {
        pub fn new() -> io::Result<Job> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    let error = io::Error::last_os_error();
                    CloseHandle(handle);
                    return Err(error);
                }
                Ok(Job(handle))
            }
        }

        pub fn assign(&self, child: &Child) -> io::Result<()> {
            if unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }
}

#[cfg(not(windows))]
mod job {
    pub struct Job;
    impl Job {
        pub fn new() -> std::io::Result<Job> {
            Ok(Job)
        }
        pub fn assign(&self, _: &std::process::Child) -> std::io::Result<()> {
            Ok(())
        }
    }
}

use job::Job;

// ------------------------------------------------------------------ the process

/// The last output of the server, for the error message when it does not come up or dies.
type Tail = Arc<Mutex<String>>;

const TAIL_CHARS: usize = 3000;

fn collect(mut source: impl Read + Send + 'static, tail: Tail) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 1024];
        while let Ok(n) = source.read(&mut buf) {
            if n == 0 {
                break;
            }
            let mut text = tail.lock().unwrap_or_else(|e| e.into_inner());
            text.push_str(&String::from_utf8_lossy(&buf[..n]));
            let excess = text.chars().count().saturating_sub(TAIL_CHARS);
            if excess > 0 {
                *text = text.chars().skip(excess).collect();
            }
        }
    });
}

/// Starts the process without a console window, inside a new job object that kills it with Kladde.
fn spawn(mut command: Command) -> std::io::Result<(Child, Job, Tail)> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let job = Job::new()?;
    let mut child = command.spawn()?;
    if let Err(e) = job.assign(&child) {
        // Without the job the process could outlive Kladde: better no server than a stray one.
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
    }
    let tail = Tail::default();
    if let Some(out) = child.stdout.take() {
        collect(out, tail.clone());
    }
    if let Some(err) = child.stderr.take() {
        collect(err, tail.clone());
    }
    Ok((child, job, tail))
}

struct Running {
    id: u64,
    child: Child,
    /// Dropped after the child is gone; closing it kills whatever is left in it.
    _job: Job,
    port: u16,
    /// The server answers requests; false while it starts.
    ready: bool,
    last_used: Instant,
    tail: Tail,
}

impl Running {
    fn kill(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    fn exit_message(&self, status: std::process::ExitStatus) -> String {
        let tail = self.tail.lock().unwrap_or_else(|e| e.into_inner());
        let last = last_lines(&tail, 3);
        let code = status.code().map(|c| format!(" (exit code {c})")).unwrap_or_default();
        if last.is_empty() { format!("exited{code}") } else { format!("exited{code}: {last}") }
    }
}

fn last_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let from = lines.len().saturating_sub(n);
    let joined = lines[from..].join(" | ");
    let cut = joined.chars().count().saturating_sub(400);
    joined.chars().skip(cut).collect()
}

/// If the process has exited by itself, removes it and says how it ended.
fn reap(state: &mut Option<Running>) -> Option<String> {
    let r = state.as_mut()?;
    let status = match r.child.try_wait() {
        Ok(None) => return None,
        Ok(Some(status)) => Some(status),
        Err(_) => None,
    };
    let message = status.map(|s| r.exit_message(s)).unwrap_or_else(|| "exited".into());
    *state = None;
    Some(message)
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// What a failed request finds out about the server.
#[derive(Debug, PartialEq, Eq)]
pub enum Fate {
    /// Still running: the request failed for its own reasons.
    Alive,
    /// Stopped on purpose (grammar checking turned off, removed, idle).
    Stopped,
    /// Died on its own; the message says how.
    Crashed(String),
}

struct Shared {
    state: Mutex<Option<Running>>,
    /// Held during a start, so concurrent requests wait for it instead of starting a second server.
    starting: Mutex<()>,
    /// Why the last server died by itself; read by the request that notices.
    crash: Mutex<Option<String>>,
    next_id: AtomicU64,
    /// Told about `starting`, `running` and `stopped` (the page shows it).
    notify: Box<dyn Fn(&'static str) + Send + Sync>,
}

/// The managed server: at most one process, started on demand.
#[derive(Clone)]
pub struct Managed(Arc<Shared>);

impl Managed {
    pub fn new(notify: impl Fn(&'static str) + Send + Sync + 'static) -> Self {
        Managed(Arc::new(Shared {
            state: Mutex::new(None),
            starting: Mutex::new(()),
            crash: Mutex::new(None),
            next_id: AtomicU64::new(1),
            notify: Box::new(notify),
        }))
    }

    /// The server is up and answering.
    pub fn is_running(&self) -> bool {
        locked(&self.0.state).as_ref().is_some_and(|r| r.ready)
    }

    /// Records a request, so the idle timer starts again.
    pub fn touch(&self) {
        if let Some(r) = locked(&self.0.state).as_mut() {
            r.last_used = Instant::now();
        }
    }

    /// Stops the server if it runs; the next request starts it again.
    pub fn stop(&self) {
        let running = locked(&self.0.state).take();
        if let Some(r) = running {
            r.kill();
            (self.0.notify)("stopped");
        }
    }

    /// The port of the running server, after noticing that a dead one is gone.
    fn alive_port(&self) -> Option<u16> {
        let mut state = locked(&self.0.state);
        if let Some(message) = reap(&mut state) {
            drop(state);
            *locked(&self.0.crash) = Some(message);
            (self.0.notify)("stopped");
            return None;
        }
        let r = state.as_mut().filter(|r| r.ready)?;
        r.last_used = Instant::now();
        Some(r.port)
    }

    /// Starts the server unless it runs and returns its port. Blocks until the server answers.
    pub fn ensure_started(&self, data: &Path) -> Result<u16, CheckError> {
        self.ensure_started_with(&|port| launch_command(data, port), STARTUP_TIMEOUT, idle_timeout(), MONITOR_TICK)
    }

    fn ensure_started_with(
        &self,
        make: &dyn Fn(u16) -> Command,
        startup: Duration,
        idle: Duration,
        tick: Duration,
    ) -> Result<u16, CheckError> {
        let _starting = locked(&self.0.starting);
        if let Some(port) = self.alive_port() {
            return Ok(port);
        }
        *locked(&self.0.crash) = None;
        let fail = |message: String| CheckError::new("network", format!("The local LanguageTool could not be started: {message}"));
        let mut last_error = String::new();
        for _ in 0..3 {
            let port = free_port().map_err(|e| fail(format!("no free port ({e})")))?;
            (self.0.notify)("starting");
            let (child, job, tail) = match spawn(make(port)) {
                Ok(started) => started,
                Err(e) => {
                    (self.0.notify)("stopped");
                    return Err(fail(format!("{e}. Remove LanguageTool on the settings page and download it again.")));
                }
            };
            let id = self.0.next_id.fetch_add(1, Ordering::Relaxed);
            *locked(&self.0.state) =
                Some(Running { id, child, _job: job, port, ready: false, last_used: Instant::now(), tail: tail.clone() });
            match self.wait_ready(id, port, startup) {
                Ok(()) => {
                    if let Some(r) = locked(&self.0.state).as_mut().filter(|r| r.id == id) {
                        r.ready = true;
                        r.last_used = Instant::now();
                    }
                    let shared = self.0.clone();
                    std::thread::spawn(move || monitor(shared, id, idle, tick));
                    (self.0.notify)("running");
                    return Ok(port);
                }
                Err(failure) => {
                    let running = locked(&self.0.state).take_if(|r| r.id == id);
                    if let Some(r) = running {
                        r.kill();
                    }
                    (self.0.notify)("stopped");
                    match failure {
                        StartFailure::Stopped => return Err(CheckError::new("stopped", "LanguageTool was stopped.")),
                        StartFailure::Timeout => {
                            return Err(fail(format!("it did not answer within {} s.", startup.as_secs())));
                        }
                        StartFailure::Exited(message) => {
                            let output = tail.lock().unwrap_or_else(|e| e.into_inner()).clone();
                            last_error = format!("it {message}");
                            // Someone took the port in the meantime: try another one.
                            if !is_bind_error(&output) {
                                return Err(fail(last_error));
                            }
                        }
                    }
                }
            }
        }
        Err(fail(last_error))
    }

    fn wait_ready(&self, id: u64, port: u16, timeout: Duration) -> Result<(), StartFailure> {
        let deadline = Instant::now() + timeout;
        loop {
            {
                let mut state = locked(&self.0.state);
                match state.as_mut().filter(|r| r.id == id) {
                    None => return Err(StartFailure::Stopped),
                    Some(r) => {
                        if let Ok(Some(status)) = r.child.try_wait() {
                            // Let the readers collect the last output.
                            std::thread::sleep(Duration::from_millis(150));
                            return Err(StartFailure::Exited(r.exit_message(status)));
                        }
                    }
                }
            }
            if answers(port) {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(StartFailure::Timeout);
            }
            std::thread::sleep(POLL);
        }
    }

    /// Asks what became of the server a failed request used (`port`).
    pub fn fate(&self, port: u16) -> Fate {
        let mut state = locked(&self.0.state);
        if let Some(r) = state.as_ref() {
            if r.port != port {
                return Fate::Stopped;
            }
            return match reap(&mut state) {
                None => Fate::Alive,
                Some(message) => {
                    drop(state);
                    (self.0.notify)("stopped");
                    Fate::Crashed(format!("The local LanguageTool {message}"))
                }
            };
        }
        drop(state);
        match locked(&self.0.crash).take() {
            Some(message) => Fate::Crashed(format!("The local LanguageTool {message}")),
            None => Fate::Stopped,
        }
    }

    /// One check against the managed server, which is started first if necessary.
    pub fn check(&self, data: &Path, text: &str, language: &str, variants: &str) -> Result<String, CheckError> {
        let port = self.ensure_started(data)?;
        self.touch();
        let result = languagetool::check(&format!("http://127.0.0.1:{port}"), text, language, variants);
        self.touch();
        match result {
            Ok(body) => Ok(body),
            Err(error) => Err(match self.fate(port) {
                Fate::Alive => error,
                Fate::Stopped => CheckError::new("stopped", "LanguageTool was stopped."),
                Fate::Crashed(message) => {
                    CheckError::new("network", format!("{message}. It starts again with the next check."))
                }
            }),
        }
    }
}

enum StartFailure {
    Exited(String),
    Timeout,
    Stopped,
}

/// The server answers its language list.
fn answers(port: u16) -> bool {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(2)))
        .http_status_as_error(false)
        .build()
        .into();
    agent.get(&format!("http://127.0.0.1:{port}/v2/languages")).call().is_ok_and(|r| r.status().as_u16() == 200)
}

/// Watches a running server: stops it after `idle` without requests and notices when it dies.
fn monitor(shared: Arc<Shared>, id: u64, idle: Duration, tick: Duration) {
    loop {
        std::thread::sleep(tick);
        let mut state = locked(&shared.state);
        if !state.as_ref().is_some_and(|r| r.id == id) {
            return;
        }
        if let Some(message) = reap(&mut state) {
            drop(state);
            *locked(&shared.crash) = Some(message);
            (shared.notify)("stopped");
            return;
        }
        if !idle_expired(state.as_ref().map_or(Instant::now(), |r| r.last_used), Instant::now(), idle) {
            continue;
        }
        let idle_one = state.take();
        drop(state);
        if let Some(r) = idle_one {
            r.kill();
        }
        (shared.notify)("stopped");
        return;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    const FAKE_PORT: &str = "KLADDE_TEST_FAKE_LT_PORT";
    const FAKE_EXIT_AFTER_MS: &str = "KLADDE_TEST_FAKE_LT_EXIT_MS";

    /// Not a test of its own: when the test executable is started as the stand-in server (see
    /// `fake_command`), this serves 200 to every request on the given port, forever or for a while.
    #[test]
    fn fake_server_child() {
        let Ok(port) = std::env::var(FAKE_PORT) else { return };
        let listener = TcpListener::bind(("127.0.0.1", port.parse().unwrap())).unwrap();
        if let Some(ms) = std::env::var(FAKE_EXIT_AFTER_MS).ok().and_then(|v| v.parse::<u64>().ok()) {
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(ms));
                std::process::exit(3);
            });
        }
        for stream in listener.incoming().flatten() {
            let mut stream = stream;
            let mut line = String::new();
            let _ = BufReader::new(stream.try_clone().unwrap()).read_line(&mut line);
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[]");
        }
    }

    fn fake_command(port: u16, exit_after_ms: Option<u64>) -> Command {
        let mut c = Command::new(std::env::current_exe().unwrap());
        c.args(["--exact", "lt_server::tests::fake_server_child", "--nocapture", "--test-threads=1"]).env(FAKE_PORT, port.to_string());
        if let Some(ms) = exit_after_ms {
            c.env(FAKE_EXIT_AFTER_MS, ms.to_string());
        }
        c
    }

    fn quiet() -> Managed {
        Managed::new(|_| {})
    }

    const LONG: Duration = Duration::from_secs(3600);
    const SLOW_TICK: Duration = Duration::from_secs(3600);

    fn port_open(port: u16) -> bool {
        std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(300)).is_ok()
    }

    fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !condition() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn the_setting_wins_over_the_local_install() {
        assert_eq!(route("http://localhost:8081", true), Route::Configured);
        assert_eq!(route("https://api.languagetool.org", false), Route::Configured);
        assert_eq!(route("  ", true), Route::Local);
        assert_eq!(route("", true), Route::Local);
        assert_eq!(route("", false), Route::NotInstalled);
    }

    #[test]
    fn idle_stop_after_the_timeout() {
        let t = Instant::now();
        let timeout = Duration::from_secs(900);
        assert!(!idle_expired(t, t, timeout));
        assert!(!idle_expired(t, t + Duration::from_secs(899), timeout));
        assert!(idle_expired(t, t + timeout, timeout));
        // A last use "in the future" is not expired.
        assert!(!idle_expired(t + Duration::from_secs(5), t, timeout));
        assert_eq!(IDLE_TIMEOUT, Duration::from_secs(900));
    }

    #[test]
    fn the_real_command_is_java_with_a_heap_limit_on_the_server_class() {
        let args = java_args(8123);
        assert_eq!(args[0], format!("-Xmx{HEAP_MB}m"));
        assert!(args.windows(2).any(|w| w == ["-cp", SERVER_JAR]));
        assert!(args.contains(&SERVER_CLASS.to_string()));
        assert_eq!(&args[args.len() - 2..], ["--port", "8123"]);
        // Loopback only is the server's default; "--public" would open it to the network.
        assert!(!args.iter().any(|a| a == "--public"));
    }

    #[test]
    fn bind_errors_are_recognized() {
        assert!(is_bind_error("Exception in thread \"main\" java.net.BindException: Address already in use: bind"));
        assert!(!is_bind_error("Error: Could not create the Java Virtual Machine."));
        assert_eq!(last_lines("a\n\n  b \nc\nd\n", 2), "c | d");
    }

    #[test]
    fn starts_once_serves_and_stops_on_demand() {
        let managed = quiet();
        let make = |port| fake_command(port, None);
        let port = managed.ensure_started_with(&make, Duration::from_secs(30), LONG, SLOW_TICK).unwrap();
        assert!(managed.is_running());
        assert!(answers(port));
        // A second request reuses the process.
        assert_eq!(managed.ensure_started_with(&make, Duration::from_secs(30), LONG, SLOW_TICK).unwrap(), port);

        managed.stop();
        assert!(!managed.is_running());
        wait_until("the port to close", || !port_open(port));
        assert_eq!(managed.fate(port), Fate::Stopped);

        // It starts again when asked.
        let again = managed.ensure_started_with(&make, Duration::from_secs(30), LONG, SLOW_TICK).unwrap();
        assert!(answers(again));
        managed.stop();
    }

    #[test]
    fn stops_after_the_idle_time_and_restarts() {
        let managed = quiet();
        let make = |port| fake_command(port, None);
        let idle = Duration::from_millis(1500);
        let port = managed.ensure_started_with(&make, Duration::from_secs(30), idle, Duration::from_millis(50)).unwrap();
        // Requests keep it alive.
        for _ in 0..4 {
            std::thread::sleep(Duration::from_millis(500));
            managed.touch();
            assert!(managed.is_running());
        }
        wait_until("the idle stop", || !managed.is_running());
        wait_until("the port to close", || !port_open(port));
        // Idle is not a crash.
        assert_eq!(managed.fate(port), Fate::Stopped);
        let again = managed.ensure_started_with(&make, Duration::from_secs(30), LONG, SLOW_TICK).unwrap();
        assert!(answers(again));
        managed.stop();
    }

    #[test]
    fn a_crash_is_noticed_and_the_next_request_starts_again() {
        let managed = quiet();
        let first = managed
            .ensure_started_with(&|p| fake_command(p, Some(700)), Duration::from_secs(30), LONG, Duration::from_millis(50))
            .unwrap();
        wait_until("the monitor to notice", || !managed.is_running());
        match managed.fate(first) {
            Fate::Crashed(message) => assert!(message.contains("exit code 3"), "{message}"),
            other => panic!("{other:?}"),
        }
        let second = managed.ensure_started_with(&|p| fake_command(p, None), Duration::from_secs(30), LONG, SLOW_TICK).unwrap();
        assert!(answers(second));
        managed.stop();
    }

    #[test]
    fn a_process_that_cannot_run_is_reported() {
        let managed = quiet();
        let missing = managed.ensure_started_with(
            &|_| Command::new("C:\\definitely\\not\\here\\java.exe"),
            Duration::from_secs(5),
            LONG,
            SLOW_TICK,
        );
        let error = missing.unwrap_err();
        assert_eq!(error.kind, "network");
        assert!(error.message.contains("could not be started"), "{}", error.message);

        // One that exits at once (the test executable with a filter that matches nothing).
        let exits = |_port| {
            let mut c = Command::new(std::env::current_exe().unwrap());
            c.args(["--exact", "no::such::test"]);
            c
        };
        let error = managed.ensure_started_with(&exits, Duration::from_secs(20), LONG, SLOW_TICK).unwrap_err();
        assert!(error.message.contains("exited"), "{}", error.message);
        assert!(!managed.is_running());

        // A server that never answers times out and is killed.
        let silent = |_port| fake_command(1, None);
        let error = managed.ensure_started_with(&silent, Duration::from_millis(600), LONG, SLOW_TICK).unwrap_err();
        assert!(error.message.contains("did not answer") || error.message.contains("exited"), "{}", error.message);
        assert!(!managed.is_running());
    }

    #[test]
    fn the_job_object_kills_the_process_when_its_handle_closes() {
        let port = free_port().unwrap();
        let (mut child, job, _tail) = spawn(fake_command(port, None)).unwrap();
        wait_until("the child to listen", || port_open(port));
        assert!(child.try_wait().unwrap().is_none());
        // This is what the end of the Kladde process does to the handle.
        drop(job);
        wait_until("the child to die", || child.try_wait().unwrap().is_some());
        wait_until("the port to close", || !port_open(port));
    }

    #[test]
    fn a_failed_request_learns_whether_the_server_is_to_blame() {
        let managed = quiet();
        let port = managed.ensure_started_with(&|p| fake_command(p, None), Duration::from_secs(30), LONG, SLOW_TICK).unwrap();
        assert_eq!(managed.fate(port), Fate::Alive);
        // Another port than the running one's: that server is gone already.
        assert_eq!(managed.fate(port.wrapping_add(1)), Fate::Stopped);
        managed.stop();
    }
}
