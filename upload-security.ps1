# Upload Security Files to Server
$SERVER_IP = "72.62.35.177"
$SECURITY_DIR = ".\security"

Write-Host "================================" -ForegroundColor Green
Write-Host "  Upload Security Files" -ForegroundColor Green
Write-Host "================================" -ForegroundColor Green
Write-Host ""

# Check if directory exists
if (-not (Test-Path $SECURITY_DIR)) {
    Write-Host "X security folder not found!" -ForegroundColor Red
    exit 1
}

Write-Host "Server: $SERVER_IP" -ForegroundColor Yellow
Write-Host ""

# Ask for username
$USERNAME = Read-Host "Enter username (e.g. root or ubuntu)"

# Ask for port (default 22)
$PORT = Read-Host "Enter SSH port (press Enter for 22)"
if ([string]::IsNullOrWhiteSpace($PORT)) {
    $PORT = "22"
}

Write-Host ""
Write-Host "Uploading files..." -ForegroundColor Yellow
Write-Host ""

# Upload the entire folder
$scpCommand = "scp -P $PORT -r $SECURITY_DIR ${USERNAME}@${SERVER_IP}:/home/${USERNAME}/"

Write-Host "Command: $scpCommand" -ForegroundColor Cyan
Write-Host ""

# Execute command
try {
    Invoke-Expression $scpCommand
    
    Write-Host ""
    Write-Host "================================" -ForegroundColor Green
    Write-Host "  Files uploaded successfully!" -ForegroundColor Green
    Write-Host "================================" -ForegroundColor Green
    Write-Host ""
    
    Write-Host "Next steps:" -ForegroundColor Yellow
    Write-Host "1. Connect to server:" -ForegroundColor White
    Write-Host "   ssh -p $PORT ${USERNAME}@${SERVER_IP}" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "2. Give execute permissions:" -ForegroundColor White
    Write-Host "   cd ~/security" -ForegroundColor Cyan
    Write-Host "   chmod +x *.sh" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "3. Run master setup script:" -ForegroundColor White
    Write-Host "   sudo bash master-setup.sh" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Or run each script individually:" -ForegroundColor White
    Write-Host "   sudo bash ssh-hardening.sh" -ForegroundColor Cyan
    Write-Host "   sudo bash fail2ban-setup.sh" -ForegroundColor Cyan
    Write-Host "   sudo bash firewall-setup.sh" -ForegroundColor Cyan
    Write-Host "   sudo bash nginx-security-setup.sh" -ForegroundColor Cyan
    Write-Host "   sudo bash auto-updates-setup.sh" -ForegroundColor Cyan
    Write-Host "   bash security-audit.sh" -ForegroundColor Cyan
    Write-Host ""
    
} catch {
    Write-Host ""
    Write-Host "X Error during upload!" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ""
    Write-Host "Make sure:" -ForegroundColor Yellow
    Write-Host "- OpenSSH is installed: " -ForegroundColor White
    Write-Host "  Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH*'" -ForegroundColor Cyan
    Write-Host "- Username and port are correct" -ForegroundColor White
    Write-Host "- Server is accessible" -ForegroundColor White
}
