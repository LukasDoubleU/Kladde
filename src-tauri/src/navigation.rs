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
