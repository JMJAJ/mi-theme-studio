//! Inventory: lock screen pieces saved from any theme (their MAML code and the
//! pictures they use), kept in the app's data folder so they can be added to
//! other themes later. Each item is a folder: `item.json` plus `files/…`.

use crate::error::{AppError, AppResult};
use crate::storage::{self, AppPaths};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Serialize, Deserialize, Clone)]
pub struct InventoryFile {
    pub path: String,
    pub data: Vec<u8>,
}

const MAX_ITEM_BYTES: usize = 64 * 1024 * 1024;

fn root(paths: &AppPaths) -> PathBuf {
    paths.data.join("inventory")
}

fn item_dir(paths: &AppPaths, id: &str) -> AppResult<PathBuf> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(AppError::invalid("Not a valid inventory item id."));
    }
    Ok(root(paths).join(id))
}

/// A relative path inside the item's files folder (no `..`, no drive or root).
fn safe_rel(path: &str) -> AppResult<PathBuf> {
    let p = Path::new(path);
    if path.is_empty() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(AppError::invalid(format!("`{path}` is not a valid file path.")));
    }
    Ok(p.to_path_buf())
}

pub fn list(paths: &AppPaths) -> AppResult<Vec<Value>> {
    let dir = root(paths);
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else { return Ok(out) };
    for entry in entries.flatten() {
        let file = entry.path().join("item.json");
        if let Ok(text) = fs::read_to_string(&file) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                out.push(value);
            }
        }
    }
    Ok(out)
}

pub fn save(paths: &AppPaths, mut item: Value, files: Vec<InventoryFile>) -> AppResult<Value> {
    let obj = item.as_object_mut().ok_or_else(|| AppError::invalid("An inventory item has to be an object."))?;
    let total: usize = files.iter().map(|f| f.data.len()).sum();
    if total > MAX_ITEM_BYTES {
        return Err(AppError::invalid("That piece uses too many pictures to save (over 64 MB)."));
    }
    let now = storage::now_ms();
    let id = match obj.get("id").and_then(Value::as_str) {
        Some(id) if !id.is_empty() => id.to_string(),
        _ => format!("i{now:x}"),
    };
    let dir = item_dir(paths, &id)?;
    let rels = files.iter().map(|f| safe_rel(&f.path)).collect::<AppResult<Vec<_>>>()?;
    if dir.exists() {
        let _ = fs::remove_dir_all(&dir);
    }
    fs::create_dir_all(dir.join("files"))?;
    for (file, rel) in files.iter().zip(rels) {
        storage::atomic_write(&dir.join("files").join(rel), &file.data)?;
    }
    obj.insert("id".into(), Value::String(id));
    obj.entry("createdMs").or_insert(Value::from(now));
    obj.insert("files".into(), Value::from(files.iter().map(|f| Value::String(f.path.clone())).collect::<Vec<_>>()));
    storage::atomic_write(&dir.join("item.json"), serde_json::to_string_pretty(&item).unwrap_or_default().as_bytes())?;
    Ok(item)
}

/// Change the item's details (its name), keeping its files.
pub fn update(paths: &AppPaths, id: &str, patch: Value) -> AppResult<Value> {
    let file = item_dir(paths, id)?.join("item.json");
    let text = fs::read_to_string(&file).map_err(|_| AppError::not_found("That inventory item is gone."))?;
    let mut item: Value = serde_json::from_str(&text).map_err(|e| AppError::invalid(e.to_string()))?;
    if let (Some(obj), Some(patch)) = (item.as_object_mut(), patch.as_object()) {
        for (k, v) in patch {
            if k != "id" && k != "files" {
                obj.insert(k.clone(), v.clone());
            }
        }
    }
    storage::atomic_write(&file, serde_json::to_string_pretty(&item).unwrap_or_default().as_bytes())?;
    Ok(item)
}

pub fn delete(paths: &AppPaths, id: &str) -> AppResult<()> {
    let dir = item_dir(paths, id)?;
    if dir.exists() {
        fs::remove_dir_all(dir)?;
    }
    Ok(())
}

pub fn files(paths: &AppPaths, id: &str) -> AppResult<Vec<InventoryFile>> {
    let dir = item_dir(paths, id)?;
    let text = fs::read_to_string(dir.join("item.json")).map_err(|_| AppError::not_found("That inventory item is gone."))?;
    let item: Value = serde_json::from_str(&text).map_err(|e| AppError::invalid(e.to_string()))?;
    let mut out = Vec::new();
    for path in item.get("files").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
        let rel = safe_rel(path)?;
        if let Ok(data) = fs::read(dir.join("files").join(rel)) {
            out.push(InventoryFile { path: path.to_string(), data });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_list_files_delete() {
        let tmp = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("mts-inv-{}", storage::now_ms()));
        let paths = AppPaths { config: tmp.join("c"), data: tmp.join("d") };
        let item = save(&paths, serde_json::json!({ "name": "Clock" }), vec![InventoryFile { path: "img/a.png".into(), data: vec![1, 2, 3] }]).unwrap();
        let id = item["id"].as_str().unwrap().to_string();
        assert_eq!(list(&paths).unwrap().len(), 1);
        assert_eq!(files(&paths, &id).unwrap()[0].data, vec![1, 2, 3]);
        update(&paths, &id, serde_json::json!({ "name": "Big clock" })).unwrap();
        assert_eq!(list(&paths).unwrap()[0]["name"], "Big clock");
        assert!(save(&paths, serde_json::json!({}), vec![InventoryFile { path: "../x".into(), data: vec![1] }]).is_err());
        delete(&paths, &id).unwrap();
        assert!(list(&paths).unwrap().is_empty());
        let _ = fs::remove_dir_all(tmp);
    }
}
