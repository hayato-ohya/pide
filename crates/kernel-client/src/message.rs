use anyhow::{bail, Context, Result};
use bytes::Bytes;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use zeromq::ZmqMessage;

const DELIM: &[u8] = b"<IDS|MSG>";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Header {
    pub msg_id: String,
    pub session: String,
    pub username: String,
    pub date: String,
    pub msg_type: String,
    pub version: String,
}

impl Header {
    pub fn new(msg_type: &str, session: &str) -> Self {
        Header {
            msg_id: uuid::Uuid::new_v4().to_string(),
            session: session.to_string(),
            username: "pide".into(),
            date: chrono::Utc::now().to_rfc3339(),
            msg_type: msg_type.to_string(),
            version: "5.3".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub header: Header,
    pub parent_header: Value,
    pub metadata: Value,
    pub content: Value,
    #[serde(skip)]
    pub buffers: Vec<Bytes>,
}

impl Message {
    pub fn msg_type(&self) -> &str {
        &self.header.msg_type
    }
    pub fn parent_id(&self) -> Option<&str> {
        self.parent_header.get("msg_id").and_then(|v| v.as_str())
    }

    pub fn encode(&self, signer: &Signer) -> ZmqMessage {
        let header = serde_json::to_vec(&self.header).unwrap();
        let parent = serde_json::to_vec(&self.parent_header).unwrap();
        let metadata = serde_json::to_vec(&self.metadata).unwrap();
        let content = serde_json::to_vec(&self.content).unwrap();
        let sig = signer.sign([&header, &parent, &metadata, &content]);
        let mut frames: Vec<Bytes> = vec![
            Bytes::from_static(DELIM),
            Bytes::from(sig),
            Bytes::from(header),
            Bytes::from(parent),
            Bytes::from(metadata),
            Bytes::from(content),
        ];
        frames.extend(self.buffers.iter().cloned());
        ZmqMessage::try_from(frames).unwrap()
    }

    pub fn decode(frames: Vec<Bytes>, signer: &Signer) -> Result<Message> {
        let pos = frames
            .iter()
            .position(|f| f.as_ref() == DELIM)
            .context("missing <IDS|MSG> delimiter")?;
        let rest = &frames[pos + 1..];
        if rest.len() < 5 {
            bail!("short message: {} frames after delimiter", rest.len());
        }
        let sig = &rest[0];
        let header = &rest[1];
        let parent = &rest[2];
        let metadata = &rest[3];
        let content = &rest[4];
        if !signer.key_empty() {
            let expected = signer.sign([header, parent, metadata, content]);
            let a = expected.as_bytes();
            let b: &[u8] = sig.as_ref();
            // The length of a hex HMAC is public; only the contents need a constant-time compare.
            if a.len() != b.len() || a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y)) != 0 {
                bail!("bad HMAC signature");
            }
        }
        Ok(Message {
            header: serde_json::from_slice(header).context("header")?,
            parent_header: serde_json::from_slice(parent).context("parent_header")?,
            metadata: serde_json::from_slice(metadata).context("metadata")?,
            content: serde_json::from_slice(content).context("content")?,
            buffers: rest[5..].to_vec(),
        })
    }
}

#[derive(Clone)]
pub struct Signer {
    key: Vec<u8>,
}

impl Signer {
    pub fn new(key: &str) -> Self {
        Signer { key: key.as_bytes().to_vec() }
    }
    pub fn key_empty(&self) -> bool {
        self.key.is_empty()
    }
    pub fn sign<'a>(&self, parts: impl IntoIterator<Item = &'a (impl AsRef<[u8]> + 'a + ?Sized)>) -> String {
        if self.key.is_empty() {
            return String::new();
        }
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key).expect("hmac key");
        for p in parts {
            mac.update(p.as_ref());
        }
        hex::encode(mac.finalize().into_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg() -> Message {
        Message {
            header: Header::new("execute_request", "sess"),
            parent_header: serde_json::json!({}),
            metadata: serde_json::json!({}),
            content: serde_json::json!({"code": "print(1)"}),
            buffers: vec![],
        }
    }

    #[test]
    fn sign_verify_round_trip() {
        let signer = Signer::new("secret-key");
        let frames = msg().encode(&signer).into_vec();
        let decoded = Message::decode(frames, &signer).unwrap();
        assert_eq!(decoded.header.msg_type, "execute_request");
        assert_eq!(decoded.content["code"], "print(1)");
    }

    #[test]
    fn tampered_content_is_rejected() {
        let signer = Signer::new("secret-key");
        let mut frames = msg().encode(&signer).into_vec();
        let last = frames.len() - 1;
        frames[last] = Bytes::from_static(br#"{"code":"import os"}"#);
        assert!(Message::decode(frames, &signer).is_err());
    }

    #[test]
    fn wrong_key_is_rejected() {
        let frames = msg().encode(&Signer::new("a")).into_vec();
        assert!(Message::decode(frames, &Signer::new("b")).is_err());
    }

    #[test]
    fn empty_key_disables_auth() {
        let frames = msg().encode(&Signer::new("")).into_vec();
        assert!(Message::decode(frames, &Signer::new("")).is_ok());
    }

    #[test]
    fn identities_before_delimiter_are_skipped() {
        let signer = Signer::new("k");
        let mut frames = vec![Bytes::from_static(b"router-id")];
        frames.extend(msg().encode(&signer).into_vec());
        assert!(Message::decode(frames, &signer).is_ok());
    }
}
