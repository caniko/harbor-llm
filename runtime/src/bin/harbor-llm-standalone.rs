//! Private managed-namespace setup helper. No host launch/admission entrypoint.
fn main() -> std::process::ExitCode {
    #[cfg(target_os = "linux")]
    if harbor_llm_runtime::standalone::setup().is_ok() {
        return std::process::ExitCode::SUCCESS;
    }
    eprintln!("standalone namespace setup rejected");
    std::process::ExitCode::FAILURE
}
