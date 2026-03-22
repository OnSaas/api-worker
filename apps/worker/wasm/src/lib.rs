use serde::Serialize;
use serde_json::{Map, Value, json};
use wasm_bindgen::prelude::*;

#[derive(Serialize, Clone)]
struct NormalizedUsage {
    #[serde(rename = "totalTokens")]
    total_tokens: i64,
    #[serde(rename = "promptTokens")]
    prompt_tokens: i64,
    #[serde(rename = "completionTokens")]
    completion_tokens: i64,
}

#[derive(Serialize)]
struct GeminiUsageTokens {
    #[serde(rename = "promptTokens")]
    prompt_tokens: i64,
    #[serde(rename = "completionTokens")]
    completion_tokens: i64,
    #[serde(rename = "totalTokens")]
    total_tokens: i64,
}

fn to_number(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    match value {
        Value::Number(n) => n.as_i64().or_else(|| n.as_u64().map(|v| v as i64)),
        Value::String(s) => s.parse::<f64>().ok().map(|v| v as i64),
        _ => None,
    }
}

fn pick_number(obj: &Map<String, Value>, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|k| to_number(obj.get(*k)))
}

fn normalize_usage_value(raw: &Value) -> Option<NormalizedUsage> {
    let obj = raw.as_object()?;
    let prompt_tokens = pick_number(
        obj,
        &[
            "prompt_tokens",
            "promptTokens",
            "input_tokens",
            "inputTokens",
        ],
    );
    let completion_tokens = pick_number(
        obj,
        &[
            "completion_tokens",
            "completionTokens",
            "output_tokens",
            "outputTokens",
        ],
    );
    let mut total_tokens = pick_number(
        obj,
        &[
            "total_tokens",
            "totalTokens",
            "total",
            "tokens",
            "token_count",
        ],
    );
    if total_tokens.is_none() && (prompt_tokens.is_some() || completion_tokens.is_some()) {
        total_tokens = Some(prompt_tokens.unwrap_or(0) + completion_tokens.unwrap_or(0));
    }
    total_tokens.map(|total| NormalizedUsage {
        total_tokens: total,
        prompt_tokens: prompt_tokens.unwrap_or(0),
        completion_tokens: completion_tokens.unwrap_or(0),
    })
}

fn parse_json(payload: &str) -> Option<Value> {
    serde_json::from_str::<Value>(payload).ok()
}

fn parse_usage_from_payload_value(payload: &Value) -> Option<NormalizedUsage> {
    let data = payload.as_object()?;

    let usage = data
        .get("usage")
        .or_else(|| {
            data.get("response")
                .and_then(|v| v.as_object())
                .and_then(|o| o.get("usage"))
        })
        .or_else(|| {
            data.get("data")
                .and_then(|v| v.as_object())
                .and_then(|o| o.get("usage"))
        })
        .or_else(|| {
            data.get("message")
                .and_then(|v| v.as_object())
                .and_then(|o| o.get("usage"))
        });

    if let Some(u) = usage {
        if let Some(normalized) = normalize_usage_value(u) {
            return Some(normalized);
        }
    }

    let usage_metadata = data
        .get("usageMetadata")
        .or_else(|| data.get("usage_metadata"))
        .or_else(|| {
            data.get("response")
                .and_then(|v| v.as_object())
                .and_then(|o| o.get("usageMetadata"))
        })?;

    let usage_obj = usage_metadata.as_object()?;
    let mapped = json!({
      "prompt_tokens": usage_obj.get("promptTokenCount").cloned().or_else(|| usage_obj.get("prompt_tokens").cloned()).unwrap_or(Value::Null),
      "completion_tokens": usage_obj.get("candidatesTokenCount").cloned()
        .or_else(|| usage_obj.get("completionTokenCount").cloned())
        .or_else(|| usage_obj.get("output_tokens").cloned())
        .unwrap_or(Value::Null),
      "total_tokens": usage_obj.get("totalTokenCount").cloned().or_else(|| usage_obj.get("total_tokens").cloned()).unwrap_or(Value::Null),
    });
    normalize_usage_value(&mapped)
}

fn serialize_or_null<T: Serialize>(value: Option<T>) -> String {
    match value {
        Some(v) => serde_json::to_string(&v).unwrap_or_else(|_| "null".to_string()),
        None => "null".to_string(),
    }
}

fn parse_sse_payload(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let payload = trimmed.strip_prefix("data:").map_or(trimmed, str::trim);
    if payload.is_empty() || payload == "[DONE]" {
        return None;
    }
    Some(payload)
}

fn openai_content_to_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.to_string(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|part| match part {
                Value::String(s) => s.to_string(),
                Value::Object(obj) => obj
                    .get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                _ => String::new(),
            })
            .collect::<Vec<String>>()
            .join(""),
        _ => String::new(),
    }
}

fn anthropic_content_to_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::Array(items)) => items
            .iter()
            .map(|part| match part {
                Value::Object(obj) => {
                    if obj.get("type").and_then(|v| v.as_str()) == Some("text") {
                        obj.get("text")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string()
                    } else {
                        String::new()
                    }
                }
                _ => String::new(),
            })
            .collect::<Vec<String>>()
            .join(""),
        _ => String::new(),
    }
}

