//! Session-scoped in-memory dataset store for the Rust/WASM runtime backend.
//!
//! Node results reference datasets by content-addressed ids, so equal outputs
//! from repeated runs share one entry. The store is bounded and evicts by LRU;
//! an evicted dataset simply loses preview availability and is re-registered
//! on the next execution of the producing step.

use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};

pub(crate) const DEFAULT_PREVIEW_LIMIT: usize = 50;
pub(crate) const MAX_PREVIEW_LIMIT: usize = 1000;
const MAX_DATASET_ENTRIES: usize = 64;
const MAX_SINGLE_DATASET_BYTES: usize = 8 * 1024 * 1024;
const MAX_TOTAL_DATASET_BYTES: usize = 24 * 1024 * 1024;

struct StoredDataset {
    kind: &'static str,
    items: Vec<Value>,
    content_hash: String,
    approximate_bytes: usize,
}

#[derive(Default)]
struct DatasetStore {
    entries: HashMap<String, StoredDataset>,
    lru: VecDeque<String>,
    approximate_bytes: usize,
}

thread_local! {
    static DATASETS: RefCell<DatasetStore> = RefCell::new(DatasetStore::default());
}

fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn touch(store: &mut DatasetStore, dataset_id: &str) {
    store.lru.retain(|candidate| candidate != dataset_id);
    store.lru.push_back(dataset_id.to_owned());
}

fn evict_until_fits(store: &mut DatasetStore, incoming_bytes: usize) {
    while store.entries.len() >= MAX_DATASET_ENTRIES
        || store.approximate_bytes + incoming_bytes > MAX_TOTAL_DATASET_BYTES
    {
        let Some(oldest) = store.lru.pop_front() else {
            break;
        };
        if let Some(removed) = store.entries.remove(&oldest) {
            store.approximate_bytes = store
                .approximate_bytes
                .saturating_sub(removed.approximate_bytes);
        }
    }
}

/// Registers node output data and returns its `{dataset_id, kind, content_hash}`
/// reference, or `None` when the payload cannot be stored (serialization failure
/// or an oversized dataset). A missing reference only disables on-demand preview.
pub(crate) fn register(kind: &'static str, items: &[Value]) -> Option<Value> {
    let serialized = serde_json::to_vec(items).ok()?;
    let approximate_bytes = serialized.len();
    if approximate_bytes > MAX_SINGLE_DATASET_BYTES {
        return None;
    }
    let content_hash = format!("{:016x}", fnv1a_64(&serialized));
    let dataset_id = format!("ds-{content_hash}");
    let reference = json!({
        "dataset_id": dataset_id,
        "kind": kind,
        "content_hash": content_hash,
    });

    DATASETS.with(|datasets| {
        let mut store = datasets.borrow_mut();
        if store.entries.contains_key(&dataset_id) {
            touch(&mut store, &dataset_id);
            return;
        }
        evict_until_fits(&mut store, approximate_bytes);
        store.approximate_bytes += approximate_bytes;
        store.lru.push_back(dataset_id.clone());
        store.entries.insert(
            dataset_id.clone(),
            StoredDataset {
                kind,
                items: items.to_vec(),
                content_hash,
                approximate_bytes,
            },
        );
    });
    Some(reference)
}

/// Returns a bounded sample of a stored dataset in the engine response shape.
pub(crate) fn preview(dataset_id: &str, limit: Option<usize>) -> Value {
    let limit = limit.unwrap_or(DEFAULT_PREVIEW_LIMIT).min(MAX_PREVIEW_LIMIT);
    DATASETS.with(|datasets| {
        let mut store = datasets.borrow_mut();
        let Some(entry) = store.entries.get(dataset_id) else {
            return json!({
                "ok": false,
                "error": {
                    "message": "Данные этого блока уже выгружены из памяти, запустите граф ещё раз",
                    "line": 0,
                    "column": 0,
                },
            });
        };
        let items: Vec<Value> = entry.items.iter().take(limit).cloned().collect();
        let response = json!({
            "ok": true,
            "dataset_id": dataset_id,
            "kind": entry.kind,
            "content_hash": entry.content_hash,
            "items": items,
            "total_items": entry.items.len(),
            "truncated": entry.items.len() > limit,
        });
        touch(&mut store, dataset_id);
        response
    })
}

