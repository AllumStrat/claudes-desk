//! A one-shot local HTTP server for tests, so nothing touches the network.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;

/// Serves one request with the given status and body. Returns the URL.
pub fn serve_once(status: u16, content_type: &str, body: Vec<u8>) -> String {
    serve_capture(status, content_type, body).0
}

/// Like [`serve_once`], and also hands back the raw request (head and body).
pub fn serve_capture(
    status: u16,
    content_type: &str,
    body: Vec<u8>,
) -> (String, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let content_type = content_type.to_string();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut head = String::new();
        let mut content_len = 0usize;
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                break;
            }
            if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                content_len = v.trim().parse().unwrap_or(0);
            }
            head.push_str(&line);
        }
        let mut req_body = vec![0u8; content_len];
        let _ = reader.read_exact(&mut req_body);
        let _ = tx.send(format!("{head}\r\n{}", String::from_utf8_lossy(&req_body)));
        let mut stream = stream;
        let _ = write!(
            stream,
            "HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(&body);
    });
    (format!("http://{addr}"), rx)
}