fn gemini_candidate_text(payload: &Value) -> String {
    let first_candidate = payload
        .as_object()
        .and_then(|o| o.get("candidates"))
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first());
    let parts = first_candidate
        .and_then(|c| c.as_object())
        .and_then(|c| c.get("content"))
        .and_then(|v| v.as_object())
        .and_then(|o| o.get("parts"))
        .and_then(|v| v.as_array());
    match parts {
        Some(parts) => parts
            .iter()
            .map(|part| {
                part.as_object()
                    .and_then(|o| o.get("text"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string()
            })
            .collect::<Vec<String>>()
            .join(""),
        None => String::new(),
    }
}

fn gemini_finish_reason(payload: &Value) -> Option<String> {
    payload
        .as_object()
        .and_then(|o| o.get("candidates"))
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|c| c.as_object())
        .and_then(|o| o.get("finishReason"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn replace_prefix(value: &str, from: &str, to: &str) -> String {
    if let Some(rest) = value.strip_prefix(from) {
        let mut out = String::with_capacity(to.len() + rest.len());
        out.push_str(to);
        out.push_str(rest);
        out
    } else {
        value.to_string()
    }
}

fn map_reason(kind: &str, reason: &str) -> Option<&'static str> {
    match kind {
        "openai_to_anthropic" => match reason {
            "stop" => Some("end_turn"),
            "length" => Some("max_tokens"),
            "tool_calls" | "function_call" => Some("tool_use"),
            "stop_sequence" => Some("stop_sequence"),
            _ => None,
        },
        "anthropic_to_openai" => match reason {
            "end_turn" => Some("stop"),
            "max_tokens" => Some("length"),
            "tool_use" => Some("tool_calls"),
            "stop_sequence" => Some("stop_sequence"),
            _ => None,
        },
        "gemini_to_openai" => match reason.to_ascii_uppercase().as_str() {
            "STOP" => Some("stop"),
            "MAX_TOKENS" => Some("length"),
            "STOP_SEQUENCE" => Some("stop_sequence"),
            "TOOL_CALL" | "FUNCTION_CALL" => Some("tool_calls"),
            _ => None,
        },
        "gemini_to_anthropic" => match reason.to_ascii_uppercase().as_str() {
            "STOP" => Some("end_turn"),
            "MAX_TOKENS" => Some("max_tokens"),
            "STOP_SEQUENCE" => Some("stop_sequence"),
            "TOOL_CALL" | "FUNCTION_CALL" => Some("tool_use"),
            _ => None,
        },
        "openai_to_gemini" => match reason {
            "stop" => Some("STOP"),
            "length" => Some("MAX_TOKENS"),
            "stop_sequence" => Some("STOP_SEQUENCE"),
            "tool_calls" | "function_call" => Some("TOOL_CALL"),
            _ => None,
        },
        "anthropic_to_gemini" => match reason {
            "end_turn" => Some("STOP"),
            "max_tokens" => Some("MAX_TOKENS"),
            "stop_sequence" => Some("STOP_SEQUENCE"),
            "tool_use" => Some("TOOL_CALL"),
            _ => None,
        },
        _ => None,
    }
}

fn gemini_usage_tokens(payload: &Value) -> GeminiUsageTokens {
    let usage_obj = payload
        .as_object()
        .and_then(|o| o.get("usageMetadata"))
        .and_then(|v| v.as_object());
    let prompt = usage_obj
        .and_then(|o| {
            to_number(o.get("promptTokenCount")).or_else(|| to_number(o.get("inputTokenCount")))
        })
        .unwrap_or(0);
    let completion = usage_obj
        .and_then(|o| {
            to_number(o.get("candidatesTokenCount"))
                .or_else(|| to_number(o.get("outputTokenCount")))
        })
        .unwrap_or(0);
    let total = usage_obj
        .and_then(|o| to_number(o.get("totalTokenCount")))
        .unwrap_or(prompt + completion);
    GeminiUsageTokens {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: total,
    }
}

fn detect_provider(path: &str) -> &'static str {
    if path.starts_with("/v1beta/") {
        return "gemini";
    }
    if path == "/v1/messages" || path.starts_with("/v1/messages/") {
        return "anthropic";
    }
    "openai"
}

fn detect_endpoint(provider: &str, path: &str) -> &'static str {
    if provider == "openai" {
        if path.starts_with("/v1/chat/completions") {
            return "chat";
        }
        if path.starts_with("/v1/responses") {
            return "responses";
        }
        if path.starts_with("/v1/embeddings") {
            return "embeddings";
        }
        if path.starts_with("/v1/images") {
            return "images";
        }
        return "passthrough";
    }
    if provider == "anthropic" {
        if path.starts_with("/v1/messages") {
            return "chat";
        }
        return "passthrough";
    }
    if path.contains(":generateContent") || path.contains(":streamGenerateContent") {
        return "chat";
    }
    if path.contains(":embedContent") || path.contains(":batchEmbedContents") {
        return "embeddings";
    }
    if path.contains(":generateImage") || path.contains(":streamGenerateImage") {
        return "images";
    }
    "passthrough"
}

fn parse_model_from_path(path: &str) -> Option<String> {
    let marker = "/models/";
    let idx = path.find(marker)?;
    let rest = &path[idx + marker.len()..];
    if rest.is_empty() {
        return None;
    }
    let end = rest
        .find(':')
        .or_else(|| rest.find('/'))
        .unwrap_or(rest.len());
    let model = &rest[..end];
    if model.is_empty() {
        return None;
    }
    Some(model.to_string())
}

fn apply_model_to_gemini_path(path: &str, model: &str) -> String {
    if !path.contains("/models/") {
        return path.to_string();
    }
    let marker = "/models/";
    let Some(idx) = path.find(marker) else {
        return path.to_string();
    };
    let start = idx + marker.len();
    let tail = &path[start..];
    let rel_end = tail
        .find(':')
        .or_else(|| tail.find('/'))
        .unwrap_or(tail.len());
    let end = start + rel_end;
    let mut output = String::with_capacity(path.len() + model.len());
    output.push_str(&path[..start]);
    output.push_str(model);
    output.push_str(&path[end..]);
    output
}

struct XorShift64 {
    state: u64,
}

impl XorShift64 {
    fn new(seed: u64) -> Self {
        let s = if seed == 0 { 0x9E3779B97F4A7C15 } else { seed };
        Self { state: s }
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.state = x;
        x
    }

    fn next_f64(&mut self) -> f64 {
        (self.next_u64() as f64) / (u64::MAX as f64)
    }
}

#[wasm_bindgen]
pub fn normalize_usage_json(payload_json: &str) -> String {
    let Some(payload) = parse_json(payload_json) else {
        return "null".to_string();
    };
    serialize_or_null(normalize_usage_value(&payload))
}

#[wasm_bindgen]
pub fn parse_usage_from_json(payload_json: &str) -> String {
    let Some(payload) = parse_json(payload_json) else {
        return "null".to_string();
    };
    serialize_or_null(parse_usage_from_payload_value(&payload))
}

#[wasm_bindgen]
pub fn parse_usage_from_sse_line(line: &str) -> String {
    let Some(payload) = parse_sse_payload(line) else {
        return "null".to_string();
    };
    let Some(value) = parse_json(payload) else {
        return "null".to_string();
    };
    serialize_or_null(parse_usage_from_payload_value(&value))
}

#[wasm_bindgen]
pub fn map_finish_reason(kind: &str, reason: &str) -> String {
    map_reason(kind, reason).unwrap_or("").to_string()
}

#[wasm_bindgen]
pub fn gemini_usage_tokens_json(payload_json: &str) -> String {
    let Some(payload) = parse_json(payload_json) else {
        return serde_json::to_string(&GeminiUsageTokens {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        })
        .unwrap_or_else(|_| {
            "{\"promptTokens\":0,\"completionTokens\":0,\"totalTokens\":0}".to_string()
        });
    };
    serde_json::to_string(&gemini_usage_tokens(&payload)).unwrap_or_else(|_| {
        "{\"promptTokens\":0,\"completionTokens\":0,\"totalTokens\":0}".to_string()
    })
}

#[wasm_bindgen]
pub fn detect_downstream_provider(path: &str) -> String {
    detect_provider(path).to_string()
}

#[wasm_bindgen]
pub fn detect_endpoint_type(provider: &str, path: &str) -> String {
    detect_endpoint(provider, path).to_string()
}

#[wasm_bindgen]
pub fn parse_downstream_model(provider: &str, path: &str, body_json: &str) -> String {
    if provider == "gemini" {
        if let Some(model) = parse_model_from_path(path) {
            return model;
        }
    }
    let Some(body) = parse_json(body_json) else {
        return String::new();
    };
    let model = body
        .as_object()
        .and_then(|o| o.get("model"))
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    model.to_string()
}

