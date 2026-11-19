//! AI assistant client: one OpenAI-compatible chat client for every provider
//! (a local CLIProxyAPI/AIProxy pool, Ollama, free hosted APIs, or any custom
//! endpoint). The agent loop and its tools live in the UI; this module only
//! keeps provider settings (API keys never leave the backend), lists models,
//! and streams one chat completion at a time back to the window.

use crate::error::{AppError, AppResult};
use crate::storage::atomic_write;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

const MAX_ERROR_BODY: u64 = 64 * 1024;
const MAX_MODELS_BODY: u64 = 4 * 1024 * 1024;
/// A single streamed answer larger than this is cut off.
const MAX_REPLY_CHARS: usize = 400_000;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Provider {
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettings {
    /// Provider id in use (`aiproxy`, `pollinations`, `ollama`, `openrouter`, …).
    pub active: String,
    pub providers: BTreeMap<String, Provider>,
    /// Apply file edits without asking first (they stay undoable).
    pub auto_apply: bool,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self { active: String::new(), providers: BTreeMap::new(), auto_apply: false }
    }
}

/// What the UI sees: everything except the keys themselves.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    pub base_url: String,
    pub model: String,
    pub has_key: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsView {
    pub active: String,
    pub providers: BTreeMap<String, ProviderView>,
    pub auto_apply: bool,
}

impl AiSettings {
    pub fn view(&self) -> AiSettingsView {
        AiSettingsView {
            active: self.active.clone(),
            providers: self
                .providers
                .iter()
                .map(|(id, p)| {
                    (
                        id.clone(),
                        ProviderView {
                            base_url: p.base_url.clone(),
                            model: p.model.clone(),
                            has_key: p.api_key.as_deref().is_some_and(|k| !k.is_empty()),
                        },
                    )
                })
                .collect(),
            auto_apply: self.auto_apply,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPatch {
    pub id: String,
    pub base_url: Option<String>,
    pub model: Option<String>,
    /// `Some("")` clears the key.
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsPatch {
    pub active: Option<String>,
    pub provider: Option<ProviderPatch>,
    pub auto_apply: Option<bool>,
}

static SETTINGS: Mutex<Option<AiSettings>> = Mutex::new(None);
static CANCELLED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn settings_file(config: &Path) -> PathBuf {
    config.join("ai.json")
}

fn with_settings<T>(config: &Path, f: impl FnOnce(&mut AiSettings) -> T) -> T {
    let mut guard = SETTINGS.lock().unwrap_or_else(|e| e.into_inner());
    let settings = guard.get_or_insert_with(|| {
        std::fs::read(settings_file(config))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    });
    f(settings)
}

fn save(config: &Path, settings: &AiSettings) -> AppResult<()> {
    let json = serde_json::to_vec_pretty(settings).map_err(|e| AppError::new("settings", e.to_string()))?;
    atomic_write(&settings_file(config), &json)
}

fn check_id(id: &str) -> AppResult<()> {
    if id.is_empty() || id.len() > 40 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(AppError::invalid("Invalid AI provider id."));
    }
    Ok(())
}

fn check_base_url(url: &str) -> AppResult<String> {
    let url = url.trim().trim_end_matches('/').to_string();
    if url.is_empty() {
        return Ok(url);
    }
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) || url.len() > 400 || url.chars().any(|c| c.is_whitespace()) {
        return Err(AppError::invalid("The API address must start with http:// or https://."));
    }
    Ok(url)
}

pub fn get_settings(config: &Path) -> AiSettingsView {
    with_settings(config, |s| s.view())
}

pub fn update_settings(config: &Path, patch: AiSettingsPatch) -> AppResult<AiSettingsView> {
    with_settings(config, |s| {
        let mut next = s.clone();
        if let Some(active) = patch.active {
            check_id(&active)?;
            next.active = active;
        }
        if let Some(auto) = patch.auto_apply {
            next.auto_apply = auto;
        }
        if let Some(p) = patch.provider {
            check_id(&p.id)?;
            let entry = next.providers.entry(p.id).or_default();
            if let Some(url) = p.base_url {
                entry.base_url = check_base_url(&url)?;
            }
            if let Some(model) = p.model {
                entry.model = model.trim().chars().take(200).collect();
            }
            if let Some(key) = p.api_key {
                let key = key.trim().to_string();
                if key.len() > 1000 || key.chars().any(|c| c.is_control()) {
                    return Err(AppError::invalid("That API key does not look right."));
                }
                entry.api_key = if key.is_empty() { None } else { Some(key) };
            }
        }
        save(config, &next)?;
        *s = next;
        Ok(s.view())
    })
}

fn active_provider(config: &Path) -> AppResult<Provider> {
    with_settings(config, |s| {
        let provider = s.providers.get(&s.active).cloned().ok_or_else(|| {
            AppError::new("ai_setup", "Choose an AI provider in the assistant settings first.")
        })?;
        if provider.base_url.is_empty() {
            return Err(AppError::new("ai_setup", "The AI provider has no API address set."));
        }
        Ok(provider)
    })
}

// ----- AIProxy (local CLIProxyAPI pool) ------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProxyDetection {
    pub found: bool,
    pub base_url: Option<String>,
    pub running: bool,
    pub models: Vec<String>,
    pub message: String,
}

fn aiproxy_secrets() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(base).join("AIProxy").join("state").join("secrets.json"))
}

