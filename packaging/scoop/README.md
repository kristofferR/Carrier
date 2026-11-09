# Scoop

`chatpane.json` installs the portable zip (`Chatpane_<ver>_win_{x64,arm}_portable.zip`)
and adds a "Chatpane" Start menu shortcut. The app keeps its data in `%APPDATA%`
and `%LOCALAPPDATA%`, outside the app folder, so no `persist` entry is needed.
`checkver` follows GitHub releases and `autoupdate` rewrites the URLs; hashes
come from the release asset digests.

## Bucket

The Extras bucket requires "at least 100 stars and/or 50 forks" for GitHub
projects (its package-request template); the repository has 17 and 4. A
similar Messenger client, Caprine, is in Extras, so the app itself is
acceptable once it is popular enough.

Until then, use a personal bucket:

1. Create `kristofferR/scoop-bucket` from
   [ScoopInstaller/BucketTemplate](https://github.com/ScoopInstaller/BucketTemplate)
   ("Use this template") and copy `chatpane.json` into its `bucket/` folder.
2. Allow Actions to write (Settings, Actions, Workflow permissions). The
   template's Excavator workflow runs `checkver`/`autoupdate` every 4 hours and
   commits new versions, so the app's release workflow needs no token for this.
3. Users install with:

   ```powershell
   scoop bucket add kristofferR https://github.com/kristofferR/scoop-bucket
   scoop install kristofferR/chatpane
   ```

## Blocker: the in-app updater

On Windows, the updater always downloads and runs the NSIS installer. In a
Scoop install that puts a second copy in `%LOCALAPPDATA%`, launches it, and
leaves the Scoop copy on the old version. Before publishing the bucket, the app
should detect Scoop (a `scoop-manifest.json` next to the running exe) and point
the update button at `scoop update chatpane`, as it already does for the AUR on
Linux.
