use std::ffi::OsStr;
use std::process::Command;

/// The platform program that hands a path or URL to the registered system handler.
pub(crate) fn resolve_os_open_program() -> &'static str {
    if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    }
}

/// Spawns the platform opener for an already validated argument.
///
/// Callers own validation and error phrasing: this helper deliberately keeps the raw failure text
/// so each caller can prefix it with its own context without changing the underlying message.
pub(crate) fn spawn_os_open(argument: &OsStr) -> Result<(), String> {
    let status = Command::new(resolve_os_open_program())
        .arg(argument)
        .status()
        .map_err(|error| format!("{error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("{status}"))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn resolve_os_open_program_uses_the_platform_handler() {
        let program = super::resolve_os_open_program();

        #[cfg(target_os = "macos")]
        assert_eq!(program, "open");

        #[cfg(target_os = "windows")]
        assert_eq!(program, "explorer");

        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        assert_eq!(program, "xdg-open");
    }
}
