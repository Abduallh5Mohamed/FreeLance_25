# SFTP upload script
$remotePath = "/var/www/alqaed/assets/index-1770302450944.js"
$localPath = "A:\FreeLance_25-1\dist\assets\index-1770302450944.js"

# Create SFTP batch commands
$commands = @"
put "$localPath" "$remotePath"
ls -l "$remotePath"
bye
"@

$commands | Out-File "A:\FreeLance_25-1\sftp-batch.txt" -Encoding ASCII

# Try SSH with increased timeout and keep-alive
Write-Host "Trying SSH with compression and keep-alive..."
scp -C -o ServerAliveInterval=30 -o ServerAliveCountMax=3 "$localPath" "root@72.62.35.177:$remotePath"