/// Drops the listed datasets and reports how many entries were actually removed.
pub(crate) fn release(dataset_ids: &[String]) -> Value {
    let released = DATASETS.with(|datasets| {
        let mut store = datasets.borrow_mut();
        let mut released = 0usize;
        for dataset_id in dataset_ids {
            if let Some(removed) = store.entries.remove(dataset_id) {
                store.approximate_bytes = store
                    .approximate_bytes
                    .saturating_sub(removed.approximate_bytes);
                store.lru.retain(|candidate| candidate != dataset_id);
                released += 1;
            }
        }
        released
    });
    json!({"ok": true, "released": released})
}

#[cfg(test)]
pub(crate) fn clear() {
    DATASETS.with(|datasets| {
        let mut store = datasets.borrow_mut();
        store.entries.clear();
        store.lru.clear();
        store.approximate_bytes = 0;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(count: usize) -> Vec<Value> {
        (0..count).map(|index| json!({"id": index})).collect()
    }

    #[test]
    fn register_is_content_addressed_and_previewable() {
        clear();
        let first = register("records", &rows(3)).unwrap();
        let second = register("records", &rows(3)).unwrap();
        assert_eq!(first, second);

        let dataset_id = first["dataset_id"].as_str().unwrap();
        let sample = preview(dataset_id, Some(2));
        assert_eq!(sample["ok"], true);
        assert_eq!(sample["items"].as_array().unwrap().len(), 2);
        assert_eq!(sample["total_items"], 3);
        assert_eq!(sample["truncated"], true);

        let full = preview(dataset_id, None);
        assert_eq!(full["items"].as_array().unwrap().len(), 3);
        assert_eq!(full["truncated"], false);
    }

    #[test]
    fn released_and_unknown_datasets_fail_preview() {
        clear();
        let reference = register("records", &rows(1)).unwrap();
        let dataset_id = reference["dataset_id"].as_str().unwrap().to_owned();
        assert_eq!(release(&[dataset_id.clone()])["released"], 1);
        assert_eq!(release(&[dataset_id.clone()])["released"], 0);
        assert_eq!(preview(&dataset_id, None)["ok"], false);
        assert_eq!(preview("ds-missing", None)["ok"], false);
    }

    #[test]
    fn store_evicts_least_recently_used_entries() {
        clear();
        let mut ids = Vec::new();
        for index in 0..=MAX_DATASET_ENTRIES {
            let reference = register("records", &[json!({"unique": index})]).unwrap();
            ids.push(reference["dataset_id"].as_str().unwrap().to_owned());
        }
        assert_eq!(preview(&ids[0], None)["ok"], false);
        assert_eq!(preview(ids.last().unwrap(), None)["ok"], true);
    }

    #[test]
    fn oversized_dataset_is_not_registered() {
        clear();
        let oversized = vec![json!({"payload": "x".repeat(MAX_SINGLE_DATASET_BYTES + 1)})];
        assert!(register("records", &oversized).is_none());
    }

    #[test]
    fn preview_limit_is_clamped() {
        clear();
        let reference = register("records", &rows(MAX_PREVIEW_LIMIT + 5)).unwrap();
        let dataset_id = reference["dataset_id"].as_str().unwrap();
        let sample = preview(dataset_id, Some(usize::MAX));
        assert_eq!(
            sample["items"].as_array().unwrap().len(),
            MAX_PREVIEW_LIMIT
        );
        assert_eq!(sample["truncated"], true);
    }
}