#[wasm_bindgen]
pub fn parse_downstream_stream(provider: &str, path: &str, body_json: &str) -> bool {
    if provider == "gemini"
        && (path.contains(":streamGenerateContent") || path.contains(":streamGenerateImage"))
    {
        return true;
    }
    parse_json(body_json)
        .and_then(|v| v.as_object().cloned())
        .and_then(|o| o.get("stream").cloned())
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

#[wasm_bindgen]
pub fn apply_gemini_model_to_path(path: &str, model: &str) -> String {
    if model.is_empty() {
        return path.to_string();
    }
    apply_model_to_gemini_path(path, model)
}

#[wasm_bindgen]
pub fn create_weighted_order(weights_json: &str, seed: u64) -> String {
    let Ok(raw_weights) = serde_json::from_str::<Vec<f64>>(weights_json) else {
        return "[]".to_string();
    };
    if raw_weights.is_empty() {
        return "[]".to_string();
    }
    let mut pool: Vec<(usize, f64)> = raw_weights
        .into_iter()
        .enumerate()
        .map(|(idx, w)| (idx, if w.is_finite() && w > 0.0 { w } else { 1.0 }))
        .collect();
    let mut rng = XorShift64::new(seed);
    let mut ordered: Vec<usize> = Vec::with_capacity(pool.len());
    while !pool.is_empty() {
        let total: f64 = pool.iter().map(|(_, w)| *w).sum();
        let mut roll = rng.next_f64() * total.max(1e-9);
        let mut index = 0usize;
        for (i, (_, weight)) in pool.iter().enumerate() {
            roll -= *weight;
            if roll <= 0.0 {
                index = i;
                break;
            }
            if i == pool.len() - 1 {
                index = i;
            }
        }
        let (selected, _) = pool.remove(index);
        ordered.push(selected);
    }
    serde_json::to_string(&ordered).unwrap_or_else(|_| "[]".to_string())
}

#[wasm_bindgen]
pub fn adapt_chat_json(direction: &str, payload_json: &str, model: &str, now_ms: u64) -> String {
    let Some(payload) = parse_json(payload_json) else {
        return String::new();
    };
    let now_secs = (now_ms / 1000) as i64;
    let model_value = if model.is_empty() {
        payload
            .as_object()
            .and_then(|o| o.get("model"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string()
    } else {
        model.to_string()
    };

    let transformed = match direction {
        "openai_to_anthropic" => {
            let choices = payload
                .as_object()
                .and_then(|o| o.get("choices"))
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let first = choices
                .first()
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            let message = first
                .get("message")
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            let usage = payload
                .as_object()
                .and_then(|o| o.get("usage"))
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            let prompt = to_number(usage.get("prompt_tokens")).unwrap_or(0);
            let completion = to_number(usage.get("completion_tokens")).unwrap_or(0);
            let stop_reason = first
                .get("finish_reason")
                .and_then(|v| v.as_str())
                .and_then(|reason| map_reason("openai_to_anthropic", reason));
            let text = openai_content_to_text(message.get("content"));
            json!({
                "id": payload.as_object().and_then(|o| o.get("id")).and_then(|v| v.as_str()).map(|s| replace_prefix(s, "chatcmpl", "msg")).unwrap_or_else(|| format!("msg_{}", now_ms)),
                "type": "message",
                "role": "assistant",
                "model": model_value,
                "content": if text.is_empty() { Value::Array(vec![]) } else { json!([{ "type": "text", "text": text }]) },
                "stop_reason": stop_reason,
                "stop_sequence": Value::Null,
                "usage": {
                    "input_tokens": prompt,
                    "output_tokens": completion,
                },
            })
        }
        "anthropic_to_openai" => {
            let usage = payload
                .as_object()
                .and_then(|o| o.get("usage"))
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            let prompt = to_number(usage.get("input_tokens")).unwrap_or(0);
            let completion = to_number(usage.get("output_tokens")).unwrap_or(0);
            let text =
                anthropic_content_to_text(payload.as_object().and_then(|o| o.get("content")));
            let stop_reason = payload
                .as_object()
                .and_then(|o| o.get("stop_reason"))
                .and_then(|v| v.as_str())
                .and_then(|reason| map_reason("anthropic_to_openai", reason));
            json!({
                "id": payload.as_object().and_then(|o| o.get("id")).and_then(|v| v.as_str()).map(|s| replace_prefix(s, "msg", "chatcmpl")).unwrap_or_else(|| format!("chatcmpl_{}", now_ms)),
                "object": "chat.completion",
                "created": now_secs,
                "model": model_value,
                "choices": [{
                    "index": 0,
                    "message": { "role": "assistant", "content": text },
                    "finish_reason": stop_reason,
                }],
                "usage": {
                    "prompt_tokens": prompt,
                    "completion_tokens": completion,
                    "total_tokens": prompt + completion,
                },
            })
        }
        "gemini_to_openai" => {
            let text = gemini_candidate_text(&payload);
            let usage = gemini_usage_tokens(&payload);
            let finish = gemini_finish_reason(&payload)
                .and_then(|r| map_reason("gemini_to_openai", &r).map(|s| s.to_string()));
            json!({
                "id": format!("chatcmpl_{}", now_ms),
                "object": "chat.completion",
                "created": now_secs,
                "model": model_value,
                "choices": [{
                    "index": 0,
                    "message": { "role": "assistant", "content": text },
                    "finish_reason": finish,
                }],
                "usage": {
                    "prompt_tokens": usage.prompt_tokens,
                    "completion_tokens": usage.completion_tokens,
                    "total_tokens": usage.total_tokens,
                },
            })
        }
        "gemini_to_anthropic" => {
            let text = gemini_candidate_text(&payload);
            let usage = gemini_usage_tokens(&payload);
            let stop_reason = gemini_finish_reason(&payload)
                .and_then(|r| map_reason("gemini_to_anthropic", &r).map(|s| s.to_string()));
            json!({
                "id": format!("msg_{}", now_ms),
                "type": "message",
                "role": "assistant",
                "model": model_value,
                "content": if text.is_empty() { Value::Array(vec![]) } else { json!([{ "type": "text", "text": text }]) },
                "stop_reason": stop_reason,
                "stop_sequence": Value::Null,
                "usage": {
                    "input_tokens": usage.prompt_tokens,
                    "output_tokens": usage.completion_tokens,
                },
            })
        }
        "openai_to_gemini" => {
            let choices = payload
                .as_object()
                .and_then(|o| o.get("choices"))
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let first = choices
                .first()
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            let message = first
                .get("message")
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            let text = openai_content_to_text(message.get("content"));
            let usage = payload
                .as_object()
                .and_then(|o| o.get("usage"))
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            let prompt = to_number(usage.get("prompt_tokens")).unwrap_or(0);
            let completion = to_number(usage.get("completion_tokens")).unwrap_or(0);
            let finish = first
                .get("finish_reason")
                .and_then(|v| v.as_str())
                .and_then(|reason| map_reason("openai_to_gemini", reason));
            json!({
                "candidates": [{
                    "content": { "role": "model", "parts": if text.is_empty() { Value::Array(vec![]) } else { json!([{ "text": text }]) } },
                    "finishReason": finish,
                }],
                "usageMetadata": {
                    "promptTokenCount": prompt,
                    "candidatesTokenCount": completion,
                    "totalTokenCount": prompt + completion,
                },
            })
        }
        "anthropic_to_gemini" => {
            let text =
                anthropic_content_to_text(payload.as_object().and_then(|o| o.get("content")));
            let usage = payload
                .as_object()
                .and_then(|o| o.get("usage"))
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            let prompt = to_number(usage.get("input_tokens")).unwrap_or(0);
            let completion = to_number(usage.get("output_tokens")).unwrap_or(0);
            let finish = payload
                .as_object()
                .and_then(|o| o.get("stop_reason"))
                .and_then(|v| v.as_str())
                .and_then(|reason| map_reason("anthropic_to_gemini", reason));
            json!({
                "candidates": [{
                    "content": { "role": "model", "parts": if text.is_empty() { Value::Array(vec![]) } else { json!([{ "text": text }]) } },
                    "finishReason": finish,
                }],
                "usageMetadata": {
                    "promptTokenCount": prompt,
                    "candidatesTokenCount": completion,
                    "totalTokenCount": prompt + completion,
                },
            })
        }
        _ => return String::new(),
    };

    serde_json::to_string(&transformed).unwrap_or_default()
}

fn numeric_value(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    match value {
        Value::Number(n) => n
            .as_f64()
            .or_else(|| n.as_i64().map(|v| v as f64))
            .or_else(|| n.as_u64().map(|v| v as f64)),
        Value::String(s) => s.parse::<f64>().ok(),
        _ => None,
    }
}

fn number_or_null(value: Option<&Value>) -> Value {
    numeric_value(value).map(Value::from).unwrap_or(Value::Null)
}

fn value_to_text(value: Option<&Value>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Array(items) => items
            .iter()
            .map(|item| value_to_text(Some(item)))
            .collect::<Vec<String>>()
            .join(""),
        Value::Object(obj) => {
            if let Some(text) = obj.get("text").and_then(|v| v.as_str()) {
                return text.to_string();
            }
            if let Some(parts) = obj.get("parts").and_then(|v| v.as_array()) {
                return parts
                    .iter()
                    .map(|part| value_to_text(Some(part)))
                    .collect::<Vec<String>>()
                    .join("");
            }
            if obj.get("content").is_some() {
                return value_to_text(obj.get("content"));
            }
            String::new()
        }
    }
}

fn normalize_tool_args_value(value: Option<&Value>) -> Value {
    let Some(value) = value else {
        return json!({});
    };
    if let Some(raw) = value.as_str() {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Value::String(raw.to_string());
        }
        return parse_json(trimmed).unwrap_or_else(|| Value::String(raw.to_string()));
    }
    value.clone()
}

fn to_input_schema_value(value: Option<&Value>) -> Value {
    let Some(value) = value else {
        return Value::Null;
    };
    if value.is_object() {
        return value.clone();
    }
    Value::Null
}

fn extract_system_text(value: Option<&Value>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    match value {
        Value::String(s) => s.to_string(),
        Value::Array(arr) => arr
            .iter()
            .map(|item| value_to_text(Some(item)))
            .collect::<Vec<String>>()
            .join(""),
        Value::Object(obj) => obj
            .get("text")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string())
            .unwrap_or_else(|| value_to_text(Some(value))),
        _ => String::new(),
    }
}

