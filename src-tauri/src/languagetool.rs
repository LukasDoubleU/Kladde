//! LanguageTool client. The page cannot talk to the server itself (CSP, CORS), so the one request it
//! needs, `POST <server>/v2/check`, is made here. Only that endpoint of the configured server is
//! reachable, with the form fields the check needs. TLS comes from the operating system (Schannel and
//! the Windows certificate store), which keeps the binary small.

use serde::Serialize;
use std::time::Duration;
use ureq::tls::{RootCerts, TlsConfig, TlsProvider};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckError {
    /// `config` (unusable server address), `network`, `rate-limited` or `http`.
    pub kind: &'static str,
    pub status: Option<u16>,
    /// Seconds the server asks to wait (`Retry-After`).
    pub retry_after: Option<u64>,
    pub message: String,
}

impl CheckError {
    pub(crate) fn new(kind: &'static str, message: impl Into<String>) -> Self {
        CheckError { kind, status: None, retry_after: None, message: message.into() }
    }
}

/// The check URL of a server given as base address; also accepts one that already ends with `/v2`.
pub fn endpoint(server: &str) -> Result<String, CheckError> {
    let server = server.trim().trim_end_matches('/');
    let server = server.strip_suffix("/v2/check").or_else(|| server.strip_suffix("/v2")).unwrap_or(server);
    let rest = server
        .strip_prefix("http://")
        .or_else(|| server.strip_prefix("https://"))
        .filter(|r| !r.is_empty() && !r.starts_with('/'));
    if rest.is_none() {
        return Err(CheckError::new("config", "The server address must start with http:// or https://"));
    }
    Ok(format!("{server}/v2/check"))
}

/// TLS from the operating system, shared with the download of the local LanguageTool.
pub fn tls_config() -> TlsConfig {
    TlsConfig::builder().provider(TlsProvider::NativeTls).root_certs(RootCerts::PlatformVerifier).build()
}

/// Sends one check request and returns the response body (JSON). `data` is LanguageTool's annotated text.
pub fn check(server: &str, data: &str, language: &str, variants: &str) -> Result<String, CheckError> {
    let url = endpoint(server)?;
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(40)))
        .timeout_connect(Some(Duration::from_secs(6)))
        .http_status_as_error(false)
        .user_agent(concat!("Kladde/", env!("CARGO_PKG_VERSION")))
        .tls_config(tls_config())
        .build();
    let agent: ureq::Agent = config.into();
    let mut form = vec![("data", data), ("language", language)];
    if language == "auto" && !variants.is_empty() {
        form.push(("preferredVariants", variants));
    }
    let mut response = agent.post(&url).send_form(form).map_err(|e| CheckError::new("network", e.to_string()))?;
    let status = response.status().as_u16();
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok());
    let body = response.body_mut().read_to_string().map_err(|e| CheckError::new("network", e.to_string()))?;
    if status == 200 {
        return Ok(body);
    }
    let snippet: String = body.chars().take(200).collect();
    Err(CheckError {
        kind: if status == 429 { "rate-limited" } else { "http" },
        status: Some(status),
        retry_after,
        message: format!("The server answered with status {status}. {snippet}").trim().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Answers one request with the given raw response; the handle yields what the client sent.
    fn serve_once(response: &'static str) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut received = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = stream.read(&mut buf).unwrap();
                received.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&received).to_string();
                if let Some(split) = text.find("\r\n\r\n") {
                    let length = text[..split]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if received.len() >= split + 4 + length || n == 0 {
                        break;
                    }
                }
            }
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8_lossy(&received).to_string()
        });
        (address, handle)
    }

    #[test]
    fn endpoint_normalizes_the_address() {
        for server in ["http://localhost:8081", "http://localhost:8081/", " http://localhost:8081/v2 ", "http://localhost:8081/v2/check"] {
            assert_eq!(endpoint(server).unwrap(), "http://localhost:8081/v2/check", "{server}");
        }
        assert_eq!(endpoint("https://api.languagetool.org").unwrap(), "https://api.languagetool.org/v2/check");
        for bad in ["", "localhost:8081", "ftp://x", "http://", "file:///etc"] {
            assert_eq!(endpoint(bad).unwrap_err().kind, "config", "{bad}");
        }
    }

    #[test]
    fn posts_a_form_and_returns_the_body() {
        let (server, handle) = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 14\r\nConnection: close\r\n\r\n{\"matches\":[]}",
        );
        let body = check(&server, "{\"annotation\":[{\"text\":\"Hi & bye\"}]}", "auto", "en-US,de-DE").unwrap();
        assert_eq!(body, "{\"matches\":[]}");
        let request = handle.join().unwrap();
        assert!(request.starts_with("POST /v2/check HTTP/1.1"), "{request}");
        assert!(request.contains("application/x-www-form-urlencoded"), "{request}");
        assert!(request.contains("data=%7B%22annotation%22"), "{request}");
        assert!(request.contains("Hi+%26+bye") || request.contains("Hi%20%26%20bye"), "{request}");
        assert!(request.contains("language=auto"), "{request}");
        assert!(request.contains("preferredVariants=en-US%2Cde-DE"), "{request}");
    }

    #[test]
    fn variants_only_go_with_automatic_detection() {
        let (server, handle) = serve_once("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
        check(&server, "{}", "de-DE", "en-US").unwrap();
        assert!(!handle.join().unwrap().contains("preferredVariants"));
    }

    #[test]
    fn reports_rate_limits_with_the_wait_time() {
        let (server, _) = serve_once(
            "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 12\r\nContent-Length: 4\r\nConnection: close\r\n\r\nslow",
        );
        let error = check(&server, "{}", "auto", "").unwrap_err();
        assert_eq!((error.kind, error.status, error.retry_after), ("rate-limited", Some(429), Some(12)));
        assert!(error.message.contains("slow"));
    }

    #[test]
    fn reports_other_http_errors_and_unreachable_servers() {
        let (server, _) =
            serve_once("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        let error = check(&server, "{}", "en-US", "").unwrap_err();
        assert_eq!((error.kind, error.status), ("http", Some(500)));
        // Nothing listens on a port that was just released.
        let closed = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}", listener.local_addr().unwrap())
        };
        assert_eq!(check(&closed, "{}", "en-US", "").unwrap_err().kind, "network");
    }
}