/// Find a local AIProxy install, store its address and access key under the
/// `aiproxy` provider, and check that it answers.
pub fn detect_aiproxy(config: &Path, user_agent: &str) -> AppResult<AiProxyDetection> {
    let Some(path) = aiproxy_secrets().filter(|p| p.is_file()) else {
        return Ok(AiProxyDetection {
            found: false,
            base_url: None,
            running: false,
            models: vec![],
            message: "AIProxy is not installed on this PC (no %LOCALAPPDATA%\\AIProxy). Run its Install.cmd, or enter the address and key by hand.".into(),
        });
    };
    let bytes = std::fs::read(&path).map_err(|e| AppError::io("Could not read the AIProxy settings", e))?;
    let secrets: Value = serde_json::from_slice(&bytes).map_err(|_| AppError::invalid("The AIProxy settings file could not be read."))?;
    let port = secrets.get("port").and_then(Value::as_u64).filter(|p| (1..=65535).contains(p)).unwrap_or(8317);
    let key = secrets.get("accessKey").and_then(Value::as_str).unwrap_or_default().to_string();
    let base_url = format!("http://127.0.0.1:{port}/v1");
    update_settings(
        config,
        AiSettingsPatch {
            active: None,
            auto_apply: None,
            provider: Some(ProviderPatch {
                id: "aiproxy".into(),
                base_url: Some(base_url.clone()),
                model: None,
                api_key: if key.is_empty() { None } else { Some(key.clone()) },
            }),
        },
    )?;
    let provider = Provider { base_url: base_url.clone(), model: String::new(), api_key: Some(key) };
    match fetch_models(&provider, user_agent) {
        Ok(models) => Ok(AiProxyDetection {
            found: true,
            base_url: Some(base_url),
            running: true,
            message: format!("Connected to AIProxy ({} models).", models.len()),
            models,
        }),
        Err(error) => Ok(AiProxyDetection {
            found: true,
            base_url: Some(base_url),
            running: false,
            models: vec![],
            message: format!("AIProxy is installed but did not answer ({}). Run `aiproxy start` or `aiproxy doctor`.", error.message),
        }),
    }
}

// ----- HTTP ----------------------------------------------------------------------

fn agent(user_agent: &str, stream: bool) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(15)))
        // Reasoning models can think for a while before the first byte.
        .timeout_recv_response(Some(Duration::from_secs(if stream { 300 } else { 30 })))
        .timeout_global(Some(Duration::from_secs(if stream { 900 } else { 40 })))
        .http_status_as_error(false)
        .user_agent(user_agent)
        .build()
        .into()
}

fn bearer(provider: &Provider) -> Option<String> {
    provider.api_key.as_deref().filter(|k| !k.is_empty()).map(|k| format!("Bearer {k}"))
}