fn normalize_tools_from_openai(raw: Option<&Value>) -> Vec<Value> {
    let Some(items) = raw.and_then(|v| v.as_array()) else {
        return vec![];
    };
    let mut tools: Vec<Value> = vec![];
    for item in items {
        let Some(item_obj) = item.as_object() else {
            continue;
        };
        if item_obj.get("type").and_then(|v| v.as_str()) != Some("function") {
            continue;
        }
        let Some(fn_obj) = item_obj.get("function").and_then(|v| v.as_object()) else {
            continue;
        };
        let Some(name) = fn_obj.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        let mut tool = Map::new();
        tool.insert("name".to_string(), Value::String(name.to_string()));
        if let Some(description) = fn_obj.get("description").and_then(|v| v.as_str()) {
            tool.insert(
                "description".to_string(),
                Value::String(description.to_string()),
            );
        }
        tool.insert(
            "parameters".to_string(),
            to_input_schema_value(fn_obj.get("parameters")),
        );
        tools.push(Value::Object(tool));
    }
    tools
}

fn normalize_tools_from_anthropic(raw: Option<&Value>) -> Vec<Value> {
    let Some(items) = raw.and_then(|v| v.as_array()) else {
        return vec![];
    };
    let mut tools: Vec<Value> = vec![];
    for item in items {
        let Some(item_obj) = item.as_object() else {
            continue;
        };
        let Some(name) = item_obj.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        let mut tool = Map::new();
        tool.insert("name".to_string(), Value::String(name.to_string()));
        if let Some(description) = item_obj.get("description").and_then(|v| v.as_str()) {
            tool.insert(
                "description".to_string(),
                Value::String(description.to_string()),
            );
        }
        tool.insert(
            "parameters".to_string(),
            to_input_schema_value(item_obj.get("input_schema")),
        );
        tools.push(Value::Object(tool));
    }
    tools
}

fn normalize_tools_from_gemini(raw: Option<&Value>) -> Vec<Value> {
    let Some(items) = raw.and_then(|v| v.as_array()) else {
        return vec![];
    };
    let mut tools: Vec<Value> = vec![];
    for item in items {
        let Some(item_obj) = item.as_object() else {
            continue;
        };
        let Some(declarations) = item_obj
            .get("functionDeclarations")
            .and_then(|v| v.as_array())
        else {
            continue;
        };
        for declaration in declarations {
            let Some(decl_obj) = declaration.as_object() else {
                continue;
            };
            let Some(name) = decl_obj.get("name").and_then(|v| v.as_str()) else {
                continue;
            };
            let mut tool = Map::new();
            tool.insert("name".to_string(), Value::String(name.to_string()));
            if let Some(description) = decl_obj.get("description").and_then(|v| v.as_str()) {
                tool.insert(
                    "description".to_string(),
                    Value::String(description.to_string()),
                );
            }
            tool.insert(
                "parameters".to_string(),
                to_input_schema_value(decl_obj.get("parameters")),
            );
            tools.push(Value::Object(tool));
        }
    }
    tools
}

fn normalize_openai_messages(raw: Option<&Value>) -> Vec<Value> {
    let Some(items) = raw.and_then(|v| v.as_array()) else {
        return vec![];
    };
    let mut messages: Vec<Value> = vec![];
    for (idx, item) in items.iter().enumerate() {
        let Some(item_obj) = item.as_object() else {
            continue;
        };
        let item_type = item_obj
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if item_obj.get("role").is_none() {
            if item_type == "function_call_output" {
                messages.push(json!({
                    "role": "tool",
                    "content": value_to_text(item_obj.get("output").or_else(|| item_obj.get("content"))),
                    "toolCallId": item_obj.get("call_id").or_else(|| item_obj.get("tool_call_id")).and_then(|v| v.as_str()).map(|v| v.to_string())
                }));
                continue;
            }
            if item_type == "function_call" {
                let function_obj = item_obj.get("function").and_then(|v| v.as_object());
                let name = item_obj.get("name").and_then(|v| v.as_str()).or_else(|| {
                    function_obj
                        .and_then(|fn_obj| fn_obj.get("name"))
                        .and_then(|v| v.as_str())
                });
                if let Some(name) = name {
                    let args_value = item_obj
                        .get("arguments")
                        .or_else(|| item_obj.get("args"))
                        .or_else(|| item_obj.get("input"))
                        .or_else(|| function_obj.and_then(|fn_obj| fn_obj.get("arguments")))
                        .or_else(|| function_obj.and_then(|fn_obj| fn_obj.get("args")))
                        .or_else(|| function_obj.and_then(|fn_obj| fn_obj.get("input")));
                    messages.push(json!({
                        "role": "assistant",
                        "content": "",
                        "toolCalls": [{
                            "id": item_obj.get("call_id").or_else(|| item_obj.get("id")).and_then(|v| v.as_str()).map(|v| v.to_string()).unwrap_or_else(|| format!("call_{}_fc", idx)),
                            "name": name,
                            "args": normalize_tool_args_value(args_value)
                        }]
                    }));
                }
                continue;
            }
            continue;
        }
        let Some(role) = item_obj.get("role").and_then(|v| v.as_str()) else {
            continue;
        };
        if role == "tool" {
            messages.push(json!({
                "role": "tool",
                "content": value_to_text(item_obj.get("content")),
                "toolCallId": item_obj.get("tool_call_id").or_else(|| item_obj.get("call_id")).and_then(|v| v.as_str()).map(|v| v.to_string())
            }));
            continue;
        }
        if role != "system" && role != "user" && role != "assistant" {
            continue;
        }
        let mut tool_calls: Vec<Value> = vec![];
        if let Some(calls) = item_obj.get("tool_calls").and_then(|v| v.as_array()) {
            for (call_idx, call) in calls.iter().enumerate() {
                let Some(call_obj) = call.as_object() else {
                    continue;
                };
                let fn_obj = call_obj
                    .get("function")
                    .and_then(|v| v.as_object())
                    .or(Some(call_obj));
                let Some(fn_obj) = fn_obj else {
                    continue;
                };
                let Some(name) = fn_obj.get("name").and_then(|v| v.as_str()) else {
                    continue;
                };
                let call_id = call_obj
                    .get("id")
                    .or_else(|| call_obj.get("call_id"))
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| format!("call_{}_{}", idx, call_idx));
                tool_calls.push(json!({
                    "id": call_id,
                    "name": name,
                    "args": normalize_tool_args_value(fn_obj.get("arguments").or_else(|| fn_obj.get("args")).or_else(|| fn_obj.get("input")))
                }));
            }
        }
        if let Some(fn_call) = item_obj.get("function_call").and_then(|v| v.as_object()) {
            if let Some(name) = fn_call.get("name").and_then(|v| v.as_str()) {
                tool_calls.push(json!({
                    "id": fn_call.get("id").or_else(|| fn_call.get("call_id")).and_then(|v| v.as_str()).map(|v| v.to_string()).unwrap_or_else(|| format!("call_{}_legacy", idx)),
                    "name": name,
                    "args": normalize_tool_args_value(fn_call.get("arguments").or_else(|| fn_call.get("args")).or_else(|| fn_call.get("input")))
                }));
            }
        }
        let mut message = Map::new();
        message.insert("role".to_string(), Value::String(role.to_string()));
        message.insert(
            "content".to_string(),
            Value::String(value_to_text(item_obj.get("content"))),
        );
        if !tool_calls.is_empty() {
            message.insert("toolCalls".to_string(), Value::Array(tool_calls));
        }
        messages.push(Value::Object(message));
    }
    messages
}

