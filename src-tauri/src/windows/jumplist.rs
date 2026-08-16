//! Windows taskbar jump list — the recent-conversations parity of the macOS
//! Dock menu and the Linux tray menu. Built from the same in-memory recent-thread
//! model, so it inherits the Hide Names & Avatars redaction. Each entry launches
//! `Carrier.exe --thread <id>`; the flag (not a `carrier://` URL) keeps it working
//! even if protocol registration failed and avoids a quoting round-trip.

use windows::core::{w, Interface, Result, GUID};
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::{
    DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, ShellLink,
};

use crate::menu::RecentThread;

/// `System.Title` — the label a jump-list task shows. `{F29F85E0-4FF9-1068-AB91-08002B27B3D9}`, pid 2.
const PKEY_TITLE: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0xf29f85e0_4ff9_1068_ab91_08002b27b3d9),
    pid: 2,
};

/// Monotonic rebuild generation: workers holding an outdated generation skip
/// their build entirely, so a slow older rebuild can never commit a stale list
/// over a newer one. This matters for privacy — turning Hide Names & Avatars on
/// clears the recents, and a racing stale commit could restore conversation
/// names to the jump list.
static JUMP_LIST_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Serializes the COM build itself so two workers never interleave
/// BeginList/CommitList sequences.
static JUMP_LIST_BUILD: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Rebuild the taskbar jump list from the current recent conversations. Runs on
/// its own short-lived STA thread so it never touches the main apartment, and is
/// best-effort — a COM failure is logged, not surfaced.
pub(crate) fn rebuild_jump_list(threads: Vec<RecentThread>) {
    use std::sync::atomic::Ordering;

    let generation = JUMP_LIST_GENERATION
        .fetch_add(1, Ordering::AcqRel)
        .wrapping_add(1);
    let spawned = std::thread::Builder::new()
        .name("carrier-jump-list".into())
        .spawn(move || {
            let _serialized = JUMP_LIST_BUILD
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            // A newer rebuild is pending or done; this snapshot is obsolete.
            // Checked under the lock, so the newest request always commits last.
            if JUMP_LIST_GENERATION.load(Ordering::Acquire) != generation {
                return;
            }
            // SAFETY: standard COM lifecycle on a dedicated thread.
            unsafe {
                let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
                if let Err(error) = build(&threads) {
                    log::warn!("failed to build the Windows jump list: {error}");
                }
                if initialized {
                    CoUninitialize();
                }
            }
        });
    if let Err(error) = spawned {
        log::warn!("failed to start the jump-list worker: {error}");
    }
}

unsafe fn build(threads: &[RecentThread]) -> Result<()> {
    let exe = std::env::current_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();

    let list: ICustomDestinationList =
        CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
    // BeginList reports how many slots the shell will actually show (and the
    // destinations the user removed by hand, which we don't re-add). We simply
    // cap our additions at the reported budget.
    let mut min_slots = 0u32;
    let _removed: IObjectArray = list.BeginList(&mut min_slots)?;

    let collection: IObjectCollection =
        CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
    let mut added = 0u32;
    for thread in threads {
        if added >= min_slots {
            break;
        }
        let Some(id) = thread
            .href
            .strip_prefix("/t/")
            .and_then(|rest| rest.strip_suffix('/'))
        else {
            continue;
        };
        let link = shell_link(&exe, &format!("--thread {id}"), &thread.name)?;
        collection.AddObject(&link)?;
        added += 1;
    }

    if added > 0 {
        let array: IObjectArray = collection.cast()?;
        list.AppendCategory(w!("Recent"), &array)?;
    }
    // Commit even with nothing added, so clearing the recents (e.g. Hide Names &
    // Avatars turned on) empties the jump list too.
    list.CommitList()?;
    Ok(())
}

unsafe fn shell_link(exe: &str, arguments: &str, title: &str) -> Result<IShellLinkW> {
    let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
    link.SetPath(&windows::core::HSTRING::from(exe))?;
    link.SetArguments(&windows::core::HSTRING::from(arguments))?;
    // Reuse the executable's own icon for the entry.
    link.SetIconLocation(&windows::core::HSTRING::from(exe), 0)?;

    // The visible label lives in the link's property store as System.Title.
    let store: IPropertyStore = link.cast()?;
    store.SetValue(&PKEY_TITLE, &PROPVARIANT::from(title))?;
    store.Commit()?;
    Ok(link)
}
