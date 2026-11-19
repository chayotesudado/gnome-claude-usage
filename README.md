# Claude Usage (GNOME Shell extension)

Private GNOME Shell extension, for GNOME 51, that shows how much of your Claude plan you have used. It sits beside the Habits extension and works the same way.

It lives in Quick Settings: the status area of the top bar shows the Claude icon, the current 5-hour session's usage as a percentage, or both. The Claude tile in Quick Settings shows or hides that indicator; the tile's arrow opens a menu with a bar for the current session (and how long until it resets) and a bar for the week (and when it resets).

It follows the GNOME HIG: bars use the system accent color (Settings › Appearance), turning yellow at 75% and red at 90%; the panel stays monochrome with a symbolic icon; times follow the clock format in Settings › Date & Time.

- Data: the usage report Claude Code's `/usage` reads, signed in with Claude Code's own login in `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR`). The extension only reads the token, never refreshes it, so it can't sign Claude Code out. When the sign-in expires, run `claude` once and the extension picks up the new token on its own.
- Install:
  ```sh
  glib-compile-schemas schemas
  ln -s "$PWD" ~/.local/share/gnome-shell/extensions/claude-usage@chayotesudado
  ```
  then log out and back in, and `gnome-extensions enable claude-usage@chayotesudado`
- Settings: `gnome-extensions prefs claude-usage@chayotesudado` (or the Extensions app): show icon, percentage, or both; refresh interval (default 5 minutes; opening the menu also refreshes, at most once a minute)
- Tests: `node --test tests/`
