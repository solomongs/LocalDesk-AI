use serde::Serialize;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use sysinfo::{Disks, System};
use tokio::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub name: String,
    pub total_memory_bytes: Option<u64>,
    pub free_memory_bytes: Option<u64>,
    pub source: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStatus {
    pub os: String,
    pub arch: String,
    pub cpu_name: String,
    pub cpu_cores: usize,
    pub total_memory_bytes: u64,
    pub available_memory_bytes: u64,
    pub total_disk_bytes: u64,
    pub free_disk_bytes: u64,
    pub gpus: Vec<GpuInfo>,
    pub ollama_installed: bool,
    pub llmfit_installed: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub installed: bool,
    pub path: Option<String>,
    pub install_url: &'static str,
}

pub fn locate_program(name: &str, resources: Option<&Path>) -> Option<PathBuf> {
    let filename = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    let mut paths = vec![];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            paths.push(parent.join(&filename));
        }
    }
    if let Some(resources) = resources {
        paths.push(resources.join(&filename));
        paths.push(resources.join("bin").join(&filename));
        paths.push(resources.join("binaries").join(&filename));
    }
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            paths.push(
                PathBuf::from(&local)
                    .join("Programs")
                    .join(name)
                    .join(&filename),
            );
            paths.push(
                PathBuf::from(&local)
                    .join("Microsoft/WinGet/Links")
                    .join(&filename),
            );
        }
        if name == "nvidia-smi" {
            if let Some(system) = std::env::var_os("SystemRoot") {
                paths.push(PathBuf::from(system).join("System32/nvidia-smi.exe"));
            }
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            if dir.is_absolute() {
                paths.push(dir.join(&filename));
            }
        }
    }
    paths.into_iter().find(|p| p.is_file())
}

pub async fn snapshot(
    data_path: PathBuf,
    resources: Option<PathBuf>,
) -> Result<SystemStatus, String> {
    let resource_copy = resources.clone();
    let mut info = tokio::task::spawn_blocking(move || {
        let system = System::new_all();
        let disks = Disks::new_with_refreshed_list();
        let disk = disks
            .iter()
            .filter(|d| data_path.starts_with(d.mount_point()))
            .max_by_key(|d| d.mount_point().components().count())
            .or_else(|| disks.iter().max_by_key(|d| d.available_space()));
        SystemStatus {
            os: System::long_os_version().unwrap_or_else(|| std::env::consts::OS.into()),
            arch: std::env::consts::ARCH.into(),
            cpu_name: system
                .cpus()
                .first()
                .map(|c| c.brand().to_owned())
                .unwrap_or_else(|| "Unknown CPU".into()),
            cpu_cores: system.cpus().len(),
            total_memory_bytes: system.total_memory(),
            available_memory_bytes: system.available_memory(),
            total_disk_bytes: disk.map(|d| d.total_space()).unwrap_or(0),
            free_disk_bytes: disk.map(|d| d.available_space()).unwrap_or(0),
            gpus: vec![],
            ollama_installed: locate_program("ollama", resource_copy.as_deref()).is_some(),
            llmfit_installed: locate_program("llmfit", resource_copy.as_deref()).is_some(),
        }
    })
    .await
    .map_err(|_| "Could not read system information.".to_string())?;
    if let Some(path) = locate_program("nvidia-smi", resources.as_deref()) {
        let mut command = Command::new(path);
        command
            .args([
                "--query-gpu=name,memory.total,memory.free",
                "--format=csv,noheader,nounits",
            ])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        if let Ok(Ok(output)) = tokio::time::timeout(Duration::from_secs(6), command.output()).await
        {
            if output.status.success() {
                for line in String::from_utf8_lossy(&output.stdout).lines() {
                    let values = line.rsplitn(3, ',').map(str::trim).collect::<Vec<_>>();
                    if values.len() == 3 {
                        info.gpus.push(GpuInfo {
                            name: values[2].to_owned(),
                            total_memory_bytes: values[1]
                                .parse::<u64>()
                                .ok()
                                .map(|m| m * 1024 * 1024),
                            free_memory_bytes: values[0]
                                .parse::<u64>()
                                .ok()
                                .map(|m| m * 1024 * 1024),
                            source: "nvidia-smi".into(),
                        });
                    }
                }
            }
        }
    }
    #[cfg(windows)]
    if info.gpus.is_empty() {
        if let Some(system) = std::env::var_os("SystemRoot") {
            let executable =
                PathBuf::from(system).join("System32/WindowsPowerShell/v1.0/powershell.exe");
            let mut command = Command::new(executable);
            command.args(["-NoProfile","-NonInteractive","-Command","Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress"]).stdin(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true).creation_flags(0x08000000);
            if let Ok(Ok(output)) =
                tokio::time::timeout(Duration::from_secs(8), command.output()).await
            {
                if let Ok(value) = serde_json::from_slice::<Value>(&output.stdout) {
                    let entries = if let Some(list) = value.as_array() {
                        list.clone()
                    } else {
                        vec![value]
                    };
                    for gpu in entries {
                        if let Some(name) = gpu.get("Name").and_then(Value::as_str) {
                            info.gpus.push(GpuInfo {
                                name: name.into(),
                                total_memory_bytes: gpu.get("AdapterRAM").and_then(Value::as_u64),
                                free_memory_bytes: None,
                                source: "windows-driver-estimate".into(),
                            });
                        }
                    }
                }
            }
        }
    }
    Ok(info)
}

pub async fn start_ollama(resources: Option<&Path>) -> Result<String, String> {
    let executable=locate_program("ollama",resources).ok_or("Ollama is not installed. Install the official desktop application from https://ollama.com/download first.")?;
    let mut command = Command::new(executable);
    command
        .arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|_| {
        "Ollama could not be started. Open the official Ollama application and try again."
            .to_string()
    })?;
    // Reap the dedicated server when it eventually exits; do not block the UI.
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
    Ok("Ollama startup requested. Refresh the connection status in a moment.".into())
}

pub async fn fit_recommendations(
    resources: Option<&Path>,
    use_case: Option<String>,
) -> Result<Value, String> {
    let Some(executable) = locate_program("llmfit", resources) else {
        return Ok(
            serde_json::json!({"available":false,"source":"llmfit","recommendations":null,"error":"llmfit is not installed. Use the built-in estimates or install the official llmfit tool."}),
        );
    };
    let use_case = use_case.unwrap_or_else(|| "general".into());
    if ![
        "general",
        "coding",
        "reasoning",
        "chat",
        "multimodal",
        "embedding",
    ]
    .contains(&use_case.as_str())
    {
        return Err("Unsupported recommendation use case.".into());
    }
    let mut command = Command::new(executable);
    command
        .args([
            "--max-context",
            "4096",
            "recommend",
            "--json",
            "--use-case",
            &use_case,
            "--limit",
            "8",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(Duration::from_secs(30), command.output())
        .await
        .map_err(|_| "llmfit took too long to inspect this computer.".to_string())?
        .map_err(|_| "Could not run the installed llmfit tool.".to_string())?;
    if !output.status.success() {
        return Err(
            "llmfit could not detect this hardware. Use the built-in estimates instead.".into(),
        );
    }
    if output.stdout.len() > 4 * 1024 * 1024 {
        return Err("llmfit returned an oversized response.".into());
    }
    let recommendations: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "The installed llmfit version did not return valid JSON.".to_string())?;
    Ok(serde_json::json!({"available":true,"source":"llmfit","recommendations":recommendations}))
}
