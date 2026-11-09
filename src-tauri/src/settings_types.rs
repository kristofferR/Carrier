//! Checked-in browser contracts derived from the native wire types.

use ts_rs::TS;

#[test]
fn settings_types_match_native() {
    let config = ts_rs::Config::new().with_large_int("number");
    let declarations = [
        crate::settings::NicknameScope::decl(&config),
        crate::pane_widths::PaneWidths::decl(&config),
        crate::growth::Usage::decl(&config),
        crate::sound::NotificationSound::decl(&config),
        crate::settings::Settings::decl(&config),
        crate::settings_change::SettingsChange::decl(&config),
        crate::commands::RuntimeCapabilities::decl(&config),
        crate::autostart::Status::decl(&config),
        crate::themes::ThemeMode::decl(&config),
        crate::themes::ThemeInfo::decl(&config),
        crate::sound::SoundOption::decl(&config),
        crate::account::MessengerAccountState::decl(&config),
        crate::account::MessengerAccountChange::decl(&config),
        crate::commands::UpdateInstallKind::decl(&config),
        crate::commands::UpdateInstallMode::decl(&config),
    ];
    let source = format!(
        "// GENERATED from Rust wire types. Do not edit.\n\
         // Regenerate: bun run build:settings-types\n\n{}\n",
        declarations
            .map(|decl| format!("export {decl}"))
            .join("\n\n")
    );
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../inject/src/settings/native-types.ts");
    if std::env::var_os("CHATPANE_UPDATE_SETTINGS_TYPES").is_some() {
        std::fs::write(&path, &source).unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        source,
        "native Settings types changed; run bun run build:settings-types"
    );
}
