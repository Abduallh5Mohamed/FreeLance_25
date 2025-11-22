$password = "MyPass12345@"
$server = "root@72.62.35.177"
$startChunk = 5
$totalChunks = 49

Write-Host "Uploading chunks $startChunk to $($totalChunks-1)..."

for ($i = $startChunk; $i -lt $totalChunks; $i++) {
    $chunkFile = "D:\Freelance10\FreeLance_25-1\dist\assets\chunk$i.txt"
    $chunk = Get-Content $chunkFile -Raw
    
    # Escape single quotes in the chunk
    $chunk = $chunk.Replace("'", "'\\''")
    
    # Create a temporary expect-like script using cmd
    $sshCmd = "echo -n '$chunk' >> /tmp/jsfile.b64"
    
    # Use plink if available, or ssh with password via echo
    try {
        $process = Start-Process -FilePath "ssh" -ArgumentList "$server", "$sshCmd" -NoNewWindow -Wait -PassThru -RedirectStandardInput "D:\Freelance10\FreeLance_25-1\password.txt"
        
        if ($i % 10 -eq 0) {
            Write-Host "Progress: $i/$total Chunks"
        }
    } catch {
        Write-Host "Error uploading chunk $i"
    }
}

Write-Host "Upload complete! Decoding on server..."
$decodeCmd = "base64 -d /tmp/jsfile.b64 > /var/www/alqaed-platform/dist/assets/index-C-cVA6e9.js && ls -lh /var/www/alqaed-platform/dist/assets/index-C-cVA6e9.js"
ssh $server $decodeCmd

Write-Host "Done!"