/// Pull a readable message out of an error body (OpenAI style or plain text).
fn error_text(status: u16, body: &str) -> String {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let message = parsed
        .as_ref()
        .and_then(|v| {
            v.pointer("/error/message")
                .or_else(|| v.get("error"))
                .or_else(|| v.get("message"))
                .or_else(|| v.get("detail"))
        })
        .map(|m| m.as_str().map(str::to_string).unwrap_or_else(|| m.to_string()))
        .unwrap_or_else(|| body.chars().take(400).collect());
    let hint = match status {
        401 | 403 => " Check the API key.",
        404 => " Check the API address and model name.",
        429 => " The provider is rate limiting; wait a moment or pick another model.",
        _ => "",
    };
    format!("The AI provider answered HTTP {status}: {}{hint}", message.trim())
}

fn read_error(response: &mut ureq::http::Response<ureq::Body>) -> String {
    let status = response.status().as_u16();
    let body = response.body_mut().with_config().limit(MAX_ERROR_BODY).read_to_string().unwrap_or_default();
    error_text(status, &body)
}

fn network_error(e: ureq::Error) -> AppError {
    AppError::new("network", format!("Could not reach the AI provider: {e}"))
}

pub fn fetch_models(provider: &Provider, user_agent: &str) -> AppResult<Vec<String>> {
    let mut request = agent(user_agent, false).get(format!("{}/models", provider.base_url)).header("Accept", "application/json");
    if let Some(auth) = bearer(provider) {
        request = request.header("Authorization", auth);
    }
    let mut response = request.call().map_err(network_error)?;
    if !response.status().is_success() {
        return Err(AppError::new("ai_http", read_error(&mut response)));
    }
    let body = response
        .body_mut()
        .with_config()
        .limit(MAX_MODELS_BODY)
        .read_to_string()
        .map_err(|e| AppError::new("network", format!("Could not read the model list: {e}")))?;
    let value: Value = serde_json::from_str(&body).map_err(|_| AppError::new("ai_http", "The model list was not JSON."))?;
    Ok(parse_models(&value))
}

/// `{data:[{id}]}` (OpenAI), `{models:[{name}]}` (Ollama native) or `[{name}]` (Pollinations).
pub fn parse_models(value: &Value) -> Vec<String> {
    let list = value
        .get("data")
        .or_else(|| value.get("models"))
        .unwrap_or(value)
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut out: Vec<String> = list
        .iter()
        .filter_map(|m| {
            m.as_str()
                .map(str::to_string)
                .or_else(|| m.get("id").or_else(|| m.get("name")).and_then(Value::as_str).map(str::to_string))
        })
        .filter(|id| !id.is_empty() && id.len() < 200)
        .collect();
    out.dedup();
    out
}

pub fn models(config: &Path, user_agent: &str) -> AppResult<Vec<String>> {
    fetch_models(&active_provider(config)?, user_agent)
}

// ----- chat ----------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReply {
    pub content: String,
    pub reasoning: String,
    pub tool_calls: Vec<ToolCall>,
    pub finish_reason: Option<String>,
    pub model: Option<String>,
    pub cancelled: bool,
}

/// One streamed piece of an answer, sent to the window as `ai-stream`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamDelta {
    pub request_id: String,
    pub content: Option<String>,
    pub reasoning: Option<String>,
    /// Name of a tool the model started calling.
    pub tool: Option<String>,
}

pub fn cancel(request_id: &str) {
    let mut guard = CANCELLED.lock().unwrap_or_else(|e| e.into_inner());
    guard.get_or_insert_with(HashSet::new).insert(request_id.to_string());
}

fn take_cancelled(request_id: &str) -> bool {
    let mut guard = CANCELLED.lock().unwrap_or_else(|e| e.into_inner());
    guard.as_mut().is_some_and(|set| set.remove(request_id))
}

/// Collects streamed chunks into one reply.
#[derive(Default)]
pub struct Assembler {
    pub reply: ChatReply,
    calls: BTreeMap<u64, ToolCall>,
}