fn normalize_anthropic_messages(raw: Option<&Value>) -> Vec<Value> {
    let Some(items) = raw.and_then(|v| v.as_array()) else {
        return vec![];
    };
    let mut messages: Vec<Value> = vec![];
    for (idx, item) in items.iter().enumerate() {
        let Some(item_obj) = item.as_object() else {
            continue;
        };
        let Some(role) = item_obj.get("role").and_then(|v| v.as_str()) else {
            continue;
        };
        if role != "user" && role != "assistant" {
            continue;
        }
        let mut text_parts: Vec<String> = vec![];
        let mut tool_calls: Vec<Value> = vec![];
        let mut tool_results: Vec<Value> = vec![];
        if let Some(parts) = item_obj.get("content").and_then(|v| v.as_array()) {
            for (part_idx, part) in parts.iter().enumerate() {
                let Some(part_obj) = part.as_object() else {
                    continue;
                };
                let part_type = part_obj
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                if part_type == "text" {
                    text_parts.push(
                        part_obj
                            .get("text")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string(),
                    );
                    continue;
                }
                if part_type == "tool_use" && role == "assistant" {
                    let Some(name) = part_obj.get("name").and_then(|v| v.as_str()) else {
                        continue;
                    };
                    let tool_id = part_obj
                        .get("id")
                        .and_then(|v| v.as_str())
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| format!("tool_{}_{}", idx, part_idx));
                    tool_calls.push(json!({
                        "id": tool_id,
                        "name": name,
                        "args": part_obj.get("input").cloned().unwrap_or_else(|| json!({}))
                    }));
                    continue;
                }
                if part_type == "tool_result" && role == "user" {
                    let tool_use_id = part_obj
                        .get("tool_use_id")
                        .and_then(|v| v.as_str())
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| format!("tool_{}_{}", idx, part_idx));
                    tool_results.push(json!({
                        "role": "tool",
                        "content": value_to_text(part_obj.get("content")),
                        "toolCallId": tool_use_id
                    }));
                }
            }
        } else {
            text_parts.push(value_to_text(item_obj.get("content")));
        }
        let mut message = Map::new();
        message.insert("role".to_string(), Value::String(role.to_string()));
        message.insert("content".to_string(), Value::String(text_parts.join("")));
        if !tool_calls.is_empty() {
            message.insert("toolCalls".to_string(), Value::Array(tool_calls));
        }
        messages.push(Value::Object(message));
        messages.extend(tool_results);
    }
    messages
}

fn normalize_gemini_messages(raw: Option<&Value>) -> Vec<Value> {
    let Some(items) = raw.and_then(|v| v.as_array()) else {
        return vec![];
    };
    let mut messages: Vec<Value> = vec![];
    for (idx, item) in items.iter().enumerate() {
        let Some(item_obj) = item.as_object() else {
            continue;
        };
        let raw_role = item_obj
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("user");
        let role = if raw_role == "model" {
            "assistant"
        } else {
            "user"
        };
        let mut text_parts: Vec<String> = vec![];
        let mut tool_calls: Vec<Value> = vec![];
        let mut tool_results: Vec<Value> = vec![];
        if let Some(parts) = item_obj.get("parts").and_then(|v| v.as_array()) {
            for (part_idx, part) in parts.iter().enumerate() {
                let Some(part_obj) = part.as_object() else {
                    continue;
                };
                if let Some(text) = part_obj.get("text").and_then(|v| v.as_str()) {
                    text_parts.push(text.to_string());
                }
                if let Some(fn_call) = part_obj.get("functionCall").and_then(|v| v.as_object()) {
                    if let Some(name) = fn_call.get("name").and_then(|v| v.as_str()) {
                        tool_calls.push(json!({
                            "id": format!("call_{}_{}", idx, part_idx),
                            "name": name,
                            "args": fn_call.get("args").cloned().unwrap_or_else(|| json!({}))
                        }));
                    }
                }
                if let Some(fn_resp) = part_obj.get("functionResponse").and_then(|v| v.as_object())
                {
                    let tool_name = fn_resp
                        .get("name")
                        .and_then(|v| v.as_str())
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| format!("tool_{}_{}", idx, part_idx));
                    tool_results.push(json!({
                        "role": "tool",
                        "content": value_to_text(fn_resp.get("response")),
                        "toolCallId": tool_name
                    }));
                }
            }
        }
        let mut message = Map::new();
        message.insert("role".to_string(), Value::String(role.to_string()));
        message.insert("content".to_string(), Value::String(text_parts.join("")));
        if !tool_calls.is_empty() {
            message.insert("toolCalls".to_string(), Value::Array(tool_calls));
        }
        messages.push(Value::Object(message));
        messages.extend(tool_results);
    }
    messages
}

fn normalize_openai_input(raw: Option<&Value>) -> Vec<Value> {
    let Some(raw) = raw else {
        return vec![];
    };
    if let Some(items) = raw.as_array() {
        if items.first().and_then(|v| v.as_object()).is_some() {
            return normalize_openai_messages(Some(raw));
        }
        return vec![json!({
            "role": "user",
            "content": items.iter().map(|item| value_to_text(Some(item))).collect::<Vec<String>>().join("")
        })];
    }
    vec![json!({
        "role": "user",
        "content": value_to_text(Some(raw))
    })]
}

