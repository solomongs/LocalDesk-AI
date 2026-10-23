use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Ollama,
    Llamacpp,
}
impl Default for Engine {
    fn default() -> Self {
        Self::Ollama
    }
}
impl Engine {
    pub fn endpoint(self) -> &'static str {
        match self {
            Self::Ollama => "http://127.0.0.1:11434",
            Self::Llamacpp => "http://127.0.0.1:8080",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}
impl ChatMessage {
    pub fn wire(&self) -> Value {
        serde_json::json!({"role":self.role,"content":self.content})
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub messages: Vec<ChatMessage>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeModel {
    pub id: String,
    pub name: String,
    pub size_bytes: Option<u64>,
    pub size: Option<u64>,
    pub parameter_size: Option<String>,
    pub quantization: Option<String>,
    pub family: Option<String>,
    pub modified_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStatus {
    pub engine: Engine,
    pub connected: bool,
    pub endpoint: String,
    pub version: Option<String>,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatChunk {
    pub request_id: String,
    pub content: String,
    pub done: bool,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Completion {
    pub content: String,
    pub model: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub model: String,
    pub status: String,
    pub completed: u64,
    pub total: u64,
    pub percent: Option<f64>,
}

pub fn validate_model(model: &str) -> Result<(), String> {
    if model.is_empty()
        || model.len() > 200
        || !model
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:/-+".contains(&c))
    {
        return Err("Choose a valid installed model or an Ollama model tag.".into());
    }
    Ok(())
}
pub fn validate_messages(messages: &[ChatMessage]) -> Result<(), String> {
    if messages.is_empty() || messages.len() > 500 {
        return Err("Send between 1 and 500 messages.".into());
    }
    let mut total = 0usize;
    for msg in messages {
        if !["system", "user", "assistant", "tool"].contains(&msg.role.as_str()) {
            return Err("Unsupported message role.".into());
        }
        total = total.saturating_add(msg.content.len());
    }
    if total > 2 * 1024 * 1024 {
        return Err("Conversation is too large. Start a new chat.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_ollama_tags() {
        assert!(validate_model("qwen2.5-coder:7b").is_ok());
        assert!(validate_model("user/model:q4_K_M").is_ok());
    }
    #[test]
    fn rejects_shell_and_invalid_tags() {
        for value in ["", "model;rm -rf /", "$(evil)", "a\nfoo"] {
            assert!(validate_model(value).is_err());
        }
    }
    #[test]
    fn endpoints_are_fixed_loopback() {
        assert_eq!(Engine::Ollama.endpoint(), "http://127.0.0.1:11434");
        assert_eq!(Engine::Llamacpp.endpoint(), "http://127.0.0.1:8080");
    }
}