impl Assembler {
    /// Feed one parsed chunk (or a whole non-streamed completion); returns what to show.
    pub fn push(&mut self, chunk: &Value) -> (Option<String>, Option<String>, Option<String>) {
        if let Some(model) = chunk.get("model").and_then(Value::as_str) {
            self.reply.model.get_or_insert_with(|| model.to_string());
        }
        let Some(choice) = chunk.get("choices").and_then(|c| c.get(0)) else {
            return (None, None, None);
        };
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.reply.finish_reason = Some(reason.to_string());
        }
        let delta = choice.get("delta").or_else(|| choice.get("message"));
        let Some(delta) = delta else { return (None, None, None) };
        let text = |key: &str| delta.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
        let content = text("content");
        let reasoning = text("reasoning").or_else(|| text("reasoning_content"));
        if let Some(c) = &content {
            if self.reply.content.len() < MAX_REPLY_CHARS {
                self.reply.content.push_str(c);
            }
        }
        if let Some(r) = &reasoning {
            if self.reply.reasoning.len() < MAX_REPLY_CHARS {
                self.reply.reasoning.push_str(r);
            }
        }
        let mut started = None;
        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for (position, call) in calls.iter().enumerate() {
                let index = call.get("index").and_then(Value::as_u64).unwrap_or(position as u64);
                let entry = self.calls.entry(index).or_default();
                if let Some(id) = call.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    entry.id = id.to_string();
                }
                if let Some(function) = call.get("function") {
                    if let Some(name) = function.get("name").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                        // Names arrive whole in the first chunk; some servers repeat them.
                        if entry.name.is_empty() {
                            entry.name = name.to_string();
                            started = Some(name.to_string());
                        }
                    }
                    match function.get("arguments") {
                        Some(Value::String(args)) => entry.arguments.push_str(args),
                        Some(other @ Value::Object(_)) => entry.arguments = other.to_string(),
                        _ => {}
                    }
                }
            }
        }
        (content, reasoning, started)
    }

    pub fn finish(mut self) -> ChatReply {
        self.reply.tool_calls = self
            .calls
            .into_iter()
            .filter(|(_, c)| !c.name.is_empty())
            .map(|(i, mut c)| {
                if c.id.is_empty() {
                    c.id = format!("call_{i}");
                }
                if c.arguments.trim().is_empty() {
                    c.arguments = "{}".into();
                }
                c
            })
            .collect();
        self.reply
    }
}

