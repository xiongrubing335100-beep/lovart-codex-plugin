param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $accessKey = [string]$payload.access_key
    $secretKey = [string]$payload.secret_key
    if ([string]::IsNullOrWhiteSpace($accessKey) -or [string]::IsNullOrWhiteSpace($secretKey) -or
        $accessKey.Length -gt 2048 -or $secretKey.Length -gt 2048 -or
        $accessKey -match '[\x00-\x20\x7f]' -or $secretKey -match '[\x00-\x20\x7f]') { exit 1 }
    if ($ValidateOnly) { exit 0 }
    $previousAccessKey = [Environment]::GetEnvironmentVariable('LOVART_ACCESS_KEY', 'User')
    $previousSecretKey = [Environment]::GetEnvironmentVariable('LOVART_SECRET_KEY', 'User')
    try {
        [Environment]::SetEnvironmentVariable('LOVART_ACCESS_KEY', $accessKey, 'User')
        [Environment]::SetEnvironmentVariable('LOVART_SECRET_KEY', $secretKey, 'User')
    } catch {
        [Environment]::SetEnvironmentVariable('LOVART_ACCESS_KEY', $previousAccessKey, 'User')
        [Environment]::SetEnvironmentVariable('LOVART_SECRET_KEY', $previousSecretKey, 'User')
        exit 1
    }
    exit 0
} catch { exit 1 }
finally { $payload = $accessKey = $secretKey = $previousAccessKey = $previousSecretKey = $null }
