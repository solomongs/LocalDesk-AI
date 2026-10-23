use crate::{state::AppState, types::*};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

pub trait EventSink: Send + Sync {
    fn chat_event(&self, event: ChatChunk);
    fn download_event(&self, event: DownloadProgress);
}

pub async fn status(state: &AppState, engine: Engine) -> NativeStatus {
    let endpoint = engine.endpoint().to_owned();
    let route = if engine == Engine::Ollama {
        "/api/version"
    } else {
        "/v1/models"
    };
    let result = state
        .client
        .get(format!("{endpoint}{route}"))
        .timeout(Duration::from_secs(4))
        .send()
        .await;
    match result {
        Ok(response) if response.status().is_success() => {
            let data = response.json::<Value>().await.unwrap_or(Value::Null);
            NativeStatus {
                engine,
                connected: true,
                endpoint,
                version: data
                    .get("version")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                error: None,
            }
        }
        _ => NativeStatus {
            engine,
            connected: false,
            endpoint,
            version: None,
            error: Some(
                if engine == Engine::Ollama {
                    "Ollama is not reachable. Install it or start the service."
                } else {
                    "llama.cpp is not reachable. Start its server on port 8080."
                }
                .into(),
            ),
        },
    }
}

pub async fn models(state: &AppState, engine: Engine) -> Result<Vec<NativeModel>, String> {
    let path = if engine == Engine::Ollama {
        "/api/tags"
    } else {
        "/v1/models"
    };
    let response = state
        .client
        .get(format!("{}{path}", engine.endpoint()))
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|_| "The local model server is not reachable.".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Model server returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    let data = response
        .json::<Value>()
        .await
        .map_err(|_| "The model server returned invalid JSON.".to_string())?;
    let entries = data
        .get(if engine == Engine::Ollama {
            "models"
        } else {
            "data"
        })
        .and_then(Value::as_array)
        .ok_or("The model list is missing.")?;
    Ok(entries
        .iter()
        .filter_map(|m| {
            let id = m.get("name").or_else(|| m.get("id"))?.as_str()?.to_owned();
            let details = m.get("details");
            let size = m.get("size").and_then(Value::as_u64);
            Some(NativeModel {
                id: id.clone(),
                name: id,
                size_bytes: size,
                size,
                parameter_size: details
                    .and_then(|v| v.get("parameter_size"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                quantization: details
                    .and_then(|v| v.get("quantization_level"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                family: details
                    .and_then(|v| v.get("family"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                modified_at: m
                    .get("modified_at")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            })
        })
        .collect())
}

pub fn completion_payload(
    model: &str,
    messages: &[ChatMessage],
    temperature: Option<f64>,
    max_tokens: Option<u32>,
    stream: bool,
) -> Result<Value, String> {
    validate_model(model)?;
    validate_messages(messages)?;
    let temperature = temperature.unwrap_or(0.7);
    if !temperature.is_finite() || !(0.0..=2.0).contains(&temperature) {
        return Err("Temperature must be between 0 and 2.".into());
    }
    let tokens = max_tokens.unwrap_or(1024);
    if tokens == 0 || tokens > 32768 {
        return Err("Maximum output tokens must be between 1 and 32768.".into());
    }
    Ok(
        json!({"model":model,"messages":messages.iter().map(ChatMessage::wire).collect::<Vec<_>>(),"temperature":temperature,"max_tokens":tokens,"stream":stream}),
    )
}

pub async fn completion(state: &AppState, engine: Engine, payload: Value) -> Result<Value, String> {
    let response = state
        .client
        .post(format!("{}/v1/chat/completions", engine.endpoint()))
        .json(&payload)
        .timeout(Duration::from_secs(600))
        .send()
        .await
        .map_err(|_| "Could not contact the local model server.".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "The model server returned HTTP {}. Check that the model is installed and loaded.",
            response.status().as_u16()
        ));
    }
    response
        .json()
        .await
        .map_err(|_| "The model server returned an invalid response.".into())
}

pub async fn chat(
    app: Arc<dyn EventSink>,
    state: AppState,
    request_id: String,
    engine: Engine,
    model: String,
    messages: Vec<ChatMessage>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
) -> Result<Completion, String> {
    if request_id.is_empty() || request_id.len() > 120 {
        return Err("Invalid request identifier.".into());
    }
    let payload = completion_payload(&model, &messages, temperature, max_tokens, true)?;
    let token = CancellationToken::new();
    {
        let mut map = state
            .cancellations
            .lock()
            .map_err(|_| "Request queue unavailable.")?;
        if map.contains_key(&request_id) {
            return Err("This request is already running.".into());
        }
        map.insert(request_id.clone(), token.clone());
    }
    let result = stream_chat(
        app.as_ref(),
        &state,
        &request_id,
        engine,
        &model,
        payload,
        token,
    )
    .await;
    if let Ok(mut map) = state.cancellations.lock() {
        map.remove(&request_id);
    }
    app.chat_event(ChatChunk {
        request_id,
        content: String::new(),
        done: true,
        error: result.as_ref().err().cloned(),
    });
    result
}

async fn stream_chat(
    app: &dyn EventSink,
    state: &AppState,
    id: &str,
    engine: Engine,
    model: &str,
    payload: Value,
    cancel: CancellationToken,
) -> Result<Completion, String> {
    let request = state
        .client
        .post(format!("{}/v1/chat/completions", engine.endpoint()))
        .json(&payload)
        .timeout(Duration::from_secs(600))
        .send();
    let response = tokio::select! {_ = cancel.cancelled()=>return Err("Generation stopped.".into()),r=request=>r.map_err(|_|"The local AI server could not be reached.".to_string())?};
    if !response.status().is_success() {
        return Err(format!(
            "The local AI server returned HTTP {}. Make sure this model is available.",
            response.status().as_u16()
        ));
    }
    let mut stream = response.bytes_stream();
    let mut pending = Vec::<u8>::new();
    let mut content = String::new();
    loop {
        let next = tokio::select! {_ = cancel.cancelled()=>return Err("Generation stopped.".into()),n=stream.next()=>n};
        let bytes = match next {
            None => break,
            Some(Ok(v)) => v,
            Some(Err(_)) => return Err("The model connection ended unexpectedly.".into()),
        };
        pending.extend_from_slice(&bytes);
        if pending.len() > 2 * 1024 * 1024 {
            return Err("The model returned an oversized event.".into());
        }
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            let row = pending.drain(..=end).collect::<Vec<_>>();
            let line = std::str::from_utf8(&row)
                .map_err(|_| "The model returned invalid text.".to_string())?
                .trim();
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if data == "[DONE]" {
                    return Ok(Completion {
                        content,
                        model: model.into(),
                    });
                }
                if data.is_empty() {
                    continue;
                }
                let value: Value = serde_json::from_str(data)
                    .map_err(|_| "The model returned an invalid event.".to_string())?;
                if value.get("error").is_some() {
                    return Err("The local model could not complete this request.".into());
                }
                if let Some(delta) = value
                    .pointer("/choices/0/delta/content")
                    .and_then(Value::as_str)
                {
                    content.push_str(delta);
                    if content.len() > 4 * 1024 * 1024 {
                        return Err("The generated response is too large.".into());
                    }
                    app.chat_event(ChatChunk {
                        request_id: id.into(),
                        content: delta.into(),
                        done: false,
                        error: None,
                    });
                }
            }
        }
    }
    if content.is_empty() {
        return Err("The model returned no text. Try another model.".into());
    }
    Ok(Completion {
        content,
        model: model.into(),
    })
}

pub async fn pull(app: Arc<dyn EventSink>, state: AppState, model: String) -> Result<(), String> {
    validate_model(&model)?;
    let key = format!("pull:{model}");
    let cancel = CancellationToken::new();
    {
        let mut map = state
            .cancellations
            .lock()
            .map_err(|_| "Download queue unavailable.")?;
        if map.contains_key(&key) {
            return Err("This model is already downloading.".into());
        }
        map.insert(key.clone(), cancel.clone());
    }
    let result = pull_inner(app.as_ref(), &state, &model, cancel).await;
    if let Ok(mut map) = state.cancellations.lock() {
        map.remove(&key);
    }
    if let Err(error) = &result {
        app.download_event(DownloadProgress {
            model,
            status: error.clone(),
            completed: 0,
            total: 0,
            percent: None,
        });
    }
    result
}
async fn pull_inner(
    app: &dyn EventSink,
    state: &AppState,
    model: &str,
    cancel: CancellationToken,
) -> Result<(), String> {
    let request = state
        .client
        .post("http://127.0.0.1:11434/api/pull")
        .json(&json!({"model":model,"stream":true}))
        .timeout(Duration::from_secs(7200))
        .send();
    let response = tokio::select! {_ = cancel.cancelled()=>return Err("Download cancelled.".into()),r=request=>r.map_err(|_|"Ollama is not reachable.".to_string())?};
    if !response.status().is_success() {
        return Err(format!(
            "Ollama refused the download (HTTP {}).",
            response.status().as_u16()
        ));
    }
    let mut stream = response.bytes_stream();
    let mut pending = Vec::new();
    let mut finished = false;
    loop {
        let next = tokio::select! {_ = cancel.cancelled()=>return Err("Download cancelled.".into()),n=stream.next()=>n};
        let bytes = match next {
            None => break,
            Some(Ok(v)) => v,
            Some(Err(_)) => return Err(
                "Model download connection failed. You can retry; Ollama keeps completed layers."
                    .into(),
            ),
        };
        pending.extend_from_slice(&bytes);
        if pending.len() > 1024 * 1024 {
            return Err("Ollama returned an oversized status message.".into());
        }
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            let line = pending.drain(..=end).collect::<Vec<_>>();
            if line.iter().all(|b| b.is_ascii_whitespace()) {
                continue;
            }
            let value: Value = serde_json::from_slice(&line)
                .map_err(|_| "Ollama returned invalid download status.".to_string())?;
            if value.get("error").is_some() {
                return Err(value
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Ollama could not download this model.")
                    .chars()
                    .take(300)
                    .collect());
            }
            let status = value
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("Downloading")
                .to_owned();
            finished |= status == "success";
            let total = value.get("total").and_then(Value::as_u64).unwrap_or(0);
            let completed = value.get("completed").and_then(Value::as_u64).unwrap_or(0);
            let percent = if status == "success" {
                Some(100.0)
            } else if total > 0 {
                Some((completed as f64 / total as f64 * 100.0).clamp(0.0, 100.0))
            } else {
                None
            };
            app.download_event(DownloadProgress {
                model: model.into(),
                status,
                completed,
                total,
                percent,
            });
        }
    }
    if !finished {
        return Err("Ollama ended the download before confirming success. Refresh the model list and retry if needed.".into());
    }
    Ok(())
}

pub async fn delete_model(state: &AppState, model: String) -> Result<(), String> {
    validate_model(&model)?;
    let response = state
        .client
        .delete("http://127.0.0.1:11434/api/delete")
        .json(&json!({"model":model}))
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|_| "Ollama is not reachable.".to_string())?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "Ollama could not remove this model (HTTP {}).",
            response.status().as_u16()
        ))
    }
}