fn normalize_chat_request_value(
    payload: &Value,
    provider: &str,
    endpoint: &str,
    model: &str,
    is_stream: bool,
) -> Option<Value> {
    let body = payload.as_object()?;
    let model_value = if model.is_empty() {
        Value::Null
    } else {
        Value::String(model.to_string())
    };
    if provider == "openai" && endpoint == "responses" {
        let system_text = extract_system_text(body.get("instructions"));
        let mut messages = normalize_openai_input(body.get("input"));
        if !system_text.is_empty() {
            messages.insert(0, json!({"role":"system", "content": system_text}));
        }
        return Some(json!({
            "model": model_value,
            "stream": is_stream,
            "messages": messages,
            "rawResponsesBody": Value::Object(body.clone()),
            "tools": normalize_tools_from_openai(body.get("tools")),
            "toolChoice": body.get("tool_choice").cloned().unwrap_or(Value::Null),
            "temperature": number_or_null(body.get("temperature")),
            "topP": number_or_null(body.get("top_p")),
            "maxTokens": number_or_null(body.get("max_output_tokens").or_else(|| body.get("max_tokens"))),
            "responseFormat": body.get("response_format").cloned().unwrap_or(Value::Null),
        }));
    }
    if provider == "openai" {
        return Some(json!({
            "model": model_value,
            "stream": is_stream,
            "messages": normalize_openai_messages(body.get("messages")),
            "tools": normalize_tools_from_openai(body.get("tools")),
            "toolChoice": body.get("tool_choice").cloned().unwrap_or(Value::Null),
            "temperature": number_or_null(body.get("temperature")),
            "topP": number_or_null(body.get("top_p")),
            "maxTokens": number_or_null(body.get("max_tokens")),
            "responseFormat": body.get("response_format").cloned().unwrap_or(Value::Null),
        }));
    }
    if provider == "anthropic" {
        let system_text = extract_system_text(body.get("system"));
        let mut messages = normalize_anthropic_messages(body.get("messages"));
        if !system_text.is_empty() {
            messages.insert(0, json!({"role":"system", "content": system_text}));
        }
        return Some(json!({
            "model": model_value,
            "stream": is_stream,
            "messages": messages,
            "tools": normalize_tools_from_anthropic(body.get("tools")),
            "toolChoice": body.get("tool_choice").cloned().unwrap_or(Value::Null),
            "temperature": number_or_null(body.get("temperature")),
            "topP": number_or_null(body.get("top_p")),
            "maxTokens": number_or_null(body.get("max_tokens")),
            "responseFormat": Value::Null,
        }));
    }
    let system_text = extract_system_text(
        body.get("system_instruction")
            .or_else(|| body.get("systemInstruction")),
    );
    let mut messages = normalize_gemini_messages(body.get("contents"));
    if !system_text.is_empty() {
        messages.insert(0, json!({"role":"system", "content": system_text}));
    }
    let generation_config = body
        .get("generationConfig")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    Some(json!({
        "model": model_value,
        "stream": is_stream,
        "messages": messages,
        "tools": normalize_tools_from_gemini(body.get("tools")),
        "toolChoice": Value::Null,
        "temperature": number_or_null(generation_config.get("temperature")),
        "topP": number_or_null(generation_config.get("topP").or_else(|| generation_config.get("top_p"))),
        "maxTokens": number_or_null(generation_config.get("maxOutputTokens").or_else(|| generation_config.get("max_tokens"))),
        "responseFormat": Value::Null,
    }))
}

fn resolve_override(
    override_value: Option<&Value>,
    model: &str,
) -> (Option<String>, Option<String>) {
    let Some(raw) = override_value.and_then(|v| v.as_str()) else {
        return (None, None);
    };
    let resolved = if model.is_empty() {
        raw.to_string()
    } else {
        raw.replace("{model}", model)
    };
    if resolved.starts_with("http://") || resolved.starts_with("https://") {
        return (Some(resolved), None);
    }
    (None, Some(resolved))
}

fn is_openai_responses_target(target: &str) -> bool {
    target.to_ascii_lowercase().contains("/responses")
}

fn tool_args_to_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.to_string(),
        Some(v) => serde_json::to_string(v).unwrap_or_else(|_| "{}".to_string()),
        None => "{}".to_string(),
    }
}

