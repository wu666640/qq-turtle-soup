# 启动海龟汤 QQ 机器人桥接服务（带环境自检 + 崩溃自动重启）
# 建议：自己开一个终端窗口运行本脚本，别关窗口；Ctrl+C 停止
Set-Location $PSScriptRoot

while ($true) {
    $ok = $true
    if (-not (Test-Path .env)) {
        Write-Host "⚠️ 未找到 .env，请先：Copy-Item .env.example .env 并填写 DEEPSEEK_API_KEY" -ForegroundColor Yellow
        $ok = $false
    }
    elseif (-not (Select-String -Path .env -Pattern '^DEEPSEEK_API_KEY=sk-' -Quiet)) {
        Write-Host "⚠️ .env 里 DEEPSEEK_API_KEY 未填写或格式不对（应以 sk- 开头）" -ForegroundColor Yellow
        $ok = $false
    }

    $port = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
    if (-not $port) {
        Write-Host "⚠️ NapCat 未监听 3001：请先运行 setup\NapCat-Shell\launcher-win10-user.bat，并在 WebUI 网络配置里添加 WebSocket 服务器(3001)" -ForegroundColor Yellow
        $ok = $false
    }

    if (-not $ok) {
        Write-Host "❌ 环境未就绪，修复后重试（每 10 秒自动重检）" -ForegroundColor Red
        Start-Sleep -Seconds 10
        continue
    }

    Write-Host "✅ 环境就绪，启动桥接服务（Ctrl+C 停止）" -ForegroundColor Green
    node src/index.js
    Write-Host "⚠️ 进程退出，5 秒后自动重启（Ctrl+C 结束）" -ForegroundColor Yellow
    Start-Sleep -Seconds 5
}
