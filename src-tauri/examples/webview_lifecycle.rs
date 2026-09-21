//! Native regression check for Tauri #15210 / #15224. Run on macOS with
//! `cargo run --example webview_lifecycle` from src-tauri.

#[cfg(target_os = "macos")]
mod macos {
    use std::{cell::RefCell, sync::mpsc, time::Duration};

    use objc2::{rc::Weak, runtime::AnyObject};
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    thread_local! {
        // Never retain the webview in the test: that would hide teardown.
        static WEBVIEW: RefCell<Option<Weak<AnyObject>>> = const { RefCell::new(None) };
    }

    fn check(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        for round in 1..=5 {
            let window = WebviewWindowBuilder::new(
                app,
                "lifecycle",
                WebviewUrl::External("about:blank".parse()?),
            )
            .visible(false)
            .focused(false)
            .build()?;

            // Exercise both one-time setup and repeated native access (sharing).
            for _ in 0..10 {
                let (tx, rx) = mpsc::channel();
                window.with_webview(move |platform| {
                    // SAFETY: with_webview lends the live WKWebView on the main
                    // thread. Weak::new does not take ownership of that pointer.
                    let view = unsafe { &*platform.inner().cast::<AnyObject>() };
                    WEBVIEW.with(|slot| *slot.borrow_mut() = Some(Weak::new(view)));
                    tx.send(()).unwrap();
                })?;
                rx.recv_timeout(Duration::from_secs(10))?;
            }

            window.destroy()?;
            drop(window);

            let mut released = false;
            for _ in 0..20 {
                // Let AppKit drain autoreleases and finish asynchronous teardown.
                std::thread::sleep(Duration::from_millis(100));
                let (tx, rx) = mpsc::channel();
                app.run_on_main_thread(move || {
                    let released = WEBVIEW.with(|slot| {
                        slot.borrow()
                            .as_ref()
                            .is_some_and(|view| view.load().is_none())
                    });
                    tx.send(released).unwrap();
                })?;
                if rx.recv_timeout(Duration::from_secs(10))? {
                    released = true;
                    break;
                }
            }
            if !released {
                return Err(format!("round {round}: destroyed WKWebView is still retained").into());
            }
            println!("round {round}: WKWebView released after 10 native callbacks");
        }
        Ok(())
    }

    pub fn run() {
        // Use a separate identifier and only blank pages, without Carrier's
        // plugins, injected scripts, or Messenger session.
        let mut context = tauri::generate_context!();
        context.config_mut().identifier = "io.github.kristofferr.carrier.lifecycle-test".into();
        tauri::Builder::default()
            .setup(|app| {
                let handle = app.handle().clone();
                std::thread::spawn(move || match check(&handle) {
                    Ok(()) => handle.exit(0),
                    Err(error) => {
                        eprintln!("webview lifecycle check failed: {error}");
                        // AppKit termination can discard Tauri's requested exit
                        // code. This command-line check must fail the caller.
                        std::process::exit(1);
                    }
                });
                Ok(())
            })
            .build(context)
            .expect("build lifecycle test app")
            .run(|_, event| {
                if let tauri::RunEvent::ExitRequested {
                    code: None, api, ..
                } = event
                {
                    api.prevent_exit();
                }
            });
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    macos::run();
    #[cfg(not(target_os = "macos"))]
    eprintln!("webview_lifecycle requires macOS");
}
