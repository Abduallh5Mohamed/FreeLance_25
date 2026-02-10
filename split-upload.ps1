# Split and upload large file
$sourceFile = "A:\FreeLance_25-1\dist\assets\index-1770302450944.js"
$chunkSize = 500KB
$tempDir = "A:\FreeLance_25-1\temp-chunks"

New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

Write-Host "Splitting file into chunks..." -ForegroundColor Cyan

$fileStream = [System.IO.File]::OpenRead($sourceFile)
$chunkNumber = 0

try {
    while ($fileStream.Position -lt $fileStream.Length) {
        $buffer = New-Object byte[] $chunkSize
        $bytesRead = $fileStream.Read($buffer, 0, $chunkSize)
        
        if ($bytesRead -gt 0) {
            $chunkPath = Join-Path $tempDir "chunk_$chunkNumber"
            [System.IO.File]::WriteAllBytes($chunkPath, $buffer[0..($bytesRead-1)])
            Write-Host "Created chunk $chunkNumber ($bytesRead bytes)" -ForegroundColor Green
            $chunkNumber++
        }
    }
} finally {
    $fileStream.Close()
}

Write-Host ""
Write-Host "Total chunks: $chunkNumber" -ForegroundColor Yellow
Write-Host ""
Write-Host "Uploading chunks..." -ForegroundColor Cyan

for ($i = 0; $i -lt $chunkNumber; $i++) {
    $chunkPath = Join-Path $tempDir "chunk_$i"
    Write-Host "Uploading chunk $i..." -ForegroundColor White
    
    scp "$chunkPath" "root@72.62.35.177:/tmp/chunk_$i"
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  Chunk $i uploaded" -ForegroundColor Green
    } else {
        Write-Host "  Chunk $i failed" -ForegroundColor Red
        exit 1
    }
}

Write-Host ""
Write-Host "Reassembling file on server..." -ForegroundColor Cyan

$reassemblePath = "A:\FreeLance_25-1\reassemble.sh"
$content = "#!/bin/bash" + [Environment]::NewLine
$content += "cd /tmp" + [Environment]::NewLine
$content += "cat chunk_* > index-1770302450944.js" + [Environment]::NewLine
$content += "mv index-1770302450944.js /var/www/alqaed/assets/" + [Environment]::NewLine
$content += "rm -f chunk_*" + [Environment]::NewLine
$content += "ls -lh /var/www/alqaed/assets/index-1770302450944.js"
$content | Out-File -FilePath $reassemblePath -Encoding ASCII -NoNewline

scp $reassemblePath "root@72.62.35.177:/tmp/reassemble.sh"
ssh root@72.62.35.177 'chmod +x /tmp/reassemble.sh && bash /tmp/reassemble.sh'

Remove-Item -Recurse -Force $tempDir
Remove-Item $reassemblePath

Write-Host ""
Write-Host "Upload complete!" -ForegroundColor Green
