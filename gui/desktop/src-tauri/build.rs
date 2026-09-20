use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn string_field<'a>(profile: &'a serde_json::Value, name: &str) -> &'a str {
    profile[name]
        .as_str()
        .unwrap_or_else(|| panic!("distribution profile field {name} must be a string"))
}

fn optional_string(profile: &serde_json::Value, name: &str) -> String {
    match profile.get(name) {
        Some(serde_json::Value::String(value)) => format!("Some({value:?})"),
        Some(serde_json::Value::Null) | None => "None".to_string(),
        _ => panic!("distribution profile field {name} must be a string or null"),
    }
}

fn string_array(profile: &serde_json::Value, name: &str) -> String {
    let rows = profile[name]
        .as_array()
        .unwrap_or_else(|| panic!("distribution profile field {name} must be an array"));
    let values = rows
        .iter()
        .map(|value| {
            format!(
                "{:?}",
                value.as_str().unwrap_or_else(|| panic!(
                    "distribution profile {name} entries must be strings"
                ))
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!("&[{values}]")
}

fn profile_path(manifest_dir: &Path) -> PathBuf {
    env::var_os("PODCAST_DISTRIBUTION_PROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest_dir.join("../../../config/distribution.dev.json"))
}

fn normalized_profile(manifest_dir: &Path, profile_path: &Path) -> serde_json::Value {
    let source_dir = manifest_dir.join("../../../src");
    let output = Command::new("python3")
        .arg("-c")
        .arg(
            "import json, sys\n\
             from dataclasses import asdict\n\
             sys.path.insert(0, sys.argv[1])\n\
             from podcast_mcp.distribution import load_distribution_profile\n\
             print(json.dumps(asdict(load_distribution_profile(__import__('pathlib').Path(sys.argv[2])))))",
        )
        .arg(source_dir)
        .arg(profile_path)
        .output()
        .expect("load normalized distribution profile with python3");
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        panic!("distribution profile normalization failed: {stderr}");
    }
    serde_json::from_slice(&output.stdout).expect("normalized distribution profile must be JSON")
}

fn generate_distribution_constants() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let profile_path = profile_path(&manifest_dir);
    println!("cargo:rerun-if-env-changed=PODCAST_DISTRIBUTION_PROFILE");
    println!("cargo:rerun-if-changed={}", profile_path.display());
    let profile = normalized_profile(&manifest_dir, &profile_path);
    if profile["version"].as_u64() != Some(1) {
        panic!("distribution profile version must be 1");
    }
    let generated = format!(
        "pub const PRODUCT_NAME: &str = {:?};\n\
         pub const BUNDLE_IDENTIFIER: &str = {:?};\n\
         pub const DEEP_LINK_SCHEMES: &[&str] = {};\n\
         pub const ALLOWED_HTTPS_SHARE_ORIGINS: &[&str] = {};\n\
         pub const SUPPORT_URL: &str = {:?};\n\
         pub const PRIVACY_URL: &str = {:?};\n\
         pub const REPOSITORY_URL: &str = {:?};\n\
         pub const RELEASE_MANIFEST_URL: Option<&str> = {};\n\
         pub const BOOTSTRAP_CDN_BASE: Option<&str> = {};\n",
        string_field(&profile, "product_name"),
        string_field(&profile, "bundle_identifier"),
        string_array(&profile, "deep_link_schemes"),
        string_array(&profile, "allowed_https_share_origins"),
        string_field(&profile, "support_url"),
        string_field(&profile, "privacy_url"),
        string_field(&profile, "repository_url"),
        optional_string(&profile, "release_manifest_url"),
        optional_string(&profile, "bootstrap_cdn_base"),
    );
    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR")).join("distribution.rs");
    fs::write(out, generated).expect("write generated distribution constants");
}

fn main() {
    generate_distribution_constants();
    #[cfg(feature = "app")]
    tauri_build::build();
}
