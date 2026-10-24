$ErrorActionPreference = 'Stop'

# The local MinIO launcher and the API must share one process environment.
# Running start-minio.ps1 as one npm command and tsx as a second command loses
# these variables because child-process environment changes do not flow back to
# npm's parent shell.
$env:MINIO_ACCESS_KEY = if ($env:MINIO_ACCESS_KEY) { $env:MINIO_ACCESS_KEY } else { 'minioadmin' }
$env:MINIO_SECRET_KEY = if ($env:MINIO_SECRET_KEY) { $env:MINIO_SECRET_KEY } else { 'minioadmin123' }

# MinIO's launcher uses the current ROOT variable names while the API client
# still reads ACCESS/SECRET. Keep both sides on the same local credentials.
$env:MINIO_ROOT_USER = if ($env:MINIO_ROOT_USER) { $env:MINIO_ROOT_USER } else { $env:MINIO_ACCESS_KEY }
$env:MINIO_ROOT_PASSWORD = if ($env:MINIO_ROOT_PASSWORD) { $env:MINIO_ROOT_PASSWORD } else { $env:MINIO_SECRET_KEY }

& "$PSScriptRoot\start-minio.ps1"
if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Set-Location $PSScriptRoot
& npx.cmd tsx watch src/index.ts
exit $LASTEXITCODE
