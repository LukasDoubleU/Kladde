//! What the main webview may navigate to.
//!
//! Kladde is a single page: its window must never show anything else. Markdown with raw HTML, a link that
//! bypasses the click handler (middle click, a form) or a bug could otherwise replace the whole UI with a web
//! page, and a page in the asset protocol's origin could read local files. So every top-level navigation is
//! classified here: the app's own origin stays, http(s) and mailto targets go to the system (the same rules
//! as `workspace.openHref` in the frontend: nothing else is ever opened), everything else is cancelled.
//!
//! A cancelled navigation's request may still reach the server (WebView2 reports `NavigationStarting` after
//! the request was prepared and a form post is already on its way), so this is the second line of defense: the
//! CSP (`form-action 'none'`) and the sanitizer keep such requests from being made at all.
//!
//! Two gaps the plain origin check would leave, both closed here:
//! - The own origin is allowed once. Kladde never navigates itself, but a link to `/`, `index.html` or any other
//!   path of the origin (an image map, a bug) would reload the app, because Tauri answers every unknown path with
//!   `index.html`, and the edits since the last backup would be gone. Only a `tauri dev` build reloads (Vite does).
//! - Tauri hands the callback only URLs the `url` crate can parse and *allows* the others, which WebView2 still
//!   navigates to (`http://xn--a.invalid/` is one: an invalid IDNA label). `cancels_unparseable` is the check for
//!   the raw string; `lib.rs` registers it as a second `NavigationStarting` handler, so such a target fails closed.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Url;

#[derive(Debug, PartialEq, Eq)]
pub enum Navigation {
    /// Kladde's own page (or the dev server in `tauri dev`).
    Allow,
    /// Not Kladde's page, but a link for the system: the browser or the mail program.
    External(String),
    /// Cancel and do nothing.
    Block,
}

/// Hosts that belong to Tauri's own protocols (`http://tauri.localhost`, `http://asset.localhost`,
/// `http://ipc.localhost` on Windows). They must never reach a browser, which would resolve them to loopback.
const INTERNAL_HOSTS: [&str; 3] = ["tauri.localhost", "asset.localhost", "ipc.localhost"];

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

/// Kladde's own origin: `http://tauri.localhost` (WebView2: Tauri 2 serves its assets under that host) or
/// `tauri://localhost` (other platforms), without credentials. With `dev_url` (a `tauri dev` build only) also the
/// Vite dev server.
fn is_app_origin(url: &Url, dev_url: Option<&Url>) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let own = matches!(
        (url.scheme(), url.host_str(), url.port()),
        ("http", Some("tauri.localhost"), None) | ("tauri", Some("localhost"), None)
    );
    own || dev_url.is_some_and(|dev| same_origin(url, dev))
}

/// Decides a navigation of the page itself (a link, `location = …`, a form, a redirect).
pub fn classify_navigation(url: &Url, dev_url: Option<&Url>) -> Navigation {
    if is_app_origin(url, dev_url) {
        return Navigation::Allow;
    }
    match url.scheme() {
        "http" | "https" => match url.host_str() {
            Some(host) if !INTERNAL_HOSTS.iter().any(|h| host.eq_ignore_ascii_case(h)) => {
                Navigation::External(url.to_string())
            }
            _ => Navigation::Block,
        },
        "mailto" => Navigation::External(url.to_string()),
        _ => Navigation::Block,
    }
}

/// The state of the navigation guard of one window: the origins it trusts and whether its page was loaded.
pub struct Guard {
    dev_url: Option<Url>,
    loaded: AtomicBool,
}

impl Guard {
    /// `dev_url`: the Vite dev server of a `tauri dev` build, which may also reload (hot module replacement
    /// falls back to a full reload); `None` in every other build, where the own page is loaded exactly once.
    pub fn new(dev_url: Option<Url>) -> Self {
        Self { dev_url, loaded: AtomicBool::new(false) }
    }

    /// Decides a navigation of the page itself.
    pub fn navigation(&self, url: &Url) -> Navigation {
        match classify_navigation(url, self.dev_url.as_ref()) {
            Navigation::Allow if self.dev_url.is_none() && self.loaded.swap(true, Ordering::SeqCst) => Navigation::Block,
            decision => decision,
        }
    }

