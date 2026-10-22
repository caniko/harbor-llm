//! Preparation-only systemd socket activation entrypoint. Never launches engines.
#[cfg(target_os = "linux")]
fn run() -> Result<(), Box<dyn std::error::Error>> {
    use std::{
        os::{fd::AsFd, unix::net::UnixStream},
        path::PathBuf,
    };
    let arguments: Vec<_> = std::env::args_os().take(5).collect();
    if arguments.len() != 4 || arguments[1] != "serve" || arguments[2] != "--config" {
        return Err("usage: harbor-llm-custodian serve --config ROOT_OWNED_FILE".into());
    }
    let socket = UnixStream::from(std::io::stdin().as_fd().try_clone_to_owned()?);
    harbor_llm_runtime::custodian::serve(&PathBuf::from(&arguments[3]), socket)?;
    Ok(())
}

fn main() -> std::process::ExitCode {
    #[cfg(target_os = "linux")]
    match run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(_) => {
            // The control stream and stderr never expose paths or native errors.
            eprintln!("custodian preparation connection rejected");
            std::process::ExitCode::FAILURE
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        eprintln!("custodian requires Linux");
        std::process::ExitCode::FAILURE
    }
}
