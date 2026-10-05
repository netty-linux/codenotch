//! Opt-in loopback-only LiteLLM metrics. No provider credentials enter the webview.
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::Read,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};
static SNAPSHOT: Mutex<Vec<Value>> = Mutex::new(Vec::new());

#[tauri::command]
pub fn get_litellm() -> Vec<Value> {
    SNAPSHOT.lock().unwrap().clone()
}

fn label(labels: &str, key: &str) -> Option<String> {
    // Prometheus label values are JSON-compatible quoted strings. Split outside quotes.
    let mut quoted = false;
    let mut escaped = false;
    let mut start = 0;
    for (i, c) in labels
        .char_indices()
        .chain(std::iter::once((labels.len(), ',')))
    {
        if escaped {
            escaped = false;
            continue;
        }
        if c == '\\' && quoted {
            escaped = true;
            continue;
        }
        if c == '"' {
            quoted = !quoted;
        }
        if c == ',' && !quoted {
            if let Some((k, v)) = labels[start..i].trim().split_once('=') {
                if k == key {
                    return serde_json::from_str(v).ok();
                }
            }
            start = i + 1;
        }
    }
    None
}
#[derive(Default, Clone, Debug)]
struct Counters {
    requests: Option<f64>,
    tokens: Option<f64>,
    spend: Option<f64>,
    fallbacks: Option<f64>,
    failures: Option<f64>,
}
fn parse(text: &str) -> BTreeMap<String, Counters> {
    let mut out: BTreeMap<String, Counters> = BTreeMap::new();
    for line in text.lines().filter(|s| !s.starts_with('#')) {
        let Some((name, tail)) = line.split_once('{') else {
            continue;
        };
        let Some((labels, raw)) = tail.rsplit_once('}') else {
            continue;
        };
        let Some(value) = raw
            .split_whitespace()
            .next()
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|n| n.is_finite() && *n >= 0.0)
        else {
            continue;
        };
        let field = match name {
            "litellm_proxy_total_requests_metric_total" => 0,
            "litellm_total_tokens_metric_total" => 1,
            "litellm_spend_metric_total" => 2,
            "litellm_deployment_successful_fallbacks_total" => 3,
            "litellm_proxy_failed_requests_metric_total" => 4,
            _ => continue,
        };
        let Some(model) = label(labels, "requested_model")
            .filter(|s| !s.is_empty())
            .or_else(|| label(labels, "model"))
        else {
            continue;
        };
        if model.len() > 160 {
            continue;
        }
        let c = out.entry(model).or_default();
        let slot = match field {
            0 => &mut c.requests,
            1 => &mut c.tokens,
            2 => &mut c.spend,
            3 => &mut c.fallbacks,
            _ => &mut c.failures,
        };
        *slot = Some(slot.unwrap_or(0.0) + value);
    }
    out
}
fn rate(now: Option<f64>, before: Option<f64>, seconds: f64) -> Option<f64> {
    match (now, before) {
        (Some(n), Some(b)) if n >= b && seconds > 0.0 => Some((n - b) * 60.0 / seconds),
        _ => None,
    }
}
fn display(n: Option<f64>) -> String {
    n.map(|v| format!("{v:.2}"))
        .unwrap_or_else(|| "unknown".into())
}
fn read(agent: &ureq::Agent, url: &str, key: &str) -> Result<String, ()> {
    let mut request = agent.get(url);
    if !key.is_empty() {
        request = request.set("Authorization", &format!("Bearer {key}"));
    }
    let response = request.call().map_err(|_| ())?;
    let mut text = String::new();
    response
        .into_reader()
        .take(2_000_001)
        .read_to_string(&mut text)
        .map_err(|_| ())?;
    if text.len() > 2_000_000 {
        return Err(());
    }
    Ok(text)
}
pub fn start(app: AppHandle) {
    let Ok(base) = std::env::var("CODENOTCH_LITELLM_URL") else {
        return;
    };
    // Deliberately fixed local origin: credentials never follow redirects or remote URLs.
    if !["http://127.0.0.1:4000", "http://localhost:4000"].contains(&base.trim_end_matches('/')) {
        return;
    }
    std::thread::spawn(move || {
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(3))
            .redirects(0)
            .build();
        let key = std::env::var("LITELLM_API_KEY").unwrap_or_default();
        let limits: Value = std::env::var("CODENOTCH_LITELLM_LIMITS")
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(json!({}));
        let mut previous = BTreeMap::<String, Counters>::new();
        let mut last = Instant::now();
        loop {
            let result = read(
                &agent,
                &format!("{}/metrics/", base.trim_end_matches('/')),
                &key,
            );
            match result {
                Ok(text) => {
                    let mut current = parse(&text);
                    // Include configured models before the first request, without inventing zero usage.
                    if let Ok(body) = read(
                        &agent,
                        &format!("{}/v1/models", base.trim_end_matches('/')),
                        &key,
                    ) {
                        if let Ok(value) = serde_json::from_str::<Value>(&body) {
                            if let Some(models) = value["data"].as_array() {
                                for m in models.iter().take(32) {
                                    if let Some(id) = m["id"].as_str() {
                                        current.entry(id.into()).or_default();
                                    }
                                }
                            }
                        }
                    }
                    let seconds = last.elapsed().as_secs_f64();
                    let mut cells = Vec::new();
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    for (i, (model, c)) in current.iter().take(32).enumerate() {
                        let old = previous.get(model).cloned().unwrap_or_default();
                        let rpm = rate(c.requests, old.requests, seconds);
                        let tpm = rate(c.tokens, old.tokens, seconds);
                        let mut windows = Vec::new();
                        for (id, value) in [("rpm", rpm), ("tpm", tpm)] {
                            if let (Some(v), Some(limit)) = (
                                value,
                                limits[model][id]
                                    .as_f64()
                                    .filter(|n| n.is_finite() && *n > 0.0),
                            ) {
                                windows.push(json!({"id":id,"label":format!("Estimated {id} / configured {limit}"),"used":v/limit,"derived":true,"resets_at":null}));
                            }
                        }
                        if c.fallbacks.unwrap_or(0.0) > old.fallbacks.unwrap_or(0.0)
                            && previous.contains_key(model)
                        {
                            let _ = app.emit("notice", format!("LiteLLM fallback: {model}"));
                        }
                        let note=format!("Route: {model} · estimated RPM {} · TPM {} · spend USD {} · fallbacks {} · failed requests {}. Quota/account and last error detail unavailable. Rates use the polling interval; not vendor quota.",display(rpm),display(tpm),display(c.spend),display(c.fallbacks),display(c.failures));
                        let glyph = if model.contains("nvidia") {
                            "NV"
                        } else if model.contains("claude") {
                            "An"
                        } else if model.contains("openai") {
                            "OA"
                        } else if model.contains("gemini") {
                            "Ge"
                        } else {
                            "LL"
                        };
                        cells.push(json!({"id":format!("litellm-{i}"),"base":"litellm","name":format!("LiteLLM · {model}"),"glyph":glyph,"snap":{"status":"ok","windows":windows,"note":note,"fetched_at":now}}));
                    }
                    previous = current;
                    last = Instant::now();
                    *SNAPSHOT.lock().unwrap() = cells;
                }
                Err(()) => {
                    let mut cells = SNAPSHOT.lock().unwrap();
                    if cells.is_empty() {
                        cells.push(json!({"id":"litellm-offline","base":"litellm","name":"LiteLLM","glyph":"LL","snap":{"status":"stale","windows":[],"fetched_at":0}}));
                    }
                    for c in cells.iter_mut() {
                        c["snap"]["status"] = json!("stale");
                        c["snap"]["note"]=json!("LiteLLM metrics unavailable. Check local proxy, key and Prometheus callback.");
                    }
                }
            }
            let _ = app.emit("litellm", get_litellm());
            std::thread::sleep(Duration::from_secs(5));
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metrics_aggregate_and_ignore_created() {
        let c=parse("litellm_proxy_total_requests_metric_total{requested_model=\"nim\",team=\"a,b\"} 2\nlitellm_proxy_total_requests_metric_total{requested_model=\"nim\"} 3\nlitellm_proxy_total_requests_metric_created{requested_model=\"nim\"} 999\nlitellm_total_tokens_metric_total{requested_model=\"nim\"} 42");
        assert_eq!(c["nim"].requests, Some(5.0));
        assert_eq!(c["nim"].tokens, Some(42.0));
        assert_eq!(c["nim"].spend, None);
    }
    #[test]
    fn unknown_and_reset_are_not_zero() {
        assert_eq!(rate(Some(1.0), Some(2.0), 5.0), None);
        assert_eq!(rate(Some(1.0), None, 5.0), None);
        assert_eq!(rate(Some(7.0), Some(2.0), 5.0), Some(60.0));
    }
}