fn build_upstream_chat_request_value(
    payload: &Value,
    provider: &str,
    model: &str,
    endpoint: &str,
    is_stream: bool,
    endpoint_overrides: &Value,
) -> Option<Value> {
    let normalized = payload.as_object()?;
    let messages = normalized
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let tools = normalized
        .get("tools")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let endpoint_overrides_obj = endpoint_overrides.as_object().cloned().unwrap_or_default();

    if provider == "openai" && endpoint == "responses" {
        let (override_absolute, override_path) =
            resolve_override(endpoint_overrides_obj.get("chat_url"), model);
        let mut absolute_url: Option<String> = None;
        let mut path = "/v1/responses".to_string();
        if let Some(candidate_absolute) = override_absolute {
            if is_openai_responses_target(&candidate_absolute) {
                absolute_url = Some(candidate_absolute);
            }
        }
        if absolute_url.is_none() {
            if let Some(candidate_path) = override_path {
                if is_openai_responses_target(&candidate_path) {
                    path = candidate_path;
                }
            }
        }
        let mut body = normalized
            .get("rawResponsesBody")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();
        if !model.is_empty() {
            body.insert("model".to_string(), Value::String(model.to_string()));
        }
        if is_stream {
            body.insert("stream".to_string(), Value::Bool(true));
        }
        return Some(json!({
            "path": path,
            "fallbackPath": if absolute_url.is_none() { Value::String("/responses".to_string()) } else { Value::Null },
            "absoluteUrl": absolute_url.map(Value::String).unwrap_or(Value::Null),
            "body": Value::Object(body),
        }));
    }

    if provider == "openai" {
        let (absolute_url, override_path) =
            resolve_override(endpoint_overrides_obj.get("chat_url"), model);
        let path = override_path.unwrap_or_else(|| "/v1/chat/completions".to_string());
        let mut body = Map::new();
        body.insert(
            "model".to_string(),
            if model.is_empty() {
                Value::Null
            } else {
                Value::String(model.to_string())
            },
        );
        let mut body_messages: Vec<Value> = vec![];
        for message in messages {
            let Some(msg_obj) = message.as_object() else {
                continue;
            };
            let role = msg_obj
                .get("role")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let content = msg_obj
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if role == "tool" {
                body_messages.push(json!({
                    "role": "tool",
                    "content": content,
                    "tool_call_id": msg_obj.get("toolCallId").and_then(|v| v.as_str()).unwrap_or_default()
                }));
                continue;
            }
            let mut mapped = Map::new();
            mapped.insert("role".to_string(), Value::String(role.to_string()));
            mapped.insert(
                "content".to_string(),
                if content.is_empty() {
                    Value::Null
                } else {
                    Value::String(content.to_string())
                },
            );
            if role == "assistant" {
                if let Some(calls) = msg_obj.get("toolCalls").and_then(|v| v.as_array()) {
                    let mapped_calls = calls
                        .iter()
                        .filter_map(|call| {
                            let call_obj = call.as_object()?;
                            let id = call_obj
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default();
                            let name = call_obj
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default();
                            if name.is_empty() {
                                return None;
                            }
                            Some(json!({
                                "id": id,
                                "type": "function",
                                "function": {
                                    "name": name,
                                    "arguments": tool_args_to_string(call_obj.get("args")),
                                }
                            }))
                        })
                        .collect::<Vec<Value>>();
                    if !mapped_calls.is_empty() {
                        mapped.insert("tool_calls".to_string(), Value::Array(mapped_calls));
                    }
                }
            }
            body_messages.push(Value::Object(mapped));
        }
        body.insert("messages".to_string(), Value::Array(body_messages));
        if !tools.is_empty() {
            let mapped_tools = tools
                .iter()
                .filter_map(|tool| {
                    let tool_obj = tool.as_object()?;
                    let name = tool_obj.get("name").and_then(|v| v.as_str()).unwrap_or_default();
                    if name.is_empty() {
                        return None;
                    }
                    Some(json!({
                        "type": "function",
                        "function": {
                            "name": name,
                            "description": tool_obj.get("description").and_then(|v| v.as_str()).unwrap_or_default(),
                            "parameters": tool_obj.get("parameters").cloned().unwrap_or_else(|| json!({}))
                        }
                    }))
                })
                .collect::<Vec<Value>>();
            if !mapped_tools.is_empty() {
                body.insert("tools".to_string(), Value::Array(mapped_tools));
            }
        }
        if let Some(tool_choice) = normalized.get("toolChoice") {
            if !tool_choice.is_null() {
                body.insert("tool_choice".to_string(), tool_choice.clone());
            }
        }
        if let Some(temperature) = numeric_value(normalized.get("temperature")) {
            body.insert("temperature".to_string(), Value::from(temperature));
        }
        if let Some(top_p) = numeric_value(normalized.get("topP")) {
            body.insert("top_p".to_string(), Value::from(top_p));
        }
        if let Some(max_tokens) = numeric_value(normalized.get("maxTokens")) {
            body.insert("max_tokens".to_string(), Value::from(max_tokens));
        }
        if let Some(response_format) = normalized.get("responseFormat") {
            if !response_format.is_null() {
                body.insert("response_format".to_string(), response_format.clone());
            }
        }
        if is_stream {
            body.insert("stream".to_string(), Value::Bool(true));
        }
        return Some(json!({
            "path": path,
            "fallbackPath": Value::Null,
            "absoluteUrl": absolute_url.map(Value::String).unwrap_or(Value::Null),
            "body": Value::Object(body),
        }));
    }

    if provider == "anthropic" {
        let (absolute_url, override_path) =
            resolve_override(endpoint_overrides_obj.get("chat_url"), model);
        let path = override_path.unwrap_or_else(|| "/v1/messages".to_string());
        let mut system_texts: Vec<String> = vec![];
        let mut body_messages: Vec<Value> = vec![];
        for message in messages {
            let Some(msg_obj) = message.as_object() else {
                continue;
            };
            let role = msg_obj
                .get("role")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let content = msg_obj
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if role == "system" {
                if !content.is_empty() {
                    system_texts.push(content.to_string());
                }
                continue;
            }
            if role == "tool" {
                body_messages.push(json!({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": msg_obj.get("toolCallId").and_then(|v| v.as_str()).unwrap_or_default(),
                        "content": content,
                    }]
                }));
                continue;
            }
            let mut blocks: Vec<Value> = vec![];
            if !content.is_empty() {
                blocks.push(json!({
                    "type": "text",
                    "text": content
                }));
            }
            if role == "assistant" {
                if let Some(calls) = msg_obj.get("toolCalls").and_then(|v| v.as_array()) {
                    for call in calls {
                        let Some(call_obj) = call.as_object() else {
                            continue;
                        };
                        let name = call_obj
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        if name.is_empty() {
                            continue;
                        }
                        blocks.push(json!({
                            "type": "tool_use",
                            "id": call_obj.get("id").and_then(|v| v.as_str()).unwrap_or_default(),
                            "name": name,
                            "input": normalize_tool_args_value(call_obj.get("args")),
                        }));
                    }
                }
            }
            let content_value = if blocks.len() == 1
                && blocks
                    .first()
                    .and_then(|v| v.as_object())
                    .and_then(|o| o.get("type"))
                    .and_then(|v| v.as_str())
                    == Some("text")
            {
                blocks
                    .first()
                    .and_then(|v| v.as_object())
                    .and_then(|o| o.get("text"))
                    .cloned()
                    .unwrap_or_else(|| Value::String(String::new()))
            } else {
                Value::Array(blocks)
            };
            body_messages.push(json!({
                "role": role,
                "content": content_value
            }));
        }
        let mut body = Map::new();
        body.insert(
            "model".to_string(),
            if model.is_empty() {
                Value::Null
            } else {
                Value::String(model.to_string())
            },
        );
        if !system_texts.is_empty() {
            body.insert("system".to_string(), Value::String(system_texts.join("\n")));
        }
        body.insert("messages".to_string(), Value::Array(body_messages));
        if !tools.is_empty() {
            let mapped_tools = tools
                .iter()
                .filter_map(|tool| {
                    let tool_obj = tool.as_object()?;
                    let name = tool_obj.get("name").and_then(|v| v.as_str()).unwrap_or_default();
                    if name.is_empty() {
                        return None;
                    }
                    Some(json!({
                        "name": name,
                        "description": tool_obj.get("description").and_then(|v| v.as_str()).unwrap_or_default(),
                        "input_schema": tool_obj.get("parameters").cloned().unwrap_or_else(|| json!({}))
                    }))
                })
                .collect::<Vec<Value>>();
            if !mapped_tools.is_empty() {
                body.insert("tools".to_string(), Value::Array(mapped_tools));
            }
        }
        if let Some(tool_choice) = normalized.get("toolChoice") {
            if !tool_choice.is_null() {
                body.insert("tool_choice".to_string(), tool_choice.clone());
            }
        }
        body.insert(
            "max_tokens".to_string(),
            Value::from(numeric_value(normalized.get("maxTokens")).unwrap_or(1024.0)),
        );
        if let Some(temperature) = numeric_value(normalized.get("temperature")) {
            body.insert("temperature".to_string(), Value::from(temperature));
        }
        if let Some(top_p) = numeric_value(normalized.get("topP")) {
            body.insert("top_p".to_string(), Value::from(top_p));
        }
        if is_stream {
            body.insert("stream".to_string(), Value::Bool(true));
        }
        return Some(json!({
            "path": path,
            "absoluteUrl": absolute_url.map(Value::String).unwrap_or(Value::Null),
            "body": Value::Object(body),
        }));
    }

    let (absolute_url, override_path) =
        resolve_override(endpoint_overrides_obj.get("chat_url"), model);
    let default_path = format!("/v1beta/models/{}:generateContent", model);
    let path = override_path.unwrap_or(default_path);
    let final_path = if is_stream {
        path.replace(":generateContent", ":streamGenerateContent")
    } else {
        path
    };
    let mut system_texts: Vec<String> = vec![];
    let mut contents: Vec<Value> = vec![];
    for message in messages {
        let Some(msg_obj) = message.as_object() else {
            continue;
        };
        let role = msg_obj
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let content = msg_obj
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if role == "system" {
            if !content.is_empty() {
                system_texts.push(content.to_string());
            }
            continue;
        }
        if role == "tool" {
            contents.push(json!({
                "role": "user",
                "parts": [{
                    "functionResponse": {
                        "name": msg_obj.get("toolCallId").and_then(|v| v.as_str()).unwrap_or_default(),
                        "response": { "result": content }
                    }
                }]
            }));
            continue;
        }
        let output_role = if role == "assistant" { "model" } else { "user" };
        let mut parts: Vec<Value> = vec![];
        if !content.is_empty() {
            parts.push(json!({ "text": content }));
        }
        if role == "assistant" {
            if let Some(calls) = msg_obj.get("toolCalls").and_then(|v| v.as_array()) {
                for call in calls {
                    let Some(call_obj) = call.as_object() else {
                        continue;
                    };
                    let name = call_obj
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default();
                    if name.is_empty() {
                        continue;
                    }
                    parts.push(json!({
                        "functionCall": {
                            "name": name,
                            "args": normalize_tool_args_value(call_obj.get("args")),
                        }
                    }));
                }
            }
        }
        contents.push(json!({
            "role": output_role,
            "parts": parts
        }));
    }
    let mut body = Map::new();
    body.insert("contents".to_string(), Value::Array(contents));
    if !system_texts.is_empty() {
        body.insert(
            "system_instruction".to_string(),
            json!({
                "parts": [{
                    "text": system_texts.join("\n")
                }]
            }),
        );
    }
    if !tools.is_empty() {
        let declarations = tools
            .iter()
            .filter_map(|tool| {
                let tool_obj = tool.as_object()?;
                let name = tool_obj.get("name").and_then(|v| v.as_str()).unwrap_or_default();
                if name.is_empty() {
                    return None;
                }
                Some(json!({
                    "name": name,
                    "description": tool_obj.get("description").and_then(|v| v.as_str()).unwrap_or_default(),
                    "parameters": tool_obj.get("parameters").cloned().unwrap_or_else(|| json!({}))
                }))
            })
            .collect::<Vec<Value>>();
        if !declarations.is_empty() {
            body.insert(
                "tools".to_string(),
                Value::Array(vec![json!({
                    "functionDeclarations": declarations
                })]),
            );
        }
    }
    let mut generation_config = Map::new();
    if let Some(temperature) = numeric_value(normalized.get("temperature")) {
        generation_config.insert("temperature".to_string(), Value::from(temperature));
    }
    if let Some(top_p) = numeric_value(normalized.get("topP")) {
        generation_config.insert("topP".to_string(), Value::from(top_p));
    }
    if let Some(max_output_tokens) = numeric_value(normalized.get("maxTokens")) {
        generation_config.insert(
            "maxOutputTokens".to_string(),
            Value::from(max_output_tokens),
        );
    }
    if !generation_config.is_empty() {
        body.insert(
            "generationConfig".to_string(),
            Value::Object(generation_config),
        );
    }
    Some(json!({
        "path": final_path,
        "absoluteUrl": absolute_url.map(Value::String).unwrap_or(Value::Null),
        "body": Value::Object(body),
    }))
}

