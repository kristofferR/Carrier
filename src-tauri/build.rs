fn main() {
    println!("cargo:rerun-if-env-changed=CHATPANE_BUILD_REVISION");
    let revision = std::env::var("CHATPANE_BUILD_REVISION").unwrap_or_else(|_| "local".into());
    assert!(
        revision == "local"
            || (revision.len() == 40 && revision.bytes().all(|b| b.is_ascii_hexdigit()))
    );
    println!("cargo:rustc-env=CHATPANE_BUILD_REVISION={revision}");
    tauri_build::build();
}
