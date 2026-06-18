# Build and install the Co-Steer extension locally
Write-Host "Building VSIX extension..." -ForegroundColor Cyan
npm run vsix

if ($LASTEXITCODE -eq 0) {
    Write-Host "Installing extension to VS Code..." -ForegroundColor Cyan
    code --install-extension co-steer.vsix

    $antigravityIde = "$env:LOCALAPPDATA\Programs\Antigravity IDE\bin\antigravity-ide.cmd"
    if (Test-Path $antigravityIde) {
        Write-Host "Installing extension to Antigravity IDE..." -ForegroundColor Cyan
        & $antigravityIde --install-extension co-steer.vsix
    }

    Write-Host "Done! Reload your IDE windows to apply changes." -ForegroundColor Green
} else {
    Write-Error "Failed to build the VSIX package."
}