/// Send `messages` (+ optional `tools`) to the active provider and stream the
/// answer through `on_delta`. The model comes from settings unless given.
pub fn chat(
    config: &Path,
    user_agent: &str,
    request_id: &str,
    mut body: Value,
    mut on_delta: impl FnMut(StreamDelta),
) -> AppResult<ChatReply> {
    take_cancelled(request_id);
    let provider = active_provider(config)?;
    let Some(object) = body.as_object_mut() else {
        return Err(AppError::invalid("Invalid chat request."));
    };
    if !object.get("messages").is_some_and(Value::is_array) {
        return Err(AppError::invalid("A chat request needs messages."));
    }
    if !object.contains_key("model") || object.get("model").is_some_and(|m| m.as_str().is_none_or(str::is_empty)) {
        if provider.model.is_empty() {
            return Err(AppError::new("ai_setup", "Pick a model for the AI provider first."));
        }
        object.insert("model".into(), json!(provider.model));
    }
    object.insert("stream".into(), json!(true));
    if object.get("tools").is_some_and(|t| t.as_array().is_some_and(Vec::is_empty)) {
        object.remove("tools");
    }
    let payload = serde_json::to_vec(&body).map_err(|e| AppError::invalid(e.to_string()))?;

    let mut request = agent(user_agent, true)
        .post(format!("{}/chat/completions", provider.base_url))
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream");
    if let Some(auth) = bearer(&provider) {
        request = request.header("Authorization", auth);
    }
    let mut response = request.send(&payload[..]).map_err(network_error)?;
    if !response.status().is_success() {
        return Err(AppError::new("ai_http", read_error(&mut response)));
    }
    let is_sse = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("event-stream"));

    let mut assembler = Assembler::default();
    let emit = |assembler: &mut Assembler, chunk: &Value, on_delta: &mut dyn FnMut(StreamDelta)| {
        let (content, reasoning, tool) = assembler.push(chunk);
        if content.is_some() || reasoning.is_some() || tool.is_some() {
            on_delta(StreamDelta { request_id: request_id.to_string(), content, reasoning, tool });
        }
    };

    let reader = response.body_mut().with_config().limit(64 * 1024 * 1024).reader();
    if !is_sse {
        // The provider ignored `stream` and sent one JSON completion.
        let mut text = String::new();
        BufReader::new(reader)
            .take(16 * 1024 * 1024)
            .read_to_string(&mut text)
            .map_err(|e| AppError::new("network", format!("Could not read the AI answer: {e}")))?;
        let value: Value = serde_json::from_str(&text).map_err(|_| AppError::new("ai_http", "The AI provider sent an answer that is not JSON."))?;
        if let Some(error) = value.get("error") {
            return Err(AppError::new("ai_http", error_text(200, &json!({ "error": error }).to_string())));
        }
        emit(&mut assembler, &value, &mut on_delta);
        return Ok(assembler.finish());
    }

    let mut lines = BufReader::new(reader);
    let mut line = String::new();
    loop {
        if take_cancelled(request_id) {
            let mut reply = assembler.finish();
            reply.cancelled = true;
            return Ok(reply);
        }
        line.clear();
        let read = lines
            .read_line(&mut line)
            .map_err(|e| AppError::new("network", format!("The AI answer was cut off: {e}")))?;
        if read == 0 {
            break;
        }
        let Some(data) = line.trim_end().strip_prefix("data:") else { continue };
        let data = data.trim();
        if data == "[DONE]" {
            break;
        }
        let Ok(chunk) = serde_json::from_str::<Value>(data) else { continue };
        if let Some(error) = chunk.get("error") {
            return Err(AppError::new("ai_http", error_text(200, &json!({ "error": error }).to_string())));
        }
        emit(&mut assembler, &chunk, &mut on_delta);
    }
    Ok(assembler.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assembles_streamed_tool_calls() {
        let mut a = Assembler::default();
        a.push(&json!({"model":"m","choices":[{"delta":{"content":"Hi"}}]}));
        a.push(&json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}));
        a.push(&json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":"}}]}}]}));
        a.push(&json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a.xml\"}"}}]},"finish_reason":"tool_calls"}]}));
        let reply = a.finish();
        assert_eq!(reply.content, "Hi");
        assert_eq!(reply.model.as_deref(), Some("m"));
        assert_eq!(reply.finish_reason.as_deref(), Some("tool_calls"));
        assert_eq!(reply.tool_calls.len(), 1);
        assert_eq!(reply.tool_calls[0].name, "read_file");
        assert_eq!(reply.tool_calls[0].arguments, "{\"path\":\"a.xml\"}");
    }

    #[test]
    fn reads_whole_completion_and_reasoning() {
        let mut a = Assembler::default();
        a.push(&json!({"choices":[{"message":{"content":"Done","reasoning":"think","tool_calls":[]},"finish_reason":"stop"}]}));
        let reply = a.finish();
        assert_eq!(reply.content, "Done");
        assert_eq!(reply.reasoning, "think");
        assert!(reply.tool_calls.is_empty());
    }

    #[test]
    fn parses_model_lists() {
        assert_eq!(parse_models(&json!({"data":[{"id":"a"},{"id":"b"}]})), vec!["a", "b"]);
        assert_eq!(parse_models(&json!([{"name":"openai"}])), vec!["openai"]);
        assert_eq!(parse_models(&json!({"models":[{"name":"llama3"}]})), vec!["llama3"]);
    }

    #[test]
    fn error_text_prefers_message() {
        let text = error_text(401, r#"{"error":{"message":"bad key"}}"#);
        assert!(text.contains("bad key") && text.contains("API key"));
    }

    #[test]
    fn rejects_bad_urls_and_ids() {
        assert!(check_base_url("ftp://x").is_err());
        assert_eq!(check_base_url("https://a.b/v1/").unwrap(), "https://a.b/v1");
        assert!(check_id("../x").is_err());
    }
}
