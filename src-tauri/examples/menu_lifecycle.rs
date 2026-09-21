//! Native ownership check for muda #361. Run on macOS with
//! `cargo run --example menu_lifecycle` from src-tauri.

#[cfg(target_os = "macos")]
fn main() {
    use muda::ContextMenu;
    use objc2::{rc::autoreleasepool, rc::Retained, rc::Weak, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSMenu, NSMenuItem};

    let mtm = MainThreadMarker::new().expect("run on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    for round in 0..5 {
        let weak = autoreleasepool(|_| {
            let menu = muda::Menu::new();
            let item = muda::MenuItem::with_id("lifecycle", "Lifecycle", true, None);
            menu.append(&item).unwrap();
            // SAFETY: muda owns a live NSMenu, accessed on the main thread.
            let native_menu = unsafe { &*menu.ns_menu().cast::<NSMenu>() };
            let native_item: Retained<NSMenuItem> = native_menu.itemAtIndex(0).unwrap();
            let weak = Weak::new(&*native_item);
            drop(item);
            drop(menu);

            // SAFETY: the retained item targets itself. The action must remain
            // valid even after all public Rust menu handles have been dropped.
            unsafe {
                let action = native_item.action().expect("menu item action");
                assert!(app.sendAction_to_from(action, Some(&native_item), None));
            }
            let event = muda::MenuEvent::receiver().try_recv().unwrap();
            assert_eq!(event.id.0, "lifecycle");
            drop(native_item);
            weak
        });
        assert!(weak.load().is_none(), "round {round}: native item leaked");
        println!("round {round}: action delivered and native item released");
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("menu_lifecycle requires macOS");
}