    /// Decides a request for a new window.
    pub fn new_window(&self, url: &Url) -> Navigation {
        classify_new_window(url, self.dev_url.as_ref())
    }
}

/// Whether the raw URI of a navigation has to be cancelled because the `url` crate rejects it. Tauri allows such
/// a navigation without asking `classify_navigation`, so nothing may be assumed about where it leads.
pub fn cancels_unparseable(raw: &str) -> bool {
    raw.parse::<Url>().is_err()
}

/// The address of a `srcdoc` frame: the only document a frame of Kladde ever shows.
pub const SRCDOC: &str = "about:srcdoc";

/// Whether a navigation of a frame inside the page (not the page itself) has to be cancelled. Kladde has one kind
/// of frame, the `srcdoc` frame of the document viewer, which never navigates once it shows its content: it
/// holds a document from someone else, and the page's own checks (`on_navigation` above) only see the top-level
/// frame, so a `<meta http-equiv=refresh>` or a link inside it would otherwise go wherever it likes. Everything
/// but the `srcdoc` document is cancelled, whatever it is.
pub fn cancels_frame_navigation(raw: &str) -> bool {
    raw != SRCDOC
}

/// Decides a request for a new window (`target=_blank`, `window.open`, middle click). Kladde never opens
/// one, not even for its own page.
pub fn classify_new_window(url: &Url, dev_url: Option<&Url>) -> Navigation {
    match classify_navigation(url, dev_url) {
        Navigation::Allow => Navigation::Block,
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn external(s: &str) -> Navigation {
        Navigation::External(url(s).to_string())
    }

    #[test]
    fn the_apps_own_origin_stays() {
        for own in ["http://tauri.localhost/", "http://tauri.localhost/index.html#top", "tauri://localhost/", "http://tauri.localhost:80/"] {
            assert_eq!(classify_navigation(&url(own), None), Navigation::Allow, "{own}");
        }
    }

    #[test]
    fn lookalikes_of_the_apps_origin_do_not_stay() {
        for other in [
            "https://tauri.localhost/",
            "http://tauri.localhost:8080/",
            "http://tauri.localhost.evil.example/",
            "http://evil.example/tauri.localhost",
            "http://user@tauri.localhost/",
            "http://user:pw@tauri.localhost/",
            "tauri://localhost:1/",
            "tauri://evil/",
            "http://localhost:1420/",
        ] {
            assert_ne!(classify_navigation(&url(other), None), Navigation::Allow, "{other}");
        }
    }

    #[test]
    fn the_dev_server_stays_only_in_a_dev_build() {
        let dev = url("http://localhost:1420");
        assert_eq!(classify_navigation(&url("http://localhost:1420/src/main.ts"), Some(&dev)), Navigation::Allow);
        assert_eq!(classify_navigation(&url("http://localhost:1420/"), None), external("http://localhost:1420/"));
        // Same host, other port: some other local server.
        assert_eq!(classify_navigation(&url("http://localhost:3000/"), Some(&dev)), external("http://localhost:3000/"));
        assert_eq!(classify_navigation(&url("https://localhost:1420/"), Some(&dev)), external("https://localhost:1420/"));
    }

    #[test]
    fn web_and_mail_targets_go_to_the_system() {
        assert_eq!(classify_navigation(&url("https://example.com/a?b=1#c"), None), external("https://example.com/a?b=1#c"));
        assert_eq!(classify_navigation(&url("HTTP://Example.COM"), None), external("http://example.com/"));
        assert_eq!(classify_navigation(&url("mailto:me@example.com?subject=hi"), None), external("mailto:me@example.com?subject=hi"));
        assert_eq!(classify_navigation(&url("http://127.0.0.1:8080/"), None), external("http://127.0.0.1:8080/"));
    }

    #[test]
    fn everything_else_is_cancelled() {
        for blocked in [
            "file:///C:/Windows/notepad.exe",
            "file://server/share/a.html",
            "javascript:alert(1)",
            "data:text/html,<h1>x</h1>",
            "blob:http://tauri.localhost/1234",
            "about:blank",
            "ftp://example.com/",
            "foo-app:open",
            "tel:+4912345",
            "asset://localhost/C:/a.html",
            "http://asset.localhost/C:/a.pdf",
            "https://asset.localhost/C:/a.pdf",
            "http://ipc.localhost/cmd",
            "http://ASSET.localhost/x",
            "ws://localhost:1420/",
        ] {
            assert_eq!(classify_navigation(&url(blocked), None), Navigation::Block, "{blocked}");
        }
    }

    #[test]
    fn the_own_page_is_loaded_once_and_a_reload_is_cancelled() {
        let guard = Guard::new(None);
        assert_eq!(guard.navigation(&url("https://example.com/")), external("https://example.com/"));
        assert_eq!(guard.navigation(&url("http://tauri.localhost/")), Navigation::Allow, "the first load");
        // Whatever path: Tauri answers unknown ones with index.html, which would start the app again.
        for again in ["http://tauri.localhost/", "http://tauri.localhost/index.html", "http://tauri.localhost/other.md", "http://tauri.localhost/?x", "tauri://localhost/"] {
            assert_eq!(guard.navigation(&url(again)), Navigation::Block, "{again}");
        }
        // Other targets are decided as before.
        assert_eq!(guard.navigation(&url("mailto:me@example.com")), external("mailto:me@example.com"));
        assert_eq!(guard.navigation(&url("file:///C:/a.html")), Navigation::Block);
    }

    #[test]
    fn a_lookalike_does_not_use_up_the_first_load() {
        let guard = Guard::new(None);
        assert_eq!(guard.navigation(&url("http://tauri.localhost.evil.example/")), external("http://tauri.localhost.evil.example/"));
        assert_eq!(guard.navigation(&url("http://tauri.localhost/")), Navigation::Allow);
    }

    #[test]
    fn a_dev_build_may_reload() {
        let guard = Guard::new(Some(url("http://localhost:1420")));
        for _ in 0..3 {
            assert_eq!(guard.navigation(&url("http://localhost:1420/")), Navigation::Allow);
        }
        assert_eq!(guard.navigation(&url("http://localhost:3000/")), external("http://localhost:3000/"));
    }

    #[test]
    fn a_uri_the_url_crate_rejects_is_cancelled() {
        for raw in ["http://xn--a.invalid/", "http://xn--a.example.com/x", "http://exa mple.com/", "http://[::1/", "http://a:99999/", ""] {
            assert!(cancels_unparseable(raw), "{raw:?}");
        }
        for raw in ["http://tauri.localhost/", "https://example.com/a?b#c", "mailto:me@example.com", "foo-app:open", "about:blank"] {
            assert!(!cancels_unparseable(raw), "{raw:?}");
        }
    }

    #[test]
    fn a_frame_may_only_show_its_srcdoc() {
        assert!(!cancels_frame_navigation("about:srcdoc"));
        for raw in [
            "about:blank",
            "about:srcdoc#x",
            "about:srcdoc?x",
            "ABOUT:SRCDOC",
            "https://example.com/",
            "http://127.0.0.1:8080/",
            "http://tauri.localhost/",
            "tauri://localhost/",
            "http://asset.localhost/C:/a.html",
            "file:///C:/a.html",
            "data:text/html,<h1>x</h1>",
            "blob:http://tauri.localhost/1234",
            "javascript:alert(1)",
            "foo-app:open",
            "http://xn--a.invalid/",
            "",
        ] {
            assert!(cancels_frame_navigation(raw), "{raw:?}");
        }
    }

    #[test]
    fn a_new_window_is_never_the_apps_own() {
        let dev = url("http://localhost:1420");
        assert_eq!(classify_new_window(&url("http://tauri.localhost/"), None), Navigation::Block);
        assert_eq!(classify_new_window(&url("http://localhost:1420/"), Some(&dev)), Navigation::Block);
        assert_eq!(classify_new_window(&url("https://example.com/"), None), external("https://example.com/"));
        assert_eq!(classify_new_window(&url("mailto:me@example.com"), None), external("mailto:me@example.com"));
        assert_eq!(classify_new_window(&url("file:///C:/a.html"), None), Navigation::Block);
        assert_eq!(classify_new_window(&url("http://asset.localhost/C:/a.png"), None), Navigation::Block);
    }
}