#[wasm_bindgen]
pub fn normalize_usage(payload_json: &str) -> String {
    normalize_usage_json(payload_json)
}

#[wasm_bindgen]
pub fn normalize_chat_request(
    payload_json: &str,
    provider: &str,
    endpoint: &str,
    model: &str,
    is_stream: bool,
) -> String {
    let Some(payload) = parse_json(payload_json) else {
        return "null".to_string();
    };
    serialize_or_null(normalize_chat_request_value(
        &payload, provider, endpoint, model, is_stream,
    ))
}

#[wasm_bindgen]
pub fn build_upstream_chat_request(
    payload_json: &str,
    provider: &str,
    model: &str,
    endpoint: &str,
    is_stream: bool,
    endpoint_overrides_json: &str,
) -> String {
    let Some(payload) = parse_json(payload_json) else {
        return "null".to_string();
    };
    let endpoint_overrides =
        parse_json(endpoint_overrides_json).unwrap_or_else(|| Value::Object(Map::new()));
    serialize_or_null(build_upstream_chat_request_value(
        &payload,
        provider,
        model,
        endpoint,
        is_stream,
        &endpoint_overrides,
    ))
}

#[wasm_bindgen]
pub fn adapt_sse_line(
    payload_json: &str,
    upstream: &str,
    downstream: &str,
    _model: &str,
) -> String {
    let Some(payload) = parse_json(payload_json) else {
        return "null".to_string();
    };
    let out = match (upstream, downstream) {
        ("openai", "anthropic") => {
            let choices = payload
                .as_object()
                .and_then(|o| o.get("choices"))
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let first = choices
                .first()
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            let delta = first
                .get("delta")
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            let usage = payload
                .as_object()
                .and_then(|o| o.get("usage"))
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            let stop_reason = first
                .get("finish_reason")
                .and_then(|v| v.as_str())
                .and_then(|r| map_reason("openai_to_anthropic", r))
                .map(|v| v.to_string());
            json!({
                "text": openai_content_to_text(delta.get("content")),
                "stopReason": stop_reason,
                "finishReason": Value::Null,
                "eventType": Value::Null,
                "outputTokens": to_number(usage.get("completion_tokens"))
            })
        }
        ("openai", "gemini") => {
            let choices = payload
                .as_object()
                .and_then(|o| o.get("choices"))
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let first = choices
                .first()
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            let delta = first
                .get("delta")
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            let finish_reason = first
                .get("finish_reason")
                .and_then(|v| v.as_str())
                .and_then(|r| map_reason("openai_to_gemini", r))
                .map(|v| v.to_string());
            json!({
                "text": openai_content_to_text(delta.get("content")),
                "stopReason": Value::Null,
                "finishReason": finish_reason,
                "eventType": Value::Null,
                "outputTokens": Value::Null
            })
        }
        ("anthropic", "openai") => {
            let event_type = payload
                .as_object()
                .and_then(|o| o.get("type"))
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let delta = payload
                .as_object()
                .and_then(|o| o.get("delta"))
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            let finish_reason = delta
                .get("stop_reason")
                .and_then(|v| v.as_str())
                .and_then(|r| map_reason("anthropic_to_openai", r))
                .map(|v| v.to_string());
            json!({
                "text": delta.get("text").and_then(|v| v.as_str()).unwrap_or_default(),
                "stopReason": Value::Null,
                "finishReason": finish_reason,
                "eventType": event_type,
                "outputTokens": Value::Null
            })
        }
        ("anthropic", "gemini") => {
            let event_type = payload
                .as_object()
                .and_then(|o| o.get("type"))
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let delta = payload
                .as_object()
                .and_then(|o| o.get("delta"))
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            let finish_reason = delta
                .get("stop_reason")
                .and_then(|v| v.as_str())
                .and_then(|r| map_reason("anthropic_to_gemini", r))
                .map(|v| v.to_string());
            json!({
                "text": delta.get("text").and_then(|v| v.as_str()).unwrap_or_default(),
                "stopReason": Value::Null,
                "finishReason": finish_reason,
                "eventType": event_type,
                "outputTokens": Value::Null
            })
        }
        ("gemini", "openai") => {
            let finish_reason = gemini_finish_reason(&payload)
                .and_then(|r| map_reason("gemini_to_openai", &r).map(|v| v.to_string()));
            let usage = gemini_usage_tokens(&payload);
            json!({
                "text": gemini_candidate_text(&payload),
                "stopReason": Value::Null,
                "finishReason": finish_reason,
                "eventType": Value::Null,
                "outputTokens": usage.completion_tokens
            })
        }
        ("gemini", "anthropic") => {
            let stop_reason = gemini_finish_reason(&payload)
                .and_then(|r| map_reason("gemini_to_anthropic", &r).map(|v| v.to_string()));
            let usage = gemini_usage_tokens(&payload);
            json!({
                "text": gemini_candidate_text(&payload),
                "stopReason": stop_reason,
                "finishReason": Value::Null,
                "eventType": Value::Null,
                "outputTokens": usage.completion_tokens
            })
        }
        _ => Value::Null,
    };
    if out.is_null() {
        return "null".to_string();
    }
    serde_json::to_string(&out).unwrap_or_else(|_| "null".to_string())
}
