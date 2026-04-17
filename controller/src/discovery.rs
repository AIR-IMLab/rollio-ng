use crate::runtime_paths::{default_device_executable_name, resolve_registered_program};
use rollio_types::config::DeviceType;
use serde_json::Value;
use std::error::Error;
use std::ffi::OsString;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy)]
pub(crate) struct KnownDriver {
    pub(crate) device_type: DeviceType,
    pub(crate) driver: &'static str,
    pub(crate) probe_args: &'static [&'static str],
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct DiscoveryOptions {
    pub(crate) simulated_cameras: usize,
    pub(crate) simulated_arms: usize,
}

#[derive(Debug, Clone)]
pub(crate) struct ProbeEntry {
    pub(crate) driver: KnownDriver,
    pub(crate) program: OsString,
    pub(crate) probe_entry: Value,
}

#[derive(Debug)]
pub(crate) enum DriverCommandError {
    NotFound { program: String },
    Io { program: String, source: std::io::Error },
    Timeout { program: String, args: String },
    Failed {
        program: String,
        args: String,
        details: String,
    },
    InvalidJson {
        program: String,
        source: serde_json::Error,
        stdout: String,
    },
}

impl std::fmt::Display for DriverCommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound { program } => write!(f, "driver executable not found: {program}"),
            Self::Io { program, source } => write!(f, "failed to run {program}: {source}"),
            Self::Timeout { program, args } => {
                write!(f, "driver command timed out: {program} {args}")
            }
            Self::Failed {
                program,
                args,
                details,
            } => write!(f, "driver command failed: {program} {args}: {details}"),
            Self::InvalidJson {
                program,
                source,
                stdout,
            } => write!(
                f,
                "driver command returned invalid JSON: {program}: {source}; stdout={stdout}"
            ),
        }
    }
}

impl Error for DriverCommandError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::InvalidJson { source, .. } => Some(source),
            _ => None,
        }
    }
}

pub(crate) fn discover_probe_entries(
    workspace_root: &Path,
    current_exe_dir: &Path,
    options: DiscoveryOptions,
    discovery_timeout: Duration,
) -> Result<(Vec<ProbeEntry>, Vec<String>), Box<dyn Error>> {
    let mut entries = Vec::new();
    let mut probe_errors = Vec::new();

    for driver in known_drivers() {
        extend_probe_entries(
            *driver,
            &[],
            workspace_root,
            current_exe_dir,
            discovery_timeout,
            &mut entries,
            &mut probe_errors,
        );
    }

    if options.simulated_cameras > 0 {
        let simulated_camera_args = vec![
            OsString::from("--count"),
            OsString::from(options.simulated_cameras.to_string()),
        ];
        extend_probe_entries(
            KnownDriver {
                device_type: DeviceType::Camera,
                driver: "pseudo",
                probe_args: &[],
            },
            &simulated_camera_args,
            workspace_root,
            current_exe_dir,
            discovery_timeout,
            &mut entries,
            &mut probe_errors,
        );
    }

    if options.simulated_arms > 0 {
        let simulated_robot_args = vec![
            OsString::from("--count"),
            OsString::from(options.simulated_arms.to_string()),
        ];
        extend_probe_entries(
            KnownDriver {
                device_type: DeviceType::Robot,
                driver: "pseudo",
                probe_args: &[],
            },
            &simulated_robot_args,
            workspace_root,
            current_exe_dir,
            discovery_timeout,
            &mut entries,
            &mut probe_errors,
        );
    }

    if entries.is_empty() && !probe_errors.is_empty() {
        return Err(probe_errors.join("; ").into());
    }

    Ok((entries, probe_errors))
}

pub(crate) fn known_drivers() -> &'static [KnownDriver] {
    &[
        KnownDriver {
            device_type: DeviceType::Camera,
            driver: "realsense",
            probe_args: &[],
        },
        KnownDriver {
            device_type: DeviceType::Camera,
            driver: "v4l2",
            probe_args: &[],
        },
        KnownDriver {
            device_type: DeviceType::Robot,
            driver: "airbot-play",
            probe_args: &[],
        },
    ]
}

pub(crate) fn run_driver_json(
    program: &OsString,
    args: &[OsString],
    working_directory: &Path,
    timeout: Duration,
) -> Result<Value, DriverCommandError> {
    let program_name = os_string_lossy(program);
    let args_display = args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(" ");
    let mut child = Command::new(program)
        .args(args)
        .current_dir(working_directory)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|source| {
            if source.kind() == std::io::ErrorKind::NotFound {
                DriverCommandError::NotFound {
                    program: program_name.clone(),
                }
            } else {
                DriverCommandError::Io {
                    program: program_name.clone(),
                    source,
                }
            }
        })?;

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(DriverCommandError::Timeout {
                        program: program_name,
                        args: args_display,
                    });
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(source) => {
                return Err(DriverCommandError::Io {
                    program: program_name,
                    source,
                });
            }
        }
    };

    let stdout = read_child_pipe(child.stdout.take()).map_err(|source| DriverCommandError::Io {
        program: program_name.clone(),
        source,
    })?;
    let stderr = read_child_pipe(child.stderr.take()).map_err(|source| DriverCommandError::Io {
        program: program_name.clone(),
        source,
    })?;

    if !status.success() {
        let details = if stderr.trim().is_empty() {
            stdout.trim().to_owned()
        } else {
            stderr.trim().to_owned()
        };
        return Err(DriverCommandError::Failed {
            program: program_name,
            args: args_display,
            details,
        });
    }

    serde_json::from_str(stdout.trim()).map_err(|source| DriverCommandError::InvalidJson {
        program: program_name,
        source,
        stdout,
    })
}

fn extend_probe_entries(
    driver: KnownDriver,
    extra_probe_args: &[OsString],
    workspace_root: &Path,
    current_exe_dir: &Path,
    discovery_timeout: Duration,
    entries: &mut Vec<ProbeEntry>,
    probe_errors: &mut Vec<String>,
) {
    let executable_name = default_device_executable_name(driver.driver);
    let program = resolve_registered_program(&executable_name, workspace_root, current_exe_dir);
    let mut probe_args = vec![OsString::from("probe"), OsString::from("--json")];
    probe_args.extend(driver.probe_args.iter().map(OsString::from));
    probe_args.extend(extra_probe_args.iter().cloned());

    let probe_output = match run_driver_json(&program, &probe_args, workspace_root, discovery_timeout)
    {
        Ok(value) => value,
        Err(DriverCommandError::NotFound { .. }) => return,
        Err(error) => {
            probe_errors.push(format!("{}: {error}", driver.driver));
            return;
        }
    };

    let Some(probe_entries) = probe_output.as_array() else {
        probe_errors.push(format!(
            "{}: probe output must be a JSON array, got {}",
            driver.driver, probe_output
        ));
        return;
    };

    for probe_entry in probe_entries {
        entries.push(ProbeEntry {
            driver,
            program: program.clone(),
            probe_entry: probe_entry.clone(),
        });
    }
}

fn read_child_pipe(mut pipe: Option<impl Read>) -> Result<String, std::io::Error> {
    let mut output = String::new();
    if let Some(pipe) = pipe.as_mut() {
        pipe.read_to_string(&mut output)?;
    }
    Ok(output)
}

fn os_string_lossy(value: &OsString) -> String {
    value.to_string_lossy().into_owned()
}
